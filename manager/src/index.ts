import type { ServerWebSocket } from "bun";
import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { existsSync, rmSync } from "fs";

const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const CODE_LENGTH = 10;
const SESSION_PASSWORD_LENGTH = 67;
const CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const RECONNECT_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week (app closed grace)
const CLI_OFFLINE_GRACE_MS = 5 * 60 * 1000; // 5 minutes (CLI offline grace, public tier)
const VM_HEARTBEAT_STALE_MS = 30_000; // 30 seconds before a VM is considered dead (cloud tier)
const SAFETY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const CONTROL_MAX_SIZE = 64 * 1024; // 64KB
const ANALYTICS_INTERVAL_MS = 15_000;
const MANAGER_ADMIN_TOKEN_AUDIENCE = "lunel-manager-admin";
const MANAGER_ADMIN_TOKEN_ISSUER = "lunel-manager";
const MANAGER_ADMIN_TOKEN_TTL_S = 12 * 60 * 60;
const STALE_GATEWAY_MS = 45_000; // 3 missed heartbeats at 15s interval; aligns with client retry budget
const GATEWAY_EVENT_DEDUPE_MS = 10 * 60 * 1000;
const DEFAULT_RESUME_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MANAGER_AUTHORITY_CACHE_MS = 5000;
const PROXY_TUNNEL_QUEUE_MAX_BYTES = 2 * 1024 * 1024; // 2MB per direction
const PROXY_TUNNEL_QUEUE_MAX_FRAMES = 512;
const PROXY_TUNNEL_GC_MS = 15_000;
const V2_PASSWORD_LENGTH = 256;
const V2_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

type Role = "cli" | "app";
type Channel = "control" | "data" | "session";

type Timer = ReturnType<typeof setTimeout>;

interface SessionWebSocketData {
  type: "session";
  code: string | null;
  password: string | null;
  role: Role;
  channel: Channel;
}

interface ProxyWebSocketData {
  type: "proxy";
  sessionPassword: string;
  tunnelId: string;
  role: Role;
}

interface AssembleWebSocketData {
  type: "assemble";
  code: string;
  role: Role;
}

type WebSocketData = SessionWebSocketData | ProxyWebSocketData | AssembleWebSocketData;

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
  sockets: {
    cli: { control: ServerWebSocket<SessionWebSocketData> | null; data: ServerWebSocket<SessionWebSocketData> | null };
    app: { control: ServerWebSocket<SessionWebSocketData> | null; data: ServerWebSocket<SessionWebSocketData> | null };
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

interface ManagerSession {
  sessionId: string;
  code: string;
  resumeToken: string;
  primary: string;
  backup: string | null;
  state: "pending" | "active" | "app_offline_grace" | "cli_offline_grace" | "ended" | "expired";
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  endedAt: number | null;
}

interface SessionRow {
  session_id?: string;
  code?: string;
  resume_token?: string;
  primary_gateway?: string;
  backup_gateway?: string | null;
  state?: SessionState;
  reconnect_deadline?: number | null;
  created_at?: number;
  updated_at?: number;
  expires_at?: number;
  paired_at?: number | null;
  ended_at?: number | null;
}

interface VmHeartbeat {
  sandboxId: string;
  resumeToken: string;
  sandmanUrl: string;
  repoUrl: string;
  branch: string;
  vmProfile: string;
  lastHeartbeat: number;
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
  token?: string;
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
  channel?: Channel;
  connected?: boolean;
  reason?: string;
  eventId?: string;
  generation?: number;
}

interface ManagerAdminTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  role: "admin";
}

interface ManagerControlSocketData {
  type: "manager-control";
  authed: boolean;
  gatewayId?: string;
  gatewayUrl?: string;
}

type GatewaySocketData = WebSocketData | ManagerControlSocketData;
type GatewaySocket = ServerWebSocket<GatewaySocketData>;

interface AssembleSession {
  code: string;
  createdAt: number;
  expiresAt: number;
  password: string | null;
  appWs: GatewaySocket | null;
  cliWs: GatewaySocket | null;
  appAcked: boolean;
  cliAcked: boolean;
}

interface IssuedPasswordRecord {
  code: string;
  passwordHash: string;
  proxyUrl: string | null;
  issuedAt: number;
  expiresAt: number;
}

interface ReattachSessionRow {
  resumeToken?: string;
  generation?: number;
  proxyUrl?: string | null;
  waitingFor?: "app" | "cli" | "both" | "none";
  appAttached?: number;
  cliAttached?: number;
  createdAt?: number;
  updatedAt?: number;
  expiresAt?: number;
}

class Mutex {
  #locked = false;
  #waiters: Array<() => void> = [];

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next();
      return;
    }
    this.#locked = false;
  }
}

type SessionState = "pending" | "active" | "app_offline_grace" | "cli_offline_grace" | "ended" | "expired";

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
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Proxy-Password, X-Manager-Password",
};

function corsHeadersForRequest(req: Request): Record<string, string> {
  const originHeader = req.headers.get("origin");
  if (originHeader && isTrustedRequestOrigin(req)) {
    return {
      ...corsHeaders,
      "Access-Control-Allow-Origin": originHeader,
      Vary: "Origin",
    };
  }
  return { ...corsHeaders };
}

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

function generateSessionPassword(): string {
  let out = "";
  while (out.length < SESSION_PASSWORD_LENGTH) {
    out += randomBytes(64).toString("base64").replace(/=/g, "");
  }
  return out.slice(0, SESSION_PASSWORD_LENGTH);
}

function generatePersistentSecret(length = 256): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function isPeerFullyConnected(session: Session, role: Role): boolean {
  return session.sockets[role].control !== null && session.sockets[role].data !== null;
}

function getOppositeRole(role: Role): Role {
  return role === "cli" ? "app" : "cli";
}

function sendSystemMessage(ws: ServerWebSocket<WebSocketData>, type: string, payload: Record<string, unknown> = {}): void {
  ws.send(JSON.stringify({ type, ...payload }));
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

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? "=".repeat(4 - pad) : "");
  return Buffer.from(padded, "base64");
}

