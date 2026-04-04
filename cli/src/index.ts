#!/usr/bin/env node

import { WebSocket } from "ws";
import qrcode from "qrcode-terminal";
import shell from "shelljs";
import { createAiManager } from "./ai/index.js";
import type { AiManager, AiBackend } from "./ai/index.js";
import type { Message, Response } from "./transport/protocol.js";
import { V2SessionTransport } from "./transport/v2.js";
import Ignore from "ignore";
const ignore = Ignore.default;
type IgnoreInstance = ReturnType<typeof ignore>;
import * as fs from "fs/promises";
import * as fssync from "fs";
import * as path from "path";
import * as os from "os";
import { randomBytes } from "crypto";
import { spawn, spawnSync, ChildProcess, execSync } from "child_process";
import { createServer, createConnection, Socket } from "net";
import { createInterface } from "readline";

const DEFAULT_PROXY_URL = normalizeGatewayUrl(process.env.LUNEL_PROXY_URL || "https://gateway.lunel.dev");
const MANAGER_URL = normalizeGatewayUrl(process.env.LUNEL_MANAGER_URL || "https://manager.lunel.dev");
const CLI_ARGS = process.argv.slice(2);
function hasAnyFlag(args: string[], ...flags: string[]): boolean {
  return flags.some((flag) => args.includes(flag));
}
const SHOW_HELP = hasAnyFlag(CLI_ARGS, "--help", "-h");
const DEBUG_MODE = hasAnyFlag(CLI_ARGS, "--debug", "-d");
if (DEBUG_MODE) {
  process.env.LUNEL_DEBUG = "1";
  process.env.LUNEL_DEBUG_AI = "1";
}
import { createRequire } from "module";
const __require = createRequire(import.meta.url);
const VERSION = (__require("../package.json") as { version: string }).version;
const VERBOSE_AI_LOGS = process.env.LUNEL_DEBUG_AI === "1";
const PTY_RELEASE_BASE_URL = "https://github.com/lunel-dev/lunel/releases/download/v0";
const PTY_RELEASES: Record<string, { fileName: string; url: string }> = {
  "linux:x64": {
    fileName: "lunel-pty-linux-x8664-0",
    url: `${PTY_RELEASE_BASE_URL}/lunel-pty-linux-x8664-0`,
  },
  "darwin:arm64": {
    fileName: "lunel-pty-macos-arm64-0",
    url: `${PTY_RELEASE_BASE_URL}/lunel-pty-macos-arm64-0`,
  },
  "win32:x64": {
    fileName: "lunel-pty-windows-x8664-1.exe",
    url: `${PTY_RELEASE_BASE_URL}/lunel-pty-windows-x8664-1.exe`,
  },
};

// Root directory - sandbox all file operations to this
const ROOT_DIR = (() => {
  try {
    return fssync.realpathSync(process.cwd());
  } catch {
    return process.cwd();
  }
})();
const CLI_CONFIG_PATH = (() => {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "lunel", "config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "lunel", "config.json");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "lunel", "config.json");
})();

// Terminal sessions (managed by Rust PTY binary)
const terminals = new Set<string>();

// PTY binary process
let ptyProcess: ChildProcess | null = null;
const ptyPendingSpawns = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();

function getDefaultTerminalShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

function runWindowsCommandSync(command: string, args: string[], timeout = 5000): string {
  const result = spawnSync(command, args, { encoding: "utf-8", timeout });
  if (result.error) {
    throw result.error;
  }
  return result.stdout || "";
}

function runWindowsPowerShellJson(command: string, timeout = 5000): unknown {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf-8",
    timeout,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `PowerShell exited with code ${result.status}`);
  }

  const output = (result.stdout || "").trim();
  if (!output) {
    return null;
  }
  return JSON.parse(output);
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value == null ? [] : [value];
}

// Process management
interface ManagedProcess {
  pid: number;
  proc: ChildProcess;
  command: string;
  args: string[];
  cwd: string;
  startTime: number;
  output: string[];
  channel: string;
}
const processes = new Map<number, ManagedProcess>();
const processOutputBuffers = new Map<string, string>();

// CPU usage tracking
let lastCpuInfo: { idle: number; total: number }[] | null = null;

// AI manager — runs OpenCode and Codex simultaneously, routes by backend
let aiManager: AiManager | null = null;
let aiManagerInitPromise: Promise<void> | null = null;
// Proxy tunnel management
let currentSessionCode: string | null = null;
let currentSessionPassword: string | null = null;
let currentPrimaryGateway: string = DEFAULT_PROXY_URL;
let activeGatewayUrl: string = DEFAULT_PROXY_URL;
let shuttingDown = false;
let activeV2Transport: V2SessionTransport | null = null;
const trackedEditorFiles = new Map<string, TrackedEditorFile>();
const trackedEditorDirectories = new Map<string, TrackedEditorDirectory>();
const pendingTrackedFileChecks = new Set<string>();

function logWithTimestamp(scope: string, message: string, fields?: Record<string, unknown>): void {
  if (!DEBUG_MODE) return;
  const timestamp = new Date().toISOString();
  const suffix = fields ? ` ${JSON.stringify(fields)}` : "";
  console.log(`[${timestamp}] [${scope}] ${message}${suffix}`);
}

function debugLog(message: string, ...args: unknown[]): void {
  if (!DEBUG_MODE) return;
  console.log(message, ...args);
}

function debugWarn(message: string, ...args: unknown[]): void {
  if (!DEBUG_MODE) return;
  console.warn(message, ...args);
}

function printHelp(): void {
  console.log(`Lunel CLI v${VERSION}

Usage:
  npx lunel-cli [options]

Options:
  -h, --help         Show help
  -n, --new          Create a new session code
  -d, --debug        Show verbose debug logs
      --extra-ports  Extra local ports to expose, comma-separated (e.g. 3000,8080)
`);
}
interface ActiveTunnel {
  tunnelId: string;
  port: number;
  tcpSocket: Socket;
  proxyWs: WebSocket;
  localEnded: boolean;
  remoteEnded: boolean;
  finSent: boolean;
  finalizeTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
}
const activeTunnels = new Map<string, ActiveTunnel>();
const PORT_SYNC_INTERVAL_MS = 30_000;

const CLI_LOCAL_TCP_CONNECT_TIMEOUT_MS = 2_500;
const PROXY_WS_CONNECT_TIMEOUT_MS = 12_000;
const TUNNEL_SETUP_BUDGET_MS = 18_000;
const PROXY_WS_CONNECT_RETRY_ATTEMPTS = 1;
const PROXY_WS_RETRY_JITTER_MIN_MS = 200;
const PROXY_WS_RETRY_JITTER_MAX_MS = 500;
const PROXY_TUNNEL_LINGER_MS = 1_200;
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
let portSyncTimer: ReturnType<typeof setInterval> | null = null;
let portScanInFlight = false;
let lastDiscoveredPorts: number[] = [];

type ProxyControlAction = "fin" | "rst";
interface ProxyControlFrame {
  v: 1;
  t: "proxy_ctrl";
  action: ProxyControlAction;
  reason?: string;
}

function redactSensitive(input: unknown): string {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text
    .replace(/([A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,})/g, "[redacted_jwt]")
    .replace(/(password|token|authorization|resumeToken|x-manager-password)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted_secret]");
}

function parseProxyControlFrame(raw: WebSocket.RawData): ProxyControlFrame | null {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf-8") : null;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<ProxyControlFrame>;
    if (parsed?.v !== 1 || parsed?.t !== "proxy_ctrl") return null;
    if (parsed.action !== "fin" && parsed.action !== "rst") return null;
    return {
      v: 1,
      t: "proxy_ctrl",
      action: parsed.action,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

function sendProxyControl(tunnel: ActiveTunnel, action: ProxyControlAction, reason?: string): void {
  if (tunnel.proxyWs.readyState !== WebSocket.OPEN) return;
  const frame: ProxyControlFrame = { v: 1, t: "proxy_ctrl", action, reason };
  tunnel.proxyWs.send(JSON.stringify(frame));
}

function maybeFinalizeTunnel(tunnelId: string): void {
  const tunnel = activeTunnels.get(tunnelId);
  if (!tunnel || tunnel.closing) return;
  if (!tunnel.localEnded || !tunnel.remoteEnded) return;
  if (tunnel.finalizeTimer) return;

  tunnel.finalizeTimer = setTimeout(() => {
    const current = activeTunnels.get(tunnelId);
    if (!current || current.closing) return;
    current.closing = true;
    activeTunnels.delete(tunnelId);
    if (!current.tcpSocket.destroyed) {
      current.tcpSocket.destroy();
    }
    if (current.proxyWs.readyState === WebSocket.OPEN || current.proxyWs.readyState === WebSocket.CONNECTING) {
      current.proxyWs.close();
    }
  }, PROXY_TUNNEL_LINGER_MS);
}

// Popular development server ports to scan on connect
const DEV_PORTS: number[] = [
  1234,  // Parcel
  1313,  // Hugo
  2000,  // Deno (alt)
  3000,  // Next.js / CRA / Remix / Express
  3001,  // Next.js (alt)
  3002,  // Dev server (alt)
  3003,  // Dev server (alt)
  3333,  // AdonisJS / Nitro
  4000,  // Gatsby / Redwood
  4200,  // Angular CLI
  4321,  // Astro
  4173,  // Vite preview
  4444,  // Selenium
  4567,  // Sinatra
  5000,  // Flask / Sails.js
  5001,  // Flask (alt)
  5173,  // Vite
  5174,  // Vite (alt)
  5175,  // Vite (alt)
  5500,  // Live Server (VS Code)
  5555,  // Prisma Studio
  6006,  // Storybook
  7000,  // Hapi
  7070,  // Dev server
  7777,  // Dev server
  8000,  // Django / Laravel / Gatsby
  8001,  // Django (alt)
  8008,  // Dev server
  8010,  // Dev server
  8080,  // Vue CLI / Webpack Dev Server / Spring Boot
  8081,  // Metro Bundler
  8082,  // Dev server (alt)
  8100,  // Ionic
  8200,  // Vault
  8443,  // HTTPS dev server
  8787,  // Wrangler (Cloudflare Workers)
  8888,  // Jupyter Notebook
  8899,  // Dev server
  9000,  // PHP / SonarQube
  9090,  // Prometheus / Cockpit
  9200,  // Elasticsearch
  9229,  // Node.js debugger
  9292,  // Rack (Ruby)
  10000, // Webmin
  19006, // Expo web
  24678, // Vite HMR WebSocket
];

function parseExtraPortsFromArgs(args: string[]): number[] {
  const values: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--extra-ports=")) {
      values.push(arg.slice("--extra-ports=".length));
      continue;
    }

    if (arg === "--extra-ports" && i + 1 < args.length) {
      values.push(args[i + 1]);
      i++;
    }
  }

  const parsed = new Set<number>();
  for (const value of values) {
    for (const piece of value.split(",")) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const num = Number(trimmed);
      if (!Number.isInteger(num) || num < 1 || num > 65535) continue;
      parsed.add(num);
    }
  }

  return Array.from(parsed).sort((a, b) => a - b);
}

const EXTRA_PORTS = parseExtraPortsFromArgs(CLI_ARGS);
const FORCE_NEW_CODE = hasAnyFlag(CLI_ARGS, "--new", "-n");
const trackedProxyPorts = new Set<number>(EXTRA_PORTS);
function samePortSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ============================================================================
// Types
// ============================================================================

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: number;
}

interface FileStat {
  path: string;
  type: "file" | "directory";
  size: number;
  mtime: number;
  mode: number;
  isBinary?: boolean;
  [key: string]: unknown;
}

interface TrackedEditorFile {
  requestPath: string;
  safePath: string;
  dirPath: string;
  baseName: string;
  openCount: number;
  lastMtimeMs: number;
  lastSize: number;
  suppressWatcherUntil: number;
}

interface TrackedEditorDirectory {
  watcher: fssync.FSWatcher;
  filePaths: Set<string>;
}

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

interface GitCommitFile {
  path: string;
  status: string;
}

interface CliConfig {
  version: 1;
  deviceId: string;
  sessions?: CliSavedSession[];
}

interface CliSavedSession {
  rootDir: string;
  sessionCode: string | null;
  sessionPassword: string;
  savedAt: number;
}

// ============================================================================
// Path Safety
// ============================================================================

