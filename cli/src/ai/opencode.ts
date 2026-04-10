// OpenCode AI provider — wraps @opencode-ai/sdk.
// All logic extracted verbatim from cli/src/index.ts AI handlers section.

import * as crypto from "crypto";
import * as fs from "fs/promises";
import { spawnSync } from "child_process";
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import type {
  AgentInfo,
  AIProvider,
  AiEventEmitter,
  CodexPromptOptions,
  FileAttachment,
  ModelSelector,
  MessageInfo,
  ProviderInfo,
  SessionInfo,
  ShareInfo,
} from "./interface.js";

const VERBOSE_AI_LOGS = process.env.LUNEL_DEBUG === "1" || process.env.LUNEL_DEBUG_AI === "1";

const SSE_BACKOFF_INITIAL_MS = 500;
const SSE_BACKOFF_CAP_MS = 30_000;
const SSE_MAX_RETRIES = 20;
const OPENCODE_CONFIG_PATH = `${process.env.HOME || ""}/.config/opencode/opencode.json`;

interface OpenCodeConfigDefaults extends Record<string, unknown> {
  agent?: string;
  model?: ModelSelector;
  variant?: string;
}

interface RequestInitWithDuplex extends RequestInit {
  duplex?: "half";
}

function redactSensitive(input: unknown): string {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text
    .replace(/([A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,})/g, "[redacted_jwt]")
    .replace(/(password|token|authorization|resumeToken|x-manager-password)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted_secret]");
}

function requireData<T>(response: { data?: T; error?: unknown }, label: string): T {
  if (!response.data) {
    const errMsg = response.error
      ? (typeof response.error === "string" ? response.error : JSON.stringify(response.error))
      : `${label} returned no data`;
    console.error(
      `[ai] ${label} failed:`,
      redactSensitive(errMsg),
      "raw response:",
      redactSensitive(JSON.stringify(response).substring(0, 500))
    );
    throw new Error(errMsg);
  }
  return response.data;
}

