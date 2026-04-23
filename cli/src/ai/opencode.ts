// OpenCode AI provider — wraps @opencode-ai/sdk.
// All logic extracted verbatim from cli/src/index.ts AI handlers section.

import * as crypto from "crypto";
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import type {
  AIProvider,
  AiBackendCapabilities,
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeToolOutput(output: string, metadata: Record<string, unknown>): string {
  const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  if (attachments.length === 0) return output;

  const attachmentLines = attachments
    .map((entry) => {
      const file = asRecord(entry);
      const filename = readString(file.filename)
        ?? readString(file.path)
        ?? readString(file.url)
        ?? "attachment";
      return `- ${filename}`;
    })
    .filter((line) => line.trim().length > 0);

  if (attachmentLines.length === 0) return output;
  if (!output.trim()) {
    return `Attachments:\n${attachmentLines.join("\n")}`;
  }
  return `${output}\n\nAttachments:\n${attachmentLines.join("\n")}`;
}

function buildPatchSummary(part: Record<string, unknown>): string {
  const hash = readString(part.hash);
  const files = Array.isArray(part.files)
    ? part.files.map((value) => String(value)).filter((value) => value.trim().length > 0)
    : [];
  const lines: string[] = [];
  if (hash) lines.push(`Patch hash: ${hash}`);
  if (files.length > 0) {
    lines.push("Files:");
    for (const file of files) lines.push(`- ${file}`);
  }
  return lines.join("\n");
}

function normalizeOpenCodePart(part: unknown): Record<string, unknown> {
  const raw = asRecord(part);
  const type = readString(raw.type);
  if (!type) return raw;

  if (type === "tool") {
    const tool = readString(raw.tool) ?? "tool";
    const state = asRecord(raw.state);
    const status = readString(state.status) ?? "running";
    const metadata = asRecord(state.metadata ?? raw.metadata);
    const normalized: Record<string, unknown> = {
      ...raw,
      type: "tool",
      toolName: tool,
      name: tool,
      state: status,
      input: asRecord(state.input),
      metadata,
    };

    const title = readString(state.title);
    if (title) normalized.title = title;

    const rawText = readString(state.raw);
    if (rawText) normalized.raw = rawText;

    const time = asRecord(state.time);
    if (Object.keys(time).length > 0) {
      normalized.time = time;
    }

    if (status === "completed") {
      const output = typeof state.output === "string" ? state.output : "";
      normalized.output = normalizeToolOutput(output, {
        ...metadata,
        attachments: state.attachments,
      });
    } else if (status === "error") {
      normalized.error = readString(state.error) ?? "Tool failed";
      const errorMessage = readString(state.error);
      if (errorMessage) normalized.output = errorMessage;
    }

    const attachments = Array.isArray(state.attachments) ? state.attachments : [];
    if (attachments.length > 0) {
      normalized.attachments = attachments.map((entry) => normalizeOpenCodePart(entry));
    }

    return normalized;
  }

  if (type === "step-start") {
    const snapshot = readString(raw.snapshot);
    return {
      ...raw,
      type: "step-start",
      title: snapshot ? `Step started · ${snapshot}` : "Step started",
    };
  }

  if (type === "step-finish") {
    const reason = readString(raw.reason);
    return {
      ...raw,
      type: "step-finish",
      title: reason ? `Step finished · ${reason}` : "Step finished",
    };
  }

  if (type === "patch") {
    return {
      ...raw,
      type: "file-change",
      title: "File changes",
      output: buildPatchSummary(raw),
    };
  }

  if (type === "subtask") {
    return {
      ...raw,
      type: "tool",
      toolName: "subtask",
      name: "subtask",
      state: "completed",
      input: {
        prompt: readString(raw.prompt) ?? "",
        description: readString(raw.description) ?? "",
        agent: readString(raw.agent) ?? "",
        ...(readString(raw.command) ? { command: readString(raw.command) } : {}),
      },
      output: readString(raw.description) ?? readString(raw.prompt) ?? "Subtask requested",
    };
  }

  if (type === "agent") {
    const name = readString(raw.name) ?? "Agent";
    return {
      ...raw,
      type: "step-start",
      title: `Agent · ${name}`,
    };
  }

  if (type === "retry") {
    const attempt = raw.attempt;
    const error = asRecord(raw.error);
    const message = readString(error.message) ?? "Retry requested";
    return {
      ...raw,
      type: "tool",
      toolName: "retry",
      name: "retry",
      state: "error",
      input: {
        attempt,
      },
      error: message,
      output: message,
    };
  }

  if (type === "compaction") {
    const auto = raw.auto === true;
    const overflow = raw.overflow === true;
    return {
      ...raw,
      type: "step-start",
      title: `Context compacted${auto ? " · auto" : ""}${overflow ? " · overflow" : ""}`,
    };
  }

  if (type === "snapshot") {
    return {
      ...raw,
      type: "step-start",
      title: "Workspace snapshot",
    };
  }

  return raw;
}

function normalizeOpenCodeMessage(message: {
  info: Record<string, unknown>;
  parts: unknown[];
}): MessageInfo {
  return {
    id: message.info.id as string,
    role: message.info.role as string,
    parts: (message.parts || []).map((part) => normalizeOpenCodePart(part)),
    time: message.info.time,
  };
}

function normalizePermissionProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const tool = asRecord(properties.tool);
  const metadata = properties.metadata && typeof properties.metadata === "object"
    ? properties.metadata as Record<string, unknown>
    : properties;

  return {
    id: readString(properties.id),
    sessionID: readString(properties.sessionID) ?? readString(properties.sessionId),
    messageID: readString(properties.messageID) ?? readString(tool.messageID),
    callID: readString(properties.callID) ?? readString(tool.callID),
    type: readString(properties.type) ?? readString(properties.permission) ?? "permission",
    title: readString(properties.title)
      ?? readString(properties.permission)
      ?? "Permission requested",
    metadata,
  };
}