function resolveSafePath(requestedPath: string): string | null {
  // path.resolve handles ".." components, but on case-insensitive or symlinked
  // filesystems a simple startsWith check can still be bypassed. We use
  // realpathSync to canonicalise the path (resolves symlinks, normalises case on
  // Windows) before comparing against ROOT_DIR, which is itself canonicalised at
  // startup. If the path does not exist yet we fall back to the lexical resolve so
  // that callers creating new files can still pass the check.
  const lexical = path.resolve(ROOT_DIR, requestedPath);
  let canonical: string;
  try {
    canonical = fssync.realpathSync(lexical);
  } catch {
    // Path doesn't exist yet — verify lexically. Still safe because path.resolve
    // already eliminated all ".." traversals in the resolved string.
    canonical = lexical;
  }
  // Ensure ROOT_DIR itself is canonical for a reliable prefix comparison.
  const canonicalRoot = (() => {
    try { return fssync.realpathSync(ROOT_DIR); } catch { return ROOT_DIR; }
  })();
  if (!canonical.startsWith(canonicalRoot + path.sep) && canonical !== canonicalRoot) {
    return null;
  }
  return canonical;
}

function assertSafePath(requestedPath: string): string {
  const safePath = resolveSafePath(requestedPath);
  if (!safePath) {
    const error = new Error("Access denied: path outside root directory");
    (error as NodeJS.ErrnoException).code = "EACCES";
    throw error;
  }
  return safePath;
}

function generatePersistentSecret(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

async function readCliConfig(): Promise<CliConfig> {
  try {
    const raw = await fs.readFile(CLI_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return {
      version: 1,
      deviceId: typeof parsed.deviceId === "string" && parsed.deviceId ? parsed.deviceId : generatePersistentSecret(32),
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions.filter((entry): entry is CliSavedSession => (
          !!entry
          && typeof entry.rootDir === "string"
          && typeof entry.sessionPassword === "string"
          && typeof entry.savedAt === "number"
        )).map((entry) => ({
          rootDir: entry.rootDir,
          sessionCode: typeof entry.sessionCode === "string" ? entry.sessionCode : null,
          sessionPassword: entry.sessionPassword,
          savedAt: entry.savedAt,
        }))
        : [],
    };
  } catch {
    return {
      version: 1,
      deviceId: generatePersistentSecret(32),
      sessions: [],
    };
  }
}

async function writeCliConfig(config: CliConfig): Promise<void> {
  await fs.mkdir(path.dirname(CLI_CONFIG_PATH), { recursive: true });
  await fs.writeFile(CLI_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  cliConfigPromise = Promise.resolve(config);
}

let cliConfigPromise: Promise<CliConfig> | null = null;

async function getCliConfig(): Promise<CliConfig> {
  if (!cliConfigPromise) {
    cliConfigPromise = readCliConfig();
  }
  return await cliConfigPromise;
}

function getSavedSessionForRoot(config: CliConfig, rootDir: string): CliSavedSession | null {
  const sessions = Array.isArray(config.sessions) ? config.sessions : [];
  return sessions.find((entry) => entry.rootDir === rootDir) || null;
}

async function saveSessionForRoot(sessionCode: string | null, sessionPassword: string): Promise<void> {
  const config = await getCliConfig();
  const sessions = Array.isArray(config.sessions) ? [...config.sessions] : [];
  const nextEntry: CliSavedSession = {
    rootDir: ROOT_DIR,
    sessionCode,
    sessionPassword,
    savedAt: Date.now(),
  };
  const deduped = sessions.filter((entry) => entry.rootDir !== ROOT_DIR);
  deduped.unshift(nextEntry);
  await writeCliConfig({
    ...config,
    sessions: deduped.slice(0, 100),
  });
}

async function clearSavedSessionForRoot(): Promise<void> {
  const config = await getCliConfig();
  const sessions = Array.isArray(config.sessions) ? config.sessions : [];
  await writeCliConfig({
    ...config,
    sessions: sessions.filter((entry) => entry.rootDir !== ROOT_DIR),
  });
}

// ============================================================================
// File System Handlers
// ============================================================================

function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  if (buffer.includes(0x00)) return true;

  let suspicious = 0;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
    const isCommonControl = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (!isPrintableAscii && !isCommonControl) suspicious++;
  }

  return suspicious / buffer.length > 0.3;
}

async function handleFsLs(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = (payload.path as string) || ".";
  const safePath = assertSafePath(reqPath);

  const entries = await fs.readdir(safePath, { withFileTypes: true });
  const result: FileEntry[] = [];

  for (const entry of entries) {
    const item: FileEntry = {
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    };

    // Try to get size and mtime for files
    if (entry.isFile()) {
      try {
        const stat = await fs.stat(path.join(safePath, entry.name));
        item.size = stat.size;
        item.mtime = stat.mtimeMs;
      } catch {
        // Ignore stat errors
      }
    }

    result.push(item);
  }

  return { path: reqPath, entries: result };
}

async function handleFsStat(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });

  const safePath = assertSafePath(reqPath);
  const stat = await fs.stat(safePath);

  const result: FileStat = {
    path: reqPath,
    type: stat.isDirectory() ? "directory" : "file",
    size: stat.size,
    mtime: stat.mtimeMs,
    mode: stat.mode,
  };

  if (stat.isFile()) {
    try {
      const fd = await fs.open(safePath, "r");
      try {
        const sampleSize = Math.min(stat.size, 8192);
        const sample = Buffer.alloc(sampleSize);
        if (sampleSize > 0) {
          await fd.read(sample, 0, sampleSize, 0);
        }
        result.isBinary = isLikelyBinaryBuffer(sample);
      } finally {
        await fd.close();
      }
    } catch {
      // Keep stat resilient even if sampling fails
    }
  }

  return result;
}

async function handleFsRead(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });
  const startedAt = Date.now();
  logWithTimestamp("fs-read", "starting", { path: reqPath });

  const safePath = assertSafePath(reqPath);

  // Check if binary
  const stat = await fs.stat(safePath);
  const content = await fs.readFile(safePath);

  // Detect if binary
  const isBinary = isLikelyBinaryBuffer(content.subarray(0, 8192));
  logWithTimestamp("fs-read", "disk read complete", {
    path: reqPath,
    size: stat.size,
    bufferBytes: content.length,
    isBinary,
    durationMs: Date.now() - startedAt,
  });

  if (isBinary) {
    return {
      path: reqPath,
      content: content.toString("base64"),
      encoding: "base64",
      size: stat.size,
    };
  }

  return {
    path: reqPath,
    content: content.toString("utf-8"),
    encoding: "utf8",
    size: stat.size,
  };
}

async function handleFsWrite(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  const content = payload.content as string;
  const encoding = (payload.encoding as string) || "utf8";
  const source = typeof payload.source === "string" ? payload.source : null;

  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });
  if (typeof content !== "string") throw Object.assign(new Error("content is required"), { code: "EINVAL" });

  const safePath = assertSafePath(reqPath);
  const parentDir = path.dirname(safePath);
  await fs.mkdir(parentDir, { recursive: true });

  if (encoding === "base64") {
    await fs.writeFile(safePath, Buffer.from(content, "base64"));
  } else {
    await fs.writeFile(safePath, content, "utf-8");
  }

  await noteTrackedFileWrite(reqPath, source);

  return { path: reqPath };
}

async function handleFsMkdir(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  const recursive = payload.recursive !== false;

  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });

  const safePath = assertSafePath(reqPath);
  await fs.mkdir(safePath, { recursive });

  return { path: reqPath };
}

async function handleFsRm(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  const recursive = payload.recursive === true;

  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });

  const safePath = assertSafePath(reqPath);
  await fs.rm(safePath, { recursive, force: false });
  deleteTrackedEditorFile(reqPath);

  return { path: reqPath };
}

async function handleFsMv(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const from = payload.from as string;
  const to = payload.to as string;

  if (!from) throw Object.assign(new Error("from is required"), { code: "EINVAL" });
  if (!to) throw Object.assign(new Error("to is required"), { code: "EINVAL" });

  const safeFrom = assertSafePath(from);
  const safeTo = assertSafePath(to);

  await fs.rename(safeFrom, safeTo);
  await renameTrackedEditorFile(from, to);

  return { from, to };
}

// Load gitignore patterns
async function loadGitignore(dirPath: string): Promise<IgnoreInstance> {
  const ig = ignore();
  ig.add(".git");

  try {
    const gitignorePath = path.join(dirPath, ".gitignore");
    const content = await fs.readFile(gitignorePath, "utf-8");
    ig.add(content);
  } catch {
    // No .gitignore
  }

  return ig;
}

async function handleFsGrep(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = (payload.path as string) || ".";
  const pattern = payload.pattern as string;
  const caseSensitive = payload.caseSensitive !== false;
  const maxResults = (payload.maxResults as number) || 100;

  if (!pattern) throw Object.assign(new Error("pattern is required"), { code: "EINVAL" });

  const safePath = assertSafePath(reqPath);
  const matches: GrepMatch[] = [];
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
  } catch {
    throw Object.assign(new Error("pattern must be a valid regular expression"), { code: "EINVAL" });
  }
  const rootIgnore = await loadGitignore(ROOT_DIR);
  const previousSilent = shell.config.silent;
  shell.config.silent = true;

  try {
    async function searchFile(filePath: string, relativePath: string): Promise<void> {
      if (matches.length >= maxResults) return;

      try {
        const grepResult = shell.grep(regex, filePath);
        if (grepResult.code !== 0 || !grepResult.stdout.trim()) {
          regex.lastIndex = 0;
          return;
        }

        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
          if (regex.test(lines[i])) {
            matches.push({
              file: relativePath,
              line: i + 1,
              content: lines[i].substring(0, 500),
            });
          }
          regex.lastIndex = 0;
        }
      } catch {
        regex.lastIndex = 0;
      }
    }

    async function searchDir(dirPath: string, relativePath: string, ig: IgnoreInstance): Promise<void> {
      if (matches.length >= maxResults) return;

      const localIgnore = ignore().add(ig);
      try {
        const localGitignorePath = path.join(dirPath, ".gitignore");
        const content = await fs.readFile(localGitignorePath, "utf-8");
        localIgnore.add(content);
      } catch {
        // No local .gitignore
      }

      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (matches.length >= maxResults) break;

        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const checkPath = entry.isDirectory() ? `${relPath}/` : relPath;
        if (localIgnore.ignores(checkPath)) continue;

        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          await searchDir(fullPath, relPath, localIgnore);
        } else if (entry.isFile()) {
          await searchFile(fullPath, relPath);
        }
      }
    }

    const stat = await fs.stat(safePath);
    if (stat.isDirectory()) {
      await searchDir(safePath, reqPath === "." ? "" : reqPath, rootIgnore);
    } else {
      await searchFile(safePath, reqPath);
    }
  } finally {
    shell.config.silent = previousSilent;
  }

  return { matches };
}

async function handleFsCreate(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  const type = payload.type as string;

  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });
  if (!type || (type !== "file" && type !== "directory")) {
    throw Object.assign(new Error("type must be 'file' or 'directory'"), { code: "EINVAL" });
  }

  const safePath = assertSafePath(reqPath);

  if (type === "directory") {
    await fs.mkdir(safePath, { recursive: true });
  } else {
    // Create parent directories if needed
    const parentDir = path.dirname(safePath);
    await fs.mkdir(parentDir, { recursive: true });
    // Create empty file
    await fs.writeFile(safePath, "");
  }

  return { path: reqPath };
}

// ============================================================================
// Git Handlers
// ============================================================================

async function runGit(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd: ROOT_DIR });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    proc.on("close", (code) => {
      resolve({ stdout, stderr, code: code || 0 });
    });

    proc.on("error", (err) => {
      resolve({ stdout: "", stderr: err.message, code: 1 });
    });
  });
}

async function handleGitStatus(): Promise<Record<string, unknown>> {
  // Get branch
  const branchResult = await runGit(["branch", "--show-current"]);
  const branch = branchResult.stdout.trim();

  // Get status
  const statusResult = await runGit(["status", "--porcelain", "-uall"]);
  // Preserve leading whitespace in each porcelain line.
  // Example: " M file" (unstaged-only) starts with a space that is semantically important.
  const lines = statusResult.stdout.split(/\r?\n/).filter((line) => line.length > 0);

  const staged: Array<{ path: string; status: string }> = [];
  const unstaged: Array<{ path: string; status: string }> = [];
  const untracked: string[] = [];

  for (const line of lines) {
    const index = line[0];
    const worktree = line[1];
    // Git porcelain format: XY path (where X=index status, Y=worktree status)
    // For renamed files: XY old -> new
    let filepath = line.substring(3).trim();

    // Handle quoted paths (git quotes paths with special chars)
    if (filepath.startsWith('"') && filepath.endsWith('"')) {
      filepath = filepath.slice(1, -1);
    }

    // For renamed files, extract just the new name
    if (filepath.includes(' -> ')) {
      filepath = filepath.split(' -> ')[1];
    }

    if (index === "?" && worktree === "?") {
      untracked.push(filepath);
    } else {
      if (index !== " " && index !== "?") {
        staged.push({ path: filepath, status: index });
      }
      if (worktree !== " " && worktree !== "?") {
        unstaged.push({ path: filepath, status: worktree });
      }
    }
  }

  // Get ahead/behind
  const aheadBehind = await runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  let ahead = 0;
  let behind = 0;
  if (aheadBehind.code === 0) {
    const parts = aheadBehind.stdout.trim().split(/\s+/);
    behind = parseInt(parts[0]) || 0;
    ahead = parseInt(parts[1]) || 0;
  }

  return { branch, ahead, behind, staged, unstaged, untracked };
}

