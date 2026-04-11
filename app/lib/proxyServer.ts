import { logger } from '@/lib/logger';
import { Platform } from 'react-native';

let TcpSocket: typeof import('react-native-tcp-socket').default | null = null;
type MobileWebSocketOptions = { headers?: Record<string, string> };
type MobileWebSocketConstructor = {
  new (url: string, protocols?: string | string[], options?: MobileWebSocketOptions): WebSocket;
};
const MobileWebSocket = WebSocket as unknown as MobileWebSocketConstructor;
const TRUSTED_NATIVE_ORIGIN = 'https://lunel.dev';

function buildNativeWebSocketOptions(sessionPassword: string | null): MobileWebSocketOptions {
  return {
    headers: {
      Origin: TRUSTED_NATIVE_ORIGIN,
      ...(sessionPassword ? { 'x-session-password': sessionPassword } : {}),
    },
  };
}
try {
  const tcpSocketModule = require('react-native-tcp-socket');
  TcpSocket = (tcpSocketModule?.default ?? tcpSocketModule) as typeof import('react-native-tcp-socket').default;
  logger.info('proxy', 'loaded react-native-tcp-socket module', {
    hasDefaultExport: Boolean(tcpSocketModule?.default),
    hasCreateServer: Boolean((tcpSocketModule?.default ?? tcpSocketModule)?.createServer),
  });
} catch (error) {
  logger.warn('proxy', 'failed to load react-native-tcp-socket module', {
    error: error instanceof Error ? error.message : String(error),
  });
}

const DEFAULT_GATEWAY_WS_URL = 'wss://gateway.lunel.dev';

// ============================================================================
// Types
// ============================================================================

interface TunnelInfo {
  tunnelId: string;
  port: number;
  tcpSocket: any;
  proxyWs: WebSocket | null;
  acceptedAt: number;
  remoteAddress: string | null;
  remotePort: number | null;
  localAddress: string | null;
  localPort: number | null;
  clientPreview: string;
  serverPreview: string;
  clientPreviewLogged: boolean;
  serverPreviewLogged: boolean;
  pendingWriteCount: number;
  remoteFinPending: boolean;
  localEnded: boolean;
  remoteEnded: boolean;
  finSent: boolean;
  finalizeTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
}

interface ServerInfo {
  port: number;
  server: any;
}

// ============================================================================
// State
// ============================================================================

let sessionCode: string | null = null;
let sessionPassword: string | null = null;
let activeGatewayWsUrl: string = DEFAULT_GATEWAY_WS_URL;
let failoverGatewayWsUrls: string[] = [DEFAULT_GATEWAY_WS_URL];
let sendControlMessage: ((ns: string, action: string, payload?: Record<string, unknown>) => Promise<any>) | null = null;

const activeServers = new Map<number, ServerInfo>();
const activeTunnels = new Map<string, TunnelInfo>();
const pendingServers = new Map<number, any>();
const bindFailedUntil = new Map<number, number>();
const bindConflictLoggedAt = new Map<number, number>();
const retryTimers = new Map<number, ReturnType<typeof setTimeout>>();
const desiredPorts = new Set<number>();
const lastStoppedAt = new Map<number, number>();

let tunnelCounter = 0;
const BIND_RETRY_COOLDOWN_MS = 60_000;
const QUICK_RETRY_WINDOW_MS = 5_000;
const QUICK_RETRY_DELAY_MS = 1_500;
const EADDRINUSE_LOG_THROTTLE_MS = 5 * 60_000;
const PROXY_WS_CONNECT_TIMEOUT_MS = 12_000;
const TUNNEL_SETUP_BUDGET_MS = 18_000;
const PROXY_WS_CONNECT_RETRY_ATTEMPTS = 1;
const PROXY_WS_RETRY_JITTER_MIN_MS = 200;
const PROXY_WS_RETRY_JITTER_MAX_MS = 500;
const PROXY_TUNNEL_LINGER_MS = 1_200;
const CLIENT_PROTOCOL_SNIFF_TIMEOUT_MS = 300;

type ProxyControlAction = 'fin' | 'rst';
interface ProxyControlFrame {
  v: 1;
  t: 'proxy_ctrl';
  action: ProxyControlAction;
  reason?: string;
}

// ============================================================================
// Public API
// ============================================================================

