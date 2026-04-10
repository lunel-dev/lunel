import type { ServerWebSocket } from "bun";
import { randomBytes, randomUUID } from "crypto";
import os from "os";

const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const CODE_LENGTH = 10;
const SESSION_PASSWORD_LENGTH = 67;
const CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const RECONNECT_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week (app closed grace)
const SAFETY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const DATA_MAX_SIZE = 32 * 1024 * 1024; // 32MB — prevents memory-exhaustion DoS on session traffic
const ANALYTICS_INTERVAL_MS = 15_000;
const STALE_GATEWAY_MS = 45_000; // 3 missed heartbeats at 15s interval; aligns with client retry budget
const GATEWAY_EVENT_DEDUPE_MS = 10 * 60 * 1000;
const DEFAULT_RESUME_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MANAGER_AUTHORITY_CACHE_MS = 5000;
// In read-only mode we may serve a stale "allowed" decision, but never beyond
// this hard cap — this bounds how long a revoked session can stay connected.
const MANAGER_READONLY_CACHE_MAX_MS = 5 * 60 * 1000; // 5 minutes
const MANAGER_HEALTH_CHECK_INTERVAL_MS = 30_000;
const MANAGER_HEALTH_FAILURES_BEFORE_READONLY = 2;
const PENDING_MANAGER_EVENTS_MAX = 500;
const PROXY_TUNNEL_QUEUE_MAX_BYTES = 2 * 1024 * 1024; // 2MB per direction
const PROXY_TUNNEL_QUEUE_MAX_FRAMES = 512;
const PROXY_TUNNEL_GC_MS = 15_000;
const CLI_OFFLINE_GRACE_MS = 5 * 60 * 1000; // 5 minutes (public tier)

type Role = "cli" | "app";
const SESSION_V2_MAX_SIZE = DATA_MAX_SIZE;

type Timer = ReturnType<typeof setTimeout>;

interface SessionV2WebSocketData {
  type: "session-v2";
  password: string;
  role: Role;
  generation: number | null;
}

interface ProxyWebSocketData {
  type: "proxy";
  sessionPassword: string;
  tunnelId: string;
  role: Role;
}

type WebSocketData = SessionV2WebSocketData | ProxyWebSocketData;

interface ProxyTunnel {
  cli: ServerWebSocket<ProxyWebSocketData> | null;
  app: ServerWebSocket<ProxyWebSocketData> | null;
  pendingToCli: Array<string | ArrayBuffer | Uint8Array>;
  pendingToApp: Array<string | ArrayBuffer | Uint8Array>;
  pendingBytesToCli: number;
  pendingBytesToApp: number;
  gcTimer: Timer | null;
}

interface Session {
  code: string | null;
  password: string | null;
  createdAt: number;
  locked: boolean;
  role: "primary" | "secondary";
  backupGateway: string | null;
  peerGateway: string | null;
  reconnectDeadline: number | null;
  reconnectTimer: Timer | null;
  cliReconnectDeadline: number | null;
  cliGraceTimer: Timer | null;
  sockets: {
    cli: ServerWebSocket<SessionV2WebSocketData> | null;
    app: ServerWebSocket<SessionV2WebSocketData> | null;
  };
  tunnels: Map<string, ProxyTunnel>;
}

interface BackupRegistration {
  password: string;
  createdAt: number;
  role: "primary" | "secondary";
  backupGateway: string | null;
  peerGateway: string | null;
}

interface ManagerProxyMetrics {
  gatewayId?: string;
  url: string;
  activeConnections: number;
  activeSessions: number;
  uniqueSessions24h: number;
  lastHeartbeat: number;
  state?: "active" | "draining" | "disabled";
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  networkInBps?: number;
  networkOutBps?: number;
  lastTelemetry?: number;
}

interface GatewayControlEvent {
  type:
    | "gateway_auth"
    | "gateway_hello"
    | "proxy_metrics"
    | "session_event"
    | "connection_event"
    | "manager_command";
  password?: string;
  gatewayId?: string;
  gateway?: string;
  ts?: number;
  activeConnections?: number;
  activeSessions?: number;
  uniqueSessions24h?: number;
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  networkInBps?: number;
  networkOutBps?: number;
  lastTelemetry?: number;
  event?: "peer_connected" | "app_disconnected" | "session_ended" | "session_expired";
  connectionAction?: "socket_connected" | "socket_disconnected" | "session_end_requested";
  resumeToken?: string;
  reconnectDeadline?: number | null;
  command?: "close_session" | "set_reconnect_grace" | "clear_reconnect_grace" | "set_cli_reconnect_grace" | "ring_update";
  ring?: string[];
  role?: Role;
  channel?: string;
  protocol?: "v2";
  connected?: boolean;
  reason?: string;
  eventId?: string;
  generation?: number;
}

interface ManagerControlSocketData {
  type: "manager-control";
  authed: boolean;
  gatewayId?: string;
  gatewayUrl?: string;
}

interface ManagerPasswordValidation {
  valid: boolean;
  reason: string;
  proxyUrl: string | null;
  expiresAt: number;
}

interface RateLimitPolicy {
  windowMs: number;
  perIp: number;
  perSubnet: number;
}

interface AuditLogRow {
  id: number;
  ts: number;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  source_ip: string;
  status: string;
  message: string;
  metadata: string;
}

const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Proxy-Password, X-Session-Password",
};

function isTrustedRequestOrigin(req: Request): boolean {
  const originHeader = req.headers.get("origin");
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    const hostname = origin.hostname.toLowerCase();
    return hostname === "lunel.dev"
      || hostname.endsWith(".lunel.dev")
      || hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1";
  } catch {
    return false;
  }
}

function generateSecureCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let result = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    result += CHARSET[bytes[i] % CHARSET.length];
  }
  return result;
}

function isPeerConnected(session: Session, role: Role): boolean {
  return session.sockets[role] !== null;
}

function getOppositeRole(role: Role): Role {
  return role === "cli" ? "app" : "cli";
}