async function handleGitStage(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const paths = payload.paths as string[];
  if (!paths || !paths.length) throw Object.assign(new Error("paths is required"), { code: "EINVAL" });

  const result = await runGit(["add", "--", ...paths]);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git add failed"), { code: "EGIT" });
  }

  return {};
}

async function handleGitUnstage(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const paths = payload.paths as string[];
  if (!paths || !paths.length) throw Object.assign(new Error("paths is required"), { code: "EINVAL" });

  // Use git restore --staged (Git 2.23+) which is more reliable
  // Falls back to git reset HEAD for older versions
  let result = await runGit(["restore", "--staged", "--", ...paths]);
  if (result.code !== 0) {
    // Fallback to reset for older git versions
    result = await runGit(["reset", "HEAD", "--", ...paths]);
    if (result.code !== 0) {
      throw Object.assign(new Error(result.stderr || "git unstage failed"), { code: "EGIT" });
    }
  }

  return {};
}

async function handleGitCommit(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const message = payload.message as string;
  if (!message) throw Object.assign(new Error("message is required"), { code: "EINVAL" });

  const result = await runGit(["commit", "-m", message]);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git commit failed"), { code: "EGIT" });
  }

  // Get the commit hash
  const hashResult = await runGit(["rev-parse", "HEAD"]);
  const hash = hashResult.stdout.trim().substring(0, 7);

  return { hash, message };
}

async function handleGitLog(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const limit = (payload.limit as number) || 20;

  const result = await runGit([
    "log",
    `-${limit}`,
    "--pretty=format:%H|%s|%an|%at",
  ]);

  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git log failed"), { code: "EGIT" });
  }

  const commits = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, message, author, timestamp] = line.split("|");
      return {
        hash: hash.substring(0, 7),
        message,
        author,
        date: parseInt(timestamp) * 1000,
      };
    });

  return { commits };
}

async function handleGitCommitDetails(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const hash = (payload.hash as string)?.trim();
  if (!hash) throw Object.assign(new Error("hash is required"), { code: "EINVAL" });

  try {
    const commitResult = await runGit(["show", "-s", "--format=%H%n%s%n%an%n%at", hash]);
    if (commitResult.code !== 0 || !commitResult.stdout.trim()) {
      throw Object.assign(new Error("Commit not found"), { code: "EGIT" });
    }

    const commitLines = commitResult.stdout.split(/\r?\n/);
    const fullHash = commitLines[0]?.trim() || "";
    const message = commitLines[1] ?? "";
    const author = commitLines[2] ?? "";
    const timestamp = Number.parseInt(commitLines[3] ?? "0", 10);
    if (!fullHash) {
      throw Object.assign(new Error("Commit not found"), { code: "EGIT" });
    }

    const filesResult = await runGit(["show", "--name-status", "--format=", hash]);
    if (filesResult.code !== 0) {
      throw Object.assign(new Error(filesResult.stderr || "git show failed"), { code: "EGIT" });
    }

    const filesRaw = filesResult.stdout;
    const files: GitCommitFile[] = filesRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        const status = parts[0] || "?";
        // Handles regular + rename/copy name-status output.
        const path = parts[2] || parts[1] || "";
        return { status, path };
      })
      .filter((entry) => !!entry.path);

    const diffResult = await runGit(["show", "--patch", "--format=", hash]);
    if (diffResult.code !== 0) {
      throw Object.assign(new Error(diffResult.stderr || "git show failed"), { code: "EGIT" });
    }
    const diff = diffResult.stdout;
    const fileDiffs: Record<string, string> = {};
    const fileChunks = diff.split(/^diff --git /m).filter(Boolean);
    for (const chunk of fileChunks) {
      const patch = `diff --git ${chunk}`;
      const firstLine = chunk.split(/\r?\n/, 1)[0] || "";
      const match = firstLine.match(/^a\/(.+?) b\/(.+)$/);
      if (match?.[2]) {
        fileDiffs[match[2]] = patch;
      }
    }

    return {
      commit: {
        hash: fullHash.substring(0, 7),
        fullHash,
        message,
        author,
        date: timestamp * 1000,
      },
      files,
      diff,
      fileDiffs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "git show failed";
    throw Object.assign(new Error(message), { code: "EGIT" });
  }
}

async function handleGitDiff(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const filepath = payload.path as string;
  const staged = payload.staged === true;

  const args = ["diff"];
  if (staged) args.push("--staged");
  if (filepath) args.push(filepath);

  const result = await runGit(args);

  return { diff: result.stdout };
}

async function handleGitBranches(): Promise<Record<string, unknown>> {
  const result = await runGit(["branch", "-a"]);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git branch failed"), { code: "EGIT" });
  }

  const lines = result.stdout.trim().split("\n");
  let current = "";
  const branches: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("* ")) {
      current = trimmed.substring(2);
      branches.push(current);
    } else if (!trimmed.startsWith("remotes/")) {
      branches.push(trimmed);
    }
  }

  return { current, branches };
}

async function handleGitCheckout(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const branch = payload.branch as string;
  const create = payload.create === true;
  if (!branch) throw Object.assign(new Error("branch is required"), { code: "EINVAL" });

  const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
  const result = await runGit(args);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git checkout failed"), { code: "EGIT" });
  }

  return { branch };
}

async function handleGitPull(): Promise<Record<string, unknown>> {
  const result = await runGit(["pull"]);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git pull failed"), { code: "EGIT" });
  }

  return { success: true, summary: result.stdout.trim() || result.stderr.trim() };
}

async function handleGitPush(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const setUpstream = payload.setUpstream === true;

  const args = ["push"];
  if (setUpstream) {
    // Get current branch name
    const branchResult = await runGit(["branch", "--show-current"]);
    const branch = branchResult.stdout.trim();
    args.push("-u", "origin", branch);
  }

  const result = await runGit(args);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git push failed"), { code: "EGIT" });
  }

  return { success: true };
}

async function handleGitDiscard(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const paths = payload.paths as string[] | undefined;
  const all = payload.all === true;

  if (!paths && !all) {
    throw Object.assign(new Error("paths or all is required"), { code: "EINVAL" });
  }

  if (all) {
    // Discard all changes
    const result = await runGit(["checkout", "--", "."]);
    if (result.code !== 0) {
      throw Object.assign(new Error(result.stderr || "git checkout failed"), { code: "EGIT" });
    }
    // Also clean untracked files
    await runGit(["clean", "-fd"]);
  } else if (paths && paths.length > 0) {
    const result = await runGit(["checkout", "--", ...paths]);
    if (result.code !== 0) {
      throw Object.assign(new Error(result.stderr || "git checkout failed"), { code: "EGIT" });
    }
  }

  return {};
}

function emitAppEvent(msg: Message): void {
  if (activeV2Transport) {
    if (!activeV2Transport.isSecure()) {
      if (DEBUG_MODE) {
        console.error("[transport:v2] dropped event before secure session:", `${msg.ns}.${msg.action}`);
      }
      return;
    }
    void activeV2Transport.sendEvent(msg).catch((error) => {
      if (DEBUG_MODE) console.error("[transport:v2] failed to send event:", error instanceof Error ? error.message : String(error));
    });
  }
}

function emitEditorFileChanged(requestPath: string, mtimeMs: number, size: number): void {
  logWithTimestamp("editor-watch", "emitting fileChanged", { path: requestPath, mtime: mtimeMs, size });
  emitAppEvent({
    v: 1,
    id: `editor-change-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ns: "editor",
    action: "fileChanged",
    payload: { path: requestPath, mtime: mtimeMs, size },
  });
}

function emitEditorFileDeleted(requestPath: string): void {
  logWithTimestamp("editor-watch", "emitting fileDeleted", { path: requestPath });
  emitAppEvent({
    v: 1,
    id: `editor-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ns: "editor",
    action: "fileDeleted",
    payload: { path: requestPath },
  });
}

function releaseTrackedEditorDirectory(dirPath: string): void {
  const trackedDir = trackedEditorDirectories.get(dirPath);
  if (!trackedDir || trackedDir.filePaths.size > 0) {
    return;
  }

  trackedDir.watcher.close();
  trackedEditorDirectories.delete(dirPath);
}

function queueTrackedEditorFileCheck(safePath: string): void {
  if (pendingTrackedFileChecks.has(safePath)) {
    return;
  }

  pendingTrackedFileChecks.add(safePath);
  void (async () => {
    try {
      const tracked = trackedEditorFiles.get(safePath);
      if (!tracked) {
        return;
      }
      logWithTimestamp("editor-watch", "checking tracked file", { path: tracked.requestPath });

      let stat: fssync.Stats;
      try {
        stat = await fs.stat(tracked.safePath);
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError?.code === "ENOENT") {
          trackedEditorFiles.delete(tracked.safePath);
          const trackedDir = trackedEditorDirectories.get(tracked.dirPath);
          if (trackedDir) {
            trackedDir.filePaths.delete(tracked.safePath);
            releaseTrackedEditorDirectory(tracked.dirPath);
          }
          emitEditorFileDeleted(tracked.requestPath);
          return;
        }
        throw error;
      }

      if (!stat.isFile()) {
        trackedEditorFiles.delete(tracked.safePath);
        const trackedDir = trackedEditorDirectories.get(tracked.dirPath);
        if (trackedDir) {
          trackedDir.filePaths.delete(tracked.safePath);
          releaseTrackedEditorDirectory(tracked.dirPath);
        }
        emitEditorFileDeleted(tracked.requestPath);
        return;
      }

      const changed = tracked.lastMtimeMs !== stat.mtimeMs || tracked.lastSize !== stat.size;
      logWithTimestamp("editor-watch", "stat compared", {
        path: tracked.requestPath,
        changed,
        prevMtime: tracked.lastMtimeMs,
        nextMtime: stat.mtimeMs,
        prevSize: tracked.lastSize,
        nextSize: stat.size,
        suppressWatcherUntil: tracked.suppressWatcherUntil,
      });
      tracked.lastMtimeMs = stat.mtimeMs;
      tracked.lastSize = stat.size;

      if (!changed) {
        return;
      }

      if (Date.now() <= tracked.suppressWatcherUntil) {
        return;
      }

      emitEditorFileChanged(tracked.requestPath, stat.mtimeMs, stat.size);
    } catch (error) {
      if (DEBUG_MODE) {
        console.error("[editor-watch] file check failed:", error instanceof Error ? error.message : String(error));
      }
    } finally {
      pendingTrackedFileChecks.delete(safePath);
    }
  })();
}

function ensureTrackedEditorDirectory(dirPath: string): TrackedEditorDirectory {
  const existing = trackedEditorDirectories.get(dirPath);
  if (existing) {
    return existing;
  }

  const watcher = fssync.watch(dirPath, (_eventType, fileName) => {
    const trackedDir = trackedEditorDirectories.get(dirPath);
    if (!trackedDir) {
      return;
    }

    const changedName = fileName == null ? null : String(fileName);
    logWithTimestamp("editor-watch", "directory event", { dirPath, fileName: changedName });
    if (!changedName) {
      for (const safePath of trackedDir.filePaths) {
        queueTrackedEditorFileCheck(safePath);
      }
      return;
    }

    for (const safePath of trackedDir.filePaths) {
      const tracked = trackedEditorFiles.get(safePath);
      if (tracked && tracked.baseName === changedName) {
        queueTrackedEditorFileCheck(safePath);
      }
    }
  });
  watcher.on("error", (error) => {
    if (DEBUG_MODE) {
      console.error("[editor-watch] directory watcher error:", dirPath, error instanceof Error ? error.message : String(error));
    }
  });

  const trackedDir: TrackedEditorDirectory = {
    watcher,
    filePaths: new Set<string>(),
  };
  trackedEditorDirectories.set(dirPath, trackedDir);
  return trackedDir;
}