function signJwtToken(claims: object, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${toBase64Url(signature)}`;
}

function websocketMessageToString(message: string | Buffer | Uint8Array | ArrayBuffer): string {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return Buffer.from(message).toString("utf-8");
  }
  return Buffer.from(message).toString("utf-8");
}

function verifyJwtToken(
  token: string,
  secret: string,
  expectedAudience: string,
  expectedIssuer: string
): (Record<string, unknown> & { iss: string; aud: string; sub: string; iat: number; exp: number }) | null {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  try {
    const header = JSON.parse(fromBase64Url(encodedHeader).toString("utf-8")) as {
      alg?: string;
      typ?: string;
    };
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const expectedSig = createHmac("sha256", secret).update(signingInput).digest();
    const actualSig = fromBase64Url(encodedSig);
    if (expectedSig.length !== actualSig.length) return null;
    if (!timingSafeEqual(expectedSig, actualSig)) return null;

    const claims = JSON.parse(fromBase64Url(encodedPayload).toString("utf-8")) as {
      iss?: unknown;
      aud?: unknown;
      sub?: unknown;
      iat?: unknown;
      exp?: unknown;
      [k: string]: unknown;
    };
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== expectedIssuer) return null;
    if (claims.aud !== expectedAudience) return null;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) return null;
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
    if (claims.exp <= now || claims.iat > now + 30) return null;
    return claims as any;
  } catch {
    return null;
  }
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

function startManager(): void {
  const managerAdminPassword = process.env.MANAGER_ADMIN_PASSWORD || "";
  if (!managerAdminPassword) {
    console.error("MANAGER_ADMIN_PASSWORD is required");
    process.exit(1);
  }
  const managerAdminTokenSecret = managerAdminPassword;
  const allowLegacyAdminPassword = process.env.MANAGER_ALLOW_LEGACY_ADMIN_PASSWORD === "1";
  const auditRetentionDays = Math.max(1, Number(process.env.MANAGER_AUDIT_RETENTION_DAYS || 30));
  const resumeTokenTtlMs = Math.max(
    60_000,
    Number(process.env.MANAGER_RESUME_TOKEN_TTL_MS || DEFAULT_RESUME_TOKEN_TTL_MS)
  );
  const configured = (process.env.PROXIES || "")
    .split(",")
    .map((x) => normalizeGatewayUrl(x.trim()))
    .filter((x): x is string => !!x);
  const sandmanAuthToken = (process.env.SANDMAN_AUTH_TOKEN || "").trim();
  const sandmanPublicUrl = normalizeGatewayUrl(process.env.SANDMAN_URL || "") || "";
  const dbPath = process.env.MANAGER_DB_PATH || "manager.db";
  const resetManagerState = process.argv.includes("--new");

  if (resetManagerState) {
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (!existsSync(path)) continue;
      rmSync(path, { force: true });
    }
    console.log(`[manager] starting fresh with --new; removed ${dbPath} and sqlite sidecars if present`);
  }

  const db = new Database(dbPath, {
    create: true,
    strict: true,
  });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS proxies (
      url TEXT PRIMARY KEY,
      password TEXT NOT NULL DEFAULT '',
      gateway_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active',
      state_source TEXT NOT NULL DEFAULT 'manual',
      active_connections INTEGER NOT NULL DEFAULT 0,
      active_sessions INTEGER NOT NULL DEFAULT 0,
      unique_sessions_24h INTEGER NOT NULL DEFAULT 0,
      last_heartbeat INTEGER NOT NULL DEFAULT 0,
      cpu_percent REAL NOT NULL DEFAULT 0,
      memory_used_mb REAL NOT NULL DEFAULT 0,
      memory_total_mb REAL NOT NULL DEFAULT 0,
      network_in_bps REAL NOT NULL DEFAULT 0,
      network_out_bps REAL NOT NULL DEFAULT 0,
      last_telemetry INTEGER NOT NULL DEFAULT 0
    );
  `);
  try {
    db.run(`ALTER TABLE proxies ADD COLUMN password TEXT NOT NULL DEFAULT ''`);
  } catch {}
  try {
    db.run(`ALTER TABLE proxies ADD COLUMN gateway_id TEXT NOT NULL DEFAULT ''`);
  } catch {}
  try {
    db.run(`ALTER TABLE proxies ADD COLUMN state TEXT NOT NULL DEFAULT 'active'`);
  } catch {
    // Column already exists for upgraded databases.
  }
  try {
    db.run(`ALTER TABLE proxies ADD COLUMN state_source TEXT NOT NULL DEFAULT 'manual'`);
  } catch {}
  try {
    db.run(`ALTER TABLE proxies ADD COLUMN cpu_percent REAL NOT NULL DEFAULT 0`);
  } catch {}
  try {
    db.run(`ALTER TABLE proxies ADD COLUMN memory_used_mb REAL NOT NULL DEFAULT 0`);
  } catch {}
  try {
    db.run(`ALTER TABLE proxies ADD COLUMN memory_total_mb REAL NOT NULL DEFAULT 0`);
  } catch {}
  try {
    db.run(`ALTER TABLE proxies ADD COLUMN network_in_bps REAL NOT NULL DEFAULT 0`);
  } catch {}
  try {
    db.run(`ALTER TABLE proxies ADD COLUMN network_out_bps REAL NOT NULL DEFAULT 0`);
  } catch {}
  try {
    db.run(`ALTER TABLE proxies ADD COLUMN last_telemetry INTEGER NOT NULL DEFAULT 0`);
  } catch {}
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      resume_token TEXT UNIQUE NOT NULL,
      primary_gateway TEXT NOT NULL,
      backup_gateway TEXT,
      state TEXT NOT NULL,
      reconnect_deadline INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      paired_at INTEGER,
      ended_at INTEGER
    );
  `);
  try {
    db.run(`ALTER TABLE sessions ADD COLUMN paired_at INTEGER`);
  } catch {}
  db.run(`
    CREATE TABLE IF NOT EXISTS pairings (
      secret TEXT PRIMARY KEY,
      pc_id TEXT NOT NULL,
      phone_id TEXT NOT NULL,
      root TEXT NOT NULL,
      hostname TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      paired_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      source_ip TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS security_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      alert_key TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS gateway_instances (
      gateway_id TEXT PRIMARY KEY,
      gateway_url TEXT NOT NULL,
      status TEXT NOT NULL,
      connected_at INTEGER NOT NULL,
      disconnected_at INTEGER,
      last_seen INTEGER NOT NULL,
      last_error TEXT NOT NULL DEFAULT ''
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS session_runtime (
      resume_token TEXT PRIMARY KEY,
      cli_control INTEGER NOT NULL DEFAULT 0,
      cli_data INTEGER NOT NULL DEFAULT 0,
      app_control INTEGER NOT NULL DEFAULT 0,
      app_data INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS vm_heartbeats (
      sandbox_id TEXT PRIMARY KEY,
      resume_token TEXT NOT NULL,
      sandman_url TEXT NOT NULL DEFAULT '',
      repo_url TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '',
      vm_profile TEXT NOT NULL DEFAULT '',
      last_heartbeat INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS reattach_sessions (
      resume_token TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      proxy_url TEXT,
      waiting_for TEXT NOT NULL DEFAULT 'none',
      app_attached INTEGER NOT NULL DEFAULT 0,
      cli_attached INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  const upsertProxyStmt = db.query(`
    INSERT INTO proxies (
      url, gateway_id, state, state_source, active_connections, active_sessions, unique_sessions_24h, last_heartbeat,
      cpu_percent, memory_used_mb, memory_total_mb, network_in_bps, network_out_bps, last_telemetry
    )
    VALUES (?1, ?2, COALESCE(?3, 'active'), COALESCE(?4, 'manual'), ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    ON CONFLICT(url) DO UPDATE SET
      gateway_id = COALESCE(NULLIF(excluded.gateway_id, ''), proxies.gateway_id),
      state_source = CASE
        WHEN proxies.state = 'draining' AND proxies.state_source = 'auto_stale' AND excluded.last_heartbeat > proxies.last_heartbeat
          THEN 'heartbeat_recovered'
        ELSE proxies.state_source
      END,
      state = CASE
        WHEN proxies.state = 'draining' AND proxies.state_source = 'auto_stale' AND excluded.last_heartbeat > proxies.last_heartbeat
          THEN 'active'
        ELSE proxies.state
      END,
      active_connections = excluded.active_connections,
      active_sessions = excluded.active_sessions,
      unique_sessions_24h = excluded.unique_sessions_24h,
      last_heartbeat = excluded.last_heartbeat,
      cpu_percent = excluded.cpu_percent,
      memory_used_mb = excluded.memory_used_mb,
      memory_total_mb = excluded.memory_total_mb,
      network_in_bps = excluded.network_in_bps,
      network_out_bps = excluded.network_out_bps,
      last_telemetry = excluded.last_telemetry
  `);
  const insertSessionStmt = db.query(`
    INSERT INTO sessions (
      session_id, code, resume_token, primary_gateway, backup_gateway,
      state, reconnect_deadline, created_at, updated_at, expires_at, paired_at, ended_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  `);
  const getSessionByCodeStmt = db.query(`
    SELECT session_id, code, resume_token, primary_gateway, backup_gateway, state,
           reconnect_deadline, created_at, updated_at, expires_at, paired_at, ended_at
    FROM sessions WHERE code = ?1
  `);
  const getSessionByTokenStmt = db.query(`
    SELECT session_id, code, resume_token, primary_gateway, backup_gateway, state,
           reconnect_deadline, created_at, updated_at, expires_at, paired_at, ended_at
    FROM sessions WHERE resume_token = ?1
  `);
  const getPairingBySecretStmt = db.query(`
    SELECT secret, pc_id as pcId, phone_id as phoneId, root, hostname,
           created_at as createdAt, updated_at as updatedAt, paired_at as pairedAt,
           last_used_at as lastUsedAt, revoked_at as revokedAt
    FROM pairings
    WHERE secret = ?1
    LIMIT 1
  `);
  const getPairingByScopeStmt = db.query(`
    SELECT secret, pc_id as pcId, phone_id as phoneId, root, hostname,
           created_at as createdAt, updated_at as updatedAt, paired_at as pairedAt,
           last_used_at as lastUsedAt, revoked_at as revokedAt
    FROM pairings
    WHERE pc_id = ?1 AND phone_id = ?2 AND root = ?3
    LIMIT 1
  `);
  const listPairingsByCliScopeStmt = db.query(`
    SELECT secret, pc_id as pcId, phone_id as phoneId, root, hostname,
           created_at as createdAt, updated_at as updatedAt, paired_at as pairedAt,
           last_used_at as lastUsedAt, revoked_at as revokedAt
    FROM pairings
    WHERE pc_id = ?1 AND root = ?2 AND revoked_at IS NULL
    ORDER BY last_used_at DESC
    LIMIT 10
  `);
  const insertPairingStmt = db.query(`
    INSERT INTO pairings (
      secret, pc_id, phone_id, root, hostname, created_at, updated_at, paired_at, last_used_at, revoked_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)
  `);
  const updatePairingTouchStmt = db.query(`
    UPDATE pairings
    SET hostname = ?2,
        updated_at = ?3,
        last_used_at = ?3
    WHERE secret = ?1
  `);
  const revokePairingStmt = db.query(`
    UPDATE pairings
    SET revoked_at = ?2,
        updated_at = ?2
    WHERE secret = ?1
      AND revoked_at IS NULL
  `);
  const getSessionRoutingByTokenStmt = db.query(`
    SELECT session_id as sessionId, resume_token as resumeToken,
           primary_gateway as primaryGateway, backup_gateway as backupGateway, state
    FROM sessions
    WHERE resume_token = ?1
    LIMIT 1
  `);
  const codeExistsStmt = db.query(`SELECT 1 FROM sessions WHERE code = ?1 LIMIT 1`);
  const deleteSessionByCodeStmt = db.query(`DELETE FROM sessions WHERE code = ?1`);
  const cleanupExpiredPendingStmt = db.query(`
    UPDATE sessions
    SET state = 'expired', updated_at = ?1, ended_at = COALESCE(ended_at, ?1)
    WHERE state IN ('pending')
      AND expires_at <= ?2
  `);
  const cleanupExpiredGraceStmt = db.query(`
    UPDATE sessions
    SET state = 'expired', updated_at = ?1, ended_at = COALESCE(ended_at, ?1)
    WHERE state = 'app_offline_grace'
      AND reconnect_deadline IS NOT NULL
      AND reconnect_deadline <= ?2
  `);
  const cleanupExpiredCliGraceStmt = db.query(`
    UPDATE sessions
    SET state = 'expired', updated_at = ?1, ended_at = COALESCE(ended_at, ?1)
    WHERE state = 'cli_offline_grace'
      AND reconnect_deadline IS NOT NULL
      AND reconnect_deadline <= ?2
  `);
  const listExpiredCliGraceSessionsStmt = db.query(`
    SELECT session_id as sessionId, resume_token as resumeToken,
           primary_gateway as primaryGateway, backup_gateway as backupGateway
    FROM sessions
    WHERE state = 'cli_offline_grace'
      AND reconnect_deadline IS NOT NULL
      AND reconnect_deadline <= ?1
  `);
  const getSessionStateStmt = db.query(`
    SELECT state, paired_at as pairedAt
    FROM sessions
    WHERE resume_token = ?1
    LIMIT 1
  `);
  const markSessionPairedStmt = db.query(`
    UPDATE sessions
    SET paired_at = COALESCE(paired_at, ?2),
        updated_at = ?2
    WHERE resume_token = ?1
  `);
  const updateSessionStateStmt = db.query(`
    UPDATE sessions
    SET state = ?3,
        reconnect_deadline = ?4,
        updated_at = ?5,
        ended_at = CASE WHEN ?6 = 1 THEN ?5 ELSE ended_at END
    WHERE resume_token = ?1
      AND state = ?2
  `);
  const forceUpdateSessionStateStmt = db.query(`
    UPDATE sessions
    SET state = ?2,
        reconnect_deadline = ?3,
        updated_at = ?4,
        ended_at = CASE WHEN ?5 = 1 THEN ?4 ELSE ended_at END
    WHERE resume_token = ?1
  `);
  const listProxiesStmt = db.query(`
    SELECT url, gateway_id as gatewayId, state, active_connections as activeConnections, active_sessions as activeSessions,
           state_source as stateSource, unique_sessions_24h as uniqueSessions24h, last_heartbeat as lastHeartbeat,
           cpu_percent as cpuPercent, memory_used_mb as memoryUsedMb, memory_total_mb as memoryTotalMb,
           network_in_bps as networkInBps, network_out_bps as networkOutBps, last_telemetry as lastTelemetry
    FROM proxies ORDER BY url ASC
  `);
  const detailsProxyStmt = db.query(`
    SELECT url, gateway_id as gatewayId, state, active_connections as activeConnections, active_sessions as activeSessions,
           state_source as stateSource, unique_sessions_24h as uniqueSessions24h, last_heartbeat as lastHeartbeat,
           cpu_percent as cpuPercent, memory_used_mb as memoryUsedMb, memory_total_mb as memoryTotalMb,
           network_in_bps as networkInBps, network_out_bps as networkOutBps, last_telemetry as lastTelemetry
    FROM proxies WHERE url = ?1
  `);
  const setProxyStateStmt = db.query(`
    UPDATE proxies
    SET state = ?2,
        state_source = ?3
    WHERE url = ?1
  `);
  const addProxyStmt = db.query(`
    INSERT INTO proxies (
      url, password, gateway_id, state, state_source, active_connections, active_sessions, unique_sessions_24h, last_heartbeat,
      cpu_percent, memory_used_mb, memory_total_mb, network_in_bps, network_out_bps, last_telemetry
    )
    VALUES (?1, ?2, '', 'active', 'manual', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    ON CONFLICT(url) DO UPDATE SET password = COALESCE(NULLIF(excluded.password, ''), proxies.password)
  `);
  const getProxyPasswordStmt = db.query(`SELECT password FROM proxies WHERE url = ?1 LIMIT 1`);
  const removeProxyStmt = db.query(`DELETE FROM proxies WHERE url = ?1`);
  const markStaleProxiesDrainingStmt = db.query(`
    UPDATE proxies
    SET state = 'draining',
        state_source = 'auto_stale'
    WHERE state = 'active'
      AND last_heartbeat > 0
      AND last_heartbeat < ?1
  `);
  const upsertGatewayInstanceStmt = db.query(`
    INSERT INTO gateway_instances (
      gateway_id, gateway_url, status, connected_at, disconnected_at, last_seen, last_error
    )
    VALUES (?1, ?2, ?3, ?4, NULL, ?4, '')
    ON CONFLICT(gateway_id) DO UPDATE SET
      gateway_url = excluded.gateway_url,
      status = excluded.status,
      last_seen = excluded.last_seen,
      connected_at = CASE WHEN gateway_instances.status != 'connected' THEN excluded.connected_at ELSE gateway_instances.connected_at END,
      disconnected_at = CASE WHEN excluded.status = 'disconnected' THEN excluded.last_seen ELSE gateway_instances.disconnected_at END,
      last_error = CASE WHEN excluded.last_error != '' THEN excluded.last_error ELSE gateway_instances.last_error END
  `);
  const markGatewayDisconnectedStmt = db.query(`
    UPDATE gateway_instances
    SET status = 'disconnected',
        disconnected_at = ?2,
        last_seen = ?2,
        last_error = ?3
    WHERE gateway_id = ?1
  `);
  const getSessionRuntimeStmt = db.query(`
    SELECT resume_token as resumeToken,
           cli_control as cliControl,
           cli_data as cliData,
           app_control as appControl,
           app_data as appData,
           updated_at as updatedAt
    FROM session_runtime
    WHERE resume_token = ?1
    LIMIT 1
  `);
  const upsertSessionRuntimeStmt = db.query(`
    INSERT INTO session_runtime (
      resume_token, cli_control, cli_data, app_control, app_data, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(resume_token) DO UPDATE SET
      cli_control = excluded.cli_control,
      cli_data = excluded.cli_data,
      app_control = excluded.app_control,
      app_data = excluded.app_data,
      updated_at = excluded.updated_at
  `);
  const deleteSessionRuntimeStmt = db.query(`
    DELETE FROM session_runtime
    WHERE resume_token = ?1
  `);
  const upsertVmHeartbeatStmt = db.query(`
    INSERT INTO vm_heartbeats (sandbox_id, resume_token, sandman_url, repo_url, branch, vm_profile, last_heartbeat)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(sandbox_id) DO UPDATE SET
      resume_token = excluded.resume_token,
      sandman_url = CASE WHEN excluded.sandman_url != '' THEN excluded.sandman_url ELSE vm_heartbeats.sandman_url END,
      repo_url = CASE WHEN excluded.repo_url != '' THEN excluded.repo_url ELSE vm_heartbeats.repo_url END,
      branch = CASE WHEN excluded.branch != '' THEN excluded.branch ELSE vm_heartbeats.branch END,
      vm_profile = CASE WHEN excluded.vm_profile != '' THEN excluded.vm_profile ELSE vm_heartbeats.vm_profile END,
      last_heartbeat = excluded.last_heartbeat
  `);
  const getReattachSessionStmt = db.query(`
    SELECT resume_token as resumeToken,
           generation,
           proxy_url as proxyUrl,
           waiting_for as waitingFor,
           app_attached as appAttached,
           cli_attached as cliAttached,
           created_at as createdAt,
           updated_at as updatedAt,
           expires_at as expiresAt
    FROM reattach_sessions
    WHERE resume_token = ?1
    LIMIT 1
  `);
  const upsertReattachSessionStmt = db.query(`
    INSERT INTO reattach_sessions (
      resume_token, generation, proxy_url, waiting_for, app_attached, cli_attached, created_at, updated_at, expires_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(resume_token) DO UPDATE SET
      generation = excluded.generation,
      proxy_url = excluded.proxy_url,
      waiting_for = excluded.waiting_for,
      app_attached = excluded.app_attached,
      cli_attached = excluded.cli_attached,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `);
  const updateReattachAttachmentStmt = db.query(`
    UPDATE reattach_sessions
    SET app_attached = ?2,
        cli_attached = ?3,
        waiting_for = ?4,
        updated_at = ?5
    WHERE resume_token = ?1
      AND generation = ?6
  `);
  const deleteReattachSessionStmt = db.query(`
    DELETE FROM reattach_sessions
    WHERE resume_token = ?1
  `);
  const deleteExpiredReattachSessionsStmt = db.query(`
    DELETE FROM reattach_sessions
    WHERE expires_at <= ?1
  `);
  const listDeadVmHeartbeatsForCliGraceStmt = db.query(`
    SELECT v.sandbox_id as sandboxId, v.resume_token as resumeToken, v.sandman_url as sandmanUrl,
           v.repo_url as repoUrl, v.branch, v.vm_profile as vmProfile, v.last_heartbeat as lastHeartbeat,
           s.code as sessionCode, s.primary_gateway as primaryGateway, s.backup_gateway as backupGateway
    FROM vm_heartbeats v
    JOIN sessions s ON s.resume_token = v.resume_token
    WHERE s.state = 'cli_offline_grace'
      AND v.last_heartbeat < ?1
  `);
  const deleteVmHeartbeatStmt = db.query(`DELETE FROM vm_heartbeats WHERE sandbox_id = ?1`);
  const listExpiredGraceSessionsStmt = db.query(`
    SELECT session_id as sessionId, resume_token as resumeToken, primary_gateway as primaryGateway, backup_gateway as backupGateway
    FROM sessions
    WHERE state = 'app_offline_grace'
      AND reconnect_deadline IS NOT NULL
      AND reconnect_deadline <= ?1
  `);
  const listGatewayInstancesStmt = db.query(`
    SELECT gateway_id as gatewayId, gateway_url as gatewayUrl, status, connected_at as connectedAt,
           disconnected_at as disconnectedAt, last_seen as lastSeen, last_error as lastError
    FROM gateway_instances
    ORDER BY last_seen DESC
    LIMIT ?1
  `);
  const insertAuditLogStmt = db.query(`
    INSERT INTO audit_logs (
      ts, actor_type, actor_id, action, target_type, target_id, source_ip, status, message, metadata
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  `);
  const listAuditLogsStmt = db.query(`
    SELECT id, ts, actor_type, actor_id, action, target_type, target_id, source_ip, status, message, metadata
    FROM audit_logs
    ORDER BY id DESC
    LIMIT ?1
  `);
  const insertSecurityAlertStmt = db.query(`
    INSERT INTO security_alerts (
      ts, severity, category, alert_key, message, metadata
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `);
  const listSecurityAlertsStmt = db.query(`
    SELECT id, ts, severity, category, alert_key as alertKey, message, metadata
    FROM security_alerts
    ORDER BY id DESC
    LIMIT ?1
  `);
  const purgeOldAuditLogsStmt = db.query(`
    DELETE FROM audit_logs
    WHERE ts < ?1
  `);
  const purgeOldSecurityAlertsStmt = db.query(`
    DELETE FROM security_alerts
    WHERE ts < ?1
  `);

  for (const proxy of configured) {
    addProxyStmt.run(proxy, "");
  }

  const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
  const failureBuckets = new Map<string, { count: number; resetAt: number }>();
  const temporaryBlocks = new Map<string, number>();
  const recentGatewayEventIds = new Map<string, number>();
  const recentAlertKeys = new Map<string, number>();
  const securityMetrics = {
    rateLimited: 0,
    tempBlocked: 0,
    authDenied: 0,
    duplicateGatewayEvents: 0,
    alertsRaised: 0,
  };
  const checkRateLimit = (key: string, limit: number, windowMs: number): boolean => {
    const now = Date.now();
    const existing = rateLimitBuckets.get(key);
    if (!existing || existing.resetAt <= now) {
      rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (existing.count >= limit) return false;
    existing.count += 1;
    return true;
  };
  const enforceRateLimit = (
    req: Request,
    keyPrefix: string,
    policy: RateLimitPolicy
  ): Response | null => {
    const ip = extractClientIp(req);
    const subnet = toIpv4Subnet24(ip);
    const ipAllowed = checkRateLimit(`${keyPrefix}:ip:${ip}`, policy.perIp, policy.windowMs);
    const subnetAllowed = checkRateLimit(
      `${keyPrefix}:subnet:${subnet}`,
      policy.perSubnet,
      policy.windowMs
    );
    if (ipAllowed && subnetAllowed) return null;
    securityMetrics.rateLimited += 1;
    emitSecurityAlert({
      severity: "warn",
      category: "rate_limit",
      alertKey: `rate_limit:${keyPrefix}:${ip}`,
      message: `Rate limit triggered for ${keyPrefix}`,
      metadata: { keyPrefix, ip, subnet, windowMs: policy.windowMs },
    });
    return Response.json(
      { error: "rate_limited", message: "Too many requests. Please try again shortly." },
      {
        status: 429,
        headers: {
          ...corsHeaders,
          "Retry-After": String(Math.ceil(policy.windowMs / 1000)),
        },
      }
    );
  };
  const recordFailureAndMaybeBlock = (
    scope: string,
    req: Request,
    opts: { threshold: number; windowMs: number; blockMs: number }
  ): void => {
    const ip = extractClientIp(req);
    const subnet = toIpv4Subnet24(ip);
    const now = Date.now();
    const keys = [`${scope}:ip:${ip}`, `${scope}:subnet:${subnet}`];
    for (const key of keys) {
      const existing = failureBuckets.get(key);
      if (!existing || existing.resetAt <= now) {
        failureBuckets.set(key, { count: 1, resetAt: now + opts.windowMs });
        continue;
      }
      existing.count += 1;
      if (existing.count >= opts.threshold) {
        temporaryBlocks.set(key, now + opts.blockMs);
        securityMetrics.tempBlocked += 1;
        emitSecurityAlert({
          severity: "critical",
          category: "abuse_block",
          alertKey: `temp_block:${key}`,
          message: `Temporary block activated for ${scope}`,
          metadata: { scope, key, threshold: opts.threshold, blockMs: opts.blockMs },
        });
      }
    }
  };
  const enforceTemporaryBlock = (req: Request, scope: string): Response | null => {
    const ip = extractClientIp(req);
    const subnet = toIpv4Subnet24(ip);
    const now = Date.now();
    const keys = [`${scope}:ip:${ip}`, `${scope}:subnet:${subnet}`];
    for (const key of keys) {
      const until = temporaryBlocks.get(key);
      if (until && until > now) {
        securityMetrics.authDenied += 1;
        emitSecurityAlert({
          severity: "warn",
          category: "temporary_block",
          alertKey: `blocked:${key}`,
          message: `Blocked request due to temporary block (${scope})`,
          metadata: { scope, key, retryAfterMs: until - now },
        });
        return Response.json(
          { error: "temporarily_blocked", message: "Temporarily blocked due to repeated failures." },
          {
            status: 429,
            headers: {
              ...corsHeaders,
              "Retry-After": String(Math.ceil((until - now) / 1000)),
            },
          }
        );
      }
    }
    return null;
  };
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rateLimitBuckets) {
      if (value.resetAt <= now) rateLimitBuckets.delete(key);
    }
    for (const [key, value] of failureBuckets) {
      if (value.resetAt <= now) failureBuckets.delete(key);
    }
    for (const [key, until] of temporaryBlocks) {
      if (until <= now) temporaryBlocks.delete(key);
    }
    for (const [key, until] of recentGatewayEventIds) {
      if (until <= now) recentGatewayEventIds.delete(key);
    }
    for (const [key, until] of recentAlertKeys) {
      if (until <= now) recentAlertKeys.delete(key);
    }
  }, 60_000);
  setInterval(() => {
    const cutoff = Date.now() - auditRetentionDays * 24 * 60 * 60 * 1000;
    purgeOldAuditLogsStmt.run(cutoff);
    purgeOldSecurityAlertsStmt.run(cutoff);
  }, 60 * 60 * 1000);
  setInterval(() => {
    const staleBefore = Date.now() - STALE_GATEWAY_MS;
    const result = markStaleProxiesDrainingStmt.run(staleBefore);
    if ((result as any).changes > 0) broadcastRingUpdate();
  }, 30_000);

  const writeAuditLog = (entry: {
    ts?: number;
    actorType: string;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    sourceIp?: string;
    status: "ok" | "error" | "denied";
    message: string;
    metadata?: Record<string, unknown>;
  }): void => {
    const safeMetadata = redactSensitive(entry.metadata || {}) as Record<string, unknown>;
    insertAuditLogStmt.run(
      Number(entry.ts || Date.now()),
      entry.actorType,
      entry.actorId,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.sourceIp || "system",
      entry.status,
      entry.message,
      JSON.stringify(safeMetadata)
    );
  };

  const emitSecurityAlert = (entry: {
    severity: "info" | "warn" | "critical";
    category: string;
    alertKey: string;
    message: string;
    metadata?: Record<string, unknown>;
  }): void => {
    const now = Date.now();
    const existingUntil = recentAlertKeys.get(entry.alertKey) || 0;
    if (existingUntil > now) return;
    recentAlertKeys.set(entry.alertKey, now + 5 * 60_000);
    const safeMetadata = redactSensitive(entry.metadata || {}) as Record<string, unknown>;
    insertSecurityAlertStmt.run(
      now,
      entry.severity,
      entry.category,
      entry.alertKey,
      entry.message,
      JSON.stringify(safeMetadata)
    );
    securityMetrics.alertsRaised += 1;
    writeAuditLog({
      ts: now,
      actorType: "system",
      actorId: "manager",
      action: "security.alert",
      targetType: "alert",
      targetId: entry.alertKey,
      status: "ok",
      message: entry.message,
      metadata: {
        severity: entry.severity,
        category: entry.category,
        ...safeMetadata,
      },
    });
  };

  const allowedTransitions: Record<SessionState, Set<SessionState>> = {
    pending: new Set<SessionState>(["active", "app_offline_grace", "cli_offline_grace", "ended", "expired"]),
    active: new Set<SessionState>(["app_offline_grace", "cli_offline_grace", "ended", "expired"]),
    app_offline_grace: new Set<SessionState>(["active", "ended", "expired"]),
    cli_offline_grace: new Set<SessionState>(["active", "ended", "expired"]),
    ended: new Set<SessionState>([]),
    expired: new Set<SessionState>([]),
  };

  const transitionSessionState = (
    resumeToken: string,
    nextState: SessionState,
    reconnectDeadline: number | null,
    updatedAt: number,
    markEnded: 0 | 1
  ): { ok: boolean; reason: string } => {
    const currentRow = getSessionStateStmt.get(resumeToken) as { state?: SessionState; pairedAt?: number | null } | null;
    if (!currentRow || !currentRow.state) return { ok: false, reason: "not_found" };
    const currentState = currentRow.state;
    if (currentState === nextState) {
      const info = forceUpdateSessionStateStmt.run(
        resumeToken,
        nextState,
        reconnectDeadline,
        updatedAt,
        markEnded
      ) as { changes?: number };
      if (nextState === "active" && !Number(currentRow.pairedAt || 0) && Number(info?.changes || 0) > 0) {
        markSessionPairedStmt.run(resumeToken, updatedAt);
      }
      if ((nextState === "active" || nextState === "ended" || nextState === "expired") && Number(info?.changes || 0) > 0) {
        clearReattachSession(resumeToken);
      }
      return { ok: Number(info?.changes || 0) > 0, reason: "noop" };
    }
    const allowed = allowedTransitions[currentState]?.has(nextState) || false;
    if (!allowed) return { ok: false, reason: `blocked:${currentState}->${nextState}` };
    const info = updateSessionStateStmt.run(
      resumeToken,
      currentState,
      nextState,
      reconnectDeadline,
      updatedAt,
      markEnded
    ) as { changes?: number };
    if (Number(info?.changes || 0) > 0) {
      if (nextState === "active" && !Number(currentRow.pairedAt || 0)) {
        markSessionPairedStmt.run(resumeToken, updatedAt);
      }
      if (nextState === "ended" || nextState === "expired") {
        deleteSessionRuntimeStmt.run(resumeToken);
      }
      if (nextState === "active" || nextState === "ended" || nextState === "expired") {
        clearReattachSession(resumeToken);
      }
      return { ok: true, reason: "transitioned" };
    }
    return { ok: false, reason: "race_lost" };
  };

  const getResumeTokenStatus = (
    row: any,
    now: number
  ): { valid: boolean; reason: string; tokenExpiresAt: number } => {
    const state = String(row?.state || "");
    const createdAt = Number(row?.created_at ?? row?.createdAt ?? 0);
    const expiresAt = Number(row?.expires_at ?? row?.expiresAt ?? 0);
    const reconnectDeadline = Number(row?.reconnect_deadline ?? row?.reconnectDeadline ?? 0);
    const tokenExpiresAt = createdAt > 0 ? createdAt + resumeTokenTtlMs : now;

    if (state === "ended" || state === "expired") {
      return { valid: false, reason: "session_finalized", tokenExpiresAt };
    }
    if (state === "pending" && expiresAt > 0 && expiresAt <= now) {
      transitionSessionState(String(row?.resume_token ?? row?.resumeToken ?? ""), "expired", null, now, 1);
      return { valid: false, reason: "pairing_expired", tokenExpiresAt };
    }
    if (state === "app_offline_grace" && reconnectDeadline > 0 && reconnectDeadline <= now) {
      transitionSessionState(String(row?.resume_token ?? row?.resumeToken ?? ""), "expired", null, now, 1);
      return { valid: false, reason: "reconnect_grace_expired", tokenExpiresAt };
    }
    if (tokenExpiresAt <= now) {
      return { valid: false, reason: "resume_token_ttl_expired", tokenExpiresAt };
    }
    return { valid: true, reason: "ok", tokenExpiresAt };
  };

  const buildSessionSnapshot = (
    row: any,
    now: number
  ): {
    exists: boolean;
    valid: boolean;
    reason: string;
    sessionId?: string;
    code?: string;
    resumeToken?: string;
    primary?: string;
    backup?: string | null;
    state?: string;
    reconnectDeadline?: number | null;
    expiresAt?: number;
    updatedAt?: number;
    pairedAt?: number | null;
    resumeTokenExpiresAt?: number;
  } => {
    if (!row) {
      return { exists: false, valid: false, reason: "not_found" };
    }

    const resumeStatus = getResumeTokenStatus(row, now);
    return {
      exists: true,
      valid: resumeStatus.valid,
      reason: resumeStatus.reason,
      sessionId: row.session_id ?? row.sessionId,
      code: row.code,
      resumeToken: row.resume_token ?? row.resumeToken,
      primary: row.primary_gateway ?? row.primaryGateway ?? row.primary,
      backup: row.backup_gateway ?? row.backupGateway ?? row.backup,
      state: row.state,
      reconnectDeadline: row.reconnect_deadline ?? row.reconnectDeadline ?? null,
      expiresAt: row.expires_at ?? row.expiresAt,
      updatedAt: row.updated_at ?? row.updatedAt,
      pairedAt: row.paired_at ?? row.pairedAt ?? null,
      resumeTokenExpiresAt: resumeStatus.tokenExpiresAt,
    };
  };

  const buildPairingSnapshot = (
    row: any
  ): {
    exists: boolean;
    valid: boolean;
    reason: string;
    sessionId?: string;
    code?: string;
    resumeToken?: string;
    primary?: string;
    backup?: string | null;
    state?: string;
    expiresAt?: number;
  } => {
    if (!row) {
      return { exists: false, valid: false, reason: "not_found" };
    }
    if (Number(row.revokedAt || 0) > 0) {
      return {
        exists: true,
        valid: false,
        reason: "revoked",
        code: "",
        resumeToken: row.secret,
        state: "ended",
      };
    }
    const picked = pickGatewaysForSession(String(row.secret || ""));
    if (!picked) {
      return {
        exists: true,
        valid: false,
        reason: "no_healthy_gateways",
        code: "",
        resumeToken: row.secret,
        state: "pending",
      };
    }
    return {
      exists: true,
      valid: true,
      reason: "ok",
      sessionId: `pairing:${String(row.secret || "").slice(0, 16)}`,
      code: "",
      resumeToken: row.secret,
      primary: picked.primary,
      backup: picked.backup,
      state: "active",
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
  };

  const getAdminBearerToken = (req: Request): string => {
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) return "";
    return authHeader.slice(7).trim();
  };

  const isAdminAuthorized = (req: Request, url: URL): boolean => {
    const token = getAdminBearerToken(req);
    if (token) {
      const claims = verifyJwtToken(
        token,
        managerAdminTokenSecret,
        MANAGER_ADMIN_TOKEN_AUDIENCE,
        MANAGER_ADMIN_TOKEN_ISSUER
      ) as ManagerAdminTokenClaims | null;
      return Boolean(claims && claims.role === "admin");
    }
    if (allowLegacyAdminPassword) {
      if (!managerAdminPassword) return false;
      const provided = req.headers.get("x-manager-password") || url.searchParams.get("password") || "";
      return provided === managerAdminPassword;
    }
    return false;
  };

  const loadAllProxies = (): ManagerProxyMetrics[] => {
    return listProxiesStmt.all() as ManagerProxyMetrics[];
  };
  const managerControlSocketsByGateway = new Map<string, Set<GatewaySocket>>();

  const attachGatewayControlSocket = (
    gatewayUrl: string,
    ws: GatewaySocket
  ): void => {
    const set = managerControlSocketsByGateway.get(gatewayUrl) || new Set<GatewaySocket>();
    set.add(ws);
    managerControlSocketsByGateway.set(gatewayUrl, set);
  };

  const detachGatewayControlSocket = (
    gatewayUrl: string,
    ws: GatewaySocket
  ): void => {
    const set = managerControlSocketsByGateway.get(gatewayUrl);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) managerControlSocketsByGateway.delete(gatewayUrl);
  };

  const sendManagerCommandToGateway = (
    gatewayUrl: string,
    command: "close_session" | "set_reconnect_grace" | "clear_reconnect_grace" | "set_cli_reconnect_grace",
    payload: { resumeToken: string; reconnectDeadline?: number | null; reason?: string }
  ): boolean => {
    const sockets = managerControlSocketsByGateway.get(gatewayUrl);
    if (!sockets || sockets.size === 0) return false;
    const event: GatewayControlEvent = {
      type: "manager_command",
      ts: Date.now(),
      command,
      resumeToken: payload.resumeToken,
      reconnectDeadline: payload.reconnectDeadline ?? null,
      reason: payload.reason,
    };
    let sent = false;
    for (const ws of sockets) {
      try {
        ws.send(JSON.stringify(event));
        sent = true;
      } catch {
        // ignore broken sockets
      }
    }
    return sent;
  };

  const sendManagerCommandForSession = (
    sessionRow: { primaryGateway?: string; backupGateway?: string | null; primary_gateway?: string; backup_gateway?: string | null },
    command: "close_session" | "set_reconnect_grace" | "clear_reconnect_grace" | "set_cli_reconnect_grace",
    payload: { resumeToken: string; reconnectDeadline?: number | null; reason?: string }
  ): void => {
    const primary = normalizeGatewayUrl((sessionRow.primaryGateway ?? sessionRow.primary_gateway ?? null) as string | null);
    const backup = normalizeGatewayUrl((sessionRow.backupGateway ?? sessionRow.backup_gateway ?? null) as string | null);
    if (primary) sendManagerCommandToGateway(primary, command, payload);
    if (backup && backup !== primary) sendManagerCommandToGateway(backup, command, payload);
  };

  // Consistent-hash ring: deterministically assign a sessionId to a position in a sorted
  // list of healthy gateway URLs. Takes first 4 bytes of SHA-256(sessionId) as uint32.
  const hashSessionToRingIndex = (sessionId: string, nodes: string[]): number => {
    if (nodes.length === 0) return 0;
    const buf = createHash("sha256").update(sessionId).digest();
    const val = buf.readUInt32BE(0);
    return val % nodes.length;
  };

  const getHealthyRing = (): string[] => {
    const now = Date.now();
    const allProxies = loadAllProxies().filter((p) => (p.state || "active") === "active");
    const healthy = allProxies
      .filter((p) => p.lastHeartbeat > 0 && now - p.lastHeartbeat <= STALE_GATEWAY_MS)
      .sort((a, b) => a.url.localeCompare(b.url)) // lexicographic — stable across calls
      .map((p) => p.url);
    // Bootstrap: allow never-seen gateways when no heartbeat data yet
    if (healthy.length > 0) return healthy;
    return allProxies
      .filter((p) => p.lastHeartbeat === 0)
      .sort((a, b) => a.url.localeCompare(b.url))
      .map((p) => p.url);
  };

  const chooseGatewaysForSession = (sessionId: string): string[] => {
    const ring = getHealthyRing();
    if (ring.length === 0) return [];
    if (ring.length === 1) return ring;
    const primaryIdx = hashSessionToRingIndex(sessionId, ring);
    const backupIdx = (primaryIdx + 1) % ring.length;
    return [ring[primaryIdx], ring[backupIdx]];
  };

  // Legacy alias for callers that don't have a sessionId (e.g. /v1/gateways info endpoint).
  const chooseGateways = (): string[] => chooseGatewaysForSession(randomUUID());

  const broadcastRingUpdate = (): void => {
    const ring = getHealthyRing();
    const event: GatewayControlEvent = { type: "manager_command", command: "ring_update", ring, ts: Date.now() };
    const payload = JSON.stringify(event);
    for (const sockets of managerControlSocketsByGateway.values()) {
      for (const ws of sockets) {
        try { ws.send(payload); } catch { /* ignore */ }
      }
    }
  };

  const assembleSessionsByCode = new Map<string, AssembleSession>();
  const issuedPasswordsByHash = new Map<string, IssuedPasswordRecord>();
  const assembleMutex = new Mutex();
  const proxyAssignmentMutex = new Mutex();
  const reattachMutex = new Mutex();
  const hashPassword = (password: string): string => createHash("sha256").update(password).digest("hex");

  const makeV2Password = (): string => generatePersistentSecret(V2_PASSWORD_LENGTH);

  const getActiveProxyUrls = (): string[] => getHealthyRing();

  const cleanupExpiredV2State = (now = Date.now()): void => {
    for (const [code, session] of assembleSessionsByCode) {
      if (session.expiresAt <= now) {
        try {
          session.appWs?.close(1000, "code expired");
        } catch {
          // ignore
        }
        try {
          session.cliWs?.close(1000, "code expired");
        } catch {
          // ignore
        }
        assembleSessionsByCode.delete(code);
      }
    }

    for (const [passwordHash, record] of issuedPasswordsByHash) {
      if (record.expiresAt <= now) {
        issuedPasswordsByHash.delete(passwordHash);
      }
    }

    deleteExpiredReattachSessionsStmt.run(now);
  };

  const getOrCreateAssembleSession = (code: string): AssembleSession => {
    const now = Date.now();
    cleanupExpiredV2State(now);
    const existing = assembleSessionsByCode.get(code);
    if (existing && existing.expiresAt > now) {
      return existing;
    }
    const created: AssembleSession = {
      code,
      createdAt: now,
      expiresAt: now + V2_CODE_TTL_MS,
      password: null,
      appWs: null,
      cliWs: null,
      appAcked: false,
      cliAcked: false,
    };
    assembleSessionsByCode.set(code, created);
    return created;
  };

  const maybeCompleteAssembleSession = (session: AssembleSession): void => {
    if (!session.password) return;
    if (!session.appAcked || !session.cliAcked) return;
    try {
      session.appWs?.close(1000, "assembled");
    } catch {
      // ignore
    }
    try {
      session.cliWs?.close(1000, "assembled");
    } catch {
      // ignore
    }
    assembleSessionsByCode.delete(session.code);
  };

  const maybeIssueAssemblePassword = (session: AssembleSession): void => {
    if (session.password) return;
    if (!session.appWs || !session.cliWs) return;

    const password = makeV2Password();
    const now = Date.now();
    const passwordHash = hashPassword(password);
    session.password = password;
    issuedPasswordsByHash.set(passwordHash, {
      code: session.code,
      passwordHash,
      proxyUrl: null,
      issuedAt: now,
      expiresAt: now + DEFAULT_RESUME_TOKEN_TTL_MS,
    });

    const payload = JSON.stringify({
      type: "assembled",
      code: session.code,
      password,
    });
    session.appWs.send(payload);
    session.cliWs.send(payload);
  };

  const assignProxyUrl = async (password: string): Promise<IssuedPasswordRecord | null> => {
    const passwordHash = hashPassword(password);
    return proxyAssignmentMutex.runExclusive(() => {
      cleanupExpiredV2State();
      const record = issuedPasswordsByHash.get(passwordHash);
      if (!record) return null;
      if (record.proxyUrl) return record;

      const activeProxyUrls = getActiveProxyUrls();
      if (activeProxyUrls.length === 0) return null;

      const index = hashSessionToRingIndex(record.code, activeProxyUrls);
      record.proxyUrl = activeProxyUrls[index];
      issuedPasswordsByHash.set(passwordHash, record);
      return record;
    });
  };

  const getReattachSession = (resumeToken: string, now = Date.now()): ReattachSessionRow | null => {
    cleanupExpiredV2State(now);
    const row = getReattachSessionStmt.get(resumeToken) as ReattachSessionRow | null;
    if (!row) return null;
    if (Number(row.expiresAt || 0) <= now) {
      deleteReattachSessionStmt.run(resumeToken);
      return null;
    }
    return row;
  };

  const resolveReattachSource = (
    resumeToken: string,
    now = Date.now()
  ): { code: string } | null => {
    const sessionRow = getSessionByTokenStmt.get(resumeToken) as SessionRow | null;
    const sessionSnapshot = buildSessionSnapshot(sessionRow, now);
    if (sessionSnapshot.exists && sessionSnapshot.valid) {
      return { code: sessionSnapshot.code || "" };
    }

    const issuedRecord = issuedPasswordsByHash.get(hashPassword(resumeToken));
    if (issuedRecord && issuedRecord.expiresAt > now) {
      return { code: issuedRecord.code || "" };
    }

    const pairingRow = getPairingBySecretStmt.get(resumeToken) as any;
    const pairingSnapshot = buildPairingSnapshot(pairingRow);
    if (pairingSnapshot.exists && pairingSnapshot.valid) {
      return { code: pairingSnapshot.code || "" };
    }

    return null;
  };

  const chooseProxyForResumeToken = (resumeToken: string, fallbackCode: string): string | null => {
    const routing = getSessionRoutingByTokenStmt.get(resumeToken) as
      | { sessionId?: string; primaryGateway?: string; backupGateway?: string | null }
      | null;
    const primaryGateway = normalizeGatewayUrl(routing?.primaryGateway || null);
    const backupGateway = normalizeGatewayUrl(routing?.backupGateway || null);
    const healthy = new Set(getHealthyRing());
    if (primaryGateway && healthy.has(primaryGateway)) {
      return primaryGateway;
    }
    if (backupGateway && healthy.has(backupGateway)) {
      return backupGateway;
    }
    const chosen = pickGatewaysForSession(routing?.sessionId || fallbackCode || resumeToken);
    return chosen?.primary || null;
  };

  const upsertReattachSession = (
    resumeToken: string,
    generation: number,
    proxyUrl: string,
    waitingFor: "app" | "cli" | "both" | "none",
    appAttached: boolean,
    cliAttached: boolean,
    createdAt: number,
    updatedAt: number,
    expiresAt: number
  ): ReattachSessionRow => {
    upsertReattachSessionStmt.run(
      resumeToken,
      generation,
      proxyUrl,
      waitingFor,
      appAttached ? 1 : 0,
      cliAttached ? 1 : 0,
      createdAt,
      updatedAt,
      expiresAt
    );
    return {
      resumeToken,
      generation,
      proxyUrl,
      waitingFor,
      appAttached: appAttached ? 1 : 0,
      cliAttached: cliAttached ? 1 : 0,
      createdAt,
      updatedAt,
      expiresAt,
    };
  };

  const claimReattachSession = async (resumeToken: string, role: Role): Promise<ReattachSessionRow | null> => {
    return reattachMutex.runExclusive(() => {
      const now = Date.now();
      const source = resolveReattachSource(resumeToken, now);
      if (!source) return null;
      const existing = getReattachSession(resumeToken, now);
      if (existing?.proxyUrl && Number(existing.generation || 0) > 0) {
        return existing;
      }

      const proxyUrl = chooseProxyForResumeToken(resumeToken, source.code);
      if (!proxyUrl) return null;
      return upsertReattachSession(
        resumeToken,
        Math.max(1, Number(existing?.generation || 0) + 1),
        proxyUrl,
        role === "app" ? "cli" : "app",
        false,
        false,
        now,
        now,
        now + RECONNECT_GRACE_MS
      );
    });
  };

  const noteReattachDisconnect = async (resumeToken: string, missingRole: Role): Promise<ReattachSessionRow | null> => {
    return reattachMutex.runExclusive(() => {
      const now = Date.now();
      const source = resolveReattachSource(resumeToken, now);
      if (!source) return null;
      const existing = getReattachSession(resumeToken, now);
      const proxyUrl = existing?.proxyUrl || chooseProxyForResumeToken(resumeToken, source.code);
      if (!proxyUrl) return null;
      const appAttached = missingRole === "cli";
      const cliAttached = missingRole === "app";
      return upsertReattachSession(
        resumeToken,
        Math.max(1, Number(existing?.generation || 0) + 1),
        proxyUrl,
        missingRole,
        appAttached,
        cliAttached,
        now,
        now,
        now + (missingRole === "app" ? RECONNECT_GRACE_MS : CLI_OFFLINE_GRACE_MS)
      );
    });
  };

  const noteReattachAttached = (resumeToken: string, role: Role, generation: number): void => {
    const now = Date.now();
    const existing = getReattachSession(resumeToken, now);
    if (!existing) return;
    if (Number(existing.generation || 0) !== generation) return;
    const appAttached = role === "app" ? true : Boolean(existing.appAttached);
    const cliAttached = role === "cli" ? true : Boolean(existing.cliAttached);
    if (appAttached && cliAttached) {
      deleteReattachSessionStmt.run(resumeToken);
      return;
    }
    updateReattachAttachmentStmt.run(
      resumeToken,
      appAttached ? 1 : 0,
      cliAttached ? 1 : 0,
      appAttached ? "cli" : "app",
      now,
      generation
    );
  };

  const clearReattachSession = (resumeToken: string): void => {
    deleteReattachSessionStmt.run(resumeToken);
  };

  const renderManagerPage = (): string => {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lunel Manager</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      --mono: "SF Mono", ui-monospace, Menlo, monospace;
      --bg: #f5f5f5;
      --surface: #ffffff;
      --border: #e0e0e0;
      --text: #111111;
      --muted: #777777;
      --accent: #0055cc;
      --danger-text: #cc2200;
      --danger-bg: #fff5f3;
      --danger-border: #f5c0b4;
    }
    html, body {
      height: 100%;
      font-family: var(--font);
      font-size: 13px;
      background: var(--bg);
      color: var(--text);
      line-height: 1.4;
    }

    /* ── Login ── */
    #loginOverlay {
      position: fixed;
      inset: 0;
      background: var(--bg);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    #loginOverlay.hidden { display: none; }
    .login-card {
      background: var(--surface);
      border: 1px solid var(--border);
      padding: 28px 24px;
      width: min(380px, 92vw);
    }
    .login-card h2 {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .login-card p {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 18px;
    }
    #loginError {
      font-size: 12px;
      color: var(--danger-text);
      min-height: 16px;
      margin-bottom: 10px;
    }

    /* ── Shell ── */
    .shell {

      padding: 20px 20px 40px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* ── Header ── */
    .app-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }
    .app-header h1 {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.2px;
    }
    .app-header .sub {
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
    }

    /* ── Stats ── */
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
    }
    .summary-card {
      background: var(--surface);
      border: 1px solid var(--border);
      padding: 14px 16px;
    }
    .summary-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 700;
      color: var(--muted);
    }
    .summary-card b {
      display: block;
      font-family: var(--mono);
      font-size: 26px;
      font-weight: 600;
      margin-top: 5px;
      color: var(--text);
    }

    /* ── Layout ── */
    .layout {
      display: grid;
      grid-template-columns: 1fr 470px;
      gap: 14px;
      align-items: start;
    }
    .side-column {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    /* ── Panels ── */
    .panel-card {
      background: var(--surface);
      border: 1px solid var(--border);
      overflow: hidden;
    }
    .card-header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: #fafafa;
    }
    .card-header strong {
      font-size: 12.5px;
      font-weight: 600;
    }
    .card-header .sub {
      font-size: 11px;
      color: var(--muted);
      margin-top: 1px;
    }
    .table-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .card-body {
      padding: 10px 14px;
    }

    /* ── Add proxy form ── */
    .proxy-form {
      display: grid;
      grid-template-columns: 1fr 190px 100px;
      gap: 8px;
    }

    /* ── Table ── */
    .table-responsive { overflow: auto; }
    .proxy-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .table-sticky thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #fafafa;
      border-bottom: 1px solid var(--border);
      padding: 7px 12px;
      text-align: left;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      white-space: nowrap;
    }
    .proxy-table tbody td {
      padding: 8px 12px;
      border-bottom: 1px solid #f0f0f0;
      vertical-align: middle;
      font-family: var(--mono);
      font-size: 11.5px;
      white-space: nowrap;
    }
    .proxy-table tbody td:first-child {
      font-family: var(--font);
      font-size: 12px;
    }
    .proxy-table tbody tr:last-child td { border-bottom: none; }
    .proxy-table tbody tr:hover { background: #fafafa; }
    .table-wrap { overflow: auto; }
    .proxy-panel { height: calc(100vh - 230px); display: flex; flex-direction: column; }
    .proxy-panel .table-wrap { flex: 1 1 auto; min-height: 0; }

    /* ── Status chips ── */
    .status-chip {
      display: inline-block;
      font-family: var(--font);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 2px 6px;
      border: 1px solid transparent;
    }
    .status-active  { background: #e8f5ec; color: #1a7a40; border-color: #b8e4c6; }
    .status-draining { background: #fef9e7; color: #8a6200; border-color: #f0d98a; }
    .status-disabled { background: #f0f0f0; color: #555555; border-color: #d8d8d8; }
    .status-unknown  { background: #f5f5f5; color: #666666; border-color: #e0e0e0; }

    /* ── Inputs ── */
    .input-app {
      width: 100%;
      border: 1px solid var(--border);
      padding: 6px 9px;
      background: var(--surface);
      color: var(--text);
      font-family: var(--font);
      font-size: 12.5px;
      outline: none;
    }
    .input-app:focus { border-color: var(--accent); }

    /* ── Buttons ── */
    .btn-app {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-family: var(--font);
      font-size: 12.5px;
      font-weight: 500;
      padding: 6px 11px;
      cursor: pointer;
      white-space: nowrap;
      line-height: 1.2;
    }
    .btn-app:hover { background: #f5f5f5; }
    .btn-app-primary {
      background: var(--text);
      color: #ffffff;
      border-color: var(--text);
    }
    .btn-app-primary:hover { background: #333333; border-color: #333333; }
    .btn-app-ghost {
      background: transparent;
      color: var(--text);
      border-color: var(--border);
    }
    .btn-app-soft {
      background: var(--surface);
      color: var(--text);
      border-color: var(--border);
    }
    .btn-app-danger {
      background: var(--danger-bg);
      color: var(--danger-text);
      border-color: var(--danger-border);
    }
    .btn-app-danger:hover { background: #ffe8e3; }
    .btn-app-xs {
      font-size: 11px;
      padding: 4px 8px;
    }

    /* ── Operations sidebar ── */
    .operations-list {
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .operations-list .btn-app {
      text-align: left;
      font-size: 12.5px;
    }

    /* ── Inspector ── */
    .inspector-panel { display: flex; flex-direction: column; }
    #details {
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.6;
      padding: 10px 12px;
      overflow: auto;
      max-height: 440px;
      color: #333;
      background: #fafafa;
      white-space: pre-wrap;
      word-break: break-all;
      border: none;
    }
    /* ── Inspector maximized overlay ── */
    #inspectorOverlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 200;
      background: var(--surface);
      flex-direction: column;
    }
    #inspectorOverlay.visible { display: flex; }
    #inspectorOverlay .overlay-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: #fafafa;
      flex-shrink: 0;
    }
    #inspectorOverlay .overlay-header strong { font-size: 12.5px; font-weight: 600; }
    #overlayDetails {
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.6;
      padding: 16px 20px;
      overflow: auto;
      flex: 1 1 auto;
      color: #333;
      background: #fafafa;
      white-space: pre-wrap;
      word-break: break-all;
      border: none;
      margin: 0;
    }

    /* ── Misc utils ── */
    .mb-3 { margin-bottom: 12px; }
    .mb-2 { margin-bottom: 8px; }
    .w-100 { width: 100%; }
    .text-danger { color: var(--danger-text); }
    .small { font-size: 11px; }
    .border-bottom-line { border-bottom: 1px solid var(--border); }
    .stack-col { display: flex; flex-direction: column; }
    .flex-grow-1 { flex: 1 1 auto; }
    .p-3 { padding: 10px 14px; }
    .h-100 { height: 100%; }

    @media (max-width: 960px) {
      .layout { grid-template-columns: 1fr; }
      .summary-grid { grid-template-columns: repeat(2, 1fr); }
      .proxy-form { grid-template-columns: 1fr; }
      .proxy-panel { height: auto; }
    }
  </style>
</head>
<body>
  <div id="loginOverlay">
    <div class="login-card">
      <h2>Lunel Manager</h2>
      <p>Enter your admin password to continue.</p>
      <div id="loginError"></div>
      <input id="loginPw" type="password" class="input-app mb-3" placeholder="Admin password" autocomplete="current-password" />
      <button id="loginBtn" class="btn-app btn-app-primary w-100">Sign in</button>
    </div>
  </div>

  <div class="shell">
    <div class="app-header">
      <div>
        <h1>Lunel Manager</h1>
        <div class="sub">Proxy control plane</div>
      </div>
      <button id="signOutBtn" class="btn-app btn-app-ghost">Sign out</button>
    </div>

    <div class="summary-grid" id="summary">
      <div class="summary-card">
        <div class="summary-label">Proxies</div>
        <b id="statProxies">0</b>
      </div>
      <div class="summary-card">
        <div class="summary-label">Active</div>
        <b id="statActive">0</b>
      </div>
      <div class="summary-card">
        <div class="summary-label">Sessions</div>
        <b id="statSessions">0</b>
      </div>
      <div class="summary-card">
        <div class="summary-label">Connections</div>
        <b id="statConnections">0</b>
      </div>
    </div>

    <div class="layout">
      <section class="panel-card proxy-panel">
        <div class="card-header table-header">
          <div>
            <strong>Proxies</strong>
            <div class="sub">Add gateways and manage state directly from this table.</div>
          </div>
          <button id="refreshBtn" class="btn-app btn-app-soft btn-app-xs">Refresh</button>
        </div>
        <div class="card-body border-bottom-line">
          <div class="proxy-form">
            <input id="newUrl" class="input-app" placeholder="https://gateway-1.lunel.dev" />
            <input id="newProxyPw" type="password" class="input-app" placeholder="Proxy password" />
            <button id="addBtn" class="btn-app btn-app-primary">Add Proxy</button>
          </div>
        </div>
        <div class="table-responsive table-wrap">
          <table class="proxy-table table-sticky">
            <thead>
              <tr>
                <th>Proxy</th>
                <th>State</th>
                <th>CPU</th>
                <th>RAM</th>
                <th>Network</th>
                <th>Connections</th>
                <th>Sessions</th>
                <th>Unique 24h</th>
                <th>Last Heartbeat</th>
                <th></th>
                <th></th>
                <th></th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody id="tbody"></tbody>
          </table>
        </div>
      </section>

      <div class="side-column">
        <section class="panel-card">
          <div class="card-header"><strong>Operations</strong></div>
          <div class="operations-list">
            <button id="auditBtn" class="btn-app btn-app-soft">Audit Events</button>
            <button id="alertsBtn" class="btn-app btn-app-danger">Security Alerts</button>
            <button id="vmHealthBtn" class="btn-app btn-app-soft">VM Health</button>
            <button id="gatewaysBtn" class="btn-app btn-app-soft">Gateway Lifecycle</button>
          </div>
        </section>

        <section class="panel-card inspector-panel stack-col">
          <div class="card-header table-header">
            <strong id="detailsTitle">JSON Viewer</strong>
            <div style="display:flex;gap:4px;">
              <button id="copyJsonBtn" class="btn-app btn-app-soft btn-app-xs">Copy</button>
              <button id="maximizeBtn" class="btn-app btn-app-soft btn-app-xs">Maximize</button>
            </div>
          </div>
          <pre id="details" class="flex-grow-1">{}</pre>
        </section>
      </div>
    </div>
  </div>

  <div id="inspectorOverlay">
    <div class="overlay-header">
      <strong id="overlayTitle">JSON Viewer</strong>
      <div style="display:flex;gap:4px;">
        <button id="overlayCopyBtn" class="btn-app btn-app-soft btn-app-xs">Copy</button>
        <button id="minimizeBtn" class="btn-app btn-app-soft btn-app-xs">Minimize</button>
      </div>
    </div>
    <pre id="overlayDetails">{}</pre>
  </div>

  <script>
    let token = "";
    let currentJsonText = "{}";

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function fmtNum(n) {
      return Number.isFinite(n) ? Number(n).toFixed(1) : "0.0";
    }

    function fmtMbps(n) {
      const mbps = (Number(n || 0) * 8) / (1024 * 1024);
      return fmtNum(mbps) + " Mbps";
    }

    function fmtInt(n) {
      return Number(n || 0).toLocaleString();
    }

    function stateBadgeClass(state) {
      if (state === "active") return "status-active";
      if (state === "draining") return "status-draining";
      if (state === "disabled") return "status-disabled";
      return "status-unknown";
    }

    function setDetails(title, data) {
      currentJsonText = JSON.stringify(data, null, 4);
      document.getElementById("detailsTitle").textContent = title;
      document.getElementById("details").textContent = currentJsonText;
      document.getElementById("overlayTitle").textContent = title;
      document.getElementById("overlayDetails").textContent = currentJsonText;
    }

    function showLogin(message) {
      document.getElementById("loginError").textContent = message || "";
      document.getElementById("loginPw").value = "";
      document.getElementById("loginOverlay").classList.remove("hidden");
      document.getElementById("loginPw").focus();
    }

    function hideLogin() {
      document.getElementById("loginOverlay").classList.add("hidden");
    }

    document.getElementById("loginBtn").addEventListener("click", async () => {
      const pw = document.getElementById("loginPw").value.trim();
      if (!pw) { document.getElementById("loginError").textContent = "Enter password"; return; }
      try {
        const res = await fetch("/v1/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pw }),
        });
        if (!res.ok) { document.getElementById("loginError").textContent = "Wrong password"; return; }
        const json = await res.json();
        token = json.token || "";
        if (!token) { document.getElementById("loginError").textContent = "No token received"; return; }
        hideLogin();
        await refresh();
      } catch (err) {
        document.getElementById("loginError").textContent = String(err);
      }
    });

    document.getElementById("loginPw").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("loginBtn").click();
    });

    document.getElementById("signOutBtn").addEventListener("click", () => {
      token = "";
      showLogin("Signed out");
    });

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token,
          ...(options.headers || {}),
        },
      });

      if (res.status === 401) {
        token = "";
        showLogin("Session expired — please sign in again");
        throw new Error("Unauthorized");
      }
      return res;
    }

    async function refresh() {
      const res = await api("/v1/admin/list");
      const data = await res.json();
      const proxies = Array.isArray(data.proxies) ? data.proxies : [];
      const tbody = document.getElementById("tbody");
      tbody.innerHTML = "";

      let active = 0;
      let sessions = 0;
      let connections = 0;

      for (const proxy of proxies) {
        if ((proxy.state || "active") === "active") active++;
        sessions += Number(proxy.activeSessions || 0);
        connections += Number(proxy.activeConnections || 0);

        const tr = document.createElement("tr");
        const proxyState = proxy.state || "active";
        tr.innerHTML =
          "<td>" + escapeHtml(proxy.url) + "</td>" +
          "<td><span class='status-chip " + stateBadgeClass(proxyState) + "'>" + escapeHtml(proxyState) + "</span></td>" +
          "<td>" + fmtNum(proxy.cpuPercent || 0) + "%</td>" +
          "<td>" + fmtNum(proxy.memoryUsedMb || 0) + " / " + fmtNum(proxy.memoryTotalMb || 0) + " MB</td>" +
          "<td>↓ " + fmtMbps(proxy.networkInBps || 0) + " &nbsp; ↑ " + fmtMbps(proxy.networkOutBps || 0) + "</td>" +
          "<td>" + fmtInt(proxy.activeConnections || 0) + "</td>" +
          "<td>" + fmtInt(proxy.activeSessions || 0) + "</td>" +
          "<td>" + fmtInt(proxy.uniqueSessions24h || 0) + "</td>" +
          "<td>" + (proxy.lastHeartbeat ? new Date(proxy.lastHeartbeat).toLocaleString() : "never") + "</td>" +
          "<td><button class='btn-app btn-app-soft btn-app-xs' data-action='details' data-url='" + escapeHtml(proxy.url) + "'>Details</button></td>" +
          "<td><button class='btn-app btn-app-soft btn-app-xs' data-action='activate' data-url='" + escapeHtml(proxy.url) + "'>Activate</button></td>" +
          "<td><button class='btn-app btn-app-soft btn-app-xs' data-action='drain' data-url='" + escapeHtml(proxy.url) + "'>Drain</button></td>" +
          "<td><button class='btn-app btn-app-soft btn-app-xs' data-action='disable' data-url='" + escapeHtml(proxy.url) + "'>Disable</button></td>" +
          "<td><button class='btn-app btn-app-danger btn-app-xs' data-action='remove' data-url='" + escapeHtml(proxy.url) + "'>Remove</button></td>";
        tbody.appendChild(tr);
      }

      document.getElementById("statProxies").textContent = fmtInt(proxies.length);
      document.getElementById("statActive").textContent = fmtInt(active);
      document.getElementById("statSessions").textContent = fmtInt(sessions);
      document.getElementById("statConnections").textContent = fmtInt(connections);
    }

    document.getElementById("addBtn").addEventListener("click", async () => {
      const urlInput = document.getElementById("newUrl");
      const pwInput = document.getElementById("newProxyPw");
      const url = urlInput.value.trim();
      if (!url) return;
      const proxyPassword = pwInput.value.trim();
      if (!proxyPassword) { alert("Proxy password is required"); return; }
      const res = await api("/v1/admin/add", { method: "POST", body: JSON.stringify({ url, proxyPassword }) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert("Error: " + (data.error || res.status));
        return;
      }
      urlInput.value = "";
      pwInput.value = "";
      await refresh();
    });

    document.getElementById("refreshBtn").addEventListener("click", async () => {
      await refresh();
    });

    function flashCopied(btn) {
      btn.style.background = "#22c55e";
      btn.style.color = "#fff";
      btn.style.borderColor = "#16a34a";
      setTimeout(() => {
        btn.style.background = "";
        btn.style.color = "";
        btn.style.borderColor = "";
      }, 1000);
    }

    document.getElementById("copyJsonBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(currentJsonText); flashCopied(document.getElementById("copyJsonBtn")); } catch {}
    });

    document.getElementById("maximizeBtn").addEventListener("click", () => {
      document.getElementById("inspectorOverlay").classList.add("visible");
    });

    document.getElementById("minimizeBtn").addEventListener("click", () => {
      document.getElementById("inspectorOverlay").classList.remove("visible");
    });

    document.getElementById("overlayCopyBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(currentJsonText); flashCopied(document.getElementById("overlayCopyBtn")); } catch {}
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") document.getElementById("inspectorOverlay").classList.remove("visible");
    });

    document.getElementById("tbody").addEventListener("click", async (e) => {
      const target = e.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const action = target.getAttribute("data-action");
      const url = target.getAttribute("data-url") || "";
      if (!url) return;

      if (action === "remove") {
        await api("/v1/admin/remove", { method: "POST", body: JSON.stringify({ url }) });
        await refresh();
        return;
      }

      if (action === "activate" || action === "drain" || action === "disable") {
        const state = action === "activate" ? "active" : action === "drain" ? "draining" : "disabled";
        await api("/v1/admin/proxy-state", { method: "POST", body: JSON.stringify({ url, state }) });
        await refresh();
        return;
      }

      if (action === "details") {
        const res = await api("/v1/admin/details?url=" + encodeURIComponent(url));
        const details = await res.json();
        setDetails("Proxy Details", details);
      }
    });

    document.getElementById("auditBtn").addEventListener("click", async () => {
      const res = await api("/v1/admin/audit?limit=100");
      setDetails("Audit Events", await res.json());
    });

    document.getElementById("alertsBtn").addEventListener("click", async () => {
      const res = await api("/v1/admin/security-alerts?limit=100");
      setDetails("Security Alerts", await res.json());
    });

    document.getElementById("vmHealthBtn").addEventListener("click", async () => {
      const res = await api("/v1/admin/vm-health");
      setDetails("VM Health", await res.json());
    });

    document.getElementById("gatewaysBtn").addEventListener("click", async () => {
      const res = await api("/v1/admin/gateways?limit=200");
      setDetails("Gateway Lifecycle", await res.json());
    });

    // Show login screen on load; auto-refresh after login
    showLogin("");
    setInterval(() => { if (token) refresh().catch(() => {}); }, 10000);
  </script>