function normalizeOpenCodeEvent(event: { type: string; properties: Record<string, unknown> }): { type: string; properties: Record<string, unknown> } {
  const { type, properties } = event;

  if (type === "message.part.updated") {
    return {
      type,
      properties: {
        ...properties,
        part: normalizeOpenCodePart(properties.part),
      },
    };
  }

  if (type === "permission.updated" || type === "permission.asked") {
    return {
      type: "permission.updated",
      properties: normalizePermissionProperties(properties),
    };
  }

  if (type === "permission.replied") {
    return {
      type: "permission.replied",
      properties: {
        sessionID: readString(properties.sessionID) ?? readString(properties.sessionId),
        permissionId: readString(properties.permissionID)
          ?? readString(properties.requestID)
          ?? readString(properties.permissionId)
          ?? readString(properties.id),
        response: readString(properties.response) ?? readString(properties.reply),
      },
    };
  }

  return event;
}

export class OpenCodeProvider implements AIProvider {
  readonly capabilities: AiBackendCapabilities = {
    setAuth: true,
    command: true,
    revert: true,
    unrevert: true,
    share: true,
    permissionReply: true,
    questionReply: true,
    questionReject: true,
    fileAttachments: true,
  };

  private client: ReturnType<typeof createOpencodeClient> | null = null;
  private server: Awaited<ReturnType<typeof createOpencodeServer>> | null = null;
  private authHeader: string | null = null;
  private lastActiveSessionId: string | null = null;
  private shuttingDown = false;
  private emitter: AiEventEmitter | null = null;
  private knownPendingPermissionIds = new Set<string>();
  private knownPendingQuestionIds = new Set<string>();

  async init(): Promise<void> {
    const opencodeUsername = "lunel";
    const opencodePassword = crypto.randomBytes(32).toString("base64url");
    const authHeader = `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}`;

    process.env.OPENCODE_SERVER_USERNAME = opencodeUsername;
    process.env.OPENCODE_SERVER_PASSWORD = opencodePassword;
    this.authHeader = authHeader;

    if (VERBOSE_AI_LOGS) console.log("Starting OpenCode...");
    this.server = await createOpencodeServer({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 15000,
    });
    if (VERBOSE_AI_LOGS) console.log(`OpenCode server listening on ${this.server.url}`);

    this.client = createOpencodeClient({
      baseUrl: this.server.url,
      headers: { Authorization: authHeader },
    });
    if (VERBOSE_AI_LOGS) console.log("OpenCode ready.\n");
  }

  async destroy(): Promise<void> {
    this.shuttingDown = true;
    this.authHeader = null;
  }