async function trackEditorFile(requestPath: string): Promise<Record<string, unknown>> {
  const safePath = assertSafePath(requestPath);
  const stat = await fs.stat(safePath);
  if (!stat.isFile()) {
    throw Object.assign(new Error("Only files can be tracked by the editor"), { code: "EINVAL" });
  }

  const existing = trackedEditorFiles.get(safePath);
  if (existing) {
    existing.openCount += 1;
    existing.requestPath = requestPath;
    existing.lastMtimeMs = stat.mtimeMs;
    existing.lastSize = stat.size;
    logWithTimestamp("editor-watch", "increment tracked file", { path: requestPath, openCount: existing.openCount });
    return { path: requestPath, tracked: true };
  }

  const dirPath = path.dirname(safePath);
  const trackedDir = ensureTrackedEditorDirectory(dirPath);
  trackedDir.filePaths.add(safePath);
  trackedEditorFiles.set(safePath, {
    requestPath,
    safePath,
    dirPath,
    baseName: path.basename(safePath),
    openCount: 1,
    lastMtimeMs: stat.mtimeMs,
    lastSize: stat.size,
    suppressWatcherUntil: 0,
  });
  logWithTimestamp("editor-watch", "tracking file", { path: requestPath, dirPath, mtime: stat.mtimeMs, size: stat.size });

  return { path: requestPath, tracked: true };
}

function untrackEditorFile(requestPath: string): Record<string, unknown> {
  const safePath = assertSafePath(requestPath);
  const tracked = trackedEditorFiles.get(safePath);
  if (!tracked) {
    return { path: requestPath, tracked: false };
  }

  tracked.openCount -= 1;
  logWithTimestamp("editor-watch", "decrement tracked file", { path: requestPath, openCount: tracked.openCount });
  if (tracked.openCount > 0) {
    return { path: requestPath, tracked: true };
  }

  trackedEditorFiles.delete(safePath);
  const trackedDir = trackedEditorDirectories.get(tracked.dirPath);
  if (trackedDir) {
    trackedDir.filePaths.delete(safePath);
    releaseTrackedEditorDirectory(tracked.dirPath);
  }

  return { path: requestPath, tracked: false };
}

async function renameTrackedEditorFile(fromPath: string, toPath: string): Promise<Record<string, unknown>> {
  const safeFrom = assertSafePath(fromPath);
  const safeTo = assertSafePath(toPath);
  const tracked = trackedEditorFiles.get(safeFrom);
  if (!tracked) {
    return { from: fromPath, to: toPath, tracked: false };
  }
  logWithTimestamp("editor-watch", "renaming tracked file", { from: fromPath, to: toPath });

  const fromDir = trackedEditorDirectories.get(tracked.dirPath);
  if (fromDir) {
    fromDir.filePaths.delete(tracked.safePath);
    releaseTrackedEditorDirectory(tracked.dirPath);
  }
  trackedEditorFiles.delete(tracked.safePath);

  const stat = await fs.stat(safeTo);
  const nextDirPath = path.dirname(safeTo);
  const nextDir = ensureTrackedEditorDirectory(nextDirPath);
  nextDir.filePaths.add(safeTo);

  tracked.requestPath = toPath;
  tracked.safePath = safeTo;
  tracked.dirPath = nextDirPath;
  tracked.baseName = path.basename(safeTo);
  tracked.lastMtimeMs = stat.mtimeMs;
  tracked.lastSize = stat.size;
  trackedEditorFiles.set(safeTo, tracked);

  return { from: fromPath, to: toPath, tracked: true };
}

function deleteTrackedEditorFile(requestPath: string): Record<string, unknown> {
  const safePath = assertSafePath(requestPath);
  const tracked = trackedEditorFiles.get(safePath);
  if (!tracked) {
    return { path: requestPath, tracked: false };
  }
  logWithTimestamp("editor-watch", "deleting tracked file", { path: requestPath });

  trackedEditorFiles.delete(safePath);
  const trackedDir = trackedEditorDirectories.get(tracked.dirPath);
  if (trackedDir) {
    trackedDir.filePaths.delete(safePath);
    releaseTrackedEditorDirectory(tracked.dirPath);
  }

  return { path: requestPath, tracked: false };
}

async function noteTrackedFileWrite(requestPath: string, source: string | null): Promise<void> {
  const safePath = assertSafePath(requestPath);
  const tracked = trackedEditorFiles.get(safePath);
  if (!tracked) {
    return;
  }

  const stat = await fs.stat(safePath);
  tracked.lastMtimeMs = stat.mtimeMs;
  tracked.lastSize = stat.size;
  tracked.suppressWatcherUntil = Date.now() + 1500;
  logWithTimestamp("editor-watch", "tracked file write noted", {
    path: tracked.requestPath,
    source,
    mtime: stat.mtimeMs,
    size: stat.size,
    suppressWatcherUntil: tracked.suppressWatcherUntil,
  });

  if (source !== "editor") {
    emitEditorFileChanged(tracked.requestPath, stat.mtimeMs, stat.size);
  }
}

let ensurePtyBinaryPromise: Promise<string | null> | null = null;

function normalizeJsonWithTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function getLunelConfigDir(): string {
  const platform = os.platform();
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "lunel");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "lunel");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "lunel");
}

function getPtyReleaseTarget(): { fileName: string; url: string } | null {
  const release = PTY_RELEASES[`${os.platform()}:${os.arch()}`];
  if (!release) return null;
  return release;
}

function getPtyBinaryPath(fileName: string): string {
  return path.join(getLunelConfigDir(), "pty-releases", fileName);
}

async function downloadPtyBinary(url: string, destination: string): Promise<void> {
  const tempPath = `${destination}.download`;
  console.log("[pty] Downloading PTY [downloading...]");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download PTY binary (${response.status})`);
  }
  if (!response.body) {
    throw new Error("PTY download response had no body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  }

  const binary = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  await fs.writeFile(tempPath, binary);
  if (os.platform() !== "win32") {
    await fs.chmod(tempPath, 0o755);
  }
  await fs.rename(tempPath, destination);
  console.log(`[pty] Downloaded PTY (${Math.max(1, Math.round(totalBytes / 1024))} KB)`);
}

async function ensurePtyBinaryReady(): Promise<string | null> {
  if (ensurePtyBinaryPromise) return ensurePtyBinaryPromise;

  ensurePtyBinaryPromise = (async () => {
    const release = getPtyReleaseTarget();
    if (!release) return null;

    const binPath = getPtyBinaryPath(release.fileName);
    await fs.mkdir(path.dirname(binPath), { recursive: true });

    try {
      await fs.access(binPath);
      return binPath;
    } catch {
      console.log(`[pty] PTY missing. Installing ${release.fileName}...`);
      await downloadPtyBinary(release.url, binPath);
      return binPath;
    }
  })();

  try {
    return await ensurePtyBinaryPromise;
  } finally {
    ensurePtyBinaryPromise = null;
  }
}

async function ensurePtyProcess(): Promise<void> {
  if (ptyProcess && ptyProcess.exitCode === null) return;

  const binPath = await ensurePtyBinaryReady();
  if (!binPath) {
    throw new Error(`PTY is not supported on ${os.platform()}/${os.arch()}`);
  }
  ptyProcess = spawn(binPath, [], {
    cwd: ROOT_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  });

  ptyProcess.stderr?.on("data", (data: Buffer) => {
    console.error("[pty]", data.toString().trim());
  });

  ptyProcess.on("exit", (code) => {
    debugLog(`[pty] PTY process exited with code ${code}`);
    ptyProcess = null;
    // Reject all pending spawns
    for (const [id, pending] of ptyPendingSpawns) {
      pending.reject(new Error("PTY process exited"));
    }
    ptyPendingSpawns.clear();
  });

  // Parse stdout line by line for events from the Rust binary
  const rl = createInterface({ input: ptyProcess.stdout! });
  rl.on("line", (line: string) => {
    let event: { event: string; id: string; [key: string]: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.event === "spawned") {
      const pending = ptyPendingSpawns.get(event.id);
      if (pending) {
        pending.resolve();
        ptyPendingSpawns.delete(event.id);
      }
    } else if (event.event === "state") {
      // Forward screen state to app via data channel
      const msg: Message = {
        v: 1,
        id: `evt-${Date.now()}`,
        ns: "terminal",
        action: "state",
        payload: {
          terminalId: event.id,
          cells: event.cells,
          cursorX: event.cursorX,
          cursorY: event.cursorY,
          cols: event.cols,
          rows: event.rows,
          cursorVisible: event.cursorVisible,
          cursorStyle: event.cursorStyle,
          appCursorKeys: event.appCursorKeys,
          bracketedPaste: event.bracketedPaste,
          mouseMode: event.mouseMode,
          mouseEncoding: event.mouseEncoding,
          reverseVideo: event.reverseVideo,
          title: event.title,
          scrollbackLength: event.scrollbackLength,
        },
      };
      emitAppEvent(msg);
    } else if (event.event === "exit") {
      terminals.delete(event.id);
      const msg: Message = {
        v: 1,
        id: `evt-${Date.now()}`,
        ns: "terminal",
        action: "exit",
        payload: { terminalId: event.id, code: event.code },
      };
      emitAppEvent(msg);
    } else if (event.event === "error") {
      const pending = ptyPendingSpawns.get(event.id);
      if (pending) {
        pending.reject(new Error(String(event.message || "PTY error")));
        ptyPendingSpawns.delete(event.id);
      }
      console.error(`[pty] Error for ${event.id}: ${event.message}`);
    }
  });
}

function sendToPty(cmd: object): void {
  if (!ptyProcess || !ptyProcess.stdin) {
    throw Object.assign(new Error("PTY process not running"), { code: "ENOPTY" });
  }
  ptyProcess.stdin.write(JSON.stringify(cmd) + "\n");
}

async function handleTerminalSpawn(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensurePtyProcess();

  const shell = (payload.shell as string) || getDefaultTerminalShell();
  const cols = (payload.cols as number) || 80;
  const rows = (payload.rows as number) || 24;
  const terminalId = `term-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // Wait for the Rust binary to confirm spawn
  const spawnPromise = new Promise<void>((resolve, reject) => {
    ptyPendingSpawns.set(terminalId, { resolve, reject });
    setTimeout(() => {
      if (ptyPendingSpawns.has(terminalId)) {
        ptyPendingSpawns.delete(terminalId);
        reject(new Error("Spawn timed out"));
      }
    }, 10000);
  });

  sendToPty({ cmd: "spawn", id: terminalId, shell, cols, rows });
  await spawnPromise;

  terminals.add(terminalId);
  return { terminalId };
}

function handleTerminalWrite(payload: Record<string, unknown>): Record<string, unknown> {
  const terminalId = payload.terminalId as string;
  const data = payload.data as string;

  if (!terminalId) throw Object.assign(new Error("terminalId is required"), { code: "EINVAL" });
  if (typeof data !== "string") throw Object.assign(new Error("data is required"), { code: "EINVAL" });
  if (!terminals.has(terminalId)) throw Object.assign(new Error("Terminal not found"), { code: "ENOTERM" });

  sendToPty({ cmd: "write", id: terminalId, data });
  return {};
}

function handleTerminalResize(payload: Record<string, unknown>): Record<string, unknown> {
  const terminalId = payload.terminalId as string;
  const cols = payload.cols as number;
  const rows = payload.rows as number;

  if (!terminalId) throw Object.assign(new Error("terminalId is required"), { code: "EINVAL" });
  if (!terminals.has(terminalId)) throw Object.assign(new Error("Terminal not found"), { code: "ENOTERM" });

  sendToPty({ cmd: "resize", id: terminalId, cols, rows });
  return {};
}

function handleTerminalKill(payload: Record<string, unknown>): Record<string, unknown> {
  const terminalId = payload.terminalId as string;

  if (!terminalId) throw Object.assign(new Error("terminalId is required"), { code: "EINVAL" });
  if (!terminals.has(terminalId)) throw Object.assign(new Error("Terminal not found"), { code: "ENOTERM" });

  sendToPty({ cmd: "kill", id: terminalId });
  terminals.delete(terminalId);
  return {};
}

function handleTerminalScroll(payload: Record<string, unknown>): Record<string, unknown> {
  const terminalId = payload.terminalId as string;
  const offset = (payload.offset as number) || 0;

  if (!terminalId) throw Object.assign(new Error("terminalId is required"), { code: "EINVAL" });
  if (!terminals.has(terminalId)) throw Object.assign(new Error("Terminal not found"), { code: "ENOTERM" });

  sendToPty({ cmd: "scroll", id: terminalId, offset });
  return {};
}

// ============================================================================
// System Handlers
// ============================================================================

function handleSystemCapabilities(): Record<string, unknown> {
  return {
    version: VERSION,
    namespaces: ["fs", "git", "terminal", "processes", "ports", "monitor", "http", "ai", "proxy", "editor"],
    platform: os.platform(),
    rootDir: ROOT_DIR,
    hostname: os.hostname(),
  };
}

function handleSystemPing(): Record<string, unknown> {
  return { pong: true, timestamp: Date.now() };
}

// ============================================================================
// Processes Handlers
// ============================================================================