function sendSystemMessage(
  ws: ServerWebSocket<WebSocketData> | null | undefined,
  type: string,
  payload: Record<string, unknown> = {}
): void {
  if (!ws) return;
  try {
    ws.send(JSON.stringify({ type, ...payload }));
  } catch {
    // Best effort only; sockets can disappear between timer scheduling and send.
  }
}

function normalizeGatewayUrl(input: string | null): string | null {
  if (!input) return null;
  try {
    const raw = input.trim();
    const withScheme = raw.includes("://") ? raw : `https://${raw}`;
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "https:") {
      return null;
    }
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return null;
  }
}

function normalizeGatewayId(input: string | null | undefined): string | null {
  if (!input) return null;
  const normalized = input.trim();
  if (!normalized) return null;
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(normalized)) return null;
  return normalized;
}


function extractClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for") || "";
  const realIp = req.headers.get("x-real-ip") || "";
  const cfIp = req.headers.get("cf-connecting-ip") || "";
  const raw = (forwardedFor.split(",")[0] || realIp || cfIp || "unknown").trim();
  return raw || "unknown";
}

function toIpv4Subnet24(ip: string): string {
  const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return `host:${ip}`;
  return `${match[1]}.${match[2]}.${match[3]}.0/24`;
}

function messageByteLength(message: string | ArrayBuffer | Uint8Array): number {
  if (typeof message === "string") return Buffer.byteLength(message, "utf-8");
  if (message instanceof ArrayBuffer) return message.byteLength;
  return message.byteLength;
}

