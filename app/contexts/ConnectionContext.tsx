import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
} from "react";
import { AppState } from "react-native";
import {
  configureProxy,
  startPortServers,
  stopAllServers,
} from "@/lib/proxyServer";
import { logger } from "@/lib/logger";
import { V2SessionTransport } from "@/lib/transport/v2";

// ============================================================================
// Types
// ============================================================================

export interface Message {
  v: 1;
  id: string;
  ns: string;
  action: string;
  payload: Record<string, unknown>;
}

export interface Response {
  v: 1;
  id: string;
  ns: string;
  action: string;
  ok: boolean;
  payload: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  startedAt: number;
  ns: string;
  action: string;
  path?: string | null;
}

interface Capabilities {
  version: string;
  namespaces: string[];
  platform: string;
  rootDir: string;
  hostname: string;
}

interface ConnectionContextType {
  status: ConnectionStatus;
  capabilities: Capabilities | null;
  error: string | null;
  isReconnecting: boolean;
  trackedProxyPorts: number[];
  discoveredProxyPorts: number[];
  connect: (url: string, secret: string) => Promise<void>;
  disconnect: () => void;
  endSession: () => void;
  refreshProxyState: () => Promise<void>;
  trackProxyPort: (port: number) => Promise<void>;
  untrackProxyPort: (port: number) => Promise<void>;
  sendControl: (
    ns: string,
    action: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<Response>;
  sendData: (
    ns: string,
    action: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<Response>;
  fireData: (
    ns: string,
    action: string,
    payload?: Record<string, unknown>,
  ) => void;
  onDataEvent: (handler: (message: Message) => void) => () => void;
}

const ConnectionContext = createContext<ConnectionContextType | null>(null);
let hasLoggedMissingConnectionProvider = false;

const unavailableConnectionError = () =>
  new Error("Connection context unavailable during app bootstrap");

const fallbackConnectionContext: ConnectionContextType = {
  status: "disconnected",
  capabilities: null,
  error: "Connection unavailable",
  isReconnecting: false,
  trackedProxyPorts: [],
  discoveredProxyPorts: [],
  connect: async () => {
    throw unavailableConnectionError();
  },
  endSession: async () => {},
  disconnect: () => {},
  refreshProxyState: async () => {
    throw unavailableConnectionError();
  },
  trackProxyPort: async () => {
    throw unavailableConnectionError();
  },
  untrackProxyPort: async () => {
    throw unavailableConnectionError();
  },
  sendControl: async () => {
    throw unavailableConnectionError();
  },
  sendData: async () => {
    throw unavailableConnectionError();
  },
  fireData: () => {},
  onDataEvent: () => () => {},
};

function shouldLogRequest(ns: string, action: string): boolean {
  if (ns === "fs" && action === "ls") return false;
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ============================================================================
// Provider
// ============================================================================

export function ConnectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [trackedProxyPorts, setTrackedProxyPorts] = useState<number[]>([]);
  const [discoveredProxyPorts, setDiscoveredProxyPorts] = useState<number[]>(
    [],
  );

  const v2TransportRef = useRef<V2SessionTransport | null>(null);
  const connectionGenerationRef = useRef(0);
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());
  const dataEventHandlersRef = useRef<Set<(message: Message) => void>>(
    new Set(),
  );
  const messageIdRef = useRef(0);

  const localWsUrlRef = useRef<string | null>(null);
  const localWsSecretRef = useRef<string | null>(null);
  const sendControlRef = useRef<
    | ((
        ns: string,
        action: string,
        payload?: Record<string, unknown>,
      ) => Promise<Response>)
    | null
  >(null);
  const manualDisconnectRef = useRef(false);
  const connectingRef = useRef(false);
  const discoveredPortsRef = useRef<number[]>([]);
  const trackedPortsRef = useRef<number[]>([]);

  const generateId = useCallback(() => {
    messageIdRef.current += 1;
    return `msg-${Date.now()}-${messageIdRef.current}`;
  }, []);

  const sendMessageV2 = useCallback(
    (
      ns: string,
      action: string,
      payload: Record<string, unknown> = {},
      timeoutMs = 30000,
    ): Promise<Response> => {
      return new Promise((resolve, reject) => {
        const transport = v2TransportRef.current;
        if (!transport) {
          reject(new Error("Transport not connected"));
          return;
        }

        const id = generateId();
        const message: Message = { v: 1, id, ns, action, payload };
        const startedAt = Date.now();
        const path = typeof payload.path === "string" ? payload.path : null;

        if (shouldLogRequest(ns, action)) {
          logger.info("connection", "sending request", {
            id,
            ns,
            action,
            channel: "v2",
            path,
            timeoutMs,
          });
        }

        const timeout = setTimeout(() => {
          pendingRequestsRef.current.delete(id);
          reject(new Error(`Request timeout: ${ns}.${action}`));
        }, timeoutMs);

        pendingRequestsRef.current.set(id, {
          resolve,
          reject,
          timeout,
          startedAt,
          ns,
          action,
          path,
        });

        transport.sendMessage(message).catch((error) => {
          clearTimeout(timeout);
          pendingRequestsRef.current.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    },
    [generateId],
  );

  const sendControl = useCallback(
    (
      ns: string,
      action: string,
      payload?: Record<string, unknown>,
      timeoutMs?: number,
    ) => {
      return sendMessageV2(ns, action, payload, timeoutMs);
    },
    [sendMessageV2],
  );

  sendControlRef.current = sendControl;

  const sendData = useCallback(
    (
      ns: string,
      action: string,
      payload?: Record<string, unknown>,
      timeoutMs?: number,
    ) => {
      return sendMessageV2(ns, action, payload, timeoutMs);
    },
    [sendMessageV2],
  );

  const fireData = useCallback(
    (ns: string, action: string, payload: Record<string, unknown> = {}) => {
      const transport = v2TransportRef.current;
      if (!transport) return;
      const id = generateId();
      const message: Message = { v: 1, id, ns, action, payload };
      transport.sendEvent(message).catch((err) =>
        logger.error("connection", "fireData send failed", {
          error: err instanceof Error ? err.message : String(err),
          ns,
          action,
        }),
      );
    },
    [generateId],
  );

  const onDataEvent = useCallback((handler: (message: Message) => void) => {
    dataEventHandlersRef.current.add(handler);
    return () => {
      dataEventHandlersRef.current.delete(handler);
    };
  }, []);

  const clearPendingRequests = useCallback((reason: string) => {
    for (const pending of pendingRequestsRef.current.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    pendingRequestsRef.current.clear();
  }, []);

  const applyProxyState = useCallback(
    (trackedPorts: number[], openPorts: number[]) => {
      const nextTrackedPorts = [...trackedPorts].sort((a, b) => a - b);
      const nextOpenPorts = [...openPorts].sort((a, b) => a - b);
      trackedPortsRef.current = nextTrackedPorts;
      discoveredPortsRef.current = nextOpenPorts;
      setTrackedProxyPorts(nextTrackedPorts);
      setDiscoveredProxyPorts(nextOpenPorts);

      if (AppState.currentState === "active" && status === "connected") {
        startPortServers(nextOpenPorts);
      }
    },
    [status],
  );

  const refreshProxyState = useCallback(async () => {
    const response = await sendControl("proxy", "getState");
    const trackedPorts = Array.isArray(response.payload?.trackedPorts)
      ? response.payload.trackedPorts.filter(
          (value): value is number => typeof value === "number",
        )
      : [];
    const openPorts = Array.isArray(response.payload?.openPorts)
      ? response.payload.openPorts.filter(
          (value): value is number => typeof value === "number",
        )
      : [];
    applyProxyState(trackedPorts, openPorts);
  }, [applyProxyState, sendControl]);

  const trackProxyPort = useCallback(
    async (port: number) => {
      const response = await sendControl("proxy", "trackPort", { port });
      const trackedPorts = Array.isArray(response.payload?.trackedPorts)
        ? response.payload.trackedPorts.filter(
            (value): value is number => typeof value === "number",
          )
        : [];
      const openPorts = Array.isArray(response.payload?.openPorts)
        ? response.payload.openPorts.filter(
            (value): value is number => typeof value === "number",
          )
        : [];
      applyProxyState(trackedPorts, openPorts);
    },
    [applyProxyState, sendControl],
  );

  const untrackProxyPort = useCallback(
    async (port: number) => {
      const response = await sendControl("proxy", "untrackPort", { port });
      const trackedPorts = Array.isArray(response.payload?.trackedPorts)
        ? response.payload.trackedPorts.filter(
            (value): value is number => typeof value === "number",
          )
        : [];
      const openPorts = Array.isArray(response.payload?.openPorts)
        ? response.payload.openPorts.filter(
            (value): value is number => typeof value === "number",
          )
        : [];
      applyProxyState(trackedPorts, openPorts);
    },
    [applyProxyState, sendControl],
  );

  const cleanupSockets = useCallback(
    (clearState: boolean) => {
      v2TransportRef.current?.close();
      v2TransportRef.current = null;
      stopAllServers();

      if (clearState) {
        setIsReconnecting(false);
        setStatus("disconnected");
        localWsUrlRef.current = null;
        localWsSecretRef.current = null;
        discoveredPortsRef.current = [];
        trackedPortsRef.current = [];
        setTrackedProxyPorts([]);
        setDiscoveredProxyPorts([]);
        setCapabilities(null);
        setError(null);
        clearPendingRequests("Disconnected");
      }
    },
    [clearPendingRequests],
  );

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true;
    setIsReconnecting(false);
    cleanupSockets(true);
  }, [cleanupSockets]);

  const endSession = useCallback(async () => {
    try {
      await sendControl("system", "end_session", {});
    } catch {
      // Best effort
    }
  }, [sendControl]);

  const connect = useCallback(
    async (url: string, secret: string) => {
      manualDisconnectRef.current = false;
      connectingRef.current = true;
      setStatus("connecting");
      setError(null);

      cleanupSockets(false);

      const generation = ++connectionGenerationRef.current;

      try {
        const transport = new V2SessionTransport({
          gatewayUrl: url,
          password: secret,
          sessionSecret: secret,
          wsUrlOverride: `${url}/v2/ws/app?secret=${secret}`,
          role: "app",
          debugLog: (message, ...args) =>
            logger.info("connection", message, {
              args: args.map((value) => {
                if (
                  typeof value === "string" ||
                  typeof value === "number" ||
                  typeof value === "boolean" ||
                  value == null
                ) {
                  return value;
                }
                try {
                  return JSON.stringify(value);
                } catch {
                  return String(value);
                }
              }),
            }),
          handlers: {
            onSystemMessage: async (message) => {
              if (
                generation !== connectionGenerationRef.current ||
                v2TransportRef.current !== transport
              )
                return;
              if (message.type === "connected") return;

              if (message.type === "peer_connected") {
                logger.info("connection", "peer connected");
                setError(null);
                if (sendControlRef.current) {
                  configureProxy(
                    url,
                    secret,
                    sendControlRef.current,
                  );
                }
                return;
              }

              if (message.type === "peer_disconnected") {
                stopAllServers();
                setError("CLI disconnected");
                return;
              }
            },
            onProtocolRequest: async () => ({
              v: 1,
              id: generateId(),
              ns: "system",
              action: "unsupported",
              ok: false,
              payload: {},
              error: {
                code: "EUNSUPPORTED",
                message: "App does not serve protocol requests",
              },
            }),
            onProtocolResponse: async (response) => {
              if (
                generation !== connectionGenerationRef.current ||
                v2TransportRef.current !== transport
              )
                return;
              const pending = pendingRequestsRef.current.get(response.id);
              if (pending) {
                clearTimeout(pending.timeout);
                pendingRequestsRef.current.delete(response.id);
                pending.resolve(response);
              }
            },
            onProtocolEvent: async (message) => {
              if (
                generation !== connectionGenerationRef.current ||
                v2TransportRef.current !== transport
              )
                return;
              if (
                message.ns === "proxy" &&
                message.action === "ports_discovered"
              ) {
                const ports = message.payload?.ports as number[];
                if (Array.isArray(ports)) {
                  discoveredPortsRef.current = ports;
                  setDiscoveredProxyPorts(ports);
                  if (AppState.currentState === "active") {
                    startPortServers(ports);
                  }
                }
                return;
              }

              for (const handler of dataEventHandlersRef.current) {
                handler(message);
              }
            },
            onClose: (reason) => {
              if (
                generation !== connectionGenerationRef.current ||
                v2TransportRef.current !== transport
              )
                return;
              logger.warn("connection", "v2 transport closed", {
                url,
                reason,
              });
              if (manualDisconnectRef.current) return;
              setStatus("disconnected");
              setError(`Disconnected: ${reason}`);
              localWsUrlRef.current = url;
              localWsSecretRef.current = secret;
              setIsReconnecting(true);
              setTimeout(() => {
                if (!manualDisconnectRef.current && localWsUrlRef.current && localWsSecretRef.current) {
                  void connect(localWsUrlRef.current, localWsSecretRef.current).catch(() => {
                    setTimeout(() => {
                      if (!manualDisconnectRef.current && localWsUrlRef.current && localWsSecretRef.current) {
                        void connect(localWsUrlRef.current, localWsSecretRef.current);
                      }
                    }, 2000);
                  });
                }
              }, 1000);
            },
          },
        });

        v2TransportRef.current = transport;
        localWsUrlRef.current = url;
        localWsSecretRef.current = secret;
        await transport.connect();

        if (
          generation !== connectionGenerationRef.current ||
          v2TransportRef.current !== transport
        ) {
          transport.close();
          return;
        }

        const response = await sendMessageV2("system", "capabilities");
        if (
          generation !== connectionGenerationRef.current ||
          v2TransportRef.current !== transport
        ) {
          transport.close();
          return;
        }
        if (!response.ok) {
          throw new Error(
            response.error?.message || "Failed to get capabilities",
          );
        }

        setCapabilities(response.payload as unknown as Capabilities);
        setStatus("connected");
        setError(null);
        setIsReconnecting(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("connection", "connect failed", { error: message });
        setStatus("error");
        setError(message);
        throw err;
      } finally {
        connectingRef.current = false;
      }
    },
    [cleanupSockets, generateId, sendMessageV2],
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (
        nextState === "active" &&
        status === "connected" &&
        discoveredPortsRef.current.length > 0
      ) {
        startPortServers(discoveredPortsRef.current);
      }
      if (nextState !== "active") {
        stopAllServers();
      }
    });
    return () => sub.remove();
  }, [status]);

  useEffect(() => {
    return () => {
      manualDisconnectRef.current = true;
      cleanupSockets(true);
    };
  }, [cleanupSockets]);

  const value = useMemo<ConnectionContextType>(
    () => ({
      status,
      capabilities,
      error,
      isReconnecting,
      trackedProxyPorts,
      discoveredProxyPorts,
      connect,
      endSession,
      disconnect,
      refreshProxyState,
      trackProxyPort,
      untrackProxyPort,
      sendControl,
      sendData,
      fireData,
      onDataEvent,
    }),
    [
      status,
      capabilities,
      error,
      isReconnecting,
      trackedProxyPorts,
      discoveredProxyPorts,
      connect,
      endSession,
      disconnect,
      refreshProxyState,
      trackProxyPort,
      untrackProxyPort,
      sendControl,
      sendData,
      fireData,
      onDataEvent,
    ],
  );

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

export function useConnection() {
  const context = useContext(ConnectionContext);
  if (!context) {
    if (!hasLoggedMissingConnectionProvider) {
      hasLoggedMissingConnectionProvider = true;
      console.error(
        "useConnection called outside ConnectionProvider; using fallback context.",
      );
    }
    return fallbackConnectionContext;
  }
  return context;
}
