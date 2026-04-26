import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import { configureProxy, startPortServers, stopAllServers } from '@/lib/proxyServer';
import { logger } from '@/lib/logger';
import { V2SessionTransport } from '@/lib/transport/v2';

const DEFAULT_GATEWAY = 'wss://gateway.lunel.dev';
const MANAGER_URL = 'https://manager.lunel.dev';
const LAST_SESSION_STORAGE_KEY = 'lunel_last_session';
const LAST_SESSION_FALLBACK_STORAGE_KEY = '@lunel_last_session_fallback';
const PAIRED_SESSIONS_STORAGE_KEY = 'lunel_paired_sessions';
const MAX_RECONNECT_ATTEMPTS = 5;

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

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type SessionState = 'idle' | 'pending' | 'active' | 'app_offline_grace' | 'cli_offline_grace' | 'ended' | 'expired';

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
  managerSessionId?: string | null;
}

interface AssembleResult {
  code: string;
  password: string;
  sessionId: string | null;
}

interface ReattachClaimResult {
  proxyUrl: string;
  generation: number;
  expiresAt: number;
}

class ProxyLookupError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProxyLookupError';
    this.status = status;
  }
}

interface ManagerHealthProbeResult {
  ok: boolean;
  status: number | null;
  body: string | null;
}

export interface StoredSession {
  sessionCode: string | null;
  sessionPassword: string;
  managerSessionId?: string | null;
  gateways: string[];
  savedAt: number;
}

export interface PairedSession extends StoredSession {
  hostname: string;
  root: string;
  phoneId: string;
  pairedAt: number;
  lastUsedAt: number;
}