function handleProcessesList(): Record<string, unknown> {
  const result: Array<{
    pid: number;
    command: string;
    startTime: number;
    status: string;
    channel: string;
    cwd: string;
  }> = [];

  for (const [pid, proc] of processes) {
    result.push({
      pid,
      command: `${proc.command} ${proc.args.join(" ")}`.trim(),
      startTime: proc.startTime,
      status: proc.proc.killed ? "stopped" : "running",
      channel: proc.channel,
      cwd: proc.cwd,
    });
  }

  return { processes: result };
}

async function handleProcessesSpawn(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const command = payload.command as string;
  const args = (payload.args as string[]) || [];
  const cwd = payload.cwd as string | undefined;
  const extraEnv = (payload.env as Record<string, string>) || {};

  if (!command) throw Object.assign(new Error("command is required"), { code: "EINVAL" });

  const workDir = cwd ? assertSafePath(cwd) : ROOT_DIR;

  const proc = spawn(command, args, {
    cwd: workDir,
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  const pid = await new Promise<number>((resolve, reject) => {
    let settled = false;

    const handleSpawn = () => {
      if (settled) return;
      settled = true;
      proc.removeListener("error", handleError);
      if (!proc.pid) {
        reject(Object.assign(new Error(`Failed to spawn "${command}"`), { code: "ERROR" }));
        return;
      }
      resolve(proc.pid);
    };

    const handleError = (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      proc.removeListener("spawn", handleSpawn);
      reject(Object.assign(new Error(err.message || `Failed to spawn "${command}"`), {
        code: err.code || "ERROR",
      }));
    };

    proc.once("spawn", handleSpawn);
    proc.once("error", handleError);
  });
  const channel = `proc-${pid}`;

  const managedProc: ManagedProcess = {
    pid,
    proc,
    command,
    args,
    cwd: workDir,
    startTime: Date.now(),
    output: [],
    channel,
  };

  processes.set(pid, managedProc);
  processOutputBuffers.set(channel, "");

  // Stream output
  const sendOutput = (stream: "stdout" | "stderr") => (data: Buffer) => {
    const text = data.toString();
    managedProc.output.push(text);
    processOutputBuffers.set(channel, (processOutputBuffers.get(channel) || "") + text);

    const msg: Message = {
      v: 1,
      id: `evt-${Date.now()}`,
      ns: "processes",
      action: "output",
      payload: { pid, channel, stream, data: text },
    };
    emitAppEvent(msg);
  };

  proc.stdout?.on("data", sendOutput("stdout"));
  proc.stderr?.on("data", sendOutput("stderr"));
  proc.on("error", (err) => {
    const message = err.message || `Process "${command}" failed`;
    processOutputBuffers.set(channel, (processOutputBuffers.get(channel) || "") + `${message}\n`);
    emitAppEvent({
      v: 1,
      id: `evt-${Date.now()}`,
      ns: "processes",
      action: "output",
      payload: { pid, channel, stream: "stderr", data: `${message}\n` },
    });
  });

  proc.on("close", (code, signal) => {
    const msg: Message = {
      v: 1,
      id: `evt-${Date.now()}`,
      ns: "processes",
      action: "exit",
      payload: { pid, channel, code, signal },
    };
    emitAppEvent(msg);
  });

  return { pid, channel };
}

function handleProcessesKill(payload: Record<string, unknown>): Record<string, unknown> {
  const pid = payload.pid as number;
  if (!pid) throw Object.assign(new Error("pid is required"), { code: "EINVAL" });

  const proc = processes.get(pid);
  if (!proc) throw Object.assign(new Error("Process not found"), { code: "ENOPROC" });

  proc.proc.kill();
  processes.delete(pid);

  return {};
}

function handleProcessesGetOutput(payload: Record<string, unknown>): Record<string, unknown> {
  const channel = payload.channel as string;
  if (!channel) throw Object.assign(new Error("channel is required"), { code: "EINVAL" });

  const output = processOutputBuffers.get(channel) || "";
  return { channel, output };
}

function handleProcessesClearOutput(payload: Record<string, unknown>): Record<string, unknown> {
  const channel = payload.channel as string;

  if (channel) {
    processOutputBuffers.set(channel, "");
  } else {
    processOutputBuffers.clear();
  }

  return {};
}

// ============================================================================
// Ports Handlers
// ============================================================================

function handlePortsList(): Record<string, unknown> {
  const platform = os.platform();
  const ports: Array<{ port: number; pid: number; process: string; address: string }> = [];

  try {
    let output: string;

    if (platform === "darwin" || platform === "linux") {
      // Use lsof on macOS/Linux
      try {
        output = execSync("lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null || true", {
          encoding: "utf-8",
          timeout: 5000,
        });

        const lines = output.trim().split("\n").slice(1); // Skip header
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 9) {
            const processName = parts[0];
            const pid = parseInt(parts[1]);
            const nameField = parts[8];
            // Parse address:port format
            const match = nameField.match(/:(\d+)$/);
            if (match) {
              const port = parseInt(match[1]);
              const address = nameField.replace(`:${port}`, "") || "0.0.0.0";
              ports.push({ port, pid, process: processName, address });
            }
          }
        }
      } catch {
        // lsof might fail, try netstat
        output = execSync("netstat -tlnp 2>/dev/null || netstat -an 2>/dev/null || true", {
          encoding: "utf-8",
          timeout: 5000,
        });
      }
    } else if (platform === "win32") {
      output = runWindowsCommandSync("netstat", ["-ano"]);

      const lines = output.trim().split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[3]?.toUpperCase() === "LISTENING") {
          const localAddr = parts[1];
          const pid = parseInt(parts[4]);
          const match = localAddr.match(/:(\d+)$/);
          if (match) {
            const port = parseInt(match[1]);
            const address = localAddr.replace(`:${port}`, "");
            ports.push({ port, pid, process: "unknown", address });
          }
        }
      }
    }
  } catch {
    // Return empty list on error
  }

  return { ports };
}

function handlePortsIsAvailable(payload: Record<string, unknown>): Record<string, unknown> {
  const port = Math.floor(Number(payload.port));
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error("port must be an integer between 1 and 65535"), { code: "EINVAL" });
  }

  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve({ port, available: false });
      } else {
        resolve({ port, available: false, error: err.message });
      }
    });

    server.once("listening", () => {
      server.close(() => {
        resolve({ port, available: true });
      });
    });

    server.listen(port, "127.0.0.1");
  }) as unknown as Record<string, unknown>;
}

function handlePortsKill(payload: Record<string, unknown>): Record<string, unknown> {
  const port = payload.port as number;
  if (!port) throw Object.assign(new Error("port is required"), { code: "EINVAL" });

  // Strict port range validation to prevent injection via crafted numeric values
  const portNum = Math.floor(Number(port));
  if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
    throw Object.assign(new Error("port must be an integer between 1 and 65535"), { code: "EINVAL" });
  }

  const platform = os.platform();

  try {
    let pid: number | null = null;

    if (platform === "darwin" || platform === "linux") {
      // Use spawnSync with an explicit args array — never shell: true — so portNum
      // cannot escape into a shell command even if it were somehow non-numeric.
      const result = spawnSync("lsof", ["-ti", String(portNum)], { encoding: "utf-8" });
      const pids = (result.stdout || "").trim().split("\n").filter(Boolean);
      for (const pidStr of pids) {
        const p = parseInt(pidStr, 10);
        if (!Number.isFinite(p) || p <= 0) continue;
        if (pid === null) pid = p;
        // Send SIGKILL directly via process.kill — no shell involved.
        try { process.kill(p, "SIGKILL"); } catch { /* already dead */ }
      }
    } else if (platform === "win32") {
      // Use netstat via args array, parse PIDs, then taskkill via args array.
      const result = spawnSync("netstat", ["-ano"], { encoding: "utf-8" });
      const lines = (result.stdout || "").trim().split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        // netstat -ano columns: Proto  Local  Foreign  State  PID
        // Match only lines where the local address ends with :<portNum>
        if (parts.length < 5) continue;
        const localAddr = parts[1] ?? "";
        if (!localAddr.endsWith(`:${portNum}`)) continue;
        const p = parseInt(parts[4], 10);
        if (!Number.isFinite(p) || p <= 0) continue;
        if (pid === null) pid = p;
        spawnSync("taskkill", ["/F", "/PID", String(p)], { encoding: "utf-8" });
        break;
      }
    }

    return { port: portNum, pid };
  } catch (err) {
    throw Object.assign(new Error(`Failed to kill process on port ${portNum}`), { code: "EPERM" });
  }
}

// ============================================================================
// Monitor Handlers
// ============================================================================

function getCpuUsage(): { usage: number; cores: number[] } {
  const cpus = os.cpus();
  const coreUsages: number[] = [];
  let totalIdle = 0;
  let totalTick = 0;

  for (let i = 0; i < cpus.length; i++) {
    const cpu = cpus[i];
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;

    if (lastCpuInfo && lastCpuInfo[i]) {
      const deltaTotal = total - lastCpuInfo[i].total;
      const deltaIdle = idle - lastCpuInfo[i].idle;
      const usage = deltaTotal > 0 ? ((deltaTotal - deltaIdle) / deltaTotal) * 100 : 0;
      coreUsages.push(Math.round(usage * 10) / 10);
    } else {
      coreUsages.push(0);
    }

    totalIdle += idle;
    totalTick += total;
  }

  // Update last CPU info for next calculation
  lastCpuInfo = cpus.map((cpu) => ({
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((a, b) => a + b, 0),
  }));

  const avgUsage = coreUsages.length > 0
    ? coreUsages.reduce((a, b) => a + b, 0) / coreUsages.length
    : 0;

  return { usage: Math.round(avgUsage * 10) / 10, cores: coreUsages };
}

function getMemoryInfo(): { total: number; used: number; free: number; usedPercent: number } {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const usedPercent = Math.round((used / total) * 1000) / 10;

  return { total, used, free, usedPercent };
}

function getDiskInfo(): Array<{ mount: string; filesystem: string; size: number; used: number; free: number; usedPercent: number }> {
  const platform = os.platform();
  const disks: Array<{ mount: string; filesystem: string; size: number; used: number; free: number; usedPercent: number }> = [];

  try {
    if (platform === "darwin" || platform === "linux") {
      const output = execSync("df -k 2>/dev/null || true", { encoding: "utf-8" });
      const lines = output.trim().split("\n").slice(1);

      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 6) {
          const filesystem = parts[0];
          const size = parseInt(parts[1]) * 1024;
          const used = parseInt(parts[2]) * 1024;
          const free = parseInt(parts[3]) * 1024;
          const mount = parts[5];

          // Skip special filesystems
          if (mount.startsWith("/") && !filesystem.startsWith("devfs") && !filesystem.startsWith("map ")) {
            disks.push({
              mount,
              filesystem,
              size,
              used,
              free,
              usedPercent: size > 0 ? Math.round((used / size) * 1000) / 10 : 0,
            });
          }
        }
      }
    } else if (platform === "win32") {
      const diskData = toArray(runWindowsPowerShellJson(
        "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object DeviceID,FileSystem,Size,FreeSpace | ConvertTo-Json -Compress"
      ) as Array<Record<string, unknown>> | Record<string, unknown> | null);

      for (const entry of diskData) {
        const mount = typeof entry.DeviceID === "string" ? entry.DeviceID : "";
        const filesystem = typeof entry.FileSystem === "string" ? entry.FileSystem : "unknown";
        const size = Number(entry.Size) || 0;
        const free = Number(entry.FreeSpace) || 0;
        const used = size - free;

        if (mount && size > 0) {
          disks.push({
            mount,
            filesystem,
            size,
            used,
            free,
            usedPercent: Math.round((used / size) * 1000) / 10,
          });
        }
      }
    }
  } catch {
    // Return empty on error
  }

  return disks;
}