export function configureProxy(
  gatewayWsUrl: string,
  code: string,
  password: string | null,
  gateways: string[],
  sendControl: (ns: string, action: string, payload?: Record<string, unknown>) => Promise<any>,
): void {
  activeGatewayWsUrl = gatewayWsUrl || DEFAULT_GATEWAY_WS_URL;
  failoverGatewayWsUrls = gateways.length > 0 ? gateways : [activeGatewayWsUrl];
  sessionCode = code;
  sessionPassword = password;
  sendControlMessage = sendControl;
  logger.info('proxy', 'configured app proxy transport', {
    gatewayWsUrl: activeGatewayWsUrl,
    gatewayCount: failoverGatewayWsUrls.length,
    hasSessionCode: Boolean(sessionCode),
    hasSessionPassword: Boolean(sessionPassword),
    hasSendControl: Boolean(sendControlMessage),
  });
}

export function startPortServers(ports: number[]): void {
  const wanted = new Set(ports);
  desiredPorts.clear();
  for (const port of wanted) {
    desiredPorts.add(port);
  }
  logger.info('proxy', 'updating desired localhost proxy ports', {
    ports: Array.from(wanted).sort((a, b) => a - b),
    activeServers: Array.from(activeServers.keys()).sort((a, b) => a - b),
    pendingServers: Array.from(pendingServers.keys()).sort((a, b) => a - b),
  });

  // Stop servers not in the new list
  for (const [port] of activeServers) {
    if (!wanted.has(port)) {
      stopPortServer(port);
    }
  }
  for (const [port] of pendingServers) {
    if (!wanted.has(port)) {
      stopPortServer(port);
    }
  }
  for (const port of bindFailedUntil.keys()) {
    if (!wanted.has(port)) {
      bindFailedUntil.delete(port);
    }
  }
  for (const port of bindConflictLoggedAt.keys()) {
    if (!wanted.has(port)) {
      bindConflictLoggedAt.delete(port);
    }
  }
  for (const [port, timer] of retryTimers) {
    if (!wanted.has(port)) {
      clearTimeout(timer);
      retryTimers.delete(port);
    }
  }
  for (const port of lastStoppedAt.keys()) {
    if (!wanted.has(port)) {
      lastStoppedAt.delete(port);
    }
  }

  // Start servers for new ports
  for (const port of wanted) {
    startPortIfNeeded(port);
  }
}

export function stopAllServers(): void {
  logger.info('proxy', 'stopping all localhost proxy servers', {
    activeServers: Array.from(activeServers.keys()).sort((a, b) => a - b),
    activeTunnels: activeTunnels.size,
  });
  // Close all tunnels
  for (const [tunnelId] of activeTunnels) {
    closeTunnel(tunnelId);
  }
  activeTunnels.clear();

  // Close all servers
  for (const [port, serverInfo] of activeServers) {
    try {
      serverInfo.server.close();
    } catch (e) {
    }
  }
  activeServers.clear();
  for (const [port, server] of pendingServers) {
    try {
      server.close();
    } catch (e) {
    }
  }
  pendingServers.clear();
  bindFailedUntil.clear();
  bindConflictLoggedAt.clear();
  for (const [, timer] of retryTimers) {
    clearTimeout(timer);
  }
  retryTimers.clear();
  desiredPorts.clear();
  lastStoppedAt.clear();

  sessionCode = null;
  sessionPassword = null;
  activeGatewayWsUrl = DEFAULT_GATEWAY_WS_URL;
  failoverGatewayWsUrls = [DEFAULT_GATEWAY_WS_URL];
  sendControlMessage = null;
}

export function getActiveServers(): number[] {
  return Array.from(activeServers.keys());
}

export function getActiveTunnelCount(): number {
  return activeTunnels.size;
}

// ============================================================================
// Internal
// ============================================================================

function generateTunnelId(): string {
  tunnelCounter++;
  return `t-${Date.now()}-${tunnelCounter}`;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(Object.assign(new Error(message), { code: 'ETIMEOUT' }));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function randomRetryJitterMs(): number {
  const spread = PROXY_WS_RETRY_JITTER_MAX_MS - PROXY_WS_RETRY_JITTER_MIN_MS;
  return PROXY_WS_RETRY_JITTER_MIN_MS + Math.floor(Math.random() * (spread + 1));
}

function parseProxyControlFrame(data: unknown): ProxyControlFrame | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data) as Partial<ProxyControlFrame>;
    if (parsed?.v !== 1 || parsed?.t !== 'proxy_ctrl') return null;
    if (parsed.action !== 'fin' && parsed.action !== 'rst') return null;
    return {
      v: 1,
      t: 'proxy_ctrl',
      action: parsed.action,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

function sendProxyControl(tunnel: TunnelInfo, action: ProxyControlAction, reason?: string): void {
  const ws = tunnel.proxyWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const frame: ProxyControlFrame = { v: 1, t: 'proxy_ctrl', action, reason };
  ws.send(JSON.stringify(frame));
}

function normalizeChunkToUint8Array(data: any): Uint8Array | null {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length || 0);
  }
  return null;
}