function listManagedOpenCodeServerPids(): number[] {
  if (process.platform === "win32") {
    return [];
  }

  const result = spawnSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf-8" });
  return (result.stdout || "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .filter((match) => Number(match[2]) === process.pid && match[3]?.includes("opencode") && match[3]?.includes("serve"))
    .map((match) => Number(match[1]))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function listAllOpenCodeServePids(): number[] {
  if (process.platform === "win32") {
    return [];
  }

  const result = spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf-8" });
  return (result.stdout || "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .filter((match) => match[2]?.includes("opencode") && match[2]?.includes("serve"))
    .map((match) => Number(match[1]))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function listChildPids(pid: number): number[] {
  if (process.platform === "win32") {
    return [];
  }

  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf-8" });
  return (result.stdout || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function listProcessTreePids(rootPid: number, visited = new Set<number>()): number[] {
  if (visited.has(rootPid)) {
    return [];
  }
  visited.add(rootPid);
  const children = listChildPids(rootPid).flatMap((childPid) => listProcessTreePids(childPid, visited));
  return [...children, rootPid];
}

function killManagedOpenCodeServerProcesses(): void {
  const pids = listManagedOpenCodeServerPids().flatMap((pid) => listProcessTreePids(pid));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (pids.length > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function killProcessList(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (pids.length > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export class OpenCodeProvider implements AIProvider {
  private client: ReturnType<typeof createOpencodeClient> | null = null;
  private server: Awaited<ReturnType<typeof createOpencodeServer>> | null = null;
  private serverAbortController: AbortController | null = null;
  private authHeader: string | null = null;
  private sseLoopRunning = false;
  private managedServerPids = new Set<number>();
  private lastActiveSessionId: string | null = null;
  private shuttingDown = false;
  private emitter: AiEventEmitter | null = null;
  private knownPendingPermissionIds = new Set<string>();
  private knownPendingQuestionIds = new Set<string>();
  private configDefaults: OpenCodeConfigDefaults = {};

  async init(): Promise<void> {
    const opencodeUsername = "lunel";
    const opencodePassword = crypto.randomBytes(32).toString("base64url");
    const authHeader = `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}`;

    process.env.OPENCODE_SERVER_USERNAME = opencodeUsername;
    process.env.OPENCODE_SERVER_PASSWORD = opencodePassword;
    this.authHeader = authHeader;
    this.serverAbortController = new AbortController();
    const existingServePids = new Set(listAllOpenCodeServePids());

    if (VERBOSE_AI_LOGS) console.log("Starting OpenCode...");
    this.server = await createOpencodeServer({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 15000,
      signal: this.serverAbortController.signal,
    });
    this.managedServerPids = new Set(listAllOpenCodeServePids().filter((pid) => !existingServePids.has(pid)));
    if (VERBOSE_AI_LOGS) console.log(`OpenCode server listening on ${this.server.url}`);

    const normalizedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<globalThis.Response> => {
      if (typeof input === "string" || input instanceof URL) {
        return await globalThis.fetch(input, init);
      }

      const request = input;
      const requestInit: RequestInitWithDuplex = {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        redirect: request.redirect,
        ...(request.body ? { body: request.body, duplex: "half" as const } : {}),
        ...(init || {}),
      };
      return await globalThis.fetch(request.url, requestInit);
    };

    this.client = createOpencodeClient({
      baseUrl: this.server.url,
      headers: { Authorization: authHeader },
      fetch: normalizedFetch,
    });
    this.configDefaults = await this.loadConfigDefaults();
    if (VERBOSE_AI_LOGS) console.log("OpenCode ready.\n");
  }

  async destroy(): Promise<void> {
    this.shuttingDown = true;
    this.sseLoopRunning = false;
    this.emitter = null;
    this.authHeader = null;
    this.lastActiveSessionId = null;
    this.knownPendingPermissionIds.clear();
    this.knownPendingQuestionIds.clear();

    const controller = this.serverAbortController;
    this.serverAbortController = null;
    controller?.abort();

    const server = this.server;
    this.server = null;
    this.client = null;

    if (server) {
      try {
        await Promise.resolve(server.close());
      } catch {
        // best effort shutdown
      }
    }

    const managedPids = Array.from(this.managedServerPids).flatMap((pid) => listProcessTreePids(pid));
    this.managedServerPids.clear();
    killProcessList(managedPids);
    killManagedOpenCodeServerProcesses();
  }

  subscribe(emitter: AiEventEmitter): () => void {
    this.emitter = emitter;
    this.shuttingDown = false;
    if (!this.sseLoopRunning) {
      this.sseLoopRunning = true;
      void this.runSseLoop().finally(() => {
        this.sseLoopRunning = false;
      });
    }
    return () => {
      this.emitter = null;
    };
  }

  setActiveSession(sessionId: string): void {
    this.lastActiveSessionId = sessionId;
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  async createSession(title?: string): Promise<{ session: SessionInfo }> {
    if (VERBOSE_AI_LOGS) console.log("[ai] createSession called");
    try {
      const response = await this.client!.session.create({ body: { title } });
      if (VERBOSE_AI_LOGS) {
        console.log(
          "[ai] createSession response ok:",
          !!response.data,
          "error:",
          response.error ? redactSensitive(JSON.stringify(response.error).substring(0, 200)) : "none"
        );
      }
      return { session: requireData(response, "session.create") };
    } catch (err) {
      console.error("[ai] createSession exception:", redactSensitive((err as Error).message));
      throw err;
    }
  }

  async listSessions(): Promise<{ sessions: unknown }> {
    if (VERBOSE_AI_LOGS) console.log("[ai] listSessions called");
    try {
      const response = await this.client!.session.list();
      const data = requireData(response, "session.list");
      if (VERBOSE_AI_LOGS) {
        console.log("[ai] listSessions returned", Array.isArray(data) ? data.length : typeof data, "sessions");
      }
      return { sessions: data };
    } catch (err) {
      console.error("[ai] listSessions exception:", (err as Error).message);
      throw err;
    }
  }

  async getSession(id: string): Promise<{ session: SessionInfo }> {
    const response = await this.client!.session.get({ path: { id } });
    return { session: requireData(response, "session.get") };
  }

  async deleteSession(id: string): Promise<{ deleted: boolean }> {
    const response = await this.client!.session.delete({ path: { id } });
    return { deleted: Boolean(requireData(response, "session.delete")) };
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async getMessages(sessionId: string): Promise<{ messages: MessageInfo[] }> {
    if (VERBOSE_AI_LOGS) console.log("[ai] getMessages called");
    try {
      const response = await this.client!.session.messages({ path: { id: sessionId } });
      const raw = requireData(response, "session.messages") as Array<{
        info: Record<string, unknown>;
        parts: unknown[];
      }>;
      const messages = raw.map((m) => ({
        id: m.info.id as string,
        role: m.info.role as string,
        parts: m.parts || [],
        time: m.info.time,
      }));
      if (VERBOSE_AI_LOGS) console.log("[ai] getMessages returned", messages.length, "messages");
      return { messages };
    } catch (err) {
      console.error("[ai] getMessages exception:", (err as Error).message);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  async prompt(
    sessionId: string,
    text: string,
    model?: ModelSelector,
    agent?: string,
    files: FileAttachment[] = [],
    codexOptions?: CodexPromptOptions,
  ): Promise<{ ack: true }> {
    void codexOptions;
    if (sessionId) this.lastActiveSessionId = sessionId;

    if (VERBOSE_AI_LOGS) {
      console.log("[ai] prompt called", {
        hasSessionId: Boolean(sessionId),
        model: redactSensitive(JSON.stringify(model || {})),
        hasAgent: Boolean(agent),
        textLength: typeof text === "string" ? text.length : 0,
      });
    }

    // Fire-and-forget — results come back through the SSE event stream.
    // Prefer the async prompt endpoint so long-running turns do not get tied
    // to the request lifecycle the way the basic prompt route can be.
    this.sendPromptAsync(sessionId, text, model, agent, files).catch((err: unknown) => {
      console.error("[ai] prompt error:", (err as Error).message);
      this.emitter?.({
        type: "prompt_error",
        properties: { sessionId, error: (err as Error).message },
      });
    });

    return { ack: true };
  }

  async abort(sessionId: string): Promise<Record<string, never>> {
    await this.client!.session.abort({ path: { id: sessionId } });
    return {};
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  async agents(): Promise<{ agents: AgentInfo[] }> {
    if (VERBOSE_AI_LOGS) console.log("[ai] getAgents called");
    try {
      const response = await this.client!.app.agents();
      const data = requireData(response, "app.agents");
      const agents = this.toAgentInfoList(data);
      if (VERBOSE_AI_LOGS) {
        console.log("[ai] getAgents returned:", redactSensitive(JSON.stringify(agents).substring(0, 300)));
      }
      return { agents };
    } catch (err) {
      console.error("[ai] getAgents exception:", (err as Error).message);
      throw err;
    }
  }

  async providers(): Promise<ProviderInfo> {
    if (VERBOSE_AI_LOGS) console.log("[ai] getProviders called");
    try {
      const response = await this.client!.config.providers();
      const data = requireData(response, "config.providers") as {
        providers: unknown[];
        default: Record<string, string>;
      };
      if (VERBOSE_AI_LOGS) {
        console.log(
          "[ai] getProviders returned",
          data.providers?.length,
          "providers, defaults:",
          redactSensitive(JSON.stringify(data.default))
        );
      }
      return {
        providers: data.providers,
        default: data.default,
        configDefaults: this.configDefaults,
      };
    } catch (err) {
      console.error("[ai] getProviders exception:", (err as Error).message);
      throw err;
    }
  }

  private async loadConfigDefaults(): Promise<OpenCodeConfigDefaults> {
    try {
      const raw = await fs.readFile(OPENCODE_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const defaults: OpenCodeConfigDefaults = {};
      const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
      if (model.includes("/")) {
        const [providerID, modelID] = model.split("/");
        if (providerID && modelID) {
          defaults.model = { providerID, modelID };
        }
      }

      const agentConfig = parsed.agent && typeof parsed.agent === "object"
        ? parsed.agent as Record<string, unknown>
        : null;
      if (agentConfig) {
        const [firstAgentId, firstAgentValue] = Object.entries(agentConfig)[0] || [];
        if (firstAgentId) {
          defaults.agent = firstAgentId;
        }
        if (firstAgentValue && typeof firstAgentValue === "object") {
          const variant = (firstAgentValue as Record<string, unknown>).variant;
          if (typeof variant === "string" && variant.trim()) {
            defaults.variant = variant.trim();
          }
        }
      }

      return defaults;
    } catch {
      return {};
    }
  }

  private toAgentInfoList(input: unknown): AgentInfo[] {
    if (!Array.isArray(input)) {
      return [];
    }

    return input
      .map((value) => this.toAgentInfo(value))
      .filter((value): value is AgentInfo => Boolean(value))
      .filter((agent) => {
        const id = agent.id.toLowerCase();
        const mode = (agent.mode || "").toLowerCase();
        if (mode === "subagent") return false;
        if (["compaction", "summary", "title"].includes(id)) return false;
        if (id.startsWith("ui5-") || id.startsWith("cap-")) return false;
        return true;
      });
  }

  private toAgentInfo(input: unknown): AgentInfo | undefined {
    if (!input || typeof input !== "object") {
      return undefined;
    }

    const record = input as Record<string, unknown>;
    const rawId = typeof record.id === "string" ? record.id.trim() : "";
    const rawName = typeof record.name === "string" ? record.name.trim() : "";
    const id = rawId || rawName;
    if (!id) {
      return undefined;
    }

    const description = typeof record.description === "string"
      ? record.description.trim()
      : "";
    const mode = typeof record.mode === "string"
      ? record.mode.trim()
      : "";

    return {
      id,
      name: rawName || id,
      ...(description ? { description } : {}),
      ...(mode ? { mode } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  async setAuth(providerId: string, key: string): Promise<Record<string, never>> {
    await this.client!.auth.set({
      path: { id: providerId },
      body: { type: "api", key },
    });
    return {};
  }

  // -------------------------------------------------------------------------
  // Session operations
  // -------------------------------------------------------------------------

  async command(sessionId: string, command: string, args: string): Promise<{ result: unknown }> {
    const response = await this.client!.session.command({
      path: { id: sessionId },
      body: { command, arguments: args },
    });
    return { result: response.data ?? null };
  }

  async revert(sessionId: string, messageId: string): Promise<Record<string, never>> {
    await this.client!.session.revert({
      path: { id: sessionId },
      body: { messageID: messageId },
    });
    return {};
  }

  async unrevert(sessionId: string): Promise<Record<string, never>> {
    await this.client!.session.unrevert({ path: { id: sessionId } });
    return {};
  }

  async share(sessionId: string): Promise<{ share: ShareInfo }> {
    const response = await this.client!.session.share({ path: { id: sessionId } });
    return { share: requireData(response, "session.share") };
  }

  async permissionReply(
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<Record<string, never>> {
    await this.client!.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response },
    });
    return {};
  }

  async questionReply(
    sessionId: string,
    questionId: string,
    answers: string[][],
  ): Promise<Record<string, never>> {
    await this.fetchOpenCodeJson(`/question/${encodeURIComponent(questionId)}/reply`, {
      method: "POST",
      body: { answers },
    });
    this.knownPendingQuestionIds.delete(questionId);
    this.emitter?.({ type: "question.replied", properties: { sessionID: sessionId, requestID: questionId, answers } });
    return {};
  }

  async questionReject(
    sessionId: string,
    questionId: string,
  ): Promise<Record<string, never>> {
    await this.fetchOpenCodeJson(`/question/${encodeURIComponent(questionId)}/reject`, {
      method: "POST",
    });
    this.knownPendingQuestionIds.delete(questionId);
    this.emitter?.({ type: "question.rejected", properties: { sessionID: sessionId, requestID: questionId } });
    return {};
  }

  // -------------------------------------------------------------------------
  // SSE event loop (private)
  // -------------------------------------------------------------------------

  private async runSseLoop(): Promise<void> {
    let attempt = 0;

    const backoffMs = (n: number): number => {
      const base = Math.min(SSE_BACKOFF_INITIAL_MS * 2 ** n, SSE_BACKOFF_CAP_MS);
      const jitter = Math.random() * base * 0.3;
      return Math.round(base + jitter);
    };

    while (!this.shuttingDown) {
      try {
        // On reconnect, verify the active session is still alive.
        if (attempt > 0 && this.lastActiveSessionId) {
          const checkResp = await this.client!.session.get({
            path: { id: this.lastActiveSessionId },
          });
          if (checkResp.error) {
            console.warn(`[sse] OpenCode session ${this.lastActiveSessionId} was garbage-collected. Notifying app.`);
            const gcSessionId = this.lastActiveSessionId;
            this.lastActiveSessionId = null;
            this.emitter?.({ type: "session_gc", properties: { sessionId: gcSessionId } });
          } else {
            console.log(`[sse] Active session ${this.lastActiveSessionId} still valid.`);
          }
        }

        if (attempt > 0) {
          await this.reconcileOpenCodeState();
        }

        const events = await this.client!.event.subscribe();
        if (attempt > 0) {
          console.log(`[sse] reconnected after ${attempt} attempt(s)`);
        }
        attempt = 0;

        for await (const raw of events.stream) {
          if (this.shuttingDown) return;

          // Handle two SSE payload shapes across SDK versions:
          //   { type, properties, ... }
          //   { payload: { type, properties, ... }, directory: "..." }
          const parsed = raw as any;
          const base =
            parsed?.payload && typeof parsed.payload === "object"
              ? parsed.payload
              : parsed;

          if (!base || typeof base.type !== "string") {
            console.warn("[sse] Dropped malformed event:", redactSensitive(JSON.stringify(parsed).substring(0, 200)));
            continue;
          }

          if (base.type !== "server.heartbeat") {
            console.log("[sse]", base.type);
          }
          this.trackPermissionEvent(base.type, base.properties || {});
          this.emitter?.({ type: base.type, properties: base.properties || {} });
        }

        console.log("[sse] Event stream ended, reconnecting...");
      } catch (err) {
        if (this.shuttingDown) return;
        attempt++;
        const delay = backoffMs(attempt - 1);
        console.error(
          `[sse] Stream error (attempt ${attempt}/${SSE_MAX_RETRIES}): ${(err as Error).message}. Retrying in ${delay}ms`
        );

        if (attempt >= SSE_MAX_RETRIES) {
          console.error("[sse] Max retries reached. Sending error event to app and giving up.");
          this.emitter?.({
            type: "sse_dead",
            properties: { error: (err as Error).message, attempts: attempt },
          });
          return;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async sendPromptAsync(
    sessionId: string,
    text: string,
    model?: ModelSelector,
    agent?: string,
    files: FileAttachment[] = [],
  ): Promise<void> {
    const server = this.server;
    const authHeader = this.authHeader;
    if (!server || !authHeader) {
      throw new Error("OpenCode server is not ready");
    }

    const url = new URL(`/session/${encodeURIComponent(sessionId)}/prompt_async`, server.url);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        parts: [
          ...(text.trim().length > 0 ? [{ type: "text", text }] : []),
          ...files,
        ],
        ...(model ? {
          model: {
            providerID: model.providerID,
            modelID: model.modelID,
          },
        } : {}),
        ...(model?.variant ? { variant: model.variant } : {}),
        ...(agent ? { agent } : {}),
      }),
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // ignore detail read failures
      }
      const suffix = detail.trim().length > 0 ? `: ${detail.trim()}` : "";
      throw new Error(`OpenCode prompt_async failed (${response.status})${suffix}`);
    }
  }

  private async reconcileOpenCodeState(): Promise<void> {
    await Promise.allSettled([
      this.refreshSessionsMetadata(),
      this.refreshPendingPermissions(),
      this.refreshPendingQuestions(),
      this.refreshSessionStatuses(),
    ]);
  }

  private async refreshSessionsMetadata(): Promise<void> {
    const response = await this.client!.session.list();
    const sessions = Array.isArray(response.data) ? response.data : [];
    for (const session of sessions) {
      const info = this.asRecord(session);
      const id = this.readString(info.id);
      if (!id) continue;
      this.emitter?.({
        type: "session.updated",
        properties: { info },
      });
    }
  }

  private async refreshPendingPermissions(): Promise<void> {
    const permissionApi = (this.client as unknown as {
      permission?: {
        list: () => Promise<{ data?: unknown[]; error?: unknown }>;
      };
    })?.permission;
    if (!permissionApi?.list) {
      return;
    }

    const response = await permissionApi.list();
    const data = Array.isArray(response.data) ? response.data : [];
    const nextIds = new Set<string>();

    for (const entry of data) {
      const permission = this.asRecord(entry);
      const id = this.readString(permission.id);
      if (!id) continue;
      nextIds.add(id);

      if (this.knownPendingPermissionIds.has(id)) {
        continue;
      }

      this.knownPendingPermissionIds.add(id);
      this.emitter?.({
        type: "permission.updated",
        properties: {
          id,
          sessionID: this.readString(permission.sessionID) ?? this.readString(permission.sessionId),
          messageID: this.readString(this.asRecord(permission.tool).messageID),
          callID: this.readString(this.asRecord(permission.tool).callID),
          type: this.readString(permission.permission) ?? "permission",
          title: this.readString(permission.title)
            ?? this.readString(permission.permission)
            ?? "Permission requested",
          metadata: permission.metadata && typeof permission.metadata === "object"
            ? permission.metadata as Record<string, unknown>
            : permission,
        },
      });
    }

    for (const id of Array.from(this.knownPendingPermissionIds)) {
      if (nextIds.has(id)) continue;
      this.knownPendingPermissionIds.delete(id);
      this.emitter?.({ type: "permission.replied", properties: { permissionId: id } });
    }
  }

  private async refreshPendingQuestions(): Promise<void> {
    const data = await this.fetchOpenCodeJson("/question", {
      method: "GET",
    });
    const questions = Array.isArray(data) ? data : [];
    const nextIds = new Set<string>();

    for (const entry of questions) {
      const question = this.asRecord(entry);
      const id = this.readString(question.id);
      const sessionID = this.readString(question.sessionID) ?? this.readString(question.sessionId);
      if (!id || !sessionID) continue;
      nextIds.add(id);

      if (this.knownPendingQuestionIds.has(id)) {
        continue;
      }

      this.knownPendingQuestionIds.add(id);
      this.emitter?.({
        type: "question.asked",
        properties: {
          id,
          sessionID,
          questions: Array.isArray(question.questions) ? question.questions : [],
          tool: typeof question.tool === "object" && question.tool !== null ? question.tool as Record<string, unknown> : undefined,
        },
      });
    }

    for (const id of Array.from(this.knownPendingQuestionIds)) {
      if (nextIds.has(id)) continue;
      this.knownPendingQuestionIds.delete(id);
    }
  }

  private async fetchOpenCodeJson(
    pathname: string,
    options: {
      method?: "GET" | "POST";
      body?: Record<string, unknown>;
    } = {},
  ): Promise<unknown> {
    const server = this.server;
    const authHeader = this.authHeader;
    if (!server || !authHeader) {
      throw new Error("OpenCode server is not ready");
    }

    const url = new URL(pathname, server.url);
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: authHeader,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // ignore detail read failures
      }
      const suffix = detail.trim().length > 0 ? `: ${detail.trim()}` : "";
      throw new Error(`OpenCode request failed (${response.status})${suffix}`);
    }

    return response.json().catch(() => null);
  }

  private async refreshSessionStatuses(): Promise<void> {
    const server = this.server;
    const authHeader = this.authHeader;
    if (!server || !authHeader) {
      return;
    }

    const url = new URL("/session/status", server.url);
    const response = await fetch(url, {
      headers: {
        Authorization: authHeader,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      return;
    }

    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") {
      return;
    }

    for (const [sessionId, status] of Object.entries(payload)) {
      this.emitter?.({
        type: "session.status",
        properties: {
          sessionID: sessionId,
          status: status as Record<string, unknown>,
        },
      });
    }
  }

  private trackPermissionEvent(type: string, properties: Record<string, unknown>): void {
    if (type === "permission.updated") {
      const id = this.readString(properties.id);
      if (id) {
        this.knownPendingPermissionIds.add(id);
      }
      return;
    }

    if (type === "permission.replied") {
      const id = this.readString(properties.permissionId)
        ?? this.readString(properties.requestID)
        ?? this.readString(properties.id);
      if (id) {
        this.knownPendingPermissionIds.delete(id);
      }
    }

    if (type === "question.asked") {
      const id = this.readString(properties.id);
      if (id) {
        this.knownPendingQuestionIds.add(id);
      }
      return;
    }

    if (type === "question.replied" || type === "question.rejected") {
      const id = this.readString(properties.requestID)
        ?? this.readString(properties.questionId)
        ?? this.readString(properties.id);
      if (id) {
        this.knownPendingQuestionIds.delete(id);
      }
    }
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  private readString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}