function getBatteryInfo(): { hasBattery: boolean; percent: number; charging: boolean; timeRemaining: number | null } {
  const platform = os.platform();

  try {
    if (platform === "darwin") {
      const output = execSync("pmset -g batt 2>/dev/null || true", { encoding: "utf-8" });
      const percentMatch = output.match(/(\d+)%/);
      const chargingMatch = output.match(/AC Power|charging|charged/i);
      const timeMatch = output.match(/(\d+):(\d+) remaining/);

      if (percentMatch) {
        return {
          hasBattery: true,
          percent: parseInt(percentMatch[1]),
          charging: !!chargingMatch,
          timeRemaining: timeMatch ? parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]) : null,
        };
      }
    } else if (platform === "linux") {
      try {
        const capacityPath = "/sys/class/power_supply/BAT0/capacity";
        const statusPath = "/sys/class/power_supply/BAT0/status";

        const capacity = parseInt(execSync(`cat ${capacityPath} 2>/dev/null || echo 0`, { encoding: "utf-8" }).trim());
        const status = execSync(`cat ${statusPath} 2>/dev/null || echo Unknown`, { encoding: "utf-8" }).trim();

        if (capacity > 0) {
          return {
            hasBattery: true,
            percent: capacity,
            charging: status === "Charging" || status === "Full",
            timeRemaining: null,
          };
        }
      } catch {
        // No battery
      }
    } else if (platform === "win32") {
      const batteries = toArray(runWindowsPowerShellJson(
        "Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress"
      ) as Array<Record<string, unknown>> | Record<string, unknown> | null);

      if (batteries.length > 0) {
        const battery = batteries[0];
        const status = Number(battery.BatteryStatus);
        const percent = Number(battery.EstimatedChargeRemaining);

        return {
          hasBattery: true,
          percent: Number.isFinite(percent) ? percent : 0,
          charging: status === 2 || status === 6, // Charging or Charging High
          timeRemaining: null,
        };
      }
    }
  } catch {
    // No battery or error
  }

  return { hasBattery: false, percent: 0, charging: false, timeRemaining: null };
}

function handleMonitorSystem(): Record<string, unknown> {
  return {
    cpu: getCpuUsage(),
    memory: getMemoryInfo(),
    disk: getDiskInfo(),
    battery: getBatteryInfo(),
  };
}

function handleMonitorCpu(): Record<string, unknown> {
  const cpuInfo = getCpuUsage();
  const cpus = os.cpus();

  return {
    ...cpuInfo,
    model: cpus[0]?.model || "Unknown",
    speed: cpus[0]?.speed || 0,
  };
}

function handleMonitorMemory(): Record<string, unknown> {
  return getMemoryInfo();
}

function handleMonitorDisk(): Record<string, unknown> {
  return { disks: getDiskInfo() };
}

function handleMonitorBattery(): Record<string, unknown> {
  return getBatteryInfo();
}

// ============================================================================
// HTTP Handlers
// ============================================================================

async function handleHttpRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const method = (payload.method as string) || "GET";
  const url = payload.url as string;
  const headers = (payload.headers as Record<string, string>) || {};
  const body = payload.body as string | undefined;
  const timeout = (payload.timeout as number) || 30000;

  if (!url) throw Object.assign(new Error("url is required"), { code: "EINVAL" });

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method,
      headers,
      body: body || undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const responseBody = await response.text();
    const timing = Date.now() - startTime;

    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      timing,
    };
  } catch (err) {
    const error = err as Error;
    if (error.name === "AbortError") {
      throw Object.assign(new Error("Request timed out"), { code: "ETIMEOUT" });
    }
    throw Object.assign(new Error(error.message || "Network error"), { code: "ENETWORK" });
  }
}

// ============================================================================
// AI Handlers — delegated to the active AIProvider
// ============================================================================
// (Implementation lives in cli/src/ai/opencode.ts or cli/src/ai/codex.ts)

// Proxy Handlers
// ============================================================================

async function scanDevPorts(): Promise<number[]> {
  const openPorts: number[] = [];

  const scanPorts = Array.from(new Set([...DEV_PORTS, ...trackedProxyPorts])).sort((a, b) => a - b);
  const checks = scanPorts.map((port) => {
    return new Promise<void>((resolve) => {
      let finished = false;
      let pending = LOOPBACK_HOSTS.length;
      for (const host of LOOPBACK_HOSTS) {
        const socket = createConnection({ port, host });
        socket.setTimeout(200);

        socket.on("connect", () => {
          if (finished) return;
          finished = true;
          openPorts.push(port);
          socket.destroy();
          resolve();
        });

        const onDone = () => {
          if (finished) return;
          pending -= 1;
          if (pending <= 0) {
            finished = true;
            resolve();
          }
        };

        socket.on("timeout", () => {
          socket.destroy();
          onDone();
        });

        socket.on("error", () => {
          onDone();
        });
      }
    });
  });

  await Promise.all(checks);
  return openPorts.sort((a, b) => a - b);
}

function getTrackedProxyPorts(): number[] {
  return Array.from(trackedProxyPorts).sort((a, b) => a - b);
}

async function publishDiscoveredPorts(force = false): Promise<void> {
  if (portScanInFlight) return;
  if (!activeV2Transport) return;

  portScanInFlight = true;
  try {
    const openPorts = await scanDevPorts();
    if (!force && samePortSet(openPorts, lastDiscoveredPorts)) {
      return;
    }

    lastDiscoveredPorts = openPorts;
    emitAppEvent({
      v: 1,
      id: `evt-${Date.now()}`,
      ns: "proxy",
      action: "ports_discovered",
      payload: { ports: openPorts },
    });
    debugLog(`[proxy] ports updated (${openPorts.length}): ${openPorts.join(", ") || "-"}`);
  } catch (err) {
    console.error("Port scan failed:", err);
  } finally {
    portScanInFlight = false;
  }
}

async function getProxyState(): Promise<Record<string, unknown>> {
  const openPorts = await scanDevPorts();
  lastDiscoveredPorts = openPorts;
  return {
    trackedPorts: getTrackedProxyPorts(),
    openPorts,
  };
}

async function handleTrackProxyPort(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const port = Number(payload.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error("port must be an integer between 1 and 65535"), { code: "EINVAL" });
  }

  trackedProxyPorts.add(port);
  debugLog("[proxy] tracking custom port", {
    port,
    trackedPorts: getTrackedProxyPorts(),
  });

  await publishDiscoveredPorts(true);
  return {
    trackedPorts: getTrackedProxyPorts(),
    openPorts: lastDiscoveredPorts,
  };
}

async function handleUntrackProxyPort(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const port = Number(payload.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error("port must be an integer between 1 and 65535"), { code: "EINVAL" });
  }

  trackedProxyPorts.delete(port);
  debugLog("[proxy] removed custom port tracking", {
    port,
    trackedPorts: getTrackedProxyPorts(),
  });

  await publishDiscoveredPorts(true);
  return {
    trackedPorts: getTrackedProxyPorts(),
    openPorts: lastDiscoveredPorts,
  };
}

function stopPortSync(): void {
  if (portSyncTimer) {
    clearInterval(portSyncTimer);
    portSyncTimer = null;
  }
  portScanInFlight = false;
}

function startPortSync(): void {
  stopPortSync();
  void publishDiscoveredPorts(true);
  portSyncTimer = setInterval(() => {
    void publishDiscoveredPorts(false);
  }, PORT_SYNC_INTERVAL_MS);
}

async function handleProxyConnect(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tunnelId = payload.tunnelId as string;
  const port = payload.port as number;
  const setupStartedAt = Date.now();
  const getRemainingSetupMs = () => TUNNEL_SETUP_BUDGET_MS - (Date.now() - setupStartedAt);
  debugLog("[proxy] handleProxyConnect received", {
    tunnelId,
    port,
    hasSessionCode: Boolean(currentSessionCode),
    hasSessionPassword: Boolean(currentSessionPassword),
    activeGatewayUrl,
  });

  if (!tunnelId) throw Object.assign(new Error("tunnelId is required"), { code: "EINVAL" });
  if (!port) throw Object.assign(new Error("port is required"), { code: "EINVAL" });
  if (!currentSessionCode && !currentSessionPassword) throw Object.assign(new Error("no active session"), { code: "ENOENT" });
  if (getRemainingSetupMs() <= 0) {
    throw Object.assign(new Error("Tunnel setup timeout before start"), { code: "ETIMEOUT" });
  }

  // 1. Open TCP connection to the local service (dual-stack localhost fallback)
  let tcpSocket: Socket | null = null;
  let tcpConnectError: Error | null = null;
  for (const host of LOOPBACK_HOSTS) {
    const remainingMs = getRemainingSetupMs();
    if (remainingMs <= 0) {
      throw Object.assign(new Error("Tunnel setup timeout before local TCP connect"), { code: "ETIMEOUT" });
    }
    const tcpConnectTimeoutMs = Math.min(CLI_LOCAL_TCP_CONNECT_TIMEOUT_MS, Math.max(250, remainingMs));
    const candidate = createConnection({ port, host });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          candidate.destroy();
          reject(Object.assign(new Error(`TCP connect timeout to ${host}:${port}`), { code: "ETIMEOUT" }));
        }, tcpConnectTimeoutMs);

        candidate.on("connect", () => {
          clearTimeout(timeout);
          resolve();
        });

        candidate.on("error", (err) => {
          clearTimeout(timeout);
          reject(Object.assign(new Error(`TCP connect failed to ${host}:${port}: ${err.message}`), { code: "ECONNREFUSED" }));
        });
      });
      tcpSocket = candidate;
      break;
    } catch (error) {
      tcpConnectError = error as Error;
      try {
        candidate.destroy();
      } catch {
        // ignore
      }
    }
  }
  if (!tcpSocket) {
    debugLog("[proxy] local tcp connect failed", {
      tunnelId,
      port,
      error: tcpConnectError?.message ?? null,
    });
    throw tcpConnectError || Object.assign(new Error(`TCP connect failed to localhost:${port}`), { code: "ECONNREFUSED" });
  }
  debugLog("[proxy] local tcp connected", { tunnelId, port });

  // 2. Open proxy WebSocket to gateway
  const wsBase = activeGatewayUrl.replace(/^https:/, "wss:");
  if (!wsBase.startsWith("wss://")) {
    throw Object.assign(new Error("Gateway URL must use https://"), { code: "EPROTO" });
  }
  const authQuery = currentSessionPassword
    ? `password=${encodeURIComponent(currentSessionPassword)}`
    : `code=${encodeURIComponent(currentSessionCode as string)}`;
  const proxyWsUrl = `${wsBase}/v1/ws/proxy?${authQuery}&tunnelId=${encodeURIComponent(tunnelId)}&role=cli`;
  debugLog("[proxy] connecting cli proxy websocket", {
    tunnelId,
    port,
    authMode: currentSessionPassword ? "password" : "code",
    wsBase,
  });
  let proxyWs: WebSocket | null = null;
  let lastProxyError: Error | null = null;

  for (let attempt = 0; attempt <= PROXY_WS_CONNECT_RETRY_ATTEMPTS; attempt++) {
    const remainingMs = getRemainingSetupMs();
    if (remainingMs <= 0) {
      tcpSocket.destroy();
      throw Object.assign(new Error("Tunnel setup timeout while connecting proxy WS"), { code: "ETIMEOUT" });
    }

    const wsConnectTimeoutMs = Math.min(PROXY_WS_CONNECT_TIMEOUT_MS, Math.max(250, remainingMs));
    const candidateWs = new WebSocket(proxyWsUrl);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          candidateWs.close();
          reject(Object.assign(new Error("Proxy WS connect timeout"), { code: "ETIMEOUT" }));
        }, wsConnectTimeoutMs);

        candidateWs.on("open", () => {
          clearTimeout(timeout);
          resolve();
        });

        candidateWs.on("error", (err) => {
          clearTimeout(timeout);
          reject(Object.assign(new Error(`Proxy WS failed: ${err.message}`), { code: "ECONNREFUSED" }));
        });

        candidateWs.on("close", () => {
          clearTimeout(timeout);
          reject(Object.assign(new Error("Proxy WS closed during connect"), { code: "ECONNRESET" }));
        });
      });

      proxyWs = candidateWs;
      break;
    } catch (error) {
      lastProxyError = error as Error;
      try {
        candidateWs.close();
      } catch {
        // ignore
      }

      if (attempt >= PROXY_WS_CONNECT_RETRY_ATTEMPTS) {
        break;
      }

      const jitterSpan = PROXY_WS_RETRY_JITTER_MAX_MS - PROXY_WS_RETRY_JITTER_MIN_MS;
      const jitterMs = PROXY_WS_RETRY_JITTER_MIN_MS + Math.floor(Math.random() * (jitterSpan + 1));
      if (getRemainingSetupMs() <= jitterMs) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, jitterMs));
    }
  }

  if (!proxyWs) {
    tcpSocket.destroy();
    const err = lastProxyError || Object.assign(new Error("Proxy WS connect failed"), { code: "ECONNREFUSED" });
    debugLog("[proxy] cli proxy websocket connect failed", {
      tunnelId,
      port,
      error: err.message,
    });
    throw err;
  }
  debugLog("[proxy] cli proxy websocket connected", { tunnelId, port });

  // 3. Store the tunnel
  activeTunnels.set(tunnelId, {
    tunnelId,
    port,
    tcpSocket,
    proxyWs,
    localEnded: false,
    remoteEnded: false,
    finSent: false,
    finalizeTimer: null,
    closing: false,
  });

  // 4. Pipe: TCP data -> proxy WS (as binary)
  tcpSocket.on("data", (chunk: Buffer) => {
    if (proxyWs.readyState === WebSocket.OPEN) {
      proxyWs.send(chunk);
    }
  });

  // 5. Pipe: proxy WS -> TCP socket (as binary)
  proxyWs.on("message", (data: WebSocket.RawData) => {
    const control = parseProxyControlFrame(data);
    if (control) {
      const tunnel = activeTunnels.get(tunnelId);
      if (!tunnel || tunnel.closing) return;
      if (control.action === "fin") {
        tunnel.remoteEnded = true;
        if (!tcpSocket.destroyed) {
          tcpSocket.end();
        }
        maybeFinalizeTunnel(tunnelId);
      } else {
        tunnel.closing = true;
        activeTunnels.delete(tunnelId);
        if (!tcpSocket.destroyed) {
          tcpSocket.destroy();
        }
        if (proxyWs.readyState === WebSocket.OPEN || proxyWs.readyState === WebSocket.CONNECTING) {
          proxyWs.close();
        }
      }
      return;
    }

    if (!tcpSocket.destroyed) {
      const chunk = Buffer.isBuffer(data)
        ? data
        : typeof data === "string"
          ? Buffer.from(data)
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
      tcpSocket.write(chunk);
    }
  });

  const markLocalEnded = () => {
    const tunnel = activeTunnels.get(tunnelId);
    if (!tunnel || tunnel.closing) return;
    tunnel.localEnded = true;
    if (!tunnel.finSent) {
      tunnel.finSent = true;
      sendProxyControl(tunnel, "fin");
    }
    maybeFinalizeTunnel(tunnelId);
  };

  // 6. Half-close handling
  tcpSocket.on("end", () => {
    markLocalEnded();
  });

  tcpSocket.on("close", () => {
    markLocalEnded();
  });

  tcpSocket.on("error", () => {
    debugLog("[proxy] local tcp socket error", { tunnelId, port });
    const tunnel = activeTunnels.get(tunnelId);
    if (tunnel && !tunnel.finSent) {
      sendProxyControl(tunnel, "rst", "tcp_error");
    }
    if (tunnel) {
      tunnel.closing = true;
      if (tunnel.finalizeTimer) {
        clearTimeout(tunnel.finalizeTimer);
      }
    }
    activeTunnels.delete(tunnelId);
    if (proxyWs.readyState === WebSocket.OPEN || proxyWs.readyState === WebSocket.CONNECTING) {
      proxyWs.close();
    }
  });

  // 7. Close cascade: WS closes -> close TCP
  proxyWs.on("close", () => {
    debugLog("[proxy] cli proxy websocket closed", { tunnelId, port });
    const tunnel = activeTunnels.get(tunnelId);
    if (tunnel) {
      tunnel.closing = true;
      if (tunnel.finalizeTimer) {
        clearTimeout(tunnel.finalizeTimer);
      }
    }
    activeTunnels.delete(tunnelId);
    if (!tcpSocket.destroyed) {
      tcpSocket.destroy();
    }
  });

  proxyWs.on("error", () => {
    debugLog("[proxy] cli proxy websocket error", { tunnelId, port });
    const tunnel = activeTunnels.get(tunnelId);
    if (tunnel) {
      tunnel.closing = true;
      if (tunnel.finalizeTimer) {
        clearTimeout(tunnel.finalizeTimer);
      }
    }
    activeTunnels.delete(tunnelId);
    if (!tcpSocket.destroyed) {
      tcpSocket.destroy();
    }
  });

  return { tunnelId, port };
}