function decodePreview(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

function extractHttpPreview(preview: string): { startLine: string; headers: Record<string, string> } | null {
  const headerEnd = preview.indexOf('\r\n\r\n') >= 0
    ? preview.indexOf('\r\n\r\n')
    : preview.indexOf('\n\n');
  if (headerEnd < 0) return null;

  const rawHeaderBlock = preview.slice(0, headerEnd);
  const lines = rawHeaderBlock.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;

  const startLine = lines[0];
  const isHttpRequest = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+HTTP\/\d/i.test(startLine);
  const isHttpResponse = /^HTTP\/\d\.\d\s+\d{3}\b/i.test(startLine);
  if (!isHttpRequest && !isHttpResponse) return null;

  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    if (!key) continue;
    headers[key] = line.slice(separatorIndex + 1).trim();
  }

  return { startLine, headers };
}

type InitialClientProtocol = 'http_plaintext' | 'tls_client_hello';

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function classifyInitialClientTraffic(chunks: Uint8Array[]): 'insufficient_data_yet' | 'unsupported' | InitialClientProtocol {
  const bytes = concatUint8Arrays(chunks);
  if (bytes.byteLength === 0) return 'insufficient_data_yet';

  if (bytes[0] === 0x16) {
    if (bytes.byteLength < 6) return 'insufficient_data_yet';
    const major = bytes[1];
    const minor = bytes[2];
    const handshakeType = bytes[5];
    const looksLikeTlsVersion = major === 0x03 && minor >= 0x00 && minor <= 0x04;
    if (looksLikeTlsVersion && handshakeType === 0x01) {
      return 'tls_client_hello';
    }
    return 'unsupported';
  }

  const preview = decodePreview(bytes.slice(0, Math.min(bytes.byteLength, 2048)));
  const newlineIndex = preview.indexOf('\n');
  if (newlineIndex < 0) {
    if (preview.length < 16) return 'insufficient_data_yet';
    return 'unsupported';
  }

  const requestLine = preview.slice(0, newlineIndex).replace(/\r$/, '');
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+HTTP\/1\.[01]$/i.test(requestLine)) {
    return 'http_plaintext';
  }

  return 'unsupported';
}

async function sniffInitialClientProtocol(
  tcpSocket: any,
  tunnelId: string,
  port: number,
): Promise<{ protocol: InitialClientProtocol; bufferedChunks: Uint8Array[] }> {
  return await new Promise((resolve, reject) => {
    const bufferedChunks: Uint8Array[] = [];
    let settled = false;

    const finish = (result: { protocol: InitialClientProtocol; bufferedChunks: Uint8Array[] } | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      tcpSocket.removeListener('data', handleData);
      tcpSocket.removeListener('end', handleEnd);
      tcpSocket.removeListener('close', handleClose);
      tcpSocket.removeListener('error', handleError);
      if (result) {
        try {
          tcpSocket.pause();
        } catch {
          // ignore
        }
        resolve(result);
        return;
      }
      reject(error ?? new Error('initial client protocol sniff failed'));
    };

    const handleData = (data: any) => {
      const bytes = normalizeChunkToUint8Array(data);
      if (!bytes) return;
      bufferedChunks.push(Uint8Array.from(bytes));
      const classification = classifyInitialClientTraffic(bufferedChunks);
      if (classification === 'http_plaintext' || classification === 'tls_client_hello') {
        logger.info('proxy', 'classified initial localhost client protocol', {
          tunnelId,
          port,
          protocol: classification,
        });
        finish({ protocol: classification, bufferedChunks });
        return;
      }
      if (classification === 'unsupported') {
        finish(null, Object.assign(new Error('Unsupported localhost client protocol'), { code: 'EPROTONOSUPPORT' }));
      }
    };

    const handleEnd = () => {
      finish(null, Object.assign(new Error('Localhost client closed before sending supported protocol bytes'), { code: 'ECONNRESET' }));
    };

    const handleClose = () => {
      finish(null, Object.assign(new Error('Localhost client closed during protocol sniff'), { code: 'ECONNRESET' }));
    };

    const handleError = () => {
      finish(null, Object.assign(new Error('Localhost client socket error during protocol sniff'), { code: 'ECONNRESET' }));
    };

    const timeout = setTimeout(() => {
      finish(null, Object.assign(new Error('Localhost client did not send supported protocol bytes in time'), { code: 'ETIMEOUT' }));
    }, CLIENT_PROTOCOL_SNIFF_TIMEOUT_MS);

    tcpSocket.on('data', handleData);
    tcpSocket.on('end', handleEnd);
    tcpSocket.on('close', handleClose);
    tcpSocket.on('error', handleError);

    try {
      tcpSocket.resume();
    } catch {
      finish(null, Object.assign(new Error('Failed to resume localhost socket for protocol sniff'), { code: 'EIO' }));
    }
  });
}