</body>
</html>`;
  };

  const cleanupManagerSessions = (): void => {
    const now = Date.now();
    const graceExpired = listExpiredGraceSessionsStmt.all(now) as Array<{
      sessionId: string;
      resumeToken: string;
      primaryGateway: string;
      backupGateway: string | null;
    }>;
    for (const row of graceExpired) {
      console.log(`[session] expired — ${row.sessionId} (app reconnect timeout)`);
      sendManagerCommandForSession(row, "close_session", {
        resumeToken: row.resumeToken,
        reason: "app reconnect timeout",
      });
      deleteSessionRuntimeStmt.run(row.resumeToken);
    }
    cleanupExpiredPendingStmt.run(now, now);
    cleanupExpiredGraceStmt.run(now, now);

    const cliGraceExpired = listExpiredCliGraceSessionsStmt.all(now) as Array<{
      sessionId: string;
      resumeToken: string;
      primaryGateway: string;
      backupGateway: string | null;
    }>;
    for (const row of cliGraceExpired) {
      console.log(`[session] expired — ${row.sessionId} (cli reconnect timeout)`);
      sendManagerCommandForSession(row, "close_session", {
        resumeToken: row.resumeToken,
        reason: "cli reconnect timeout",
      });
      deleteSessionRuntimeStmt.run(row.resumeToken);
    }
    cleanupExpiredCliGraceStmt.run(now, now);

    // Cloud VM dead detection: sessions in cli_offline_grace with stale VM heartbeats
    if (sandmanAuthToken) {
      const deadVmThreshold = now - VM_HEARTBEAT_STALE_MS;
      const deadVmSessions = listDeadVmHeartbeatsForCliGraceStmt.all(deadVmThreshold) as Array<{
        sandboxId: string;
        resumeToken: string;
        sandmanUrl: string;
        repoUrl: string;
        branch: string;
        vmProfile: string;
        lastHeartbeat: number;
        sessionCode: string;
        primaryGateway: string;
        backupGateway: string | null;
      }>;
      for (const row of deadVmSessions) {
        const effectiveSandmanUrl = row.sandmanUrl || sandmanPublicUrl;
        if (!effectiveSandmanUrl) {
          console.warn(`[manager] VM ${row.sandboxId} dead but no sandman_url; skipping replacement`);
          deleteVmHeartbeatStmt.run(row.sandboxId);
          continue;
        }
        const newSandboxId = `${row.sandboxId.slice(0, 48)}-r${Date.now()}`.slice(0, 64);
        insertSecurityAlertStmt.run(
          now,
          "high",
          "vm_health",
          `vm_dead:${row.sandboxId}`,
          `VM ${row.sandboxId} heartbeat stale — provisioning replacement ${newSandboxId}`,
          JSON.stringify({ sandboxId: row.sandboxId, sandmanUrl: effectiveSandmanUrl, sessionCode: row.sessionCode })
        );
        console.log(`[manager] VM ${row.sandboxId} dead, provisioning replacement ${newSandboxId}`);
        fetch(`${effectiveSandmanUrl}/vms`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${sandmanAuthToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sandbox_id: newSandboxId,
            repo_url: row.repoUrl,
            branch: row.branch,
            profile: row.vmProfile || "2-2-20-s",
            session_code: row.sessionCode,
            sandman_url: effectiveSandmanUrl,
          }),
        }).catch((err) => {
          console.warn(`[manager] replacement VM provision failed for ${row.sandboxId}:`, String(err));
        });
        deleteVmHeartbeatStmt.run(row.sandboxId);
      }
    }
  };

  const pickGatewaysForSession = (sessionId: string): { primary: string; backup: string | null } | null => {
    const gateways = chooseGatewaysForSession(sessionId);
    if (gateways.length === 0) return null;
    return { primary: gateways[0], backup: gateways[1] || null };
  };

  const preloadGatewaySession = async (
    gateway: string,
    payload: { password: string; createdAt: number; role: "primary" | "secondary"; peerGateway: string | null }
  ): Promise<void> => {
    const proxyRow = getProxyPasswordStmt.get(gateway) as { password: string } | null;
    const proxyPassword = proxyRow?.password || "";
    await fetch(`${gateway}/v1/session/preload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(proxyPassword ? { "X-Proxy-Password": proxyPassword } : {}),
      },
      body: JSON.stringify(payload),
    });
  };

  const aliasGatewaySession = async (
    gateway: string,
    payload: { fromPassword: string; toPassword: string }
  ): Promise<void> => {
    const proxyRow = getProxyPasswordStmt.get(gateway) as { password: string } | null;
    const proxyPassword = proxyRow?.password || "";
    await fetch(`${gateway}/v1/session/alias`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(proxyPassword ? { "X-Proxy-Password": proxyPassword } : {}),
      },
      body: JSON.stringify(payload),
    });
  };

  const createManagedSession = async (opts: {
    code?: string;
    expiresAt?: number;
  } = {}): Promise<ManagerSession> => {
    const sessionId = randomUUID();
    const picked = pickGatewaysForSession(sessionId);
    if (!picked) {
      throw new Error("no healthy gateways available");
    }

    let code = (opts.code || "").trim();
    if (code) {
      if (codeExistsStmt.get(code)) {
        throw new Error(`session code already exists: ${code}`);
      }
    } else {
      do {
        code = generateSecureCode();
      } while (Boolean(codeExistsStmt.get(code)));
    }

    const resumeToken = generateSessionPassword();
    const createdAt = Date.now();
    const session: ManagerSession = {
      sessionId,
      code,
      resumeToken,
      primary: picked.primary,
      backup: picked.backup,
      state: "pending",
      createdAt,
      updatedAt: createdAt,
      expiresAt: Number(opts.expiresAt || (createdAt + CODE_TTL_MS)),
      endedAt: null,
    };

    insertSessionStmt.run(
      session.sessionId,
      session.code,
      session.resumeToken,
      session.primary,
      session.backup,
      session.state,
      null,
      session.createdAt,
      session.updatedAt,
      session.expiresAt,
      null,
      session.endedAt
    );

    const preloadCalls: Promise<void>[] = [];
    preloadCalls.push(
      preloadGatewaySession(picked.primary, {
        password: resumeToken,
        createdAt,
        role: "primary",
        peerGateway: picked.backup,
      })
    );
    if (picked.backup) {
      preloadCalls.push(
        preloadGatewaySession(picked.backup, {
          password: resumeToken,
          createdAt,
          role: "secondary",
          peerGateway: picked.primary,
        })
      );
    }

    try {
      await Promise.all(preloadCalls);
      return session;
    } catch (err) {
      db.query("DELETE FROM sessions WHERE session_id = ?1").run(sessionId);
      throw err;
    }
  };

  setInterval(cleanupManagerSessions, 60 * 1000);
  setInterval(() => cleanupExpiredV2State(), 30 * 1000);

  Bun.serve<GatewaySocketData>({
    port: Number(process.env.PORT || 8899),
    fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeadersForRequest(req) });
      }

      if (path === "/v2/qr" && req.method === "GET") {
        cleanupExpiredV2State();
        let code = "";
        do {
          code = generateSecureCode();
        } while (assembleSessionsByCode.has(code));
        getOrCreateAssembleSession(code);
        return Response.json({ code, expiresInMs: V2_CODE_TTL_MS }, { headers: corsHeaders });
      }

      if (path === "/v2/assemble" && req.method === "GET") {
        cleanupExpiredV2State();
        if (!isTrustedRequestOrigin(req)) {
          return Response.json({ error: "untrusted origin" }, { status: 403, headers: corsHeaders });
        }
        const code = (url.searchParams.get("code") || "").trim();
        const role = (url.searchParams.get("role") || "").trim() as Role;
        if (!code) {
          return Response.json({ error: "code is required" }, { status: 400, headers: corsHeaders });
        }
        if (role !== "app" && role !== "cli") {
          return Response.json({ error: "role must be app or cli" }, { status: 400, headers: corsHeaders });
        }
        const session = assembleSessionsByCode.get(code);
        if (!session || session.expiresAt <= Date.now()) {
          return Response.json({ error: "code not found or expired" }, { status: 404, headers: corsHeaders });
        }
        if ((role === "app" && session.appWs) || (role === "cli" && session.cliWs)) {
          return Response.json({ error: `${role} already connected for code` }, { status: 409, headers: corsHeaders });
        }
        const upgraded = server.upgrade(req, {
          data: { type: "assemble", code, role },
        });
        if (!upgraded) {
          return Response.json({ error: "upgrade failed" }, { status: 500, headers: corsHeaders });
        }
        return undefined;
      }

        if (path === "/v2/proxy" && (req.method === "POST" || req.method === "GET")) {
          cleanupExpiredV2State();
          const responseHeaders = corsHeadersForRequest(req);
          const bodyPromise: Promise<{ password?: string }> = req.method === "POST"
            ? req.json().catch(() => { throw new Error("invalid body"); }) as Promise<{ password?: string }>
            : Promise.resolve({ password: url.searchParams.get("password") || "" });
          return bodyPromise
            .then((body) => {
              const password = (body.password || "").trim();
              if (!password) {
                return Response.json({ error: "password is required" }, { status: 400, headers: responseHeaders });
              }
              const pairing = getPairingBySecretStmt.get(password) as any;
              if (pairing && Number(pairing.revokedAt || 0) > 0) {
                return Response.json({ error: "password revoked", reason: "revoked" }, { status: 403, headers: responseHeaders });
              }
              const passwordHash = hashPassword(password);
              const record = issuedPasswordsByHash.get(passwordHash);
              if (!record || record.expiresAt <= Date.now()) {
                return Response.json({ error: "password invalid" }, { status: 404, headers: responseHeaders });
              }
              if (!record.proxyUrl && getActiveProxyUrls().length === 0) {
                return Response.json({ error: "no active proxies" }, { status: 503, headers: responseHeaders });
              }
              return assignProxyUrl(password).then((assignedRecord) => {
                if (!assignedRecord || !assignedRecord.proxyUrl) {
                  return Response.json({ error: "proxy assignment unavailable" }, { status: 503, headers: responseHeaders });
                }
                return Response.json({ proxyUrl: assignedRecord.proxyUrl }, { headers: responseHeaders });
              });
            })
            .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: responseHeaders }));
        }

        if (path === "/v2/reattach/claim" && (req.method === "POST" || req.method === "GET")) {
          cleanupExpiredV2State();
          const responseHeaders = corsHeadersForRequest(req);
          const bodyPromise: Promise<{ password?: string; role?: Role }> = req.method === "POST"
            ? req.json().catch(() => { throw new Error("invalid body"); }) as Promise<{ password?: string; role?: Role }>
            : Promise.resolve({
                password: url.searchParams.get("password") || "",
                role: (url.searchParams.get("role") || "") as Role,
              });
          return bodyPromise
            .then(async (body) => {
              const password = (body.password || "").trim();
              const role = body.role;
              if (!password) {
                return Response.json({ error: "password is required" }, { status: 400, headers: responseHeaders });
              }
              if (role !== "app" && role !== "cli") {
                return Response.json({ error: "role must be app or cli" }, { status: 400, headers: responseHeaders });
              }
              const pairing = getPairingBySecretStmt.get(password) as any;
              if (pairing && Number(pairing.revokedAt || 0) > 0) {
                return Response.json({ error: "password revoked", reason: "revoked" }, { status: 403, headers: responseHeaders });
              }
              const record = await claimReattachSession(password, role);
              if (!record || !record.proxyUrl) {
                return Response.json({ error: "reattach unavailable" }, { status: 404, headers: responseHeaders });
              }
              return Response.json({
                proxyUrl: record.proxyUrl,
                generation: record.generation,
                expiresAt: record.expiresAt,
              }, { headers: responseHeaders });
            })
            .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: responseHeaders }));
        }

      if (path === "/v2/proxy/validate" && req.method === "POST") {
        cleanupExpiredV2State();
        return req
          .json()
          .then((body: { password?: string; role?: Role; generation?: number }) => {
            const password = (body.password || "").trim();
            const role = (body.role || "").trim() as Role;
            const generation = Number(body.generation || 0);
            if (!password) {
              return Response.json({ valid: false, reason: "missing_password" }, { status: 400, headers: corsHeaders });
            }
            if (role && role !== "app" && role !== "cli") {
              return Response.json({ valid: false, reason: "invalid_role" }, { status: 400, headers: corsHeaders });
            }
            const record = issuedPasswordsByHash.get(hashPassword(password));
            if (!record || record.expiresAt <= Date.now()) {
              return Response.json({ valid: false, reason: "invalid_password" }, { headers: corsHeaders });
            }
            const reattach = getReattachSession(password);
            if (reattach) {
              if (role === "app" || role === "cli") {
                if (!Number.isFinite(generation) || generation < 1) {
                  return Response.json({
                    valid: false,
                    reason: "reattach_generation_required",
                    proxyUrl: reattach.proxyUrl,
                    generation: reattach.generation,
                    code: record.code,
                  }, { headers: corsHeaders });
                }
                if (generation !== Number(reattach.generation || 0)) {
                  return Response.json({
                    valid: false,
                    reason: "stale_generation",
                    proxyUrl: reattach.proxyUrl,
                    generation: reattach.generation,
                    code: record.code,
                  }, { headers: corsHeaders });
                }
              }
              return Response.json({
                valid: true,
                proxyUrl: reattach.proxyUrl,
                generation: reattach.generation,
                code: record.code,
              }, { headers: corsHeaders });
            }
            return Response.json({ valid: true, proxyUrl: record.proxyUrl, code: record.code }, { headers: corsHeaders });
          })
          .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
      }

      if (path === "/health") {
        const connectedProxies = managerControlSocketsByGateway.size;
        return Response.json({
          status: "ok",
          mode: "manager",
          connectedProxies,
          ring: getHealthyRing(),
        }, { headers: corsHeadersForRequest(req) });
      }

      if (path === "/v1/gateways" && req.method === "GET") {
        const gateways = chooseGateways();
        return Response.json(
          {
            gateways,
            primary: gateways[0] || null,
            backup: gateways[1] || null,
          },
          { headers: corsHeaders }
        );
      }

      if (path === "/v1/session/resolve" && req.method === "POST") {
        const sourceIp = extractClientIp(req);
        const tempBlocked = enforceTemporaryBlock(req, "public-session-resolve");
        if (tempBlocked) return tempBlocked;
        const blocked = enforceRateLimit(req, "manager:session-resolve", {
          windowMs: 60_000,
          perIp: 120,
          perSubnet: 1200,
        });
        if (blocked) {
          writeAuditLog({
            actorType: "public",
            actorId: "unknown",
            action: "session.resolve",
            targetType: "session",
            targetId: "-",
            sourceIp,
            status: "denied",
            message: "rate limited",
          });
          return blocked;
        }

        return req
          .json()
          .then((body: { code?: string; resumeToken?: string }) => {
            const code = (body.code || "").trim();
            const resumeToken = (body.resumeToken || "").trim();

            if ((!code && !resumeToken) || (code && resumeToken)) {
              return Response.json(
                { error: "provide exactly one of code or resumeToken" },
                { status: 400, headers: corsHeaders }
              );
            }

            const now = Date.now();
            let row = code ? getSessionByCodeStmt.get(code) : getSessionByTokenStmt.get(resumeToken);
            let snapshot = buildSessionSnapshot(row, now);
            if (!code && !snapshot.exists) {
              const pairing = getPairingBySecretStmt.get(resumeToken) as any;
              const pairingSnapshot = buildPairingSnapshot(pairing);
              if (pairingSnapshot.exists) {
                snapshot = pairingSnapshot;
                row = pairing;
                if (pairingSnapshot.valid) {
                  updatePairingTouchStmt.run(pairing.secret, pairing.hostname, now);
                }
              }
            }
            const reusedPairingCode =
              Boolean(code) &&
              snapshot.exists &&
              Number(snapshot.pairedAt || 0) > 0;
            const effectiveSnapshot = reusedPairingCode
              ? {
                  exists: true,
                  valid: false,
                  reason: "code_already_used",
                  sessionId: snapshot.sessionId,
                  code: snapshot.code,
                  state: snapshot.state,
                  expiresAt: snapshot.expiresAt,
                  updatedAt: snapshot.updatedAt,
                }
              : snapshot;

            if (!effectiveSnapshot.exists) {
              recordFailureAndMaybeBlock(
                code ? "public-session-resolve-code" : "public-session-resolve-token",
                req,
                {
                  threshold: 20,
                  windowMs: 5 * 60_000,
                  blockMs: 10 * 60_000,
                }
              );
              if (resumeToken) {
                emitSecurityAlert({
                  severity: "warn",
                  category: "resume_probe",
                  alertKey: `resume_probe:${sourceIp}`,
                  message: "Unknown resume token was probed",
                  metadata: { sourceIp },
                });
              }
            } else if (!effectiveSnapshot.valid && resumeToken) {
              emitSecurityAlert({
                severity: "info",
                category: "resume_invalid",
                alertKey: `resume_invalid:${effectiveSnapshot.sessionId ?? "unknown"}:${effectiveSnapshot.reason}`,
                message: "Resume token checked but not valid",
                metadata: {
                  reason: effectiveSnapshot.reason,
                  sessionId: effectiveSnapshot.sessionId ?? null,
                },
              });
            }

            writeAuditLog({
              actorType: "public",
              actorId: "unknown",
              action: "session.resolve",
              targetType: code ? "session_code" : "session_token",
              targetId: code || "redacted",
              sourceIp,
              status: effectiveSnapshot.valid ? "ok" : "error",
              message: effectiveSnapshot.reason,
            });

            return Response.json(effectiveSnapshot, { headers: corsHeaders });
          })
          .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
      }

      if (path === "/v1/session" && req.method === "POST") {
        const sourceIp = extractClientIp(req);
        const tempBlocked = enforceTemporaryBlock(req, "public-session-create");
        if (tempBlocked) return tempBlocked;
        const blocked = enforceRateLimit(req, "manager:create-session", {
          windowMs: 60_000,
          perIp: 20,
          perSubnet: 200,
        });
        if (blocked) {
          writeAuditLog({
            actorType: "public",
            actorId: "unknown",
            action: "session.create",
            targetType: "session",
            targetId: "-",
            sourceIp,
            status: "denied",
            message: "rate limited",
          });
          return blocked;
        }

        return req
          .json()
          .catch(() => ({} as { requestedCode?: string }))
          .then(() => {
            return createManagedSession().then((session) => {
              writeAuditLog({
                actorType: "public",
                actorId: "unknown",
                action: "session.create",
                targetType: "session",
                targetId: session.sessionId,
                sourceIp,
                status: "ok",
                message: "session created",
                metadata: {
                  primary: session.primary,
                  backup: session.backup,
                  expiresAt: session.expiresAt,
                },
              });
              return Response.json(
                {
                  code: session.code,
                  password: session.resumeToken,
                  sessionId: session.sessionId,
                  primary: session.primary,
                  backup: session.backup,
                  expiresAt: session.expiresAt,
                },
                { headers: corsHeaders }
              );
            });
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            writeAuditLog({
              actorType: "public",
              actorId: "unknown",
              action: "session.create",
              targetType: "session",
              targetId: "-",
              sourceIp,
              status: "error",
              message: "preload failed",
              metadata: { error: message },
            });
            console.warn(`[session] create failed — preload error:`, redactSensitive(message));
            return Response.json(
              { error: message === "no healthy gateways available" ? "no healthy gateways available" : "failed to preload gateways" },
              { status: message === "no healthy gateways available" ? 503 : 502, headers: corsHeaders }
            );
          });
      }

      if (path === "/v1/pairings/register" && req.method === "POST") {
        const sourceIp = extractClientIp(req);
        const blocked = enforceRateLimit(req, "manager:pairings-register", {
          windowMs: 60_000,
          perIp: 120,
          perSubnet: 1200,
        });
        if (blocked) return blocked;

        return req
          .json()
          .then(async (body: { activeSecret?: string; phoneId?: string; pcId?: string; root?: string; hostname?: string }) => {
            const activeSecret = (body.activeSecret || "").trim();
            const phoneId = (body.phoneId || "").trim();
            const pcId = (body.pcId || "").trim();
            const root = (body.root || "").trim();
            const hostname = (body.hostname || "").trim() || "Unknown Host";

            if (!activeSecret || !phoneId || !pcId || !root) {
              return Response.json({ error: "activeSecret, phoneId, pcId, and root are required" }, { status: 400, headers: corsHeaders });
            }

            const sessionRow = getSessionByTokenStmt.get(activeSecret) as any;

            const existingPairing = getPairingBySecretStmt.get(activeSecret) as any;
            if (existingPairing) {
              if (
                Number(existingPairing.revokedAt || 0) > 0 ||
                existingPairing.pcId !== pcId ||
                existingPairing.phoneId !== phoneId ||
                existingPairing.root !== root
              ) {
                return Response.json({ error: "pairing secret is invalid" }, { status: 403, headers: corsHeaders });
              }
              const now = Date.now();
              updatePairingTouchStmt.run(existingPairing.secret, hostname, now);
              if (existingPairing.secret !== activeSecret && sessionRow?.primary_gateway) {
                const aliasCalls: Promise<void>[] = [
                  aliasGatewaySession(sessionRow.primary_gateway, {
                    fromPassword: activeSecret,
                    toPassword: existingPairing.secret,
                  }),
                ];
                if (sessionRow.backup_gateway) {
                  aliasCalls.push(aliasGatewaySession(sessionRow.backup_gateway, {
                    fromPassword: activeSecret,
                    toPassword: existingPairing.secret,
                  }));
                }
                await Promise.all(aliasCalls);
              }
              return Response.json({
                secret: existingPairing.secret,
                hostname,
                root: existingPairing.root,
                phoneId: existingPairing.phoneId,
                pairedAt: existingPairing.pairedAt,
                lastUsedAt: now,
              }, { headers: corsHeaders });
            }

            const sessionSnapshot = buildSessionSnapshot(sessionRow, Date.now());
            if (!sessionSnapshot.exists || !sessionSnapshot.valid) {
              return Response.json({ error: "active session not found" }, { status: 404, headers: corsHeaders });
            }

            const scopedPairing = getPairingByScopeStmt.get(pcId, phoneId, root) as any;
            if (scopedPairing && Number(scopedPairing.revokedAt || 0) === 0) {
              const now = Date.now();
              updatePairingTouchStmt.run(scopedPairing.secret, hostname, now);
              if (scopedPairing.secret !== activeSecret && sessionRow?.primary_gateway) {
                const aliasCalls: Promise<void>[] = [
                  aliasGatewaySession(sessionRow.primary_gateway, {
                    fromPassword: activeSecret,
                    toPassword: scopedPairing.secret,
                  }),
                ];
                if (sessionRow.backup_gateway) {
                  aliasCalls.push(aliasGatewaySession(sessionRow.backup_gateway, {
                    fromPassword: activeSecret,
                    toPassword: scopedPairing.secret,
                  }));
                }
                await Promise.all(aliasCalls);
              }
              return Response.json({
                secret: scopedPairing.secret,
                hostname,
                root: scopedPairing.root,
                phoneId: scopedPairing.phoneId,
                pairedAt: scopedPairing.pairedAt,
                lastUsedAt: now,
              }, { headers: corsHeaders });
            }

            const now = Date.now();
            const secret = generatePersistentSecret();
            insertPairingStmt.run(
              secret,
              pcId,
              phoneId,
              root,
              hostname,
              now,
              now,
              now,
              now
            );
            if (sessionRow?.primary_gateway) {
              const aliasCalls: Promise<void>[] = [
                aliasGatewaySession(sessionRow.primary_gateway, {
                  fromPassword: activeSecret,
                  toPassword: secret,
                }),
              ];
              if (sessionRow.backup_gateway) {
                aliasCalls.push(aliasGatewaySession(sessionRow.backup_gateway, {
                  fromPassword: activeSecret,
                  toPassword: secret,
                }));
              }
              await Promise.all(aliasCalls);
            }
            writeAuditLog({
              actorType: "public",
              actorId: phoneId,
              action: "pairing.register",
              targetType: "pairing",
              targetId: secret.slice(0, 12),
              sourceIp,
              status: "ok",
              message: "persistent pairing registered",
              metadata: { pcId, root, hostname },
            });
            return Response.json({
              secret,
              hostname,
              root,
              phoneId,
              pairedAt: now,
              lastUsedAt: now,
            }, { headers: corsHeaders });
          })
          .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
      }

      if (path === "/v1/pairings/lookup" && req.method === "POST") {
        const sourceIp = extractClientIp(req);
        const blocked = enforceRateLimit(req, "manager:pairings-lookup", {
          windowMs: 60_000,
          perIp: 240,
          perSubnet: 1200,
        });
        if (blocked) return blocked;

        return req
          .json()
          .then((body: { pcId?: string; root?: string }) => {
            const pcId = (body.pcId || "").trim();
            const root = (body.root || "").trim();
            if (!pcId || !root) {
              return Response.json({ error: "pcId and root are required" }, { status: 400, headers: corsHeaders });
            }

            const matches = listPairingsByCliScopeStmt.all(pcId, root) as Array<any>;
            const active = matches.filter((row) => Number(row.revokedAt || 0) === 0);
            writeAuditLog({
              actorType: "public",
              actorId: pcId,
              action: "pairing.lookup",
              targetType: "pairing_scope",
              targetId: root,
              sourceIp,
              status: active.length > 0 ? "ok" : "error",
              message: active.length > 0 ? "pairings found" : "pairings not found",
            });
            return Response.json({
              pairings: active.map((row) => ({
                secret: row.secret,
                hostname: row.hostname,
                root: row.root,
                phoneId: row.phoneId,
                pairedAt: row.pairedAt,
                lastUsedAt: row.lastUsedAt,
              })),
            }, { headers: corsHeaders });
          })
          .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
      }

      if (path === "/v2/revoke" && req.method === "POST") {
        const sourceIp = extractClientIp(req);
        const blocked = enforceRateLimit(req, "manager:pairings-revoke", {
          windowMs: 60_000,
          perIp: 120,
          perSubnet: 1200,
        });
        if (blocked) return blocked;

        return req
          .json()
          .then((body: { password?: string; reason?: string }) => {
            const password = (body.password || "").trim();
            const reason = (body.reason || "revoked by app").trim();
            if (!password) {
              return Response.json({ error: "password is required" }, { status: 400, headers: corsHeaders });
            }

            const pairing = getPairingBySecretStmt.get(password) as any;
            if (!pairing) {
              return Response.json({ valid: false, reason: "not_found" }, { status: 404, headers: corsHeaders });
            }

            if (Number(pairing.revokedAt || 0) > 0) {
              return Response.json({ valid: false, reason: "revoked", revokedAt: pairing.revokedAt }, { headers: corsHeaders });
            }

            const now = Date.now();
            revokePairingStmt.run(password, now);
            writeAuditLog({
              actorType: "public",
              actorId: pairing.phoneId || "unknown",
              action: "pairing.revoke",
              targetType: "pairing",
              targetId: password.slice(0, 12),
              sourceIp,
              status: "ok",
              message: "pairing revoked",
              metadata: {
                reason,
                pcId: pairing.pcId,
                phoneId: pairing.phoneId,
                root: pairing.root,
                hostname: pairing.hostname,
              },
            });
            return Response.json({ ok: true, valid: false, reason: "revoked", revokedAt: now }, { headers: corsHeaders });
          })
          .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
      }

      if (path === "/v1/manager/heartbeat" && req.method === "POST") {
        const blocked = enforceRateLimit(req, "manager:heartbeat", {
          windowMs: 60_000,
          perIp: 300,
          perSubnet: 1200,
        });
        if (blocked) return blocked;
        const providedProxyPassword = req.headers.get("x-proxy-password") || "";

        return req
          .json()
          .then((body: Partial<ManagerProxyMetrics>) => {
            const normalized = normalizeGatewayUrl(body.url || null);
            if (!normalized) {
              return Response.json({ error: "invalid url" }, { status: 400, headers: corsHeaders });
            }
            const proxyRow = getProxyPasswordStmt.get(normalized) as { password: string } | null;
            const storedPassword = proxyRow?.password || "";
            if (!storedPassword || providedProxyPassword !== storedPassword) {
              console.warn(`[heartbeat] rejected from ${normalized} — ${!storedPassword ? "proxy not registered or has no password" : "wrong PROXY_PASSWORD"}`);
              return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
            }
            const gatewayId = normalizeGatewayId(
              typeof (body as any).gatewayId === "string" ? (body as any).gatewayId : null
            );
            upsertProxyStmt.run(
              normalized,
              gatewayId || "",
              null,
              null,
              Number(body.activeConnections || 0),
              Number(body.activeSessions || 0),
              Number(body.uniqueSessions24h || 0),
              Number(body.lastHeartbeat || Date.now()),
              Number((body as any).cpuPercent || 0),
              Number((body as any).memoryUsedMb || 0),
              Number((body as any).memoryTotalMb || 0),
              Number((body as any).networkInBps || 0),
              Number((body as any).networkOutBps || 0),
              Number((body as any).lastTelemetry || Date.now())
            );
            return Response.json({ ok: true }, { headers: corsHeaders });
          })
          .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
      }

      if (path === "/v1/vm/heartbeat" && req.method === "POST") {
        const blocked = enforceRateLimit(req, "manager:vm-heartbeat", {
          windowMs: 60_000,
          perIp: 300,
          perSubnet: 1200,
        });
        if (blocked) return blocked;

        return req
          .json()
          .then((body: Partial<VmHeartbeat>) => {
            const sandboxId = (typeof body.sandboxId === "string" ? body.sandboxId : "").trim();
            const resumeToken = (typeof body.resumeToken === "string" ? body.resumeToken : "").trim();
            const sandmanUrl = normalizeGatewayUrl(typeof body.sandmanUrl === "string" ? body.sandmanUrl : "") || "";
            const repoUrl = (typeof body.repoUrl === "string" ? body.repoUrl : "").trim();
            const branch = (typeof body.branch === "string" ? body.branch : "").trim();
            const vmProfile = (typeof body.vmProfile === "string" ? body.vmProfile : "").trim();

            if (!sandboxId || !/^[a-zA-Z0-9_-]{1,64}$/.test(sandboxId)) {
              return Response.json({ error: "invalid sandbox_id" }, { status: 400, headers: corsHeaders });
            }
            if (!resumeToken) {
              return Response.json({ error: "resumeToken is required" }, { status: 400, headers: corsHeaders });
            }

            // Validate resumeToken belongs to an active or grace session
            const session = getSessionByTokenStmt.get(resumeToken) as any;
            if (!session) {
              return Response.json({ error: "session not found" }, { status: 404, headers: corsHeaders });
            }
            const validStates = ["pending", "active", "app_offline_grace", "cli_offline_grace"];
            if (!validStates.includes(session.state)) {
              return Response.json({ error: "session not active" }, { status: 409, headers: corsHeaders });
            }

            upsertVmHeartbeatStmt.run(
              sandboxId,
              resumeToken,
              sandmanUrl,
              repoUrl,
              branch,
              vmProfile,
              Date.now()
            );
            return Response.json({ ok: true }, { headers: corsHeaders });
          })
          .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
      }

      if (path === "/v1/gateway/ws") {
        if (!isTrustedRequestOrigin(req)) {
          return Response.json({ error: "untrusted origin" }, { status: 403, headers: corsHeaders });
        }
        const sourceIp = extractClientIp(req);
        const blocked = enforceRateLimit(req, "manager:gateway-ws-upgrade", {
          windowMs: 60_000,
          perIp: 60,
          perSubnet: 300,
        });
        if (blocked) {
          writeAuditLog({
            actorType: "gateway",
            actorId: "unknown",
            action: "gateway.ws_upgrade",
            targetType: "manager_control_ws",
            targetId: "-",
            sourceIp,
            status: "denied",
            message: "rate limited",
          });
          return blocked;
        }

        const upgraded = server.upgrade(req, {
          data: { type: "manager-control", authed: false },
        });
        if (!upgraded) {
          return Response.json({ error: "upgrade failed" }, { status: 500, headers: corsHeaders });
        }
        return undefined;
      }

      if (path === "/v1/admin/login" && req.method === "POST") {
        const sourceIp = extractClientIp(req);
        const tempBlocked = enforceTemporaryBlock(req, "admin-login");
        if (tempBlocked) return tempBlocked;
        const blocked = enforceRateLimit(req, "manager:admin-login", {
          windowMs: 60_000,
          perIp: 20,
          perSubnet: 100,
        });
        if (blocked) {
          writeAuditLog({
            actorType: "admin",
            actorId: "unknown",
            action: "admin.login",
            targetType: "admin_api",
            targetId: "login",
            sourceIp,
            status: "denied",
            message: "rate limited",
          });
          return blocked;
        }

        return req
          .json()
          .then((body: { password?: string }) => {
            const provided = (body.password || "").trim();
            if (!managerAdminPassword || provided !== managerAdminPassword) {
              console.warn(`[admin] login failed — wrong password (ip=${sourceIp})`);
              recordFailureAndMaybeBlock("admin-login", req, {
                threshold: 8,
                windowMs: 10 * 60_000,
                blockMs: 30 * 60_000,
              });
              writeAuditLog({
                actorType: "admin",
                actorId: "unknown",
                action: "admin.login",
                targetType: "admin_api",
                targetId: "login",
                sourceIp,
                status: "denied",
                message: "invalid password",
              });
              return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
            }

            const now = Math.floor(Date.now() / 1000);
            const claims: ManagerAdminTokenClaims = {
              iss: MANAGER_ADMIN_TOKEN_ISSUER,
              aud: MANAGER_ADMIN_TOKEN_AUDIENCE,
              sub: "admin",
              role: "admin",
              iat: now,
              exp: now + MANAGER_ADMIN_TOKEN_TTL_S,
              jti: randomUUID(),
            };
            console.log(`[admin] login success (ip=${sourceIp})`);
            const token = signJwtToken(claims, managerAdminTokenSecret);
            writeAuditLog({
              actorType: "admin",
              actorId: "admin",
              action: "admin.login",
              targetType: "admin_api",
              targetId: "login",
              sourceIp,
              status: "ok",
              message: "admin token issued",
              metadata: { exp: claims.exp * 1000, jti: claims.jti },
            });
            return Response.json(
              { token, expiresAt: claims.exp * 1000, audience: claims.aud },
              { headers: corsHeaders }
            );
          })
          .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
      }

      if (path === "/oldschooladmin" && req.method === "GET") {
        return new Response(renderManagerPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (path.startsWith("/v1/admin/")) {
        const blocked = enforceRateLimit(req, "manager:admin-api", {
          windowMs: 60_000,
          perIp: 240,
          perSubnet: 1200,
        });
        if (blocked) return blocked;
        if (path === "/v1/admin/login") {
          // handled above
        } else if (!isAdminAuthorized(req, url)) {
          recordFailureAndMaybeBlock("admin-api", req, {
            threshold: 12,
            windowMs: 10 * 60_000,
            blockMs: 30 * 60_000,
          });
          writeAuditLog({
            actorType: "admin",
            actorId: "unknown",
            action: "admin.auth",
            targetType: "admin_api",
            targetId: path,
            sourceIp: extractClientIp(req),
            status: "denied",
            message: "unauthorized admin request",
          });
          return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
        }

        if (path === "/v1/admin/list" && req.method === "GET") {
          return Response.json({ proxies: loadAllProxies(), ring: getHealthyRing() }, { headers: corsHeaders });
        }

        if (path === "/v1/admin/security-metrics" && req.method === "GET") {
          return Response.json({ metrics: securityMetrics }, { headers: corsHeaders });
        }

        if (path === "/v1/admin/security-alerts" && req.method === "GET") {
          const limitRaw = Number(url.searchParams.get("limit") || 100);
          const limit = Math.max(1, Math.min(1000, Number.isFinite(limitRaw) ? limitRaw : 100));
          const alerts = listSecurityAlertsStmt.all(limit);
          return Response.json({ alerts }, { headers: corsHeaders });
        }

        if (path === "/v1/admin/vm-health" && req.method === "GET") {
          const heartbeats = db.query(`
            SELECT v.sandbox_id as sandboxId, v.resume_token as resumeToken, v.sandman_url as sandmanUrl,
                   v.repo_url as repoUrl, v.branch, v.vm_profile as vmProfile, v.last_heartbeat as lastHeartbeat,
                   s.state as sessionState, s.code as sessionCode,
                   CASE WHEN v.last_heartbeat >= ?1 THEN 'alive' ELSE 'stale' END as vmStatus
            FROM vm_heartbeats v
            LEFT JOIN sessions s ON s.resume_token = v.resume_token
            ORDER BY v.last_heartbeat DESC
            LIMIT 200
          `).all(Date.now() - VM_HEARTBEAT_STALE_MS);
          return Response.json({ heartbeats, staleThresholdMs: VM_HEARTBEAT_STALE_MS }, { headers: corsHeaders });
        }

        if (path === "/v1/admin/add" && req.method === "POST") {
          return req
            .json()
            .then(async (body: { url?: string; proxyPassword?: string }) => {
              const normalized = normalizeGatewayUrl(body.url || null);
              if (!normalized) {
                return Response.json({ error: "invalid url" }, { status: 400, headers: corsHeaders });
              }
              const proxyPassword = (body.proxyPassword || "").trim();
              if (!proxyPassword) {
                return Response.json({ error: "proxyPassword is required" }, { status: 400, headers: corsHeaders });
              }
              try {
                const healthRes = await fetch(`${normalized}/health`, {
                  signal: AbortSignal.timeout(5000),
                });
                if (!healthRes.ok) {
                  return Response.json({ error: "proxy health check failed — is the URL correct?" }, { status: 400, headers: corsHeaders });
                }
                const health = await healthRes.json() as { status?: string; mode?: string };
                if (health.status !== "ok" || health.mode !== "gateway") {
                  return Response.json({ error: "URL does not point to a lunel proxy" }, { status: 400, headers: corsHeaders });
                }
              } catch {
                return Response.json({ error: "could not reach proxy — check the URL and that the proxy is running" }, { status: 400, headers: corsHeaders });
              }
              try {
                const pingRes = await fetch(`${normalized}/v1/ping`, {
                  headers: { "X-Proxy-Password": proxyPassword },
                  signal: AbortSignal.timeout(5000),
                });
                if (pingRes.status === 401) {
                  return Response.json({ error: "wrong proxy password" }, { status: 400, headers: corsHeaders });
                }
                if (!pingRes.ok) {
                  return Response.json({ error: "proxy ping failed unexpectedly" }, { status: 400, headers: corsHeaders });
                }
              } catch {
                return Response.json({ error: "could not verify proxy password — proxy unreachable on /v1/ping" }, { status: 400, headers: corsHeaders });
              }
              addProxyStmt.run(normalized, proxyPassword);
              console.log(`[admin] proxy added: ${normalized}`);
              broadcastRingUpdate();
              writeAuditLog({
                actorType: "admin",
                actorId: "admin",
                action: "admin.proxy_add",
                targetType: "proxy",
                targetId: normalized,
                sourceIp: extractClientIp(req),
                status: "ok",
                message: "proxy added",
              });
              // Tell the proxy to connect back to us now that it's registered
              fetch(`${normalized}/v1/connect`, {
                method: "POST",
                headers: { "X-Proxy-Password": proxyPassword },
                signal: AbortSignal.timeout(5000),
              }).catch(() => {
                console.warn(`[admin] could not trigger connect on ${normalized} — proxy will need to be restarted`);
              });
              return Response.json({ ok: true }, { headers: corsHeaders });
            })
            .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
        }

        if (path === "/v1/admin/remove" && req.method === "POST") {
          return req
            .json()
            .then((body: { url?: string }) => {
              const normalized = normalizeGatewayUrl(body.url || null);
              if (!normalized) {
                return Response.json({ error: "invalid url" }, { status: 400, headers: corsHeaders });
              }
              removeProxyStmt.run(normalized);
              console.log(`[admin] proxy removed: ${normalized}`);
              broadcastRingUpdate();
              writeAuditLog({
                actorType: "admin",
                actorId: "admin",
                action: "admin.proxy_remove",
                targetType: "proxy",
                targetId: normalized,
                sourceIp: extractClientIp(req),
                status: "ok",
                message: "proxy removed",
              });
              return Response.json({ ok: true }, { headers: corsHeaders });
            })
            .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
        }

        if (path === "/v1/admin/proxy-state" && req.method === "POST") {
          return req
            .json()
            .then((body: { url?: string; state?: string }) => {
              const normalized = normalizeGatewayUrl(body.url || null);
              const state = (body.state || "").trim();
              if (!normalized) {
                return Response.json({ error: "invalid url" }, { status: 400, headers: corsHeaders });
              }
              if (!["active", "draining", "disabled"].includes(state)) {
                return Response.json({ error: "invalid state" }, { status: 400, headers: corsHeaders });
              }
              setProxyStateStmt.run(normalized, state, "manual");
              writeAuditLog({
                actorType: "admin",
                actorId: "admin",
                action: "admin.proxy_state",
                targetType: "proxy",
                targetId: normalized,
                sourceIp: extractClientIp(req),
                status: "ok",
                message: `proxy state set to ${state}`,
                metadata: { state },
              });
              return Response.json({ ok: true }, { headers: corsHeaders });
            })
            .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
        }

        if (path === "/v1/admin/session/revoke" && req.method === "POST") {
          return req
            .json()
            .then((body: { sessionId?: string; resumeToken?: string; reason?: string }) => {
              const sessionId = (body.sessionId || "").trim();
              const resumeToken = (body.resumeToken || "").trim();
              const reason = (body.reason || "revoked by admin").trim();
              if (!sessionId && !resumeToken) {
                return Response.json({ error: "sessionId or resumeToken is required" }, { status: 400, headers: corsHeaders });
              }
              let row: any = null;
              if (sessionId) {
                row = db
                  .query(`SELECT session_id, resume_token FROM sessions WHERE session_id = ?1 LIMIT 1`)
                  .get(sessionId) as any;
              } else {
                row = db
                  .query(`SELECT session_id, resume_token FROM sessions WHERE resume_token = ?1 LIMIT 1`)
                  .get(resumeToken) as any;
              }
              if (!row) {
                return Response.json({ error: "session not found" }, { status: 404, headers: corsHeaders });
              }
              const now = Date.now();
              const revoked = transitionSessionState(row.resume_token, "ended", null, now, 1);
              if (revoked.ok) {
                const routing = getSessionRoutingByTokenStmt.get(row.resume_token) as
                  | { primaryGateway?: string; backupGateway?: string | null }
                  | null;
                if (routing) {
                  sendManagerCommandForSession(routing, "close_session", {
                    resumeToken: row.resume_token,
                    reason,
                  });
                }
              }
              writeAuditLog({
                actorType: "admin",
                actorId: "admin",
                action: "admin.session_revoke",
                targetType: "session",
                targetId: row.session_id,
                sourceIp: extractClientIp(req),
                status: "ok",
                message: "session revoked",
                metadata: { reason },
              });
              return Response.json({ ok: true, sessionId: row.session_id }, { headers: corsHeaders });
            })
            .catch(() => Response.json({ error: "invalid body" }, { status: 400, headers: corsHeaders }));
        }

        if (path === "/v1/admin/audit" && req.method === "GET") {
          const limitRaw = Number(url.searchParams.get("limit") || 100);
          const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 100));
          const logs = listAuditLogsStmt.all(limit) as AuditLogRow[];
          return Response.json({ logs }, { headers: corsHeaders });
        }

        if (path === "/v1/admin/gateways" && req.method === "GET") {
          const limitRaw = Number(url.searchParams.get("limit") || 100);
          const limit = Math.max(1, Math.min(1000, Number.isFinite(limitRaw) ? limitRaw : 100));
          const gateways = listGatewayInstancesStmt.all(limit);
          return Response.json({ gateways }, { headers: corsHeaders });
        }

        if (path === "/v1/admin/audit/export" && req.method === "GET") {
          const limitRaw = Number(url.searchParams.get("limit") || 1000);
          const limit = Math.max(1, Math.min(10_000, Number.isFinite(limitRaw) ? limitRaw : 1000));
          const logs = listAuditLogsStmt.all(limit) as AuditLogRow[];
          const jsonl = logs.map((row) => JSON.stringify(row)).join("\n");
          return new Response(jsonl, {
            headers: {
              ...corsHeaders,
              "content-type": "application/x-ndjson; charset=utf-8",
              "content-disposition": `attachment; filename="manager-audit-${Date.now()}.ndjson"`,
            },
          });
        }

        if (path === "/v1/admin/details" && req.method === "GET") {
          const proxyUrl = normalizeGatewayUrl(url.searchParams.get("url"));
          if (!proxyUrl) {
            return Response.json({ error: "invalid url" }, { status: 400, headers: corsHeaders });
          }
          const proxy = detailsProxyStmt.get(proxyUrl) as ManagerProxyMetrics | null;
          if (!proxy) {
            return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
          }
          return Response.json({ proxy }, { headers: corsHeaders });
        }
      }

      return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
    },
    websocket: {
      open(ws) {
        const socketData = (ws.data || {}) as Partial<WebSocketData | ManagerControlSocketData>;
        if (socketData.type === "assemble") {
          const assembleData = socketData as AssembleWebSocketData;
          void assembleMutex.runExclusive(() => {
            const session = assembleSessionsByCode.get(assembleData.code);
            if (!session || session.expiresAt <= Date.now()) {
              ws.close(1008, "code expired");
              return;
            }
            if (assembleData.role === "app") {
              session.appWs = ws;
            } else {
              session.cliWs = ws;
            }
            maybeIssueAssemblePassword(session);
          });
          return;
        }

        ws.data = {
          type: "manager-control",
          authed: false,
        };
      },
      close(ws, _code, reason) {
        const socketData = (ws.data || {}) as Partial<WebSocketData | ManagerControlSocketData>;
        if (socketData.type === "assemble") {
          const assembleData = socketData as AssembleWebSocketData;
          void assembleMutex.runExclusive(() => {
            const session = assembleSessionsByCode.get(assembleData.code);
            if (!session) return;
            const completed = session.appAcked && session.cliAcked;
            if (assembleData.role === "app" && session.appWs === ws) {
              session.appWs = null;
            }
            if (assembleData.role === "cli" && session.cliWs === ws) {
              session.cliWs = null;
            }
            if (!completed) {
              try {
                session.appWs?.close(1000, "assemble cancelled");
              } catch {
                // ignore
              }
              try {
                session.cliWs?.close(1000, "assemble cancelled");
              } catch {
                // ignore
              }
            }
            assembleSessionsByCode.delete(assembleData.code);
          });
          return;
        }

        const controlSocketData = socketData as Partial<ManagerControlSocketData>;
        if (controlSocketData.gatewayUrl) {
          console.warn(`[gateway] proxy disconnected: ${controlSocketData.gatewayUrl}${typeof reason === "string" && reason ? ` — ${reason}` : ""}`);
          detachGatewayControlSocket(
            controlSocketData.gatewayUrl,
            ws
          );
        }
        if (controlSocketData.gatewayId) {
          markGatewayDisconnectedStmt.run(
            controlSocketData.gatewayId,
            Date.now(),
            typeof reason === "string" ? reason : "control websocket closed"
          );
        }
      },
      message(ws, message) {
        try {
          const socketData = (ws.data || {}) as Partial<WebSocketData | ManagerControlSocketData>;
          if (socketData.type === "assemble") {
            const assembleData = socketData as AssembleWebSocketData;
            const raw = websocketMessageToString(message);
            const parsed = JSON.parse(raw) as { type?: string };
            if (parsed.type !== "ack") {
              ws.close(1008, "ack required");
              return;
            }
            void assembleMutex.runExclusive(() => {
              const session = assembleSessionsByCode.get(assembleData.code);
              if (!session || !session.password) {
                ws.close(1008, "session not ready");
                return;
              }
              if (assembleData.role === "app") {
                session.appAcked = true;
              } else {
                session.cliAcked = true;
              }
              maybeCompleteAssembleSession(session);
            });
            return;
          }

          const controlSocketData = socketData as Partial<ManagerControlSocketData>;
          const raw = websocketMessageToString(message);
          const event = JSON.parse(raw) as GatewayControlEvent;
          if (!controlSocketData.authed) {
            if (event.type === "gateway_auth" && event.password) {
              const gateway = normalizeGatewayUrl(event.gateway || null);
              const gatewayId = normalizeGatewayId(event.gatewayId);
              const proxyRow = gateway ? getProxyPasswordStmt.get(gateway) as { password: string } | null : null;
              const storedPassword = proxyRow?.password || "";
              if (gateway && storedPassword && event.password === storedPassword) {
                ws.data = {
                  type: "manager-control",
                  authed: true,
                  gatewayId: gatewayId || gateway,
                  gatewayUrl: gateway,
                };
                attachGatewayControlSocket(
                  gateway,
                  ws
                );
                // Send current ring immediately so this proxy doesn't need to wait for next gateway_hello
                try {
                  ws.send(JSON.stringify({ type: "manager_command", command: "ring_update", ring: getHealthyRing(), ts: Date.now() }));
                } catch { /* ignore */ }
                upsertGatewayInstanceStmt.run(
                  gatewayId || gateway,
                  gateway,
                  "connected",
                  Date.now()
                );
                console.log(`[gateway] proxy connected via WS: ${gateway}${gatewayId ? ` (id=${gatewayId})` : ""}`);
                writeAuditLog({
                  actorType: "gateway",
                  actorId: gatewayId || gateway,
                  action: "gateway.ws_auth",
                  targetType: "manager_control_ws",
                  targetId: gateway,
                  status: "ok",
                  message: "gateway control websocket authenticated",
                  metadata: { gatewayId: gatewayId || null },
                });
                return;
              }
            }
            console.warn("[gateway] proxy WebSocket auth failed — wrong PROXY_PASSWORD or proxy not registered");
            writeAuditLog({
              actorType: "gateway",
              actorId: "unknown",
              action: "gateway.ws_auth",
              targetType: "manager_control_ws",
              targetId: "-",
              status: "denied",
              message: "gateway control websocket auth failed",
            });
            emitSecurityAlert({
              severity: "warn",
              category: "gateway_auth",
              alertKey: "gateway_ws_auth_failed",
              message: "Gateway control websocket auth failed",
            });
            ws.close(1008, "unauthorized");
            return;
          }
            if (event.type === "gateway_hello" || event.type === "proxy_metrics") {
            const gateway = normalizeGatewayUrl(event.gateway || null);
            if (!gateway) return;
            const gatewayId = normalizeGatewayId(event.gatewayId);
            if (gatewayId) {
              upsertGatewayInstanceStmt.run(gatewayId, gateway, "connected", Number(event.ts || Date.now()));
            }
            upsertProxyStmt.run(
              gateway,
              gatewayId || "",
              null,
              null,
              Number(event.activeConnections || 0),
              Number(event.activeSessions || 0),
              Number(event.uniqueSessions24h || 0),
              Number(event.ts || Date.now()),
              Number(event.cpuPercent || 0),
              Number(event.memoryUsedMb || 0),
              Number(event.memoryTotalMb || 0),
              Number(event.networkInBps || 0),
              Number(event.networkOutBps || 0),
              Number(event.lastTelemetry || event.ts || Date.now())
            );
            // Broadcast updated ring to all proxies after fleet membership changes
            if (event.type === "gateway_hello") broadcastRingUpdate();
            return;
          }
          if (event.type === "connection_event") {
            const resumeToken = event.resumeToken || "";
            if (!resumeToken) return;
            const action = event.connectionAction || "";
            const role = event.role;
            const channel = event.channel;
            const generation = Number(event.generation || 0);
            const now = Number(event.ts || Date.now());

            const routing = getSessionRoutingByTokenStmt.get(resumeToken) as
              | {
                  sessionId: string;
                  resumeToken: string;
                  primaryGateway: string;
                  backupGateway: string | null;
                  state: SessionState;
                }
              | null;
            if (!routing) {
              if (action === "socket_connected" && generation > 0 && role) {
                noteReattachAttached(resumeToken, role, generation);
              }
              if (action === "socket_disconnected" && role === "app") {
                void noteReattachDisconnect(resumeToken, "app");
              }
              if (action === "socket_disconnected" && role === "cli") {
                void noteReattachDisconnect(resumeToken, "cli");
              }
              return;
            }

            if (action === "session_end_requested") {
              const end = transitionSessionState(resumeToken, "ended", null, now, 1);
              if (end.ok) {
                sendManagerCommandForSession(routing, "close_session", {
                  resumeToken,
                  reason: event.reason || "session ended from app",
                });
              }
              return;
            }

            const runtime = (getSessionRuntimeStmt.get(resumeToken) as
              | {
                  resumeToken: string;
                  cliControl: number;
                  cliData: number;
                  appControl: number;
                  appData: number;
                  updatedAt: number;
                }
              | null) || {
              resumeToken,
              cliControl: 0,
              cliData: 0,
              appControl: 0,
              appData: 0,
              updatedAt: now,
            };

            if (action === "socket_connected" || action === "socket_disconnected") {
              const value = action === "socket_connected" ? 1 : 0;
              if (role === "cli" && channel === "session") {
                runtime.cliControl = value;
                runtime.cliData = value;
              }
              if (role === "cli" && channel === "control") runtime.cliControl = value;
              if (role === "cli" && channel === "data") runtime.cliData = value;
              if (role === "app" && channel === "session") {
                runtime.appControl = value;
                runtime.appData = value;
              }
              if (role === "app" && channel === "control") runtime.appControl = value;
              if (role === "app" && channel === "data") runtime.appData = value;
            }
            runtime.updatedAt = now;
            upsertSessionRuntimeStmt.run(
              resumeToken,
              runtime.cliControl,
              runtime.cliData,
              runtime.appControl,
              runtime.appData,
              runtime.updatedAt
            );

            const cliFully = runtime.cliControl === 1 && runtime.cliData === 1;
            const appFully = runtime.appControl === 1 && runtime.appData === 1;

            if (cliFully && appFully) {
              transitionSessionState(resumeToken, "active", null, now, 0);
              if (generation > 0 && role) {
                noteReattachAttached(resumeToken, role, generation);
              }
              sendManagerCommandForSession(routing, "clear_reconnect_grace", { resumeToken });
              return;
            }

            if (cliFully && !appFully) {
              const deadline = now + RECONNECT_GRACE_MS;
              transitionSessionState(resumeToken, "app_offline_grace", deadline, now, 0);
              void noteReattachDisconnect(resumeToken, "app");
              sendManagerCommandForSession(routing, "set_reconnect_grace", {
                resumeToken,
                reconnectDeadline: deadline,
              });
            }

            if (!cliFully && appFully) {
              const deadline = now + CLI_OFFLINE_GRACE_MS;
              transitionSessionState(resumeToken, "cli_offline_grace", deadline, now, 0);
              void noteReattachDisconnect(resumeToken, "cli");
              sendManagerCommandForSession(routing, "set_cli_reconnect_grace", {
                resumeToken,
                reconnectDeadline: deadline,
              });
            }
            return;
          }
          if (event.type === "session_event") {
            if (event.eventId) {
              const seenUntil = recentGatewayEventIds.get(event.eventId);
              const nowSeen = Date.now();
              if (seenUntil && seenUntil > nowSeen) {
                securityMetrics.duplicateGatewayEvents += 1;
                emitSecurityAlert({
                  severity: "warn",
                  category: "gateway_duplicate_event",
                  alertKey: `gateway_duplicate_event:${controlSocketData.gatewayId || "unknown"}`,
                  message: "Duplicate gateway session event dropped",
                  metadata: { gatewayId: controlSocketData.gatewayId || null },
                });
                return;
              }
              recentGatewayEventIds.set(event.eventId, nowSeen + GATEWAY_EVENT_DEDUPE_MS);
            }
            const resumeToken = event.resumeToken || "";
            if (!resumeToken) return;
            const now = Number(event.ts || Date.now());
            let transitionResult: { ok: boolean; reason: string } | null = null;
            if (event.event === "peer_connected") {
              transitionResult = transitionSessionState(resumeToken, "active", null, now, 0);
              if (!transitionResult.ok && transitionResult.reason !== "noop") {
                writeAuditLog({
                  actorType: "gateway",
                  actorId: controlSocketData.gatewayId || event.gateway || "unknown",
                  action: "session.transition",
                  targetType: "session_token",
                  targetId: "redacted",
                  status: "error",
                  message: "peer_connected transition rejected",
                  metadata: { reason: transitionResult.reason },
                });
              }
              return;
            }
            if (event.event === "app_disconnected") {
              transitionResult = transitionSessionState(
                resumeToken,
                "app_offline_grace",
                event.reconnectDeadline ?? null,
                now,
                0
              );
              if (!transitionResult.ok && transitionResult.reason !== "noop") {
                writeAuditLog({
                  actorType: "gateway",
                  actorId: controlSocketData.gatewayId || event.gateway || "unknown",
                  action: "session.transition",
                  targetType: "session_token",
                  targetId: "redacted",
                  status: "error",
                  message: "app_disconnected transition rejected",
                  metadata: { reason: transitionResult.reason },
                });
              }
              return;
            }
            if (event.event === "session_ended") {
              transitionResult = transitionSessionState(resumeToken, "ended", null, now, 1);
              if (!transitionResult.ok && transitionResult.reason !== "noop") {
                writeAuditLog({
                  actorType: "gateway",
                  actorId: controlSocketData.gatewayId || event.gateway || "unknown",
                  action: "session.transition",
                  targetType: "session_token",
                  targetId: "redacted",
                  status: "error",
                  message: "session_ended transition rejected",
                  metadata: { reason: transitionResult.reason },
                });
              }
              return;
            }
            if (event.event === "session_expired") {
              transitionResult = transitionSessionState(resumeToken, "expired", null, now, 1);
              if (!transitionResult.ok && transitionResult.reason !== "noop") {
                writeAuditLog({
                  actorType: "gateway",
                  actorId: controlSocketData.gatewayId || event.gateway || "unknown",
                  action: "session.transition",
                  targetType: "session_token",
                  targetId: "redacted",
                  status: "error",
                  message: "session_expired transition rejected",
                  metadata: { reason: transitionResult.reason },
                });
              }
            }
          }
        } catch {
          // ignore malformed manager control events
        }
      },
    },
  });

  const configuredCount = configured.length;
  console.log(`[manager] started — port=${process.env.PORT || 8899}`);
  if (configuredCount > 0) console.log(`[manager] ${configuredCount} proxy(ies) loaded from PROXIES env`);
  console.log(`[manager] admin UI at http://localhost:${process.env.PORT || 8899}`);
}

startManager();