function cleanupAllTunnels(): void {
  for (const [, tunnel] of activeTunnels) {
    if (tunnel.finalizeTimer) {
      clearTimeout(tunnel.finalizeTimer);
    }
    tunnel.tcpSocket.destroy();
    if (tunnel.proxyWs.readyState === WebSocket.OPEN) {
      tunnel.proxyWs.close();
    }
  }
  activeTunnels.clear();
}

// ============================================================================
// Message Router
// ============================================================================

async function processMessage(message: Message): Promise<Response> {
  const { v, id, ns, action, payload } = message;
  const startedAt = Date.now();
  const pathValue = typeof payload?.path === "string" ? payload.path : null;
  logWithTimestamp("router", "request received", { id, ns, action, path: pathValue });

  // Validate protocol version
  if (v !== 1) {
    return {
      v: 1,
      id,
      ns,
      action,
      ok: false,
      payload: {},
      error: { code: "EPROTO", message: `Unsupported protocol version: ${v}` },
    };
  }

  // Validate required fields
  if (!ns || !action) {
    debugWarn(
      "[router] Ignoring message with missing ns/action:",
      redactSensitive(JSON.stringify(message).substring(0, 300))
    );
    return {
      v: 1,
      id,
      ns,
      action,
      ok: false,
      payload: {},
      error: { code: "EINVAL", message: `Missing namespace or action` },
    };
  }

  try {
    let result: Record<string, unknown>;

    switch (ns) {
      case "system":
        switch (action) {
          case "capabilities":
            result = handleSystemCapabilities();
            void publishDiscoveredPorts(true);
            break;
          case "ping":
            result = handleSystemPing();
            break;
          case "pairDevice": {
            throw Object.assign(new Error("pairDevice is no longer supported"), { code: "EINVAL" });
          }
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "fs":
        switch (action) {
          case "ls":
            result = await handleFsLs(payload);
            break;
          case "stat":
            result = await handleFsStat(payload);
            break;
          case "read":
            result = await handleFsRead(payload);
            break;
          case "write":
            result = await handleFsWrite(payload);
            break;
          case "mkdir":
            result = await handleFsMkdir(payload);
            break;
          case "rm":
            result = await handleFsRm(payload);
            break;
          case "mv":
            result = await handleFsMv(payload);
            break;
          case "grep":
            result = await handleFsGrep(payload);
            break;
          case "create":
            result = await handleFsCreate(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "editor":
        switch (action) {
          case "open":
            result = await trackEditorFile(payload.path as string);
            break;
          case "close":
            result = untrackEditorFile(payload.path as string);
            break;
          case "rename":
            result = await renameTrackedEditorFile(payload.from as string, payload.to as string);
            break;
          case "delete":
            result = deleteTrackedEditorFile(payload.path as string);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "git":
        switch (action) {
          case "status":
            result = await handleGitStatus();
            break;
          case "stage":
            result = await handleGitStage(payload);
            break;
          case "unstage":
            result = await handleGitUnstage(payload);
            break;
          case "commit":
            result = await handleGitCommit(payload);
            break;
          case "log":
            result = await handleGitLog(payload);
            break;
          case "commitDetails":
            result = await handleGitCommitDetails(payload);
            break;
          case "diff":
            result = await handleGitDiff(payload);
            break;
          case "branches":
            result = await handleGitBranches();
            break;
          case "checkout":
            result = await handleGitCheckout(payload);
            break;
          case "pull":
            result = await handleGitPull();
            break;
          case "push":
            result = await handleGitPush(payload);
            break;
          case "discard":
            result = await handleGitDiscard(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "terminal":
        switch (action) {
          case "spawn":
            result = await handleTerminalSpawn(payload);
            break;
          case "write":
            result = handleTerminalWrite(payload);
            break;
          case "resize":
            result = handleTerminalResize(payload);
            break;
          case "kill":
            result = handleTerminalKill(payload);
            break;
          case "scroll":
            result = handleTerminalScroll(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "processes":
        switch (action) {
          case "list":
            result = handleProcessesList();
            break;
          case "spawn":
            result = await handleProcessesSpawn(payload);
            break;
          case "kill":
            result = handleProcessesKill(payload);
            break;
          case "getOutput":
            result = handleProcessesGetOutput(payload);
            break;
          case "clearOutput":
            result = handleProcessesClearOutput(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "ports":
        switch (action) {
          case "list":
            result = handlePortsList();
            break;
          case "isAvailable":
            result = await handlePortsIsAvailable(payload);
            break;
          case "kill":
            result = handlePortsKill(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "monitor":
        switch (action) {
          case "system":
            result = handleMonitorSystem();
            break;
          case "cpu":
            result = handleMonitorCpu();
            break;
          case "memory":
            result = handleMonitorMemory();
            break;
          case "disk":
            result = handleMonitorDisk();
            break;
          case "battery":
            result = handleMonitorBattery();
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "http":
        switch (action) {
          case "request":
            result = await handleHttpRequest(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "ai": {
        if (!aiManager) throw Object.assign(new Error("AI manager not initialized"), { code: "EUNAVAILABLE" });
        const backend = ((payload.backend as string) === "codex" ? "codex" : "opencode") as AiBackend;
        switch (action) {
          case "backends":
            result = { backends: aiManager.availableBackends() };
            break;
          case "prompt":
            result = await aiManager.prompt(
              backend,
              payload.sessionId as string,
              payload.text as string,
              payload.model as { providerID: string; modelID: string } | undefined,
              payload.agent as string | undefined,
              payload.files as Array<{ type: "file"; mime: string; filename?: string; url: string }> | undefined,
            );
            break;
          case "createSession":  result = await aiManager.createSession(backend, payload.title as string | undefined); break;
          case "listSessions":   result = await aiManager.listAllSessions(); break;
          case "getSession":     result = await aiManager.getSession(backend, payload.id as string); break;
          case "deleteSession":  result = await aiManager.deleteSession(backend, payload.id as string); break;
          case "getMessages":    result = await aiManager.getMessages(backend, payload.id as string); break;
          case "abort":          result = await aiManager.abort(backend, payload.sessionId as string); break;
          case "agents":         result = await aiManager.agents(backend); break;
          case "providers":      result = await aiManager.providers(backend); break;
          case "setAuth":        result = await aiManager.setAuth(backend, payload.providerId as string, payload.key as string); break;
          case "command":        result = await aiManager.command(backend, payload.sessionId as string, payload.command as string, (payload.arguments as string) || ""); break;
          case "revert":         result = await aiManager.revert(backend, payload.sessionId as string, payload.messageId as string); break;
          case "unrevert":       result = await aiManager.unrevert(backend, payload.sessionId as string); break;
          case "share":          result = await aiManager.share(backend, payload.sessionId as string); break;
          case "permission": {
            const r = payload.response as string | undefined;
            const permResp: "once" | "always" | "reject" =
              r === "once" || r === "always" || r === "reject" ? r : (payload.approved ? "once" : "reject");
            result = await aiManager.permissionReply(backend, payload.sessionId as string, payload.permissionId as string, permResp);
            break;
          }
          case "questionReply":
            result = await aiManager.questionReply(
              backend,
              payload.sessionId as string,
              payload.questionId as string,
              (payload.answers as string[][]) || [],
            );
            break;
          case "questionReject":
            result = await aiManager.questionReject(
              backend,
              payload.sessionId as string,
              payload.questionId as string,
            );
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;
      }

      case "proxy":
        switch (action) {
          case "connect":
            result = await handleProxyConnect(payload);
            break;
          case "getState":
            result = await getProxyState();
            break;
          case "trackPort":
            result = await handleTrackProxyPort(payload);
            break;
          case "untrackPort":
            result = await handleUntrackProxyPort(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      default:
        throw Object.assign(new Error(`Unknown namespace: ${ns}`), { code: "EINVAL" });
    }

    const response: Response = { v: 1, id, ns, action, ok: true, payload: result };
    logWithTimestamp("router", "request completed", {
      id,
      ns,
      action,
      path: pathValue,
      durationMs: Date.now() - startedAt,
      ok: true,
    });
    return response;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (DEBUG_MODE) {
      console.error(`[router] ${ns}.${action} error:`, err.code || "ERROR", err.message);
    }
    logWithTimestamp("router", "request failed", {
      id,
      ns,
      action,
      path: pathValue,
      durationMs: Date.now() - startedAt,
      code: err.code || "ERROR",
      message: err.message || "Unknown error",
    });
    return {
      v: 1,
      id,
      ns,
      action,
      ok: false,
      payload: {},
      error: {
        code: err.code || "ERROR",
        message: err.message || "Unknown error",
      },
    };
  }
}

// ============================================================================
// WebSocket Connection
// ============================================================================

interface ManagerQrResponse {
  code: string;
  expiresInMs: number;
}

interface AssembleResult {
  code: string;
  password: string;
}

interface ManagerProxyResponse {
  proxyUrl: string;
}

interface ReattachClaimResponse {
  proxyUrl: string;
  generation: number;
  expiresAt: number;
}

let currentReattachGeneration: number | null = null;

function normalizeGatewayUrl(input: string): string {
  const raw = input.trim();
  if (!raw) {
    throw new Error("Gateway URL is required");
  }
  if (raw.toLowerCase().startsWith("http://") || raw.toLowerCase().startsWith("ws://")) {
    throw new Error("Insecure gateway protocol is not allowed; use https://");
  }

  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Invalid gateway URL: ${input}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Gateway URL must use https://");
  }
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

async function createQrCode(): Promise<ManagerQrResponse> {
  const response = await fetch(`${MANAGER_URL}/v2/qr`);
  if (!response.ok) {
    throw new Error(`Failed to create QR code from manager: ${response.status}`);
  }
  return (await response.json()) as ManagerQrResponse;
}

async function assembleWithCode(code: string): Promise<AssembleResult> {
  const wsUrl = `${MANAGER_URL.replace(/^https:/, "wss:")}/v2/assemble?code=${encodeURIComponent(code)}&role=cli`;
  return await new Promise<AssembleResult>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(error);
    };

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as { type?: string; code?: string; password?: string };
        if (parsed.type !== "assembled" || typeof parsed.code !== "string" || typeof parsed.password !== "string") {
          fail(new Error("Invalid assemble payload"));
          return;
        }
        if (settled) return;
        settled = true;
        ws.send(JSON.stringify({ type: "ack" }));
        resolve({ code: parsed.code, password: parsed.password });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.on("close", (codeValue, reason) => {
      if (settled) return;
      fail(new Error(`Assemble socket closed (${codeValue}: ${reason.toString()})`));
    });

    ws.on("error", (error) => {
      fail(new Error(`Assemble socket error: ${error.message}`));
    });
  });
}

async function getAssignedProxyUrl(password: string): Promise<string> {
  const url = new URL("/v2/proxy", MANAGER_URL);
  url.searchParams.set("password", password);
  const response = await fetch(url);
  if (!response.ok) {
    let message = `Failed to get proxy from manager: ${response.status}`;
    try {
      const payload = await response.json() as { error?: string; reason?: string };
      if (payload.error) {
        message = payload.error;
      } else if (payload.reason) {
        message = payload.reason;
      }
    } catch {
      // ignore parse failures and use the fallback message
    }
    throw new Error(message);
  }
  const payload = await response.json() as Partial<ManagerProxyResponse>;
  if (typeof payload.proxyUrl !== "string" || !payload.proxyUrl) {
    throw new Error("Manager returned invalid proxy assignment");
  }
  return normalizeGatewayUrl(payload.proxyUrl);
}

async function claimReattach(password: string): Promise<ReattachClaimResponse> {
  const response = await fetch(new URL("/v2/reattach/claim", MANAGER_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      password,
      role: "cli",
    }),
  });
  if (!response.ok) {
    let message = `Failed to claim reattach from manager: ${response.status}`;
    try {
      const payload = await response.json() as { error?: string; reason?: string };
      if (payload.error) {
        message = payload.error;
      } else if (payload.reason) {
        message = payload.reason;
      }
    } catch {
      // ignore parse failures and use the fallback message
    }
    throw new Error(message);
  }
  const payload = await response.json() as Partial<ReattachClaimResponse>;
  if (typeof payload.proxyUrl !== "string" || !payload.proxyUrl) {
    throw new Error("Manager returned invalid reattach proxy assignment");
  }
  if (typeof payload.generation !== "number" || !Number.isFinite(payload.generation) || payload.generation < 1) {
    throw new Error("Manager returned invalid reattach generation");
  }
  if (typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt)) {
    throw new Error("Manager returned invalid reattach expiry");
  }
  return {
    proxyUrl: normalizeGatewayUrl(payload.proxyUrl),
    generation: payload.generation,
    expiresAt: payload.expiresAt,
  };
}

async function revokePassword(password: string, reason = "revoked by cli --new"): Promise<void> {
  const response = await fetch(new URL("/v2/revoke", MANAGER_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, reason }),
  });
  if (response.ok || response.status === 404) {
    return;
  }

  let message = `Failed to revoke previous session: ${response.status}`;
  try {
    const payload = await response.json() as { error?: string; reason?: string };
    if (payload.error) {
      message = payload.error;
    } else if (payload.reason) {
      message = payload.reason;
    }
  } catch {
    // ignore parse failures and use the fallback message
  }
  throw new Error(message);
}

function displayQR(code: string): void {
  console.log("\n");
  qrcode.generate(code, { small: true }, (qr) => {
    console.log(qr);
    console.log(`\n  Session code: ${code}\n`);
    console.log(`  Root directory: ${ROOT_DIR}\n`);
    console.log("  Scan the QR code with the Lunel app to connect.");
    console.log("  Press Ctrl+C to exit.\n");
  });
}

function supportsAnsiStyles(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.platform !== "win32") return true;

  return Boolean(
    process.env.WT_SESSION ||
    process.env.ANSICON ||
    process.env.ConEmuANSI === "ON" ||
    process.env.TERM_PROGRAM ||
    process.env.TERM === "xterm-256color",
  );
}

function displaySavedSessionNotice(): void {
  const useAnsiStyles = supportsAnsiStyles();
  const red = useAnsiStyles ? "\x1b[31m" : "";
  const bold = useAnsiStyles ? "\x1b[1m" : "";
  const reset = useAnsiStyles ? "\x1b[0m" : "";
  const lines = [
    "NOTE: You're using an existing session.",
    "You can open it from the app via Past Sessions and select this session.",
    "If you want a new QR code for pairing, run: npx lunel-cli -n",
  ];
  const width = Math.max(...lines.map((line) => line.length));
  const border = `+${"-".repeat(width + 2)}+`;

  console.log("");
  console.log(`${red}${border}${reset}`);
  for (const line of lines) {
    console.log(`${red}|${reset} ${bold}${line.padEnd(width, " ")}${reset} ${red}|${reset}`);
  }
  console.log(`${red}${border}${reset}`);
  console.log("");
}

function gracefulShutdown(): void {
  shuttingDown = true;
  console.log("\nShutting down...");
  void aiManager?.destroy();
  stopPortSync();
  for (const trackedDir of trackedEditorDirectories.values()) {
    trackedDir.watcher.close();
  }
  trackedEditorDirectories.clear();
  trackedEditorFiles.clear();
  pendingTrackedFileChecks.clear();
  activeV2Transport?.close();
  activeV2Transport = null;
  if (ptyProcess) {
    ptyProcess.kill();
    ptyProcess = null;
  }
  terminals.clear();
  for (const [pid, managedProc] of processes) {
    managedProc.proc.kill();
  }
  processes.clear();
  processOutputBuffers.clear();
  cleanupAllTunnels();
  process.exit(0);
}

function startAiManagerInBackground(): void {
  if (aiManager || aiManagerInitPromise) return;

  aiManagerInitPromise = (async () => {
    try {
      const manager = await createAiManager();
      if (shuttingDown) {
        await manager.destroy();
        return;
      }

      aiManager = manager;
      aiManager.subscribe((backend, event) => {
        emitAppEvent({
          v: 1,
          id: `evt-${Date.now()}`,
          ns: "ai",
          action: "event",
          payload: { ...event, backend },
        });
      });
    } catch (error) {
      if (DEBUG_MODE) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ai] background init failed: ${message}`);
      }
    } finally {
      aiManagerInitPromise = null;
    }
  })();
}

async function connectWebSocketV2(): Promise<void> {
  const gatewayUrl = currentPrimaryGateway;
  if (!currentSessionPassword) {
    throw new Error("missing password for websocket connect");
  }

  console.log(`Connecting to gateway ${gatewayUrl}...`);
  activeGatewayUrl = gatewayUrl;

  const transport = new V2SessionTransport({
    gatewayUrl,
    password: currentSessionPassword,
    sessionSecret: currentSessionPassword,
    generation: currentReattachGeneration,
    role: "cli",
    debugLog: DEBUG_MODE ? debugLog : undefined,
    handlers: {
      onSystemMessage: async (message) => {
        if (message.type === "connected") return;

        if (message.type === "peer_connected") {
          console.log("App connected!\n");
          void publishDiscoveredPorts(true);
          return;
        }

        if (message.type === "peer_disconnected") {
          console.log("App disconnected. Waiting for reconnect window.\n");
          stopPortSync();
          return;
        }

        if (message.type === "app_disconnected") {
          if (message.reconnectDeadline) {
            console.log(`[session] app disconnected, waiting until ${new Date(message.reconnectDeadline).toISOString()}`);
          }
          return;
        }

        if (message.type === "close_connection") {
          const reason = message.reason || "expired";
          console.log(`[session] closed by gateway: ${reason}`);
          if (reason === "session ended from app") {
            console.log("[session] Run `npx lunel-cli` again and scan the new QR code to reconnect.");
          }
          gracefulShutdown();
        }
      },
      onProtocolRequest: async (message) => {
        return await processMessage(message);
      },
      onProtocolResponse: async () => {
        // CLI does not currently await app responses outside request/reply routing.
      },
      onProtocolEvent: async (message) => {
        await processMessage(message);
      },
      onClose: (reason) => {
        if (shuttingDown) return;
        stopPortSync();
        cleanupAllTunnels();
        activeV2Transport = null;
        setTimeout(() => {
          if (shuttingDown) return;
          void handleConnectionDrop(reason);
        }, 50);
      },
    },
  });

  activeV2Transport = transport;
  await transport.connect();
  startPortSync();
  console.log("Connected to gateway (single secure session).\n");
}

async function handleConnectionDrop(reason: string): Promise<void> {
  if (shuttingDown) return;
  console.log(`\nDisconnected: ${reason}`);

  if (!currentSessionPassword) {
    console.error("No reconnect password available. Exiting.");
    gracefulShutdown();
    return;
  }

  let attempt = 0;
  while (!shuttingDown) {
    attempt += 1;
    const base = Math.min(250 * 2 ** (attempt - 1), 30_000);
    const delayMs = Math.round(base * (0.8 + Math.random() * 0.4));

    try {
      const reattach = await claimReattach(currentSessionPassword);
      currentPrimaryGateway = reattach.proxyUrl;
      currentReattachGeneration = reattach.generation;
      await connectWebSocketV2();
      debugLog(`[reconnect] connected via ${activeGatewayUrl}`);
      return;
    } catch (err) {
      if (DEBUG_MODE) console.error(`[reconnect] attempt ${attempt} failed: ${(err as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main(): Promise<void> {
  if (SHOW_HELP) {
    printHelp();
    return;
  }

  console.log("Lunel CLI v" + VERSION);
  console.log("=".repeat(20) + "\n");
  if (EXTRA_PORTS.length > 0) {
    console.log(`Extra ports enabled: ${EXTRA_PORTS.join(", ")}`);
  }

  let usedSavedSession = false;
  try {
    const cliConfig = await getCliConfig();
    const savedSession = getSavedSessionForRoot(cliConfig, ROOT_DIR);
    debugLog("Checking PTY runtime...");
    const ptyBinaryPath = await ensurePtyBinaryReady();
    if (ptyBinaryPath) {
      debugLog("PTY runtime ready.\n");
    } else {
      debugLog(`PTY runtime unsupported on ${os.platform()}/${os.arch()}. Skipping prefetch.\n`);
    }

    // Start AI backends in the background so missing or slow AI runtimes never
    // block QR/session startup for the rest of the CLI.
    startAiManagerInBackground();

    let sessionCodeToUse: string | null = null;
    let sessionPasswordToUse: string;

    if (!FORCE_NEW_CODE && savedSession) {
      console.log(`Using saved session for ${ROOT_DIR}`);
      displaySavedSessionNotice();
      sessionCodeToUse = savedSession.sessionCode;
      sessionPasswordToUse = savedSession.sessionPassword;
      usedSavedSession = true;
    } else {
      if (FORCE_NEW_CODE && savedSession?.sessionPassword) {
        await revokePassword(savedSession.sessionPassword);
        await clearSavedSessionForRoot();
      }
      const qr = await createQrCode();
      currentSessionCode = qr.code;
      displayQR(qr.code);
      const assembled = await assembleWithCode(qr.code);
      sessionCodeToUse = assembled.code;
      sessionPasswordToUse = assembled.password;
      await saveSessionForRoot(sessionCodeToUse, sessionPasswordToUse);
    }

    currentSessionCode = sessionCodeToUse;
    currentSessionPassword = sessionPasswordToUse;
    if (usedSavedSession) {
      const reattach = await claimReattach(sessionPasswordToUse);
      currentPrimaryGateway = reattach.proxyUrl;
      currentReattachGeneration = reattach.generation;
    } else {
      currentPrimaryGateway = await getAssignedProxyUrl(sessionPasswordToUse);
      currentReattachGeneration = null;
    }
    activeGatewayUrl = currentPrimaryGateway;

    await connectWebSocketV2();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      usedSavedSession &&
      /invalid|revoked|not found|expired|password invalid|password revoked/i.test(message)
    ) {
      await clearSavedSessionForRoot().catch(() => {});
    }
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
      if (DEBUG_MODE && error.stack) console.error(error.stack);
    } else {
      console.error("An unexpected error occurred");
    }
    process.exit(1);
  }
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

main();