function sendBufferedClientChunks(proxyWs: WebSocket, chunks: Uint8Array[]): void {
  for (const chunk of chunks) {
    proxyWs.send(toOwnedArrayBuffer(chunk));
  }
}

function toOwnedArrayBuffer(source: Uint8Array): ArrayBuffer {
  const payload = new Uint8Array(source.byteLength);
  payload.set(source);
  return payload.buffer;
}

function maybeLogClientPayload(tunnel: TunnelInfo, chunk: Uint8Array): void {
  if (tunnel.clientPreviewLogged) return;

  if (tunnel.clientPreview.length < 4096) {
    tunnel.clientPreview += decodePreview(chunk).slice(0, 4096 - tunnel.clientPreview.length);
  }

  const parsed = extractHttpPreview(tunnel.clientPreview);
  if (parsed) {
    tunnel.clientPreviewLogged = true;
    logger.info('proxy', 'http request preview on localhost tunnel', {
      tunnelId: tunnel.tunnelId,
      port: tunnel.port,
      remoteAddress: tunnel.remoteAddress,
      remotePort: tunnel.remotePort,
      startLine: parsed.startLine,
      host: parsed.headers.host ?? null,
      userAgent: parsed.headers['user-agent'] ?? null,
      referer: parsed.headers.referer ?? null,
      origin: parsed.headers.origin ?? null,
      upgrade: parsed.headers.upgrade ?? null,
      accept: parsed.headers.accept ?? null,
    });
    return;
  }

  if (tunnel.clientPreview.length >= 1024) {
    tunnel.clientPreviewLogged = true;
    logger.info('proxy', 'non-http client payload on localhost tunnel', {
      tunnelId: tunnel.tunnelId,
      port: tunnel.port,
      remoteAddress: tunnel.remoteAddress,
      remotePort: tunnel.remotePort,
      preview: tunnel.clientPreview.slice(0, 160),
    });
  }
}

function maybeLogServerPayload(tunnel: TunnelInfo, chunk: Uint8Array): void {
  if (tunnel.serverPreviewLogged) return;

  if (tunnel.serverPreview.length < 4096) {
    tunnel.serverPreview += decodePreview(chunk).slice(0, 4096 - tunnel.serverPreview.length);
  }

  const parsed = extractHttpPreview(tunnel.serverPreview);
  if (parsed) {
    tunnel.serverPreviewLogged = true;
    logger.info('proxy', 'http response preview on localhost tunnel', {
      tunnelId: tunnel.tunnelId,
      port: tunnel.port,
      remoteAddress: tunnel.remoteAddress,
      remotePort: tunnel.remotePort,
      startLine: parsed.startLine,
      contentType: parsed.headers['content-type'] ?? null,
      location: parsed.headers.location ?? null,
      upgrade: parsed.headers.upgrade ?? null,
      server: parsed.headers.server ?? null,
    });
    return;
  }

  if (tunnel.serverPreview.length >= 1024) {
    tunnel.serverPreviewLogged = true;
    logger.info('proxy', 'non-http server payload on localhost tunnel', {
      tunnelId: tunnel.tunnelId,
      port: tunnel.port,
      remoteAddress: tunnel.remoteAddress,
      remotePort: tunnel.remotePort,
      preview: tunnel.serverPreview.slice(0, 160),
    });
  }
}