interface ConnectionContextType {
  status: ConnectionStatus;
  sessionState: SessionState;
  sessionCode: string | null;
  cacheNamespace: string | null;
  syncGeneration: number;
  capabilities: Capabilities | null;
  error: string | null;
  isReconnecting: boolean;
  interactionBlockReason: 'offline' | 'reconnecting' | null;
  trackedProxyPorts: number[];
  discoveredProxyPorts: number[];
  connect: (code: string) => Promise<void>;
  resumeSession: (session: StoredSession) => Promise<void>;
  getStoredSession: () => Promise<StoredSession | null>;
  getPairedSessions: () => Promise<PairedSession[]>;
  revokePairedSession: (secret: string) => Promise<void>;
  removePairedSession: (secret: string) => Promise<void>;
  clearStoredSession: () => Promise<void>;
  endSession: () => Promise<void>;
  disconnect: () => void;
  refreshProxyState: () => Promise<void>;
  trackProxyPort: (port: number) => Promise<void>;
  untrackProxyPort: (port: number) => Promise<void>;
  sendControl: (ns: string, action: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<Response>;
  sendData: (ns: string, action: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<Response>;
  fireData: (ns: string, action: string, payload?: Record<string, unknown>) => void;
  onDataEvent: (handler: (message: Message) => void) => () => void;
}

const ConnectionContext = createContext<ConnectionContextType | null>(null);
let hasLoggedMissingConnectionProvider = false;

const unavailableConnectionError = () => new Error('Connection context unavailable during app bootstrap');

const fallbackConnectionContext: ConnectionContextType = {
  status: 'disconnected',
  sessionState: 'idle',
  sessionCode: null,
  cacheNamespace: null,
  syncGeneration: 0,
  capabilities: null,
  error: 'Connection unavailable',
  isReconnecting: false,
  interactionBlockReason: null,
  trackedProxyPorts: [],
  discoveredProxyPorts: [],
  connect: async () => {
    throw unavailableConnectionError();
  },
  resumeSession: async () => {
    throw unavailableConnectionError();
  },
  getStoredSession: async () => null,
  getPairedSessions: async () => [],
  revokePairedSession: async () => {
    throw unavailableConnectionError();
  },
  removePairedSession: async () => {
    throw unavailableConnectionError();
  },
  clearStoredSession: async () => {},
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

function describeWebSocketErrorEvent(event: unknown): Record<string, unknown> {
  if (typeof event !== 'object' || event === null) {
    return { raw: String(event) };
  }

  const candidate = event as {
    message?: unknown;
    type?: unknown;
    target?: unknown;
    nativeEvent?: {
      message?: unknown;
      code?: unknown;
      reason?: unknown;
      type?: unknown;
    };
  };

  return {
    type: typeof candidate.type === 'string' ? candidate.type : null,
    message: typeof candidate.message === 'string' ? candidate.message : null,
    nativeMessage: typeof candidate.nativeEvent?.message === 'string' ? candidate.nativeEvent.message : null,
    nativeCode: typeof candidate.nativeEvent?.code === 'number' ? candidate.nativeEvent.code : null,
    nativeReason: typeof candidate.nativeEvent?.reason === 'string' ? candidate.nativeEvent.reason : null,
    nativeType: typeof candidate.nativeEvent?.type === 'string' ? candidate.nativeEvent.type : null,
    hasTarget: Boolean(candidate.target),
  };
}

function shouldLogRequest(ns: string, action: string): boolean {
  if (ns === 'fs' && action === 'ls') return false;
  return true;
}

function normalizeGateway(input: string): string {
  const raw = input.trim();
  if (!raw) return DEFAULT_GATEWAY;

  const lower = raw.toLowerCase();
  if (lower.startsWith('ws://') || lower.startsWith('http://')) {
    throw new Error('Insecure gateway protocol is not allowed; use wss:// or https://');
  }

  const asWss = lower.startsWith('https://')
    ? `wss://${raw.slice(8)}`
    : lower.startsWith('wss://')
      ? raw
      : `wss://${raw}`;

  try {
    const url = new URL(asWss);
    if (url.protocol !== 'wss:') {
      throw new Error('invalid protocol');
    }
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    throw new Error('Invalid gateway URL');
  }
}

function parseConnectPayload(value: string): { code: string } {
  const raw = value.trim();
  if (!raw) return { code: '' };

  const parts = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const code = parts[parts.length - 1];
    return { code };
  }

  // Support URL payloads, e.g. lunel://connect?code=ABC or https://.../ABC
  try {
    const url = new URL(raw);
    const queryCode = url.searchParams.get('code')?.trim();
    if (queryCode) return { code: queryCode };

    const pathCode = url.pathname.split('/').filter(Boolean).pop()?.trim();
    if (pathCode) return { code: pathCode };
  } catch {
    // ignore URL parsing failures and continue with fallback parsing
  }

  // Support plain text containing "...code=ABC..."
  const queryMatch = raw.match(/(?:^|[?&#,\s])code=([^&#,\s]+)/i);
  if (queryMatch?.[1]) {
    return { code: decodeURIComponent(queryMatch[1]).trim() };
  }

  return { code: raw };
}

function toTerminalSessionState(state?: string, reason?: string): SessionState {
  if (state === 'expired') return 'expired';
  if (state === 'ended') return 'ended';
  return (reason || '').toLowerCase().includes('expired') ? 'expired' : 'ended';
}

function isTerminalReconnectMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('reattach unavailable') ||
    normalized.includes('password invalid') ||
    normalized.includes('session not found') ||
    normalized.includes('revoked') ||
    normalized.includes('expired')
  );
}

function isTerminalReconnectError(error: unknown): boolean {
  if (error instanceof ProxyLookupError) {
    return error.status === 401 || error.status === 403 || error.status === 404 || error.status === 410;
  }
  return isTerminalReconnectMessage(error instanceof Error ? error.message : String(error));
}

function hashCacheNamespace(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getSessionCacheNamespace(sessionPassword: string, sessionCode: string | null): string {
  const codePart = (sessionCode?.trim() || 'no-code').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${codePart}:${hashCacheNamespace(sessionPassword)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ============================================================================
// Provider
// ============================================================================

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [sessionCode, setSessionCode] = useState<string | null>(null);
  const [cacheNamespace, setCacheNamespace] = useState<string | null>(null);
  const [syncGeneration, setSyncGeneration] = useState(0);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [interactionBlockReason, setInteractionBlockReason] = useState<'offline' | 'reconnecting' | null>(null);
  const [trackedProxyPorts, setTrackedProxyPorts] = useState<number[]>([]);
  const [discoveredProxyPorts, setDiscoveredProxyPorts] = useState<number[]>([]);

  const v2TransportRef = useRef<V2SessionTransport | null>(null);
  const connectionGenerationRef = useRef(0);
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());
  const dataEventHandlersRef = useRef<Set<(message: Message) => void>>(new Set());
  const messageIdRef = useRef(0);

  const sessionCodeRef = useRef<string | null>(null);
  const sessionPasswordRef = useRef<string | null>(null);
  const managerSessionIdRef = useRef<string | null>(null);
  const gatewaysRef = useRef<string[]>([DEFAULT_GATEWAY]);
  const activeGatewayRef = useRef<string>(DEFAULT_GATEWAY);
  const reattachGenerationRef = useRef<number | null>(null);
  const sendControlRef = useRef<((ns: string, action: string, payload?: Record<string, unknown>) => Promise<Response>) | null>(null);
  const reconnectWithPasswordRef = useRef<(() => Promise<{ ok: boolean; terminal: boolean; message?: string }>) | null>(null);
  const runReconnectLoopRef = useRef<((source: 'app_active' | 'network_restored' | 'transport_closed') => Promise<void>) | null>(null);
  const manualDisconnectRef = useRef(false);
  const reconnectingRef = useRef(false);
  const reconnectLoopActiveRef = useRef(false);
  const networkReachableRef = useRef(true);
  const appStateRef = useRef(AppState.currentState);
  const reconnectAttemptRef = useRef(0);
  const reconnectRunIdRef = useRef(0);
  const discoveredPortsRef = useRef<number[]>([]);
  const trackedPortsRef = useRef<number[]>([]);
  const statusRef = useRef<ConnectionStatus>(status);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const setReconnectUiState = useCallback((reason: 'offline' | 'reconnecting' | null) => {
    setInteractionBlockReason(reason);
    setIsReconnecting(reason !== null);
    if (reason === 'offline') {
      setStatus((current) => current === 'connected' ? 'connected' : 'connecting');
      setError('Waiting for internet connection...');
      return;
    }
    if (reason === 'reconnecting') {
      setStatus((current) => current === 'connected' ? 'connected' : 'connecting');
      setError(null);
    }
  }, []);

  const persistPairedSessions = useCallback(async (sessions: PairedSession[]): Promise<void> => {
    const raw = JSON.stringify(sessions);
    logger.info('connection', 'persisting paired sessions', {
      count: sessions.length,
      payloadBytes: raw.length,
      hosts: sessions.map((session) => session.hostname),
      roots: sessions.map((session) => session.root),
    });
    try {
      await SecureStore.setItemAsync(PAIRED_SESSIONS_STORAGE_KEY, raw);
      logger.info('connection', 'paired sessions persisted to secure store', {
        key: PAIRED_SESSIONS_STORAGE_KEY,
        count: sessions.length,
      });
    } catch (error) {
      logger.warn('connection', 'failed to persist paired sessions to secure store', {
        key: PAIRED_SESSIONS_STORAGE_KEY,
        payloadBytes: raw.length,
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack ?? null,
        } : String(error),
      });
      throw error;
    }
  }, []);

  const getPairedSessions = useCallback(async (): Promise<PairedSession[]> => {
    try {
      const secureRaw = await SecureStore.getItemAsync(PAIRED_SESSIONS_STORAGE_KEY);
      logger.info('connection', 'loading paired sessions', {
        source: secureRaw ? 'secure_store' : 'none',
        securePresent: Boolean(secureRaw),
      });
      const raw = secureRaw;
      if (!raw) return [];
      const parsed = JSON.parse(raw) as PairedSession[];
      if (!Array.isArray(parsed)) return [];
      const filtered = parsed.filter((entry) => (
        entry &&
        typeof entry.sessionPassword === 'string' &&
        typeof entry.hostname === 'string' &&
        typeof entry.root === 'string'
      )).map((entry) => ({
        ...entry,
        gateways: Array.isArray(entry.gateways) ? entry.gateways : [],
      }));
      logger.info('connection', 'paired sessions loaded', {
        count: filtered.length,
        hosts: filtered.map((session) => session.hostname),
        roots: filtered.map((session) => session.root),
      });
      return filtered;
    } catch (error) {
      logger.warn('connection', 'failed to load paired sessions', {
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack ?? null,
        } : String(error),
      });
      return [];
    }
  }, []);

  const removePairedSession = useCallback(async (secret: string): Promise<void> => {
    const existing = await getPairedSessions();
    await persistPairedSessions(existing.filter((entry) => entry.sessionPassword !== secret));
  }, [getPairedSessions, persistPairedSessions]);

  const revokePairedSession = useCallback(async (secret: string): Promise<void> => {
    const response = await fetch(new URL('/v2/revoke', MANAGER_URL).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: secret,
        reason: 'revoked from app auth screen',
      }),
    });

    if (response.ok || response.status === 404) {
      return;
    }

    let message = `failed to revoke paired session (${response.status})`;
    try {
      const body = await response.json() as { error?: string; reason?: string };
      if (body.error) {
        message = body.error;
      } else if (body.reason) {
        message = body.reason;
      }
    } catch {
      // ignore json parse failures and use fallback message
    }
    throw new Error(message);
  }, []);

  const savePairedSession = useCallback(async (
    session: StoredSession,
    capabilitiesValue: Pick<Capabilities, 'hostname' | 'rootDir'>
  ): Promise<void> => {
    const existing = await getPairedSessions();
    const previous = existing.find((entry) => entry.sessionPassword === session.sessionPassword);
    const next: PairedSession = {
      sessionCode: session.sessionCode,
      sessionPassword: session.sessionPassword,
      managerSessionId: session.managerSessionId ?? null,
      gateways: session.gateways,
      savedAt: session.savedAt,
      hostname: capabilitiesValue.hostname,
      root: capabilitiesValue.rootDir,
      phoneId: previous?.phoneId || '',
      pairedAt: previous?.pairedAt || session.savedAt,
      lastUsedAt: session.savedAt,
    };
    const deduped = existing.filter((entry) => entry.sessionPassword !== session.sessionPassword);
    deduped.unshift(next);
    await persistPairedSessions(deduped.slice(0, 50));
  }, [getPairedSessions, persistPairedSessions]);

  const saveStoredSession = useCallback(async (session: StoredSession): Promise<void> => {
    const raw = JSON.stringify(session);
    try {
      await SecureStore.setItemAsync(LAST_SESSION_STORAGE_KEY, raw);
      await AsyncStorage.removeItem(LAST_SESSION_FALLBACK_STORAGE_KEY);
    } catch (error) {
      logger.warn('connection', 'failed to persist last session to secure store', {
        error: error instanceof Error ? error.message : String(error),
      });
      await AsyncStorage.setItem(LAST_SESSION_FALLBACK_STORAGE_KEY, raw);
    }
  }, []);

  const getStoredSession = useCallback(async (): Promise<StoredSession | null> => {
    try {
      const secureRaw = await SecureStore.getItemAsync(LAST_SESSION_STORAGE_KEY);
      const fallbackRaw = secureRaw ? null : await AsyncStorage.getItem(LAST_SESSION_FALLBACK_STORAGE_KEY);
      const raw = secureRaw || fallbackRaw;
      if (!raw) return null;

      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      if (typeof parsed.sessionPassword !== 'string' || !parsed.sessionPassword) {
        return null;
      }

      return {
        sessionCode: typeof parsed.sessionCode === 'string' ? parsed.sessionCode : null,
        sessionPassword: parsed.sessionPassword,
        managerSessionId: typeof parsed.managerSessionId === 'string' ? parsed.managerSessionId : null,
        gateways: Array.isArray(parsed.gateways)
          ? parsed.gateways.filter((gateway): gateway is string => typeof gateway === 'string' && gateway.length > 0)
          : [],
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
      };
    } catch (error) {
      logger.warn('connection', 'failed to load last stored session', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }, []);

  const clearStoredSession = useCallback(async (): Promise<void> => {
    try {
      await SecureStore.deleteItemAsync(LAST_SESSION_STORAGE_KEY);
    } catch {
      // best effort
    }
    try {
      await AsyncStorage.removeItem(LAST_SESSION_FALLBACK_STORAGE_KEY);
    } catch {
      // best effort
    }
  }, []);

  const generateId = useCallback(() => {
    messageIdRef.current += 1;
    return `msg-${Date.now()}-${messageIdRef.current}`;
  }, []);

  const sendMessageV2 = useCallback((
    ns: string,
    action: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 30000,
  ): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const transport = v2TransportRef.current;
      if (!transport) {
        reject(new Error('Transport not connected'));
        return;
      }

      const id = generateId();
      const message: Message = { v: 1, id, ns, action, payload };
      const startedAt = Date.now();
      const path = typeof payload.path === 'string' ? payload.path : null;

      if (shouldLogRequest(ns, action)) {
        logger.info('connection', 'sending request', {
          id,
          ns,
          action,
          channel: 'v2',
          path,
          timeoutMs,
        });
      }

      const timeout = setTimeout(() => {
        pendingRequestsRef.current.delete(id);
        logger.error('connection', 'request timed out', {
          id,
          ns,
          action,
          path,
          durationMs: Date.now() - startedAt,
          timeoutMs,
        });
        reject(new Error(`Request timeout: ${ns}.${action}`));
      }, timeoutMs);

      pendingRequestsRef.current.set(id, { resolve, reject, timeout, startedAt, ns, action, path });

      transport.sendMessage(message).catch((error) => {
        clearTimeout(timeout);
        pendingRequestsRef.current.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }, [generateId]);

  const sendPlaintextSystemRequestV2 = useCallback((
    action: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 30000,
  ): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const transport = v2TransportRef.current;
      if (!transport) {
        reject(new Error('Transport not connected'));
        return;
      }

      const id = generateId();
      const message: Message = { v: 1, id, ns: 'system', action, payload };
      const startedAt = Date.now();

      logger.info('connection', 'sending plaintext system request', {
        id,
        action,
        channel: 'v2',
        timeoutMs,
      });

      const timeout = setTimeout(() => {
        pendingRequestsRef.current.delete(id);
        reject(new Error(`Request timeout: system.${action}`));
      }, timeoutMs);

      pendingRequestsRef.current.set(id, {
        resolve,
        reject,
        timeout,
        startedAt,
        ns: 'system',
        action,
        path: null,
      });

      try {
        transport.sendPlaintextRequest(message);
      } catch (error) {
        clearTimeout(timeout);
        pendingRequestsRef.current.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }, [generateId]);

  const sendControl = useCallback((ns: string, action: string, payload?: Record<string, unknown>, timeoutMs?: number) => {
    return sendMessageV2(ns, action, payload, timeoutMs);
  }, [sendMessageV2]);

  sendControlRef.current = sendControl;

  const sendData = useCallback((ns: string, action: string, payload?: Record<string, unknown>, timeoutMs?: number) => {
    return sendMessageV2(ns, action, payload, timeoutMs);
  }, [sendMessageV2]);

  const fireData = useCallback((ns: string, action: string, payload: Record<string, unknown> = {}) => {
    const transport = v2TransportRef.current;
    if (!transport) return;
    const id = generateId();
    const message: Message = { v: 1, id, ns, action, payload };
    transport.sendEvent(message).catch((err) =>
      logger.error('connection', 'fireData send failed', {
        error: err instanceof Error ? err.message : String(err),
        ns,
        action,
      }),
    );
  }, [generateId]);

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

  const applyProxyState = useCallback((trackedPorts: number[], openPorts: number[]) => {
    const nextTrackedPorts = [...trackedPorts].sort((a, b) => a - b);
    const nextOpenPorts = [...openPorts].sort((a, b) => a - b);
    trackedPortsRef.current = nextTrackedPorts;
    discoveredPortsRef.current = nextOpenPorts;
    setTrackedProxyPorts(nextTrackedPorts);
    setDiscoveredProxyPorts(nextOpenPorts);

    logger.info('connection', 'applied proxy state', {
      trackedPorts: nextTrackedPorts,
      openPorts: nextOpenPorts,
      appState: AppState.currentState,
      status,
    });

    if (AppState.currentState === 'active' && status === 'connected') {
      startPortServers(nextOpenPorts);
    }
  }, [status]);

  const refreshProxyState = useCallback(async () => {
    const response = await sendControl('proxy', 'getState');
    const trackedPorts = Array.isArray(response.payload?.trackedPorts)
      ? response.payload.trackedPorts.filter((value): value is number => typeof value === 'number')
      : [];
    const openPorts = Array.isArray(response.payload?.openPorts)
      ? response.payload.openPorts.filter((value): value is number => typeof value === 'number')
      : [];
    applyProxyState(trackedPorts, openPorts);
  }, [applyProxyState, sendControl]);

  const trackProxyPort = useCallback(async (port: number) => {
    const response = await sendControl('proxy', 'trackPort', { port });
    const trackedPorts = Array.isArray(response.payload?.trackedPorts)
      ? response.payload.trackedPorts.filter((value): value is number => typeof value === 'number')
      : [];
    const openPorts = Array.isArray(response.payload?.openPorts)
      ? response.payload.openPorts.filter((value): value is number => typeof value === 'number')
      : [];
    applyProxyState(trackedPorts, openPorts);
  }, [applyProxyState, sendControl]);

  const untrackProxyPort = useCallback(async (port: number) => {
    const response = await sendControl('proxy', 'untrackPort', { port });
    const trackedPorts = Array.isArray(response.payload?.trackedPorts)
      ? response.payload.trackedPorts.filter((value): value is number => typeof value === 'number')
      : [];
    const openPorts = Array.isArray(response.payload?.openPorts)
      ? response.payload.openPorts.filter((value): value is number => typeof value === 'number')
      : [];
    applyProxyState(trackedPorts, openPorts);
  }, [applyProxyState, sendControl]);

  const connectToGatewayV2 = useCallback(async (
    gateway: string,
    options?: { sessionPassword?: string | null; sessionCode?: string | null; generation?: number | null }
  ): Promise<void> => {
    const generation = ++connectionGenerationRef.current;
    const wsPassword = options?.sessionPassword ?? sessionPasswordRef.current;
    logger.info('connection', 'connecting to gateway via v2 transport', {
      gateway,
      generation,
      hasSessionPassword: Boolean(wsPassword),
      hasSessionCode: Boolean(options?.sessionCode ?? sessionCodeRef.current),
    });

    if (!wsPassword) {
      throw new Error('No password available');
    }

    const transport = new V2SessionTransport({
      gatewayUrl: gateway,
      password: wsPassword,
      sessionSecret: wsPassword,
      generation: options?.generation ?? reattachGenerationRef.current,
      role: 'app',
      debugLog: (message, ...args) => logger.info('connection', message, {
        args: args.map((value) => {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value == null) {
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
          if (generation !== connectionGenerationRef.current || v2TransportRef.current !== transport) return;
          if (message.type === 'connected') return;

          if (message.type === 'peer_connected') {
            logger.info('connection', 'peer connected', { peer: message.peer ?? null, channel: 'v2' });
            setSessionState((current) => current === 'cli_offline_grace' ? 'pending' : current);
            setError(null);
            setSyncGeneration((current) => current + 1);
            logger.info('connection', 'evaluating proxy configuration on peer connect', {
              hasSessionCode: Boolean(sessionCodeRef.current),
              hasSessionPassword: Boolean(sessionPasswordRef.current),
              gateway: activeGatewayRef.current,
              gatewayCount: gatewaysRef.current.length,
              hasSendControl: Boolean(sendControlRef.current),
            });
            if (sessionCodeRef.current && sendControlRef.current) {
              configureProxy(
                activeGatewayRef.current,
                sessionCodeRef.current,
                sessionPasswordRef.current,
                gatewaysRef.current,
                sendControlRef.current,
              );
              logger.info('connection', 'proxy configured on peer connect', {
                gateway: activeGatewayRef.current,
                hasSessionCode: Boolean(sessionCodeRef.current),
                hasSessionPassword: Boolean(sessionPasswordRef.current),
              });
            } else {
              logger.warn('connection', 'proxy not configured on peer connect', {
                reason: !sessionCodeRef.current ? 'missing_session_code' : 'missing_send_control',
                hasSessionCode: Boolean(sessionCodeRef.current),
                hasSessionPassword: Boolean(sessionPasswordRef.current),
                hasSendControl: Boolean(sendControlRef.current),
              });
            }
            return;
          }

          if (message.type === 'cli_reconnecting') {
            logger.warn('connection', 'cli reconnecting', {
              reconnectDeadline: message.reconnectDeadline ?? null,
            });
            setSessionState('cli_offline_grace');
            setStatus('connected');
            setError('CLI is having some issues. Trying to reconnect...');
            return;
          }

          if (message.type === 'peer_disconnected') {
            logger.warn('connection', 'peer disconnected', { peer: message.peer ?? null });
            stopAllServers();
            if (message.peer === 'cli') setSessionState('cli_offline_grace');
            setStatus('connected');
            setError(message.peer === 'cli' ? 'CLI is having some issues. Trying to reconnect...' : 'Peer disconnected');
            return;
          }

          if (message.type === 'close_connection') {
            logger.warn('connection', 'connection closed by gateway', {
              reason: message.reason || 'Session expired',
            });
            stopAllServers();
            setSessionState((message.reason || '').toLowerCase().includes('expired') ? 'expired' : 'ended');
            setStatus('error');
            setError(message.reason || 'Session expired');
            if ((message.reason || '').includes('ended') || (message.reason || '').includes('expired')) {
              void clearStoredSession();
            }
          }
        },
        onProtocolRequest: async () => ({
          v: 1,
          id: generateId(),
          ns: 'system',
          action: 'unsupported',
          ok: false,
          payload: {},
          error: {
            code: 'EUNSUPPORTED',
            message: 'App does not serve protocol requests',
          },
        }),
        onProtocolResponse: async (response) => {
          if (generation !== connectionGenerationRef.current || v2TransportRef.current !== transport) return;
          const pending = pendingRequestsRef.current.get(response.id);
          if (pending) {
            clearTimeout(pending.timeout);
            pendingRequestsRef.current.delete(response.id);
            if (shouldLogRequest(pending.ns, pending.action)) {
              logger.info('connection', 'received response', {
                id: response.id,
                ns: pending.ns,
                action: pending.action,
                path: pending.path,
                ok: response.ok,
                durationMs: Date.now() - pending.startedAt,
                errorCode: response.error?.code ?? null,
              });
            }
            pending.resolve(response);
            return;
          }

        },
        onProtocolEvent: async (message) => {
          if (generation !== connectionGenerationRef.current || v2TransportRef.current !== transport) return;
          if (message.ns === 'proxy' && message.action === 'ports_discovered') {
            const ports = message.payload?.ports as number[];
            if (Array.isArray(ports)) {
              discoveredPortsRef.current = ports;
              setDiscoveredProxyPorts(ports);
              logger.info('connection', 'received proxy ports', { ports });
              if (AppState.currentState === 'active') {
                logger.info('connection', 'starting localhost proxy servers from discovered ports', {
                  ports,
                  appState: AppState.currentState,
                });
                startPortServers(ports);
              } else {
                logger.info('connection', 'deferring localhost proxy server start until app active', {
                  ports,
                  appState: AppState.currentState,
                });
              }
            }
            return;
          }

          for (const handler of dataEventHandlersRef.current) {
            handler(message);
          }
        },
        onClose: (reason) => {
          if (generation !== connectionGenerationRef.current || v2TransportRef.current !== transport) return;
          logger.warn('connection', 'v2 transport closed', {
            gateway,
            generation,
            reason,
          });
          v2TransportRef.current = null;
          if (manualDisconnectRef.current || reconnectingRef.current) return;
          void runReconnectLoopRef.current?.('transport_closed');
        },
      },
    });

    v2TransportRef.current = transport;
    activeGatewayRef.current = gateway;
    await transport.connect();
    if (generation !== connectionGenerationRef.current || v2TransportRef.current !== transport) {
      transport.close();
      return;
    }

    logger.info('connection', 'requesting capabilities over v2');
    const response = await sendMessageV2('system', 'capabilities');
    if (generation !== connectionGenerationRef.current || v2TransportRef.current !== transport) {
      transport.close();
      return;
    }
    if (!response.ok) {
      throw new Error(response.error?.message || 'Failed to get capabilities');
    }

    setCapabilities(response.payload as unknown as Capabilities);
    setSessionState('active');
    setStatus('connected');
    setError(null);
    setInteractionBlockReason(null);
    setIsReconnecting(false);
    networkReachableRef.current = true;
    setSyncGeneration((current) => current + 1);

    if (sessionPasswordRef.current) {
      await saveStoredSession({
        sessionCode: sessionCodeRef.current,
        sessionPassword: sessionPasswordRef.current,
        managerSessionId: managerSessionIdRef.current,
        gateways: gatewaysRef.current,
        savedAt: Date.now(),
      });

      try {
        await savePairedSession({
          sessionCode: sessionCodeRef.current,
          sessionPassword: sessionPasswordRef.current,
          managerSessionId: managerSessionIdRef.current,
          gateways: gatewaysRef.current,
          savedAt: Date.now(),
        }, {
          hostname: String((response.payload as Record<string, unknown>).hostname ?? ''),
          rootDir: String((response.payload as Record<string, unknown>).rootDir ?? ''),
        });
      } catch (error) {
        logger.warn('connection', 'failed to persist paired session', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, [clearStoredSession, generateId, savePairedSession, saveStoredSession, sendMessageV2]);

  const assembleWithCode = useCallback(async (code: string): Promise<AssembleResult> => {
    const wsUrl = `${MANAGER_URL.replace(/^https:/, 'wss:')}/v2/assemble?code=${encodeURIComponent(code)}&role=app`;
    const healthUrl = new URL('/health', MANAGER_URL).toString();

    try {
      logger.info('connection', 'probing manager health before assemble websocket', {
        code,
        healthUrl,
      });
      const healthProbe = await Promise.race<ManagerHealthProbeResult>([
        (async () => {
          const response = await fetch(healthUrl, {
            method: 'GET',
            headers: { Accept: 'application/json,text/plain,*/*' },
          });
          const body = await response.text().catch(() => null);
          return {
            ok: response.ok,
            status: response.status,
            body: body ? body.slice(0, 200) : null,
          };
        })(),
        new Promise<ManagerHealthProbeResult>((resolve) => {
          setTimeout(() => resolve({
            ok: false,
            status: null,
            body: 'timeout',
          }), 5000);
        }),
      ]);
      logger.info('connection', 'manager health probe completed', {
        code,
        healthUrl,
        ok: healthProbe.ok,
        status: healthProbe.status,
        bodyPreview: healthProbe.body,
      });
    } catch (error) {
      logger.warn('connection', 'manager health probe failed before assemble websocket', {
        code,
        healthUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return await new Promise<AssembleResult>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        logger.warn('connection', 'assemble websocket failed', {
          code,
          wsUrl,
          error: error.message,
        });
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(error);
      };

      ws.onopen = () => {
        logger.info('connection', 'assemble websocket opened', {
          code,
          wsUrl,
        });
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as { type?: string; code?: string; password?: string; sessionId?: string };
          logger.info('connection', 'assemble websocket message received', {
            code,
            wsUrl,
            type: parsed.type ?? null,
            hasAssembledCode: typeof parsed.code === 'string',
            hasPassword: typeof parsed.password === 'string',
          });
          if (parsed.type !== 'assembled' || typeof parsed.code !== 'string' || typeof parsed.password !== 'string') {
            fail(new Error('Invalid assemble payload'));
            return;
          }
          if (settled) return;
          settled = true;
          ws.send(JSON.stringify({ type: 'ack' }));
          logger.info('connection', 'assemble websocket completed', {
            code,
            wsUrl,
            assembledCode: parsed.code,
          });
          resolve({
            code: parsed.code,
            password: parsed.password,
            sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
          });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };

      ws.onerror = (event) => {
        logger.warn('connection', 'assemble websocket error event', {
          code,
          wsUrl,
          ...describeWebSocketErrorEvent(event),
        });
        fail(new Error('Assemble socket error'));
      };

      ws.onclose = (event) => {
        if (settled) return;
        logger.warn('connection', 'assemble websocket closed before completion', {
          code,
          wsUrl,
          closeCode: typeof event.code === 'number' ? event.code : null,
          closeReason: typeof event.reason === 'string' ? event.reason : null,
          wasClean: typeof event.wasClean === 'boolean' ? event.wasClean : null,
        });
        fail(new Error(`Assemble socket closed (${event.code})`));
      };
    });
  }, []);

  const getAssignedProxyUrl = useCallback(async (password: string): Promise<string> => {
    const url = new URL('/v2/proxy', MANAGER_URL);
    url.searchParams.set('password', password);
    const res = await fetch(url.toString());
    if (!res.ok) {
      let message = `Proxy lookup failed (${res.status})`;
      try {
        const payload = await res.json() as { error?: string; reason?: string };
        if (payload.error) {
          message = payload.error;
        } else if (payload.reason) {
          message = payload.reason;
        }
      } catch {
        // ignore json parse failures and use fallback message
      }
      throw new ProxyLookupError(message, res.status);
    }
    const payload = await res.json() as { proxyUrl?: string };
    if (typeof payload.proxyUrl !== 'string' || !payload.proxyUrl) {
      throw new Error('Invalid proxy lookup response');
    }
    return normalizeGateway(payload.proxyUrl);
  }, []);

  const claimReattach = useCallback(async (password: string): Promise<ReattachClaimResult> => {
    const response = await fetch(new URL('/v2/reattach/claim', MANAGER_URL).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password,
        role: 'app',
      }),
    });
    if (!response.ok) {
      let message = `Reattach failed (${response.status})`;
      try {
        const payload = await response.json() as { error?: string; reason?: string };
        if (payload.error) {
          message = payload.error;
        } else if (payload.reason) {
          message = payload.reason;
        }
      } catch {
        // ignore json parse failures and use fallback message
      }
      throw new ProxyLookupError(message, response.status);
    }
    const payload = await response.json() as { proxyUrl?: string; generation?: number; expiresAt?: number };
    if (typeof payload.proxyUrl !== 'string' || !payload.proxyUrl) {
      throw new Error('Invalid reattach proxy response');
    }
    if (typeof payload.generation !== 'number' || !Number.isFinite(payload.generation) || payload.generation < 1) {
      throw new Error('Invalid reattach generation');
    }
    if (typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)) {
      throw new Error('Invalid reattach expiry');
    }
    return {
      proxyUrl: normalizeGateway(payload.proxyUrl),
      generation: payload.generation,
      expiresAt: payload.expiresAt,
    };
  }, []);

  const reconnectWithPassword = useCallback(async (): Promise<{ ok: boolean; terminal: boolean; message?: string }> => {
    if (manualDisconnectRef.current) {
      logger.info('connection', 'reconnect skipped after manual disconnect');
      return { ok: false, terminal: true, message: 'Disconnected' };
    }

    if (!sessionPasswordRef.current) {
      logger.info('connection', 'reconnect skipped: no session password in memory');
      return { ok: false, terminal: true, message: 'No in-memory session to reconnect' };
    }

    try {
      const reattach = await claimReattach(sessionPasswordRef.current);
      gatewaysRef.current = [reattach.proxyUrl];
      reattachGenerationRef.current = reattach.generation;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Session not found or expired';
      logger.error('connection', 'manager proxy lookup failed', { error: msg });
      return {
        ok: false,
        terminal: isTerminalReconnectError(err),
        message: msg,
      };
    }

    const gateway = gatewaysRef.current[0] || DEFAULT_GATEWAY;
    try {
      logger.info('connection', 'reconnect attempt starting', {
        gateway,
        attempt: reconnectAttemptRef.current,
      });
      if (manualDisconnectRef.current) {
        logger.info('connection', 'reconnect aborted due to manual disconnect');
        return { ok: false, terminal: true, message: 'Disconnected' };
      }
      await connectToGatewayV2(gateway, {
        sessionPassword: sessionPasswordRef.current,
        sessionCode: sessionCodeRef.current,
        generation: reattachGenerationRef.current,
      });
      reconnectAttemptRef.current = 0;
      logger.info('connection', 'reconnect succeeded', { gateway });
      return { ok: true, terminal: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('connection', 'reconnect attempt failed', {
        gateway,
        error: message,
      });
      return {
        ok: false,
        terminal: isTerminalReconnectError(err),
        message,
      };
    }
  }, [claimReattach, connectToGatewayV2]);

  reconnectWithPasswordRef.current = reconnectWithPassword;

  const runReconnectLoop = useCallback(async (source: 'app_active' | 'network_restored' | 'transport_closed') => {
    if (manualDisconnectRef.current || reconnectLoopActiveRef.current) {
      return;
    }
    if (!sessionPasswordRef.current) {
      logger.info('connection', 'reconnect loop skipped: no in-memory session', { source });
      return;
    }

    const runId = ++reconnectRunIdRef.current;
    reconnectLoopActiveRef.current = true;
    reconnectingRef.current = true;

    try {
      while (
        runId === reconnectRunIdRef.current &&
        !manualDisconnectRef.current &&
        sessionPasswordRef.current &&
        reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS
      ) {
        if (appStateRef.current !== 'active') {
          logger.info('connection', 'reconnect loop paused while app is backgrounded', {
            source,
            attempt: reconnectAttemptRef.current,
          });
          return;
        }

        if (!networkReachableRef.current) {
          logger.info('connection', 'reconnect loop paused while offline', { source });
          setReconnectUiState('offline');
          return;
        }

        setReconnectUiState('reconnecting');
        clearPendingRequests('Reconnecting');

        const attempt = reconnectAttemptRef.current + 1;
        reconnectAttemptRef.current = attempt;
        const result = await reconnectWithPasswordRef.current!();
        if (runId !== reconnectRunIdRef.current || manualDisconnectRef.current) {
          return;
        }

        if (result.ok) {
          reconnectAttemptRef.current = 0;
          setReconnectUiState(null);
          return;
        }

        if (result.terminal) {
          const message = result.message || 'Session expired';
          setReconnectUiState(null);
          setSessionState(toTerminalSessionState(undefined, message));
          setStatus('error');
          setError(message);
          return;
        }

        if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
          logger.error('connection', 'reconnect window exhausted', {
            source,
            attempts: reconnectAttemptRef.current,
            message: result.message ?? null,
          });
          setReconnectUiState(null);
          setStatus('error');
          setSessionState('ended');
          setError(result.message || 'Automatic reconnect failed');
          return;
        }

        const baseDelay = Math.min(500 * 2 ** Math.min(reconnectAttemptRef.current - 1, 5), 5_000);
        await delay(baseDelay);
      }
    } finally {
      if (runId === reconnectRunIdRef.current) {
        reconnectLoopActiveRef.current = false;
        reconnectingRef.current = false;
      }
      if (runId === reconnectRunIdRef.current && networkReachableRef.current) {
        setIsReconnecting(false);
      }
    }
  }, [clearPendingRequests, setReconnectUiState]);

  runReconnectLoopRef.current = runReconnectLoop;

  const handleConnectivityLost = useCallback(() => {
    if (manualDisconnectRef.current || !sessionPasswordRef.current) {
      return;
    }
    if (!networkReachableRef.current && interactionBlockReason === 'offline') {
      return;
    }

    if (statusRef.current === 'connected' && v2TransportRef.current) {
      logger.warn('connection', 'manager health probe failed while transport is connected; keeping active transport');
      return;
    }

    logger.warn('connection', 'manager reachability lost; entering offline state');
    networkReachableRef.current = false;
    reconnectRunIdRef.current += 1;
    reconnectLoopActiveRef.current = false;
    reconnectingRef.current = false;
    clearPendingRequests('Offline');
    stopAllServers();
    v2TransportRef.current?.close();
    v2TransportRef.current = null;
    setReconnectUiState('offline');
  }, [clearPendingRequests, interactionBlockReason, setReconnectUiState]);

  const handleConnectivityRestored = useCallback(() => {
    if (networkReachableRef.current) {
      return;
    }

    logger.info('connection', 'manager reachability restored');
    networkReachableRef.current = true;
    if (!manualDisconnectRef.current && sessionPasswordRef.current) {
      void runReconnectLoop('network_restored');
    }
  }, [runReconnectLoop]);

  const cleanupSockets = useCallback((clearState: boolean) => {
    logger.info('connection', 'cleaning up sockets', { clearState });
    v2TransportRef.current?.close();
    v2TransportRef.current = null;
    stopAllServers();

    if (clearState) {
      reconnectRunIdRef.current += 1;
      reconnectLoopActiveRef.current = false;
      networkReachableRef.current = true;
      setIsReconnecting(false);
      setInteractionBlockReason(null);
      setStatus('disconnected');
      setSessionState('idle');
      setSessionCode(null);
      setCacheNamespace(null);
      sessionCodeRef.current = null;
      sessionPasswordRef.current = null;
      managerSessionIdRef.current = null;
      reattachGenerationRef.current = null;
      gatewaysRef.current = [DEFAULT_GATEWAY];
      activeGatewayRef.current = DEFAULT_GATEWAY;
      discoveredPortsRef.current = [];
      trackedPortsRef.current = [];
      setTrackedProxyPorts([]);
      setDiscoveredProxyPorts([]);
      setCapabilities(null);
      setError(null);
      clearPendingRequests('Disconnected');
    }
  }, [clearPendingRequests]);

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true;
    setIsReconnecting(false);
    logger.info('connection', 'manual disconnect requested');
    cleanupSockets(true);
  }, [cleanupSockets]);

  const endSession = useCallback(async () => {
    logger.info('connection', 'ending session');
    try {
      await sendPlaintextSystemRequestV2('end_session', {});
    } catch {
      // Best effort: caller can still perform local disconnect/navigation.
    }
    await clearStoredSession();
  }, [clearStoredSession, sendPlaintextSystemRequestV2]);

  const connect = useCallback(async (payload: string) => {
    logger.info('connection', 'connect requested', { payloadPreview: payload.trim().slice(0, 32) });
    manualDisconnectRef.current = false;
    reconnectRunIdRef.current += 1;
    reconnectingRef.current = false;
    reconnectLoopActiveRef.current = false;
    networkReachableRef.current = true;
    reconnectAttemptRef.current = 0;
    setCacheNamespace(null);
    setReconnectUiState(null);
    cleanupSockets(false);
    managerSessionIdRef.current = null;

    const parsed = parseConnectPayload(payload);
    if (!parsed.code) {
      logger.warn('connection', 'connect rejected due to invalid code');
      setSessionState('ended');
      setStatus('error');
      setError('Invalid connection code');
      throw new Error('Invalid connection code');
    }

    let assembled: AssembleResult;
    try {
      logger.info('connection', 'assembling session in manager', { code: parsed.code });
      assembled = await assembleWithCode(parsed.code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Manager assemble failed';
      logger.error('connection', 'manager assemble failed', { code: parsed.code, error: msg });
      setSessionState('ended');
      setStatus('error');
      setError(msg);
      throw new Error(msg);
    }

    setSessionState('pending');
    setStatus('connecting');
    setError(null);
    setSessionCode(parsed.code);

    sessionCodeRef.current = assembled.code;
    sessionPasswordRef.current = assembled.password;
    managerSessionIdRef.current = assembled.sessionId;
    setCacheNamespace(getSessionCacheNamespace(assembled.password, assembled.code));
    reattachGenerationRef.current = null;
    try {
      gatewaysRef.current = [await getAssignedProxyUrl(assembled.password)];
      logger.info('connection', 'resolved gateways', { gateways: gatewaysRef.current });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid gateway configuration';
      logger.error('connection', 'invalid gateway configuration', { error: msg });
      setSessionState('ended');
      setStatus('error');
      setError(msg);
      throw new Error(msg);
    }

    const gateway = gatewaysRef.current[0];
    try {
      await connectToGatewayV2(gateway, {
        sessionPassword: assembled.password,
        sessionCode: assembled.code,
      });
      return;
    } catch (err) {
      logger.warn('connection', 'gateway connection attempt failed', {
        gateway,
        error: err instanceof Error ? err.message : String(err),
      });
      const lastError = err instanceof Error ? err : new Error('Connection failed');
      logger.error('connection', 'connect failed', {
        error: lastError.message,
      });
      setSessionState('ended');
      setStatus('error');
      setError(lastError.message);
      throw lastError;
    }
  }, [assembleWithCode, cleanupSockets, connectToGatewayV2, getAssignedProxyUrl, setReconnectUiState]);

  const resumeSession = useCallback(async (stored: StoredSession) => {
    logger.info('connection', 'resume requested', {
      hasSessionCode: Boolean(stored?.sessionCode),
      gatewayCount: stored?.gateways?.length ?? 0,
    });
    manualDisconnectRef.current = false;
    reconnectRunIdRef.current += 1;
    reconnectingRef.current = false;
    reconnectLoopActiveRef.current = false;
    networkReachableRef.current = true;
    reconnectAttemptRef.current = 0;
    setCacheNamespace(null);
    setReconnectUiState(null);
    cleanupSockets(false);
    managerSessionIdRef.current = null;

    if (!stored?.sessionPassword) {
      logger.error('connection', 'resume rejected due to invalid stored session');
      setSessionState('ended');
      throw new Error('Invalid stored session');
    }

    setSessionState('pending');
    setStatus('connecting');
    setError(null);
    setSessionCode(stored.sessionCode || null);

    try {
      sessionCodeRef.current = stored.sessionCode || null;
      sessionPasswordRef.current = stored.sessionPassword;
      managerSessionIdRef.current = stored.managerSessionId || null;
      setCacheNamespace(getSessionCacheNamespace(stored.sessionPassword, stored.sessionCode || null));
      const reattach = await claimReattach(stored.sessionPassword);
      gatewaysRef.current = [reattach.proxyUrl];
      reattachGenerationRef.current = reattach.generation;
      logger.info('connection', 'resolved resume gateways', { gateways: gatewaysRef.current });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resume failed';
      logger.error('connection', 'manager proxy lookup failed', { error: msg });
      if (isTerminalReconnectError(err)) {
        setSessionState(err instanceof ProxyLookupError && err.status === 404 ? 'expired' : 'ended');
        setStatus('error');
        setError(msg);
        throw (err instanceof Error ? err : new Error(msg));
      }

      setReconnectUiState('reconnecting');
      void runReconnectLoop('app_active');
      return;
    }

    const gateway = gatewaysRef.current[0];
    try {
      await connectToGatewayV2(gateway, {
        sessionPassword: stored.sessionPassword,
        sessionCode: stored.sessionCode || null,
        generation: reattachGenerationRef.current,
      });
      return;
    } catch (err) {
      logger.warn('connection', 'resume gateway attempt failed', {
        gateway,
        error: err instanceof Error ? err.message : String(err),
      });
      const lastError = err instanceof Error ? err : new Error('Resume failed');
      if (isTerminalReconnectError(lastError)) {
        logger.error('connection', 'resume failed with terminal session error', {
          error: lastError.message,
        });
        setSessionState(toTerminalSessionState(undefined, lastError.message));
        setStatus('error');
        setError(lastError.message);
        throw lastError;
      }

      logger.warn('connection', 'resume failed transiently; entering bounded reconnect loop', {
        error: lastError.message,
      });
      setReconnectUiState('reconnecting');
      void runReconnectLoop('app_active');
      return;
    }
  }, [claimReattach, cleanupSockets, connectToGatewayV2, runReconnectLoop, setReconnectUiState]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState;
      logger.info('connection', 'app state changed', {
        nextState,
        status,
        hasTransport: Boolean(v2TransportRef.current),
        discoveredPorts: discoveredPortsRef.current,
      });
      if (nextState === 'active') {
        if (status === 'connected' && discoveredPortsRef.current.length > 0) {
          startPortServers(discoveredPortsRef.current);
        }
        if (statusRef.current === 'connected' && v2TransportRef.current) {
          setSyncGeneration((current) => current + 1);
        }
        if (!manualDisconnectRef.current && sessionPasswordRef.current && !reconnectingRef.current) {
          const needsReconnect = status !== 'connected' || !v2TransportRef.current;
          if (needsReconnect) {
            logger.info('connection', 'app returned active with missing connection; retrying reconnect from memory', {
              status,
              hasTransport: Boolean(v2TransportRef.current),
            });
            void runReconnectLoop('app_active');
          }
        } else if (!sessionPasswordRef.current) {
          logger.info('connection', 'app returned active without in-memory session; skipping automatic reconnect');
        }
        return;
      }
      reconnectRunIdRef.current += 1;
      reconnectLoopActiveRef.current = false;
      reconnectingRef.current = false;
      stopAllServers();
    });

    return () => {
      sub.remove();
    };
  }, [runReconnectLoop, status]);

  useEffect(() => {
    let cancelled = false;

    const probeManagerReachability = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      if (appStateRef.current !== 'active') {
        return;
      }
      if (manualDisconnectRef.current || !sessionPasswordRef.current) {
        return;
      }

      try {
        const response = await Promise.race([
          fetch(new URL('/health', MANAGER_URL).toString(), {
            method: 'GET',
            headers: { Accept: 'application/json,text/plain,*/*' },
          }),
          new Promise<globalThis.Response>((_, reject) => {
            setTimeout(() => reject(new Error('health probe timeout')), 4_000);
          }),
        ]);

        if (cancelled) {
          return;
        }

        if (!(response instanceof globalThis.Response) || !response.ok) {
          handleConnectivityLost();
          return;
        }

        if (!networkReachableRef.current) {
          handleConnectivityRestored();
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        logger.warn('connection', 'manager reachability probe failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        handleConnectivityLost();
      }
    };

    void probeManagerReachability();
    const interval = setInterval(() => {
      void probeManagerReachability();
    }, 3_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [handleConnectivityLost, handleConnectivityRestored]);

  useEffect(() => {
    logger.info('connection', 'provider state updated', {
      status,
      sessionState,
      sessionCode,
      error,
      hasCapabilities: Boolean(capabilities),
      interactionBlockReason,
    });
  }, [status, sessionState, sessionCode, error, capabilities, interactionBlockReason]);

  useEffect(() => {
    return () => {
      manualDisconnectRef.current = true;
      cleanupSockets(true);
    };
  }, [cleanupSockets]);

  const value = useMemo<ConnectionContextType>(() => ({
    status,
    sessionState,
    sessionCode,
    cacheNamespace,
    syncGeneration,
    capabilities,
      error,
      isReconnecting,
      interactionBlockReason,
      trackedProxyPorts,
      discoveredProxyPorts,
      connect,
    resumeSession,
    getStoredSession,
    getPairedSessions,
    revokePairedSession,
    removePairedSession,
    clearStoredSession,
    endSession,
    disconnect,
    refreshProxyState,
    trackProxyPort,
    untrackProxyPort,
    sendControl,
    sendData,
    fireData,
    onDataEvent,
  }), [status, sessionState, sessionCode, cacheNamespace, syncGeneration, capabilities, error, isReconnecting, interactionBlockReason, trackedProxyPorts, discoveredProxyPorts, connect, resumeSession, getStoredSession, getPairedSessions, revokePairedSession, removePairedSession, clearStoredSession, endSession, disconnect, refreshProxyState, trackProxyPort, untrackProxyPort, sendControl, sendData, fireData, onDataEvent]);

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
      console.error('useConnection called outside ConnectionProvider; using fallback context.');
    }
    return fallbackConnectionContext;
  }
  return context;
}