  subscribe(emitter: AiEventEmitter): () => void {
    this.emitter = emitter;
    this.shuttingDown = false;
    // Run the SSE loop in the background — it will call emitter for each event.
    this.runSseLoop();
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
    const raw = response as { data?: unknown; error?: unknown };
    if (raw.error) {
      const errMsg = typeof raw.error === "string"
        ? raw.error
        : JSON.stringify(raw.error);
      throw new Error(errMsg);
    }
    // Treat any non-error delete response as success. Some SDK/runtime combos
    // return inconsistent boolean payloads despite successful deletion.
    return { deleted: true };
  }

  async renameSession(id: string, title: string): Promise<{ session: SessionInfo }> {
    const response = await this.client!.session.update({
      path: { id },
      body: { title },
    });
    return { session: requireData(response, "session.update") };
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
      const messages = raw.map((m) => normalizeOpenCodeMessage(m));
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

  async agents(): Promise<{ agents: unknown }> {
    if (VERBOSE_AI_LOGS) console.log("[ai] getAgents called");
    try {
      const response = await this.client!.app.agents();
      const data = requireData(response, "app.agents");
      if (VERBOSE_AI_LOGS) {
        console.log("[ai] getAgents returned:", redactSensitive(JSON.stringify(data).substring(0, 300)));
      }
      return { agents: data };
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
      return { providers: data.providers, default: data.default };
    } catch (err) {
      console.error("[ai] getProviders exception:", (err as Error).message);
      throw err;
    }
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
          const normalizedEvent = normalizeOpenCodeEvent({
            type: base.type,
            properties: base.properties || {},
          });
          this.trackPermissionEvent(normalizedEvent.type, normalizedEvent.properties || {});
          this.emitter?.(normalizedEvent);
        }

        console.log("[sse] Event stream ended, reconnecting...");
        attempt++;
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
        ...(model ? { model } : {}),
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
    await this.refreshBusySessionMessages();
  }

  private async refreshBusySessionMessages(): Promise<void> {
    const server = this.server;
    const authHeader = this.authHeader;
    if (!server || !authHeader) return;

    const statusUrl = new URL("/session/status", server.url);
    const statusResp = await fetch(statusUrl, {
      headers: { Authorization: authHeader, accept: "application/json" },
    }).catch(() => null);
    if (!statusResp?.ok) return;

    const payload = await statusResp.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return;

    for (const [sessionId, status] of Object.entries(payload)) {
      const statusObj = status as Record<string, unknown>;
      const statusType = typeof statusObj?.type === "string" ? statusObj.type.toLowerCase() : "";
      if (statusType !== "busy") continue;

      try {
        const response = await this.client!.session.messages({ path: { id: sessionId } });
        const raw = Array.isArray(response.data) ? response.data : [];

        for (const m of raw) {
          const msgObj = this.asRecord(m as Record<string, unknown>);
          const info = this.asRecord(msgObj.info as Record<string, unknown>);
          const parts = Array.isArray(msgObj.parts) ? msgObj.parts : [];
          const msgId = this.readString(info.id);
          if (!msgId) continue;

          this.emitter?.({ type: "message.updated", properties: { info } });

          for (const part of parts) {
            const partObj = normalizeOpenCodePart(part);
            this.emitter?.({
              type: "message.part.updated",
              properties: {
                part: { ...partObj, sessionID: sessionId, messageID: msgId },
                message: { sessionID: sessionId, id: msgId, role: info.role },
              },
            });
          }
        }
        console.log(`[sse] Re-synced messages for busy session ${sessionId} after reconnect`);
      } catch (err) {
        console.warn(`[sse] Failed to refresh messages for busy session ${sessionId}:`, (err as Error).message);
      }
    }
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
        properties: normalizePermissionProperties(permission),
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
      const id = readString(properties.id);
      if (id) {
        this.knownPendingPermissionIds.add(id);
      }
      return;
    }

    if (type === "permission.replied") {
      const id = readString(properties.permissionId)
        ?? readString(properties.requestID)
        ?? readString(properties.id);
      if (id) {
        this.knownPendingPermissionIds.delete(id);
      }
    }

    if (type === "question.asked") {
      const id = readString(properties.id);
      if (id) {
        this.knownPendingQuestionIds.add(id);
      }
      return;
    }

    if (type === "question.replied" || type === "question.rejected") {
      const id = readString(properties.requestID)
        ?? readString(properties.questionId)
        ?? readString(properties.id);
      if (id) {
        this.knownPendingQuestionIds.delete(id);
      }
    }
  }

  private readString(value: unknown): string | undefined {
    return readString(value);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return asRecord(value);
  }
}