function maybeFinalizeTunnel(tunnelId: string): void {
  const tunnel = activeTunnels.get(tunnelId);
  if (!tunnel || tunnel.closing) return;
  if (!tunnel.localEnded || !tunnel.remoteEnded) return;
  if (tunnel.finalizeTimer) return;

  tunnel.finalizeTimer = setTimeout(() => {
    const current = activeTunnels.get(tunnelId);
    if (!current || current.closing) return;
    closeTunnel(tunnelId);
  }, PROXY_TUNNEL_LINGER_MS);
}

async function connectProxyWsWithRetry(
  proxyWsUrl: string,
  sessionPassword: string | null,
  getRemainingSetupMs: () => number,
): Promise<WebSocket> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= PROXY_WS_CONNECT_RETRY_ATTEMPTS; attempt++) {
    const remainingMs = getRemainingSetupMs();
    if (remainingMs <= 0) {
      throw Object.assign(
        new Error('Tunnel setup timeout while connecting proxy WebSocket'),
        { code: 'ETIMEOUT' },
      );
    }

    const connectTimeoutMs = Math.min(PROXY_WS_CONNECT_TIMEOUT_MS, Math.max(250, remainingMs));
    const wsUrl = (() => {
      if (Platform.OS !== 'web' || !sessionPassword) {
        return proxyWsUrl;
      }
      const url = new URL(proxyWsUrl);
      url.searchParams.set('password', sessionPassword);
      return url.toString();
    })();
    const proxyWs = Platform.OS === 'web'
      ? new WebSocket(wsUrl)
      : new MobileWebSocket(wsUrl, undefined, buildNativeWebSocketOptions(sessionPassword));
    proxyWs.binaryType = 'arraybuffer';

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          proxyWs.close();
          reject(new Error('Proxy WS connect timeout'));
        }, connectTimeoutMs);

        proxyWs.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };

        proxyWs.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('Proxy WS connect failed'));
        };

        proxyWs.onclose = () => {
          clearTimeout(timeout);
          reject(new Error('Proxy WS closed during connect'));
        };
      });

      return proxyWs;
    } catch (error) {
      lastError = error as Error;
      try {
        proxyWs.close();
      } catch {
        // ignore
      }

      if (attempt >= PROXY_WS_CONNECT_RETRY_ATTEMPTS) {
        break;
      }

      const jitterMs = randomRetryJitterMs();
      if (getRemainingSetupMs() <= jitterMs) {
        break;
      }
      await waitMs(jitterMs);
    }
  }

  throw Object.assign(
    new Error(lastError?.message || 'Proxy WS connect failed'),
    { code: 'ECONNREFUSED' },
  );
}

function schedulePortRetry(port: number, delayMs: number): void {
  if (!desiredPorts.has(port)) return;
  if (retryTimers.has(port)) return;

  const timer = setTimeout(() => {
    retryTimers.delete(port);
    if (!desiredPorts.has(port)) return;
    startPortIfNeeded(port, true);
  }, Math.max(250, delayMs));
  retryTimers.set(port, timer);
}

function clearPortRetry(port: number): void {
  const timer = retryTimers.get(port);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(port);
  }
}

function startPortIfNeeded(port: number, force = false): void {
  if (!desiredPorts.has(port)) return;
  if (activeServers.has(port) || pendingServers.has(port)) return;

  const cooldownUntil = bindFailedUntil.get(port);
  const now = Date.now();
  if (!force && cooldownUntil && cooldownUntil > now) {
    schedulePortRetry(port, cooldownUntil - now + 50);
    return;
  }
  startSingleServer(port);
}