function parseProxyControlMessage(message: string | ArrayBuffer | Uint8Array): { action: "fin" | "rst"; reason?: string } | null {
  const text = typeof message === "string" ? message : Buffer.from(message as ArrayBufferLike).toString("utf-8");
  try {
    const parsed = JSON.parse(text) as { v?: number; t?: string; action?: string; reason?: string };
    if (parsed?.v !== 1 || parsed?.t !== "proxy_ctrl") return null;
    if (parsed.action !== "fin" && parsed.action !== "rst") return null;
    return {
      action: parsed.action,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

function makeProxyControlMessage(action: "fin" | "rst", reason?: string): string {
  return JSON.stringify({ v: 1, t: "proxy_ctrl", action, reason });
}

function redactSensitive(input: unknown): unknown {
  if (input == null) return input;
  if (typeof input === "string") {
    return input
      .replace(/([A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,})/g, "[redacted_jwt]")
      .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted_secret]");
  }
  if (Array.isArray(input)) return input.map((v) => redactSensitive(v));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (["password", "token", "resumeToken", "authorization", "x-proxy-password"].includes(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redactSensitive(v);
      }
    }
    return out;
  }
  return input;
}

// ============================================================================
// Manager mode
// ============================================================================

function startGateway(): void {
  const sessionsByPassword = new Map<string, Session>();
  const backupRegistrations = new Map<string, BackupRegistration>();
  const sessionHistory24h = new Map<string, number>();

  const managerUrl = normalizeGatewayUrl(process.env.MANAGER_URL || "");
  if (!managerUrl) {
    console.error("[proxy] MANAGER_URL is required (e.g. https://manager.yourdomain.com)");
    process.exit(1);
  }
  const proxyPassword = process.env.PROXY_PASSWORD || "";
  if (!proxyPassword) {
    console.error("[proxy] PROXY_PASSWORD is required");
    process.exit(1);
  }
  const enforceManagerAuthority =
    (process.env.ENFORCE_MANAGER_AUTHORITY || "1") !== "0" && Boolean(managerUrl);
  const publicUrl = normalizeGatewayUrl(
    process.env.PUBLIC_URL ||
    process.env.GATEWAY_URL ||
    ""
  );
  if (!publicUrl) {
    console.error("[proxy] PUBLIC_URL is required — the public HTTPS URL of this proxy (e.g. https://one.yourdomain.com)");
    process.exit(1);
  }
  const gatewayId =
    normalizeGatewayId(process.env.GATEWAY_ID || null) ||
    normalizeGatewayId(os.hostname()) ||
    null;

  // Consistent-hash ring state — updated by manager via ring_update command
  let ringMembership: string[] = [];
  let ringSuccessorUrl: string | null = null;

  const allSessions = (): Session[] => {
    const set = new Set<Session>();
    for (const session of sessionsByPassword.values()) set.add(session);
    return Array.from(set);
  };
  const managerSessionValidationCache = new Map<string, ManagerPasswordValidation>();

  const hasAnySockets = (session: Session): boolean => {
    return session.sockets.cli !== null || session.sockets.app !== null;
  };

  const isManagerPasswordAllowed = async (
    password: string,
    role?: Role,
    generation?: number | null
  ): Promise<{ allowed: boolean; reason: string; proxyUrl: string | null }> => {
    if (!enforceManagerAuthority) return { allowed: true, reason: "authority_disabled", proxyUrl: publicUrl };
    if (!managerUrl || !password) return { allowed: false, reason: "invalid_input", proxyUrl: null };

    const cacheKey = `${password}:${role || "-"}:${typeof generation === "number" && generation > 0 ? generation : 0}`;
    const cached = managerSessionValidationCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return { allowed: cached.valid, reason: cached.reason, proxyUrl: cached.proxyUrl };
    }

    // Read-only mode: serve previously-approved sessions from cache, but only
    // within a hard cap so revoked sessions cannot reconnect indefinitely.
    if (managerReadOnly && cached?.valid) {
      const cacheAge = now - (cached.expiresAt - MANAGER_AUTHORITY_CACHE_MS);
      if (cacheAge < MANAGER_READONLY_CACHE_MAX_MS) {
        return { allowed: true, reason: "read_only_cache", proxyUrl: cached.proxyUrl };
      }
      // Cache is too stale — reject and let the session re-authenticate once
      // the manager is reachable again.
      return { allowed: false, reason: "read_only_cache_expired", proxyUrl: null };
    }

    try {
      const validateUrl = new URL("/v2/proxy/validate", managerUrl);
      const res = await fetch(validateUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          password,
          ...(role ? { role } : {}),
          ...(typeof generation === "number" && generation > 0 ? { generation } : {}),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        // 5xx errors are transient — fall back to cache within the hard cap.
        // 4xx (404, 409, etc.) are authoritative rejections even in read-only mode.
        if (managerReadOnly && cached?.valid && res.status >= 500) {
          const cacheAge = now - (cached.expiresAt - MANAGER_AUTHORITY_CACHE_MS);
          if (cacheAge < MANAGER_READONLY_CACHE_MAX_MS) {
            return { allowed: true, reason: "read_only_cache", proxyUrl: cached.proxyUrl };
          }
          return { allowed: false, reason: "read_only_cache_expired", proxyUrl: null };
        }
        managerSessionValidationCache.set(cacheKey, {
          valid: false,
          reason: `manager_http_${res.status}`,
          proxyUrl: null,
          expiresAt: now + 1000,
        });
        return { allowed: false, reason: `manager_http_${res.status}`, proxyUrl: null };
      }
      const payload = (await res.json()) as {
        valid?: boolean;
        reason?: string;
        proxyUrl?: string | null;
      };
      const assignedProxyUrl = normalizeGatewayUrl(payload.proxyUrl || null);
      const allowed =
        payload.valid === true &&
        Boolean(assignedProxyUrl) &&
        assignedProxyUrl === publicUrl;
      const reason = allowed
        ? "ok"
        : payload.reason || (!assignedProxyUrl ? "proxy_not_assigned" : assignedProxyUrl !== publicUrl ? "wrong_proxy" : "invalid_password");
      managerSessionValidationCache.set(cacheKey, {
        valid: allowed,
        reason,
        proxyUrl: assignedProxyUrl,
        expiresAt: now + MANAGER_AUTHORITY_CACHE_MS,
      });
      return { allowed, reason, proxyUrl: assignedProxyUrl };
    } catch (err) {
      console.warn("[authority] manager status check failed:", redactSensitive(String(err)));
      // Network error in read-only mode: honour previously-cached approval within the hard cap.
      if (managerReadOnly && cached?.valid) {
        const cacheAge = now - (cached.expiresAt - MANAGER_AUTHORITY_CACHE_MS);
        if (cacheAge < MANAGER_READONLY_CACHE_MAX_MS) {
          return { allowed: true, reason: "read_only_cache", proxyUrl: cached.proxyUrl };
        }
        return { allowed: false, reason: "read_only_cache_expired", proxyUrl: null };
      }
      managerSessionValidationCache.set(cacheKey, {
        valid: false,
        reason: "manager_unreachable",
        proxyUrl: null,
        expiresAt: now + 1000,
      });
      return { allowed: false, reason: "manager_unreachable", proxyUrl: null };
    }
  };

  const hasAnyRoleSockets = (session: Session, role: Role): boolean => {
    return session.sockets[role] !== null;
  };

  const clearReconnectTimer = (session: Session): void => {
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
    session.reconnectDeadline = null;
  };

  const clearCliGraceTimer = (session: Session): void => {
    if (session.cliGraceTimer) {
      clearTimeout(session.cliGraceTimer);
      session.cliGraceTimer = null;
    }
    session.cliReconnectDeadline = null;
  };

  const terminateSession = (session: Session, reason: string): void => {
    clearReconnectTimer(session);
    clearCliGraceTimer(session);

    for (const [, tunnel] of session.tunnels) {
      if (tunnel.gcTimer) {
        clearTimeout(tunnel.gcTimer);
      }
      tunnel.cli?.close(1000, reason);
      tunnel.app?.close(1000, reason);
    }
    session.tunnels.clear();

    session.sockets.cli?.close(1000, reason);
    session.sockets.app?.close(1000, reason);
    if (session.password) {
      sessionsByPassword.delete(session.password);
      backupRegistrations.delete(session.password);
    }

    emitManagerMetrics();

    console.log(`[session] terminated (${reason})`);
  };

  const getTunnelQueue = (tunnel: ProxyTunnel, target: Role): Array<string | ArrayBuffer | Uint8Array> => {
    return target === "cli" ? tunnel.pendingToCli : tunnel.pendingToApp;
  };

  const getTunnelPendingBytes = (tunnel: ProxyTunnel, target: Role): number => {
    return target === "cli" ? tunnel.pendingBytesToCli : tunnel.pendingBytesToApp;
  };

  const setTunnelPendingBytes = (tunnel: ProxyTunnel, target: Role, value: number): void => {
    if (target === "cli") {
      tunnel.pendingBytesToCli = value;
    } else {
      tunnel.pendingBytesToApp = value;
    }
  };

  const clearTunnelGc = (tunnel: ProxyTunnel): void => {
    if (tunnel.gcTimer) {
      clearTimeout(tunnel.gcTimer);
      tunnel.gcTimer = null;
    }
  };

  const scheduleTunnelGc = (session: Session, tunnelId: string, tunnel: ProxyTunnel): void => {
    if (tunnel.gcTimer) return;
    tunnel.gcTimer = setTimeout(() => {
      const current = session.tunnels.get(tunnelId);
      if (!current) return;
      if (current.cli || current.app) {
        current.gcTimer = null;
        return;
      }
      session.tunnels.delete(tunnelId);
    }, PROXY_TUNNEL_GC_MS);
  };

  const flushTunnelQueue = (tunnel: ProxyTunnel, target: Role): void => {
    const ws = target === "cli" ? tunnel.cli : tunnel.app;
    if (!ws) return;
    const queue = getTunnelQueue(tunnel, target);
    if (queue.length === 0) return;

    while (queue.length > 0) {
      const frame = queue.shift()!;
      ws.send(frame);
      proxyTrafficOutBytesTotal += messageByteLength(frame);
    }
    setTunnelPendingBytes(tunnel, target, 0);
  };

  const enqueueTunnelMessage = (
    tunnel: ProxyTunnel,
    target: Role,
    message: string | ArrayBuffer | Uint8Array,
    bytes: number
  ): boolean => {
    const queue = getTunnelQueue(tunnel, target);
    const pendingBytes = getTunnelPendingBytes(tunnel, target);
    if (queue.length >= PROXY_TUNNEL_QUEUE_MAX_FRAMES) return false;
    if (pendingBytes + bytes > PROXY_TUNNEL_QUEUE_MAX_BYTES) return false;
    queue.push(message);
    setTunnelPendingBytes(tunnel, target, pendingBytes + bytes);
    return true;
  };

  const cleanupExpiredSessions = (): void => {
    const now = Date.now();
    for (const [token, entry] of managerSessionValidationCache) {
      if (entry.expiresAt <= now) managerSessionValidationCache.delete(token);
    }

    for (const [key, createdAt] of sessionHistory24h) {
      if (now - createdAt > 24 * 60 * 60 * 1000) {
        sessionHistory24h.delete(key);
      }
    }

    for (const [password, reg] of backupRegistrations) {
      if (now - reg.createdAt > RECONNECT_GRACE_MS) {
        backupRegistrations.delete(password);
        if (!sessionsByPassword.has(password)) {
          // no-op
        }
      }
    }

    for (const session of allSessions()) {
      if (!hasAnySockets(session) && now - session.createdAt > SAFETY_TTL_MS) {
        terminateSession(session, "safety TTL expired (no sockets)");
      }
    }
  };

  const getOrCreatePasswordSession = (password: string): Session | null => {
    const existing = sessionsByPassword.get(password);
    if (existing) return existing;

    const reg = backupRegistrations.get(password);
    if (!reg) {
      const session: Session = {
        code: null,
        password,
        createdAt: Date.now(),
        locked: false,
        role: "primary",
        backupGateway: ringSuccessorUrl,
        peerGateway: ringSuccessorUrl,
        reconnectDeadline: null,
        reconnectTimer: null,
        cliReconnectDeadline: null,
        cliGraceTimer: null,
        sockets: {
          cli: null,
          app: null,
        },
        tunnels: new Map(),
      };
      sessionsByPassword.set(password, session);
      sessionHistory24h.set(password, session.createdAt);
      return session;
    }

    const session: Session = {
      code: null,
      password,
      createdAt: reg.createdAt,
      locked: true,
      role: reg.role,
      backupGateway: reg.backupGateway,
      peerGateway: reg.peerGateway,
      reconnectDeadline: null,
      reconnectTimer: null,
      cliReconnectDeadline: null,
      cliGraceTimer: null,
      sockets: {
        cli: null,
        app: null,
      },
      tunnels: new Map(),
    };

    sessionsByPassword.set(password, session);
    sessionHistory24h.set(password, reg.createdAt);
    return session;
  };

  let proxyTrafficInBytesTotal = 0;
  let proxyTrafficOutBytesTotal = 0;
  let lastTrafficInBytes = 0;
  let lastTrafficOutBytes = 0;
  let lastTrafficSampleAt = Date.now();
  let lastCpuSample: { idle: number; total: number } | null = null;

  const sampleCpuPercent = (): number => {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) return 0;
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      const t = cpu.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    if (!lastCpuSample) {
      lastCpuSample = { idle, total };
      return 0;
    }
    const idleDelta = idle - lastCpuSample.idle;
    const totalDelta = total - lastCpuSample.total;
    lastCpuSample = { idle, total };
    if (totalDelta <= 0) return 0;
    const used = Math.max(0, totalDelta - idleDelta);
    return Math.min(100, (used / totalDelta) * 100);
  };

  const computeMetrics = (): {
    activeConnections: number;
    activeSessions: number;
    uniqueSessions24h: number;
    ts: number;
    cpuPercent: number;
    memoryUsedMb: number;
    memoryTotalMb: number;
    networkInBps: number;
    networkOutBps: number;
    lastTelemetry: number;
  } => {
    const sessions = allSessions();
    let activeConnections = 0;
    for (const session of sessions) {
      if (session.sockets.cli) activeConnections++;
      if (session.sockets.app) activeConnections++;
      for (const [, tunnel] of session.tunnels) {
        if (tunnel.cli) activeConnections++;
        if (tunnel.app) activeConnections++;
      }
    }

    const now = Date.now();
    let uniqueSessions24h = 0;
    for (const [, createdAt] of sessionHistory24h) {
      if (now - createdAt <= 24 * 60 * 60 * 1000) uniqueSessions24h++;
    }
    const elapsedSeconds = Math.max(1, (now - lastTrafficSampleAt) / 1000);
    const networkInBps = (proxyTrafficInBytesTotal - lastTrafficInBytes) / elapsedSeconds;
    const networkOutBps = (proxyTrafficOutBytesTotal - lastTrafficOutBytes) / elapsedSeconds;
    lastTrafficInBytes = proxyTrafficInBytesTotal;
    lastTrafficOutBytes = proxyTrafficOutBytesTotal;
    lastTrafficSampleAt = now;

    const memoryTotalMb = os.totalmem() / (1024 * 1024);
    const memoryUsedMb = (os.totalmem() - os.freemem()) / (1024 * 1024);
    const cpuPercent = sampleCpuPercent();

    return {
      activeConnections,
      activeSessions: sessions.length,
      uniqueSessions24h,
      ts: now,
      cpuPercent,
      memoryUsedMb,
      memoryTotalMb,
      networkInBps,
      networkOutBps,
      lastTelemetry: now,
    };
  };

  let managerControlWs: WebSocket | null = null;
  let managerControlReconnectTimer: Timer | null = null;
  let managerReadOnly = false;
  let managerHealthFailures = 0;
  // Events queued while manager WS is down; flushed on reconnect
  const pendingManagerEvents: GatewayControlEvent[] = [];

  const emitManagerEvent = (event: GatewayControlEvent): void => {
    const enriched = gatewayId ? { ...event, gatewayId } : event;
    if (!managerControlWs || managerControlWs.readyState !== WebSocket.OPEN) {
      // Queue connection/session events for replay; drop metrics (they go stale quickly)
      if ((event.type === "connection_event" || event.type === "session_event") &&
          pendingManagerEvents.length < PENDING_MANAGER_EVENTS_MAX) {
        pendingManagerEvents.push(enriched);
      }
      return;
    }
    managerControlWs.send(JSON.stringify(enriched));
  };

  const flushPendingManagerEvents = (): void => {
    if (pendingManagerEvents.length === 0) return;
    console.log(`[manager] flushing ${pendingManagerEvents.length} queued events`);
    const toFlush = pendingManagerEvents.splice(0);
    for (const event of toFlush) {
      try {
        managerControlWs?.send(JSON.stringify(event));
      } catch { /* ignore broken socket */ }
    }
  };

  const emitManagerConnectionEvent = (
    session: Session,
    action: "socket_connected" | "socket_disconnected" | "session_end_requested",
    extra: Partial<GatewayControlEvent> = {}
  ): void => {
    if (!session.password || !publicUrl) return;
    emitManagerEvent({
      type: "connection_event",
      eventId: randomUUID(),
      gateway: publicUrl,
      ts: Date.now(),
      resumeToken: session.password,
      connectionAction: action,
      ...extra,
    });
  };

  const emitManagerMetrics = (): void => {
    if (!publicUrl) return;
    const metrics = computeMetrics();
    emitManagerEvent({
      type: "proxy_metrics",
      gateway: publicUrl,
      ...metrics,
    });
  };

  const scheduleManagerReconnect = (): void => {
    if (managerControlReconnectTimer) return;
    managerControlReconnectTimer = setTimeout(() => {
      managerControlReconnectTimer = null;
      connectManagerControl();
    }, 1500);
  };

  const connectManagerControl = (): void => {
    if (!managerUrl || !proxyPassword || !publicUrl) {
      console.error("[manager-control] cannot connect — missing MANAGER_URL, PROXY_PASSWORD, or PUBLIC_URL");
      return;
    }
    const wsUrl = `${managerUrl.replace(/^https:/, "wss:")}/v1/gateway/ws`;
    console.log(`[manager-control] connecting to ${wsUrl} as ${publicUrl}...`);
    const ws = new WebSocket(wsUrl);
    managerControlWs = ws;

    ws.onopen = () => {
      console.log(`[manager-control] connected to ${managerUrl}`);
      emitManagerEvent({
        type: "gateway_auth",
        password: proxyPassword,
        gateway: publicUrl,
        gatewayId: gatewayId || undefined,
      });
      const metrics = computeMetrics();
      emitManagerEvent({
        type: "gateway_hello",
        gateway: publicUrl,
        ...metrics,
      });
      // Replay any events that were queued while the manager was unreachable
      flushPendingManagerEvents();
    };

    ws.onclose = (evt) => {
      if (managerControlWs === ws) managerControlWs = null;
      const reason = evt.reason ? ` — reason: ${evt.reason}` : "";
      const code = evt.code !== 1000 ? ` (code ${evt.code})` : "";
      if (evt.code === 1008) {
        console.error(`[manager-control] auth rejected by manager${reason} — check PROXY_PASSWORD matches what was entered in the UI`);
      } else {
        console.warn(`[manager-control] disconnected${code}${reason} — will reconnect in 1.5s`);
        scheduleManagerReconnect();
      }
    };

    ws.onerror = (evt) => {
      console.error(`[manager-control] WebSocket error connecting to ${managerUrl} — is the manager reachable?`, (evt as any).message ?? "");
    };

    ws.onmessage = (evt) => {
      try {
        const raw = typeof evt.data === "string" ? evt.data : String(evt.data || "");
        const event = JSON.parse(raw) as GatewayControlEvent;
        if (event.type !== "manager_command") return;

        // Ring update: no resumeToken needed, just update local ring state
        if (event.command === "ring_update") {
          const newRing = Array.isArray(event.ring) ? (event.ring as string[]) : [];
          ringMembership = newRing;
          const myIdx = publicUrl ? newRing.findIndex((url) => url === publicUrl) : -1;
          const prevSuccessor = ringSuccessorUrl;
          ringSuccessorUrl = myIdx >= 0 && newRing.length > 1 ? newRing[(myIdx + 1) % newRing.length] : null;
          if (ringSuccessorUrl !== prevSuccessor) {
            console.log(`[ring] updated — position ${myIdx + 1}/${newRing.length}, successor: ${ringSuccessorUrl ?? "none"}`);
          }
          return;
        }

        const resumeToken = event.resumeToken || "";
        if (!resumeToken) return;
        const session = sessionsByPassword.get(resumeToken) || getOrCreatePasswordSession(resumeToken);
        if (!session) return;

        if (event.command === "clear_reconnect_grace") {
          clearReconnectTimer(session);
          return;
        }

        if (event.command === "set_reconnect_grace") {
          clearReconnectTimer(session);
          const deadline = Number(event.reconnectDeadline || 0);
          if (deadline > Date.now()) {
            session.reconnectDeadline = deadline;
            session.sockets.cli?.send(
              JSON.stringify({
                type: "app_disconnected",
                reconnectDeadline: session.reconnectDeadline,
              })
            );
          }
          return;
        }

        if (event.command === "set_cli_reconnect_grace") {
          clearCliGraceTimer(session);
          const deadline = Number(event.reconnectDeadline || 0);
          if (deadline > Date.now()) {
            session.cliReconnectDeadline = deadline;
            session.sockets.app?.send(
              JSON.stringify({ type: "cli_reconnecting", reconnectDeadline: deadline })
            );
            session.cliGraceTimer = setTimeout(() => {
              session.cliGraceTimer = null;
              session.cliReconnectDeadline = null;
              sendSystemMessage(session.sockets.app, "peer_disconnected", { peer: "cli" });
              terminateSession(session, "cli offline grace expired");
            }, deadline - Date.now());
          }
          return;
        }

        if (event.command === "close_session") {
          const reason = event.reason || "closed by manager";
          session.sockets.cli?.send(
            JSON.stringify({
              type: "close_connection",
              reason,
            })
          );
          terminateSession(session, reason);
          return;
        }
      } catch {
        // ignore malformed manager -> gateway commands
      }
    };
  };

  const checkManagerHealth = async (): Promise<void> => {
    if (!managerUrl) return;
    try {
      const res = await fetch(`${managerUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        if (managerReadOnly) console.log("[manager] health restored — back online, exiting read-only mode");
        managerHealthFailures = 0;
        managerReadOnly = false;
      } else {
        managerHealthFailures++;
        if (managerHealthFailures >= MANAGER_HEALTH_FAILURES_BEFORE_READONLY && !managerReadOnly) {
          console.warn(`[manager] health check returned ${res.status} from ${managerUrl} — entering read-only mode (sessions will still work locally)`);
          managerReadOnly = true;
        }
      }
    } catch {
      managerHealthFailures++;
      if (managerHealthFailures >= MANAGER_HEALTH_FAILURES_BEFORE_READONLY && !managerReadOnly) {
        console.warn(`[manager] unreachable (${managerUrl}) — entering read-only mode (sessions will still work locally)`);
        managerReadOnly = true;
      }
    }
  };

  setInterval(cleanupExpiredSessions, 5 * 60 * 1000);
  setInterval(() => emitManagerMetrics(), ANALYTICS_INTERVAL_MS);
  setInterval(() => void checkManagerHealth(), MANAGER_HEALTH_CHECK_INTERVAL_MS);

  const server = Bun.serve<WebSocketData>({
    port: process.env.PORT || 3000,

    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (path === "/health") {
        const myIdx = publicUrl ? ringMembership.findIndex((u) => u === publicUrl) : -1;
        return Response.json({
          status: "ok",
          mode: "gateway",
          managerReachable: !managerReadOnly,
          pendingEvents: pendingManagerEvents.length,
          ring: {
            size: ringMembership.length,
            position: myIdx >= 0 ? myIdx + 1 : null,
            successor: ringSuccessorUrl,
          },
        }, { headers: corsHeaders });
      }

      if (path === "/v1/ping" && req.method === "GET") {
        const provided = req.headers.get("x-proxy-password") || "";
        if (!proxyPassword || provided !== proxyPassword) {
          return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
        }
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      if (path === "/v1/connect" && req.method === "POST") {
        const provided = req.headers.get("x-proxy-password") || "";
        if (!proxyPassword || provided !== proxyPassword) {
          return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
        }
        if (managerControlWs && managerControlWs.readyState === WebSocket.OPEN) {
          return Response.json({ ok: true, status: "already_connected" }, { headers: corsHeaders });
        }
        connectManagerControl();
        return Response.json({ ok: true, status: "connecting" }, { headers: corsHeaders });
      }

      if (path === "/v1/session/preload" && req.method === "POST") {
        const provided = req.headers.get("x-proxy-password") || "";
        if (proxyPassword && provided !== proxyPassword) {
          console.warn(`[proxy] rejected request — wrong X-Proxy-Password on ${path}`);
          return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
        }

        return req
          .json()
          .then((body: Partial<BackupRegistration> & { role?: "primary" | "secondary"; peerGateway?: string | null }) => {
            const password = typeof body.password === "string" ? body.password : "";
            if (!password || password.length !== SESSION_PASSWORD_LENGTH) {
              return Response.json({ error: "invalid password" }, { status: 400, headers: corsHeaders });
            }

            const role = body.role === "secondary" ? "secondary" : "primary";

            const registration: BackupRegistration = {
              password,
              createdAt: Number(body.createdAt || Date.now()),
              role,
              backupGateway: normalizeGatewayUrl(body.backupGateway || null),
              peerGateway: normalizeGatewayUrl(body.peerGateway || null),
            };
            backupRegistrations.set(password, registration);
            if (!sessionsByPassword.has(password)) {
              getOrCreatePasswordSession(password);
            }
            return Response.json({ ok: true }, { headers: corsHeaders });
          })
          .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
      }

      if (path === "/v1/session/close" && req.method === "POST") {
        const provided = req.headers.get("x-proxy-password") || "";
        if (proxyPassword && provided !== proxyPassword) {
          console.warn(`[proxy] rejected request — wrong X-Proxy-Password on ${path}`);
          return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
        }

        return req
          .json()
          .then((body: { password?: string }) => {
            const password = body.password || "";
            if (!password) {
              return Response.json({ error: "password is required" }, { status: 400, headers: corsHeaders });
            }
            const session = sessionsByPassword.get(password);
            if (session) {
              terminateSession(session, "closed by primary");
            } else {
              backupRegistrations.delete(password);
            }
            return Response.json({ ok: true }, { headers: corsHeaders });
          })
          .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
      }

      if (path === "/v1/session/alias" && req.method === "POST") {
        const provided = req.headers.get("x-proxy-password") || "";
        if (proxyPassword && provided !== proxyPassword) {
          console.warn(`[proxy] rejected request — wrong X-Proxy-Password on ${path}`);
          return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
        }

        return req
          .json()
          .then((body: { fromPassword?: string; toPassword?: string }) => {
            const fromPassword = typeof body.fromPassword === "string" ? body.fromPassword.trim() : "";
            const toPassword = typeof body.toPassword === "string" ? body.toPassword.trim() : "";
            if (!fromPassword || !toPassword) {
              return Response.json({ error: "fromPassword and toPassword are required" }, { status: 400, headers: corsHeaders });
            }
            if (fromPassword === toPassword) {
              return Response.json({ ok: true, status: "noop" }, { headers: corsHeaders });
            }

            const existingTarget = sessionsByPassword.get(toPassword);
            if (existingTarget && existingTarget.password !== fromPassword) {
              return Response.json({ error: "target password already in use" }, { status: 409, headers: corsHeaders });
            }

            const sourceSession = sessionsByPassword.get(fromPassword);
            const sourceRegistration = backupRegistrations.get(fromPassword);
            const targetRegistration = backupRegistrations.get(toPassword);

            if (!sourceSession && !sourceRegistration) {
              return Response.json({ ok: true, status: "missing_source" }, { headers: corsHeaders });
            }

            if (sourceSession) {
              sessionsByPassword.delete(fromPassword);
              sourceSession.password = toPassword;
              sessionsByPassword.set(toPassword, sourceSession);
            }

            if (sourceRegistration) {
              backupRegistrations.delete(fromPassword);
              backupRegistrations.set(toPassword, {
                ...sourceRegistration,
                password: toPassword,
              });
            } else if (sourceSession && !targetRegistration) {
              backupRegistrations.set(toPassword, {
                password: toPassword,
                createdAt: sourceSession.createdAt,
                role: sourceSession.role,
                backupGateway: sourceSession.backupGateway,
                peerGateway: sourceSession.peerGateway,
              });
            }

            const existingHistory = sessionHistory24h.get(fromPassword);
            if (typeof existingHistory === "number") {
              sessionHistory24h.delete(fromPassword);
              sessionHistory24h.set(toPassword, existingHistory);
            }

            console.log("[session] aliased password", redactSensitive({
              fromPassword,
              toPassword,
              hasLiveSession: Boolean(sourceSession),
              hasRegistration: Boolean(sourceRegistration),
            }));

            return Response.json({ ok: true, status: "aliased" }, { headers: corsHeaders });
          })
          .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
      }

      const wsV2Match = path.match(/^\/v2\/ws\/(cli|app)$/);
      if (wsV2Match) {
        if (!isTrustedRequestOrigin(req)) {
          return Response.json({ error: "untrusted origin" }, { status: 403, headers: corsHeaders });
        }
        const role = wsV2Match[1] as Role;
        const password = (req.headers.get("x-session-password") || url.searchParams.get("password") || "").trim();
        const rawGeneration = Number(url.searchParams.get("generation") || "0");
        const generation = Number.isFinite(rawGeneration) && rawGeneration > 0 ? rawGeneration : null;

        if (!password) {
          return Response.json({ error: "password is required" }, { status: 400, headers: corsHeaders });
        }
        const authority = await isManagerPasswordAllowed(password, role, generation);
        if (!authority.allowed) {
          return Response.json(
            { error: "password not authorized by manager", reason: authority.reason },
            { status: 403, headers: corsHeaders }
          );
        }

        const session = getOrCreatePasswordSession(password);
        if (!session) {
          return Response.json({ error: "invalid or expired session" }, { status: 404, headers: corsHeaders });
        }

        if (session.sockets[role] !== null) {
          return Response.json({ error: `${role} already connected` }, { status: 409, headers: corsHeaders });
        }

        const upgraded = server.upgrade(req, {
          data: {
            type: "session-v2" as const,
            password: session.password!,
            role,
            generation,
          },
        });

        if (!upgraded) {
          return Response.json({ error: "upgrade failed" }, { status: 500, headers: corsHeaders });
        }
        return undefined;
      }

      if (path === "/v1/ws/proxy") {
        if (!isTrustedRequestOrigin(req)) {
          return Response.json({ error: "untrusted origin" }, { status: 403, headers: corsHeaders });
        }
        const password = (req.headers.get("x-session-password") || url.searchParams.get("password") || "").trim();
        const tunnelId = url.searchParams.get("tunnelId");
        const role = url.searchParams.get("role") as Role | null;

        if (!tunnelId || !role || (role !== "cli" && role !== "app") || !password) {
          return Response.json({ error: "missing tunnelId/role and password" }, { status: 400, headers: corsHeaders });
        }
        const authority = await isManagerPasswordAllowed(password);
        if (!authority.allowed) {
          return Response.json(
            { error: "password not authorized by manager", reason: authority.reason },
            { status: 403, headers: corsHeaders }
          );
        }

        const session = sessionsByPassword.get(password) || getOrCreatePasswordSession(password);
        if (!session) {
          return Response.json({ error: "invalid or expired session" }, { status: 404, headers: corsHeaders });
        }

        if (!session.password) {
          return Response.json({ error: "session password not ready" }, { status: 403, headers: corsHeaders });
        }

        if (!session.tunnels.has(tunnelId)) {
          session.tunnels.set(tunnelId, {
            cli: null,
            app: null,
            pendingToCli: [],
            pendingToApp: [],
            pendingBytesToCli: 0,
            pendingBytesToApp: 0,
            gcTimer: null,
          });
        }

        const tunnel = session.tunnels.get(tunnelId)!;
        if (tunnel[role] !== null) {
          return Response.json({ error: `${role} already connected for tunnel ${tunnelId}` }, { status: 409, headers: corsHeaders });
        }

        const upgraded = server.upgrade(req, {
          data: {
            type: "proxy" as const,
            sessionPassword: session.password,
            tunnelId,
            role,
          },
        });

        if (!upgraded) {
          return Response.json({ error: "upgrade failed" }, { status: 500, headers: corsHeaders });
        }
        return undefined;
      }

      return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
    },

    websocket: {
      open(ws) {
        const data = ws.data;

        if (data.type === "proxy") {
          const session = sessionsByPassword.get(data.sessionPassword);
          if (!session) {
            ws.close(1008, "session not found");
            return;
          }
          const tunnel = session.tunnels.get(data.tunnelId);
          if (!tunnel) {
            ws.close(1008, "tunnel not found");
            return;
          }
          clearTunnelGc(tunnel);
          tunnel[data.role] = ws as ServerWebSocket<ProxyWebSocketData>;
          flushTunnelQueue(tunnel, data.role);
          console.log(`[proxy] ${data.role} connected: tunnel=${data.tunnelId}`);
          return;
        }

        if (data.type === "session-v2") {
          const session = sessionsByPassword.get(data.password);
          if (!session) {
            ws.close(1008, "session not found");
            return;
          }

          session.sockets[data.role] = ws as ServerWebSocket<SessionV2WebSocketData>;
          console.log(`[ws] ${data.role} connected`);

          sendSystemMessage(ws, "connected", { role: data.role });
          emitManagerConnectionEvent(session, "socket_connected", {
            role: data.role,
            channel: "session",
            connected: true,
            protocol: "v2",
            generation: data.generation ?? undefined,
          });

          if (data.role === "app") {
            clearReconnectTimer(session);
          }

          if (data.role === "cli") {
            clearCliGraceTimer(session);
          }

          if (data.role === "app" && !session.locked && isPeerConnected(session, "app")) {
            session.locked = true;
            console.log("[session] locked");
          }

          const opposite = getOppositeRole(data.role);
          if (isPeerConnected(session, opposite)) {
            session.sockets[opposite]?.send(JSON.stringify({ type: "peer_connected", peer: data.role }));
            session.sockets[data.role]?.send(JSON.stringify({ type: "peer_connected", peer: opposite }));
            emitManagerMetrics();
          }
          return;
        }
      },

      message(ws, message) {
        const data = ws.data;
        const bytes = messageByteLength(message as any);
        proxyTrafficInBytesTotal += bytes;

        if (data.type === "proxy") {
          const session = sessionsByPassword.get(data.sessionPassword);
          if (!session) {
            ws.close(1008, "session not found");
            return;
          }
          const tunnel = session.tunnels.get(data.tunnelId);
          if (!tunnel) {
            ws.close(1008, "tunnel not found");
            return;
          }
          const control = parseProxyControlMessage(message as string | ArrayBuffer | Uint8Array);
          const opposite = getOppositeRole(data.role);
          const target = tunnel[opposite];
          if (control?.action === "rst") {
            if (target) {
              target.send(message);
              target.close(1011, control.reason || "peer reset");
            }
            ws.close(1011, control.reason || "reset");
            return;
          }
          if (target) {
            target.send(message);
            proxyTrafficOutBytesTotal += bytes;
          } else {
            const forwarded = enqueueTunnelMessage(tunnel, opposite, message as string | ArrayBuffer | Uint8Array, bytes);
            if (!forwarded) {
              ws.send(makeProxyControlMessage("rst", "peer_queue_overflow"));
              ws.close(1011, "peer queue overflow");
            }
          }
          return;
        }

        if (data.type === "session-v2") {
          const session = sessionsByPassword.get(data.password);
          if (!session) {
            ws.close(1008, "session not found");
            return;
          }

          if (typeof message === "string") {
            try {
              const parsed = JSON.parse(message) as {
                v?: number;
                id?: string;
                ns?: string;
                action?: string;
                payload?: Record<string, unknown>;
              };

              if (
                data.role === "app" &&
                parsed.v === 1 &&
                typeof parsed.id === "string" &&
                parsed.ns === "system" &&
                parsed.action === "end_session"
              ) {
                ws.send(
                  JSON.stringify({
                    v: 1,
                    id: parsed.id,
                    ns: "system",
                    action: "end_session",
                    ok: true,
                    payload: { ended: true },
                  })
                );
                emitManagerConnectionEvent(session, "session_end_requested", {
                  reason: "session ended from app",
                  role: "app",
                  channel: "session",
                  protocol: "v2",
                });
                return;
              }
            } catch {
              // Ignore JSON parse failures and forward the original payload.
            }
          }

          const messageSize = typeof message === "string" ? message.length : message.byteLength;
          if (messageSize > SESSION_V2_MAX_SIZE) {
            ws.close(1009, "message too large");
            return;
          }

          const opposite = getOppositeRole(data.role);
          const target = session.sockets[opposite];
          if (target) {
            target.send(message);
            proxyTrafficOutBytesTotal += bytes;
          } else {
            sendSystemMessage(ws, "peer_disconnected", { peer: opposite });
          }
          return;
        }
      },

      close(ws) {
        const data = ws.data;

        if (data.type === "proxy") {
          const session = sessionsByPassword.get(data.sessionPassword);
          if (!session) return;
          const tunnel = session.tunnels.get(data.tunnelId);
          if (!tunnel) return;

          console.log(`[proxy] ${data.role} disconnected: tunnel=${data.tunnelId}`);
          tunnel[data.role] = null;

          const opposite = getOppositeRole(data.role);
          const peer = tunnel[opposite];
          if (peer) {
            try {
              peer.send(makeProxyControlMessage("rst", "peer_disconnected"));
            } catch {
              // ignore send failures during close
            }
            peer.close(1000, "peer disconnected");
          }
          scheduleTunnelGc(session, data.tunnelId, tunnel);
          return;
        }

        if (data.type === "session-v2") {
          const session = sessionsByPassword.get(data.password);
          if (!session) return;

          session.sockets[data.role] = null;
          emitManagerConnectionEvent(session, "socket_disconnected", {
            role: data.role,
            channel: "session",
            connected: false,
            protocol: "v2",
            generation: data.generation ?? undefined,
          });

          if (!isPeerConnected(session, data.role)) {
            session.locked = false;
          }

          if (data.role === "cli" && !hasAnyRoleSockets(session, "cli")) {
            clearCliGraceTimer(session);
            const deadline = Date.now() + CLI_OFFLINE_GRACE_MS;
            session.cliReconnectDeadline = deadline;
            const appSocket = session.sockets.app;
            if (appSocket) {
              sendSystemMessage(appSocket, "cli_reconnecting", { reconnectDeadline: deadline });
            }
            session.cliGraceTimer = setTimeout(() => {
              session.cliGraceTimer = null;
              session.cliReconnectDeadline = null;
              const appPeer = session.sockets.app;
              if (appPeer) {
                sendSystemMessage(appPeer, "peer_disconnected", { peer: "cli" });
              }
              terminateSession(session, "cli offline grace expired");
            }, CLI_OFFLINE_GRACE_MS);
          } else if (data.role === "app") {
            const cliSocket = session.sockets.cli;
            if (cliSocket) {
              sendSystemMessage(cliSocket, "peer_disconnected", { peer: "app" });
            }
          }

          if (!hasAnyRoleSockets(session, "cli") && !hasAnyRoleSockets(session, "app")) {
            clearReconnectTimer(session);
            clearCliGraceTimer(session);
          }
          emitManagerMetrics();
          return;
        }
      },
    },
  });

  console.log(`[proxy] started — port=${server.port} | public=${publicUrl ?? "not set"} | manager=${managerUrl ?? "none"}`);
}

startGateway();