function startSingleServer(port: number): void {
  if (!TcpSocket) {
    logger.warn('proxy', 'tcp socket module unavailable; cannot bind localhost port', { port });
    return;
  }
  const server = TcpSocket.createServer({ pauseOnConnect: true }, (socket: any) => {
    logger.info('proxy', 'accepted localhost connection', {
      port,
      remoteAddress: socket?.remoteAddress ?? null,
      remotePort: socket?.remotePort ?? null,
      localAddress: socket?.localAddress ?? null,
      localPort: socket?.localPort ?? null,
      hasSessionCode: Boolean(sessionCode),
      hasSessionPassword: Boolean(sessionPassword),
      hasSendControl: Boolean(sendControlMessage),
    });
    handleIncomingConnection(socket, port);
  });

  pendingServers.set(port, server);

  server.on('listening', () => {
    pendingServers.delete(port);
    bindFailedUntil.delete(port);
    bindConflictLoggedAt.delete(port);
    clearPortRetry(port);
    activeServers.set(port, { port, server });
    logger.info('proxy', 'localhost proxy server listening', { port, host: '127.0.0.1' });
  });

  server.on('error', (error: any) => {
    pendingServers.delete(port);
    activeServers.delete(port);
    logger.warn('proxy', 'localhost proxy server error', {
      port,
      code: error?.code ?? null,
      message: error?.message ?? String(error),
    });
    if (error?.code === 'EADDRINUSE') {
      const recentlyStopped = Date.now() - (lastStoppedAt.get(port) || 0) < QUICK_RETRY_WINDOW_MS;
      const retryDelay = recentlyStopped ? QUICK_RETRY_DELAY_MS : BIND_RETRY_COOLDOWN_MS;
      bindFailedUntil.set(port, Date.now() + retryDelay);
      schedulePortRetry(port, retryDelay + 50);
      const now = Date.now();
      const lastLogAt = bindConflictLoggedAt.get(port) || 0;
      if (now - lastLogAt >= EADDRINUSE_LOG_THROTTLE_MS) {
        bindConflictLoggedAt.set(port, now);
      }
      return;
    }
  });

  server.listen({ port, host: '127.0.0.1' });
}

function stopPortServer(port: number): void {
  const serverInfo = activeServers.get(port);
  const pendingServer = pendingServers.get(port);
  if (!serverInfo && !pendingServer) return;
  clearPortRetry(port);

  // Close all tunnels for this port
  for (const [tunnelId, tunnel] of activeTunnels) {
    if (tunnel.port === port) {
      closeTunnel(tunnelId);
    }
  }

  if (serverInfo) {
    try {
      serverInfo.server.close();
    } catch (e) {
      // ignore
    }
    activeServers.delete(port);
    lastStoppedAt.set(port, Date.now());
  }
  if (pendingServer) {
    try {
      pendingServer.close();
    } catch (e) {
      // ignore
    }
    pendingServers.delete(port);
    lastStoppedAt.set(port, Date.now());
  }
  bindFailedUntil.delete(port);
  bindConflictLoggedAt.delete(port);
}

async function handleIncomingConnection(tcpSocket: any, port: number): Promise<void> {
  if (!sessionCode || !sendControlMessage) {
    logger.warn('proxy', 'dropping localhost connection before tunnel setup', {
      port,
      hasSessionCode: Boolean(sessionCode),
      hasSessionPassword: Boolean(sessionPassword),
      hasSendControl: Boolean(sendControlMessage),
      reason: !sessionCode ? 'missing_session_code' : 'missing_send_control',
    });
    tcpSocket.destroy();
    return;
  }

  const tunnelId = generateTunnelId();

  // Pause TCP socket to buffer data until proxy WS is ready
  tcpSocket.pause();
  const setupStartedAt = Date.now();
  const getRemainingSetupMs = () => TUNNEL_SETUP_BUDGET_MS - (Date.now() - setupStartedAt);
  logger.info('proxy', 'starting localhost proxy tunnel setup', {
    tunnelId,
    port,
    remoteAddress: tcpSocket?.remoteAddress ?? null,
    remotePort: tcpSocket?.remotePort ?? null,
    localAddress: tcpSocket?.localAddress ?? null,
    localPort: tcpSocket?.localPort ?? null,
    gatewayWsUrl: activeGatewayWsUrl,
    hasSessionCode: Boolean(sessionCode),
    hasSessionPassword: Boolean(sessionPassword),
  });

  let initialProtocol: InitialClientProtocol;
  let bufferedClientChunks: Uint8Array[];
  try {
    const sniffed = await sniffInitialClientProtocol(tcpSocket, tunnelId, port);
    initialProtocol = sniffed.protocol;
    bufferedClientChunks = sniffed.bufferedChunks;
  } catch (error) {
    logger.info('proxy', 'dropping localhost connection before proxy tunnel creation', {
      tunnelId,
      port,
      remoteAddress: tcpSocket?.remoteAddress ?? null,
      remotePort: tcpSocket?.remotePort ?? null,
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof Error && 'code' in error ? (error as any).code ?? null : null,
    });
    tcpSocket.destroy();
    return;
  }

  const tunnel: TunnelInfo = {
    tunnelId,
    port,
    tcpSocket,
    proxyWs: null,
    acceptedAt: Date.now(),
    remoteAddress: tcpSocket?.remoteAddress ?? null,
    remotePort: tcpSocket?.remotePort ?? null,
    localAddress: tcpSocket?.localAddress ?? null,
    localPort: tcpSocket?.localPort ?? null,
    clientPreview: '',
    serverPreview: '',
    clientPreviewLogged: false,
    serverPreviewLogged: false,
    pendingWriteCount: 0,
    remoteFinPending: false,
    localEnded: false,
    remoteEnded: false,
    finSent: false,
    finalizeTimer: null,
    closing: false,
  };
  activeTunnels.set(tunnelId, tunnel);

  try {
    const controlRemainingMs = getRemainingSetupMs();
    if (controlRemainingMs <= 0) {
      throw Object.assign(new Error('Tunnel setup timeout before CLI proxy connect'), { code: 'ETIMEOUT' });
    }

    // Step 1: Ask CLI to connect to the local service and open its proxy WS
    const response = await withTimeout(
      sendControlMessage('proxy', 'connect', { tunnelId, port }),
      controlRemainingMs,
      'Tunnel setup timeout while waiting for CLI proxy connect',
    );
    logger.info('proxy', 'received proxy.connect response from cli', {
      tunnelId,
      port,
      ok: Boolean(response?.ok),
      error: response?.error?.message ?? null,
      errorCode: response?.error?.code ?? null,
    });

    if (!response.ok) {
      closeTunnel(tunnelId);
      return;
    }

    // Step 2: Open our side of the proxy WS
    const proxyQuery = new URLSearchParams({
      tunnelId,
      role: 'app',
      ...(sessionPassword ? {} : { code: sessionCode }),
    });
    const gatewayBase = activeGatewayWsUrl || failoverGatewayWsUrls[0] || DEFAULT_GATEWAY_WS_URL;
    const proxyWsUrl = `${gatewayBase}/v1/ws/proxy?${proxyQuery.toString()}`;
    logger.info('proxy', 'connecting app proxy websocket', {
      tunnelId,
      port,
      gatewayBase,
      authMode: sessionPassword ? 'password' : 'code',
      initialProtocol,
    });
    const proxyWs = await connectProxyWsWithRetry(proxyWsUrl, sessionPassword, getRemainingSetupMs);
    tunnel.proxyWs = proxyWs;
    logger.info('proxy', 'app proxy websocket connected', { tunnelId, port });

    const markLocalEnded = () => {
      const current = activeTunnels.get(tunnelId);
      if (!current || current.closing) return;
      if (!current.localEnded) {
        current.localEnded = true;
      }
      if (!current.finSent) {
        current.finSent = true;
        sendProxyControl(current, 'fin');
      }
      maybeFinalizeTunnel(tunnelId);
    };

    const maybeEndLocalSocketAfterFlush = () => {
      const current = activeTunnels.get(tunnelId);
      if (!current || current.closing) return;
      if (!current.remoteFinPending || current.remoteEnded) return;
      if (current.pendingWriteCount > 0) return;

      current.remoteEnded = true;
      current.remoteFinPending = false;
      try {
        if (!tcpSocket.destroyed && typeof tcpSocket.end === 'function') {
          tcpSocket.end();
        }
      } catch {
        // ignore
      }
      maybeFinalizeTunnel(tunnelId);
    };

    // Step 3: Pipe TCP -> WS (binary)
    tcpSocket.on('data', (data: any) => {
      const current = activeTunnels.get(tunnelId);
      const chunk = normalizeChunkToUint8Array(data);
      if (current && chunk) {
        maybeLogClientPayload(current, chunk);
      }
      if (proxyWs.readyState === WebSocket.OPEN) {
        // react-native-tcp-socket gives Buffer; WebSocket.send accepts ArrayBuffer
        if (data instanceof ArrayBuffer) {
          proxyWs.send(data);
        } else if (data.buffer) {
          proxyWs.send(toOwnedArrayBuffer(normalizeChunkToUint8Array(data) ?? new Uint8Array(0)));
        } else {
          proxyWs.send(data);
        }
      }
    });

    for (const chunk of bufferedClientChunks) {
      maybeLogClientPayload(tunnel, chunk);
    }
    sendBufferedClientChunks(proxyWs, bufferedClientChunks);

    // Step 4: Pipe WS -> TCP (binary)
    proxyWs.onmessage = (event: MessageEvent) => {
      const control = parseProxyControlFrame(event.data);
      if (control) {
        if (control.action === 'fin') {
          const current = activeTunnels.get(tunnelId);
          if (current && !current.remoteEnded) {
            current.remoteFinPending = true;
            logger.info('proxy', 'received remote FIN on app proxy websocket', {
              tunnelId,
              port,
              pendingWriteCount: current.pendingWriteCount,
            });
            maybeEndLocalSocketAfterFlush();
          }
        } else {
          closeTunnel(tunnelId);
        }
        return;
      }

      if (!tcpSocket.destroyed) {
        // event.data is ArrayBuffer (binaryType = 'arraybuffer')
        const bytes = new Uint8Array(event.data);
        const current = activeTunnels.get(tunnelId);
        if (!current || current.closing) return;
        maybeLogServerPayload(current, bytes);
        current.pendingWriteCount += 1;
        try {
          tcpSocket.write(bytes, undefined, () => {
            const latest = activeTunnels.get(tunnelId);
            if (!latest || latest.closing) return;
            latest.pendingWriteCount = Math.max(0, latest.pendingWriteCount - 1);
            maybeEndLocalSocketAfterFlush();
          });
        } catch {
          current.pendingWriteCount = Math.max(0, current.pendingWriteCount - 1);
          throw new Error('failed to write proxy response bytes to localhost socket');
        }
      }
    };

    // Step 5: Half-close handling
    tcpSocket.on('end', () => {
      logger.info('proxy', 'localhost tcp socket ended', {
        tunnelId,
        port,
        remoteAddress: tunnel.remoteAddress,
        remotePort: tunnel.remotePort,
      });
      markLocalEnded();
    });

    tcpSocket.on('close', () => {
      logger.info('proxy', 'localhost tcp socket closed', {
        tunnelId,
        port,
        remoteAddress: tunnel.remoteAddress,
        remotePort: tunnel.remotePort,
      });
      markLocalEnded();
    });

    tcpSocket.on('error', () => {
      logger.warn('proxy', 'localhost tcp socket error', { tunnelId, port });
      const current = activeTunnels.get(tunnelId);
      if (current && !current.finSent) {
        sendProxyControl(current, 'rst', 'tcp_error');
      }
      closeTunnel(tunnelId);
    });

    proxyWs.onclose = () => {
      logger.warn('proxy', 'app proxy websocket closed', { tunnelId, port });
      closeTunnel(tunnelId);
    };

    // proxyWs.onerror is already set above for the connect phase,
    // but we reassign for the active phase
    proxyWs.onerror = () => {
      logger.warn('proxy', 'app proxy websocket error', { tunnelId, port });
      closeTunnel(tunnelId);
    };

    // Step 6: Resume TCP socket — everything is wired
    tcpSocket.resume();

  } catch (error) {
    logger.error('proxy', 'localhost proxy tunnel setup failed', {
      tunnelId,
      port,
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof Error && 'code' in error ? (error as any).code ?? null : null,
    });
    closeTunnel(tunnelId);
  }
}

function closeTunnel(tunnelId: string): void {
  const tunnel = activeTunnels.get(tunnelId);
  if (!tunnel) return;
  logger.info('proxy', 'closing localhost proxy tunnel', {
    tunnelId,
    port: tunnel.port,
    remoteAddress: tunnel.remoteAddress,
    remotePort: tunnel.remotePort,
    localAddress: tunnel.localAddress,
    localPort: tunnel.localPort,
    lifetimeMs: Date.now() - tunnel.acceptedAt,
    pendingWriteCount: tunnel.pendingWriteCount,
    remoteFinPending: tunnel.remoteFinPending,
    localEnded: tunnel.localEnded,
    remoteEnded: tunnel.remoteEnded,
    hasProxyWs: Boolean(tunnel.proxyWs),
  });
  tunnel.closing = true;
  if (tunnel.finalizeTimer) {
    clearTimeout(tunnel.finalizeTimer);
    tunnel.finalizeTimer = null;
  }

  // Delete immediately to prevent double-close from cascading events
  activeTunnels.delete(tunnelId);

  try {
    if (!tunnel.tcpSocket.destroyed) {
      tunnel.tcpSocket.destroy();
    }
  } catch (e) {
    // ignore
  }

  try {
    if (tunnel.proxyWs && (tunnel.proxyWs.readyState === WebSocket.OPEN || tunnel.proxyWs.readyState === WebSocket.CONNECTING)) {
      tunnel.proxyWs.close();
    }
  } catch (e) {
    // ignore
  }
}
