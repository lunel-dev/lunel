// Codex AI provider — spawns `codex app-server` and speaks JSON-RPC 2.0
// over stdin/stdout. Maps Codex's thread/turn model onto Lunel's AIProvider
// contract using the same thread/list + thread/read flow used by Remodex.

import * as crypto from "crypto";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
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

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcOutbound = JsonRpcRequest | JsonRpcResponse;

interface JsonRpcInbound {
  jsonrpc: "2.0";
  method: string;
  id?: number | string | null;
  params?: unknown;
}

interface CodexSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
  activeTurnId?: string;
  cwd?: string;
  messages: MessageInfo[];
}

interface ThreadListEntry {
  id: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  archived?: boolean;
  cwd?: string;
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingPermission {
  sessionId: string;
  requestId: number | string;
  method: string;
  messageId?: string;
  callId?: string;
}

type PartType = "text" | "reasoning" | "tool" | "file-change" | "step-start" | "step-finish";

const THREAD_LIST_SOURCE_KINDS = ["cli", "vscode", "appServer", "exec", "unknown"];
const DEBUG_MODE = process.env.LUNEL_DEBUG === "1" || process.env.LUNEL_DEBUG_AI === "1";

function joinStreamingText(previousText: string, nextChunk: string): string {
  if (!previousText) {
    return nextChunk;
  }

  if (nextChunk.startsWith(previousText)) {
    return nextChunk;
  }

  if (previousText.endsWith(nextChunk)) {
    return previousText;
  }

  const maxOverlap = Math.min(previousText.length, nextChunk.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previousText.slice(-overlap) === nextChunk.slice(0, overlap)) {
      return previousText + nextChunk.slice(overlap);
    }
  }

  return previousText + nextChunk;
}

export class CodexProvider implements AIProvider {
  private proc: ChildProcess | null = null;
  private shuttingDown = false;
  private emitter: AiEventEmitter | null = null;

  private nextId = 1;
  private pending = new Map<string, PendingRpc>();

  private sessions = new Map<string, CodexSession>();
  private deletedThreadIds = new Set<string>();
  private resumedThreadIds = new Set<string>();
  private pendingPermissionRequestIds = new Map<string, PendingPermission>();
  private assistantMessageIdByTurnId = new Map<string, string>();
  private partTextById = new Map<string, string>();

  async init(): Promise<void> {
    if (DEBUG_MODE) console.log("Starting Codex app-server...");

    const codexCommand = process.platform === "win32" ? "codex.cmd" : "codex";

    this.proc = spawn(codexCommand, ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
      shell: false,
      windowsHide: process.platform === "win32",
    });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.on("error", (err) => {
      console.error("[codex] Failed to start codex process:", err.message);
      this.emitter?.({ type: "sse_dead", properties: { error: err.message } });
    });

    this.proc.on("exit", (code) => {
      if (!this.shuttingDown) {
        const msg = `codex app-server exited with code ${code}`;
        console.error(`[codex] ${msg}`);
        this.emitter?.({ type: "sse_dead", properties: { error: msg } });
      }
    });

    await this.call("initialize", { clientInfo: { name: "lunel", version: "1.0" } });
    if (DEBUG_MODE) console.log("Codex ready.\n");
  }

  async destroy(): Promise<void> {
    this.shuttingDown = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex provider shutting down"));
    }
    this.pending.clear();
    this.sessions.clear();
    this.deletedThreadIds.clear();
    this.resumedThreadIds.clear();
    this.pendingPermissionRequestIds.clear();
    this.assistantMessageIdByTurnId.clear();
    this.partTextById.clear();
    this.proc?.stdin?.end();
    this.proc?.kill();
    this.proc = null;
  }

  subscribe(emitter: AiEventEmitter): () => void {
    this.emitter = emitter;
    return () => {
      this.emitter = null;
    };
  }

  async createSession(title?: string): Promise<{ session: SessionInfo }> {
    const result = await this.call("thread/start", { cwd: process.cwd() });
    const threadObject = this.extractThreadObject(result);
    const threadId = this.extractThreadId(threadObject);
    if (!threadId) {
      throw new Error("thread/start response missing threadId");
    }

    const threadTitle = this.extractThreadTitle(threadObject) || title || "Conversation";
    const session = this.upsertSession({
      id: threadId,
      title: threadTitle,
      createdAt: this.extractCreatedAt(threadObject) ?? Date.now(),
      updatedAt: this.extractUpdatedAt(threadObject) ?? Date.now(),
      archived: false,
      cwd: this.extractThreadCwd(threadObject) ?? process.cwd(),
    });
    this.resumedThreadIds.add(threadId);

    return { session: this.toSessionInfo(session) };
  }

  async listSessions(): Promise<{ sessions: unknown }> {
    const activeThreads = await this.fetchServerThreads();
    let archivedThreads: ThreadListEntry[] = [];
    try {
      archivedThreads = await this.fetchServerThreadsByArchiveState(true);
    } catch {
      // Some Codex runtimes may not support archived thread listing.
    }

    this.reconcileSessionsWithServer(activeThreads, archivedThreads);

    const sessions = Array.from(this.sessions.values())
      .filter((session) => !session.archived)
      .filter((session) => !this.deletedThreadIds.has(session.id))
      .filter((session) => this.belongsToCurrentRoot(session))
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map((session) => this.toSessionInfo(session));

    return { sessions };
  }

  async getSession(id: string): Promise<{ session: SessionInfo }> {
    const session = this.sessions.get(id);
    if (session) {
      return { session: this.toSessionInfo(session) };
    }

    await this.listSessions();
    const next = this.sessions.get(id);
    if (!next) {
      throw Object.assign(new Error(`Session ${id} not found`), { code: "ENOENT" });
    }
    return { session: this.toSessionInfo(next) };
  }

  async deleteSession(id: string): Promise<{ deleted: boolean }> {
    const session = this.sessions.get(id);

    this.deletedThreadIds.add(id);
    this.sessions.delete(id);
    this.resumedThreadIds.delete(id);

    try {
      const params: Record<string, unknown> = { threadId: id };
      if (session?.cwd) {
        params.cwd = session.cwd;
      }
      await this.call("thread/archive", params);
    } catch {
      // Match Remodex behavior: delete is optimistic locally, archive is best effort.
    }

    return { deleted: true };
  }

  async getMessages(sessionId: string): Promise<{ messages: MessageInfo[] }> {
    const session = this.ensureLocalSession(sessionId);
    const result = await this.call("thread/read", {
      threadId: session.id,
      includeTurns: true,
    });

    const threadObject = this.extractThreadObject(result);
    if (!threadObject) {
      return { messages: session.messages };
    }

    const historyMessages = this.decodeMessagesFromThreadRead(sessionId, threadObject);
    if (historyMessages.length > 0) {
      session.messages = historyMessages;
    }

    this.upsertSession({
      id: sessionId,
      title: this.extractThreadTitle(threadObject),
      createdAt: this.extractCreatedAt(threadObject) ?? session.createdAt,
      updatedAt: this.extractUpdatedAt(threadObject) ?? session.updatedAt,
      archived: false,
      cwd: this.extractThreadCwd(threadObject) ?? session.cwd,
    });

    return { messages: session.messages };
  }

  async prompt(
    sessionId: string,
    text: string,
    model?: ModelSelector,
    agent?: string,
    files: FileAttachment[] = [],
    codexOptions?: CodexPromptOptions,
  ): Promise<{ ack: true }> {
    const session = this.ensureLocalSession(sessionId);
    session.updatedAt = Date.now();

    (async () => {
      try {
        await this.ensureThreadResumed(session.id);
        let imageUrlKey: "url" | "image_url" = "url";
        while (true) {
          try {
            const effortLevels: Array<NonNullable<CodexPromptOptions["reasoningEffort"]>> = ["low", "medium", "high", "xhigh"];
            const speedDelta: Record<NonNullable<CodexPromptOptions["speed"]>, number> = {
              fast: -1,
              balanced: 0,
              quality: 1,
            };
            const baseEffort = codexOptions?.reasoningEffort ?? "medium";
            const baseIndex = effortLevels.indexOf(baseEffort);
            const adjustedIndex = Math.max(
              0,
              Math.min(
                effortLevels.length - 1,
                baseIndex + (codexOptions?.speed ? speedDelta[codexOptions.speed] : 0),
              ),
            );
            const reasoningEffort = effortLevels[adjustedIndex];
            await this.call("turn/start", {
              threadId: session.id,
              input: this.makeTurnInputPayload(text, files, imageUrlKey),
              ...(model ? { model: model.providerID === "codex" ? model.modelID : `${model.providerID}/${model.modelID}` } : {}),
              ...(agent ? { agent } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
            });
            break;
          } catch (err) {
            if (
              imageUrlKey === "url"
              && files.length > 0
              && this.shouldRetryTurnStartWithImageURLField(err)
            ) {
              imageUrlKey = "image_url";
              continue;
            }
            throw err;
          }
        }
      } catch (err) {
        const message = (err as Error).message;
        console.error("[codex] turn/start error:", message);
        this.emitter?.({ type: "prompt_error", properties: { sessionId, error: message } });
      }
    })();

    return { ack: true };
  }

  async abort(sessionId: string): Promise<Record<string, never>> {
    const session = this.ensureLocalSession(sessionId);
    const turnId = session.activeTurnId ?? await this.resolveInFlightTurnId(session.id);
    if (!turnId) {
      throw new Error(`Session ${sessionId} has no active interruptible Codex turn`);
    }
    session.activeTurnId = turnId;
    await this.call("turn/interrupt", { threadId: session.id, turnId });
    return {};
  }

  async agents(): Promise<{ agents: AgentInfo[] }> {
    return { agents: [] };
  }

  async providers(): Promise<ProviderInfo> {
    const items = await this.fetchModels();
    const models = Object.fromEntries(
      items.map((item) => [
        item.model,
        {
          id: item.model,
          name: item.displayName || item.model,
          provider: "codex",
          description: item.description,
          capabilities: {
            reasoningEfforts: ["low", "medium", "high", "xhigh"],
          },
        },
      ])
    );

    const defaultModel = items.find((item) => item.isDefault)?.model;
    return {
      providers: items.length > 0
        ? [{ id: "codex", name: "Codex", models }]
        : [],
      default: defaultModel ? { codex: defaultModel } : {},
      configDefaults: {
        codexReasoningEffort: "high",
        codexSpeed: "balanced",
      },
    };
  }

  async setAuth(providerId: string, key: string): Promise<Record<string, never>> {
    throw new Error("Codex auth configuration is not supported by Lunel yet");
  }

  async command(sessionId: string, command: string, args: string): Promise<{ result: unknown }> {
    throw new Error("Codex command execution is not supported by Lunel yet");
  }

  async revert(sessionId: string, messageId: string): Promise<Record<string, never>> {
    throw new Error("Codex revert is not supported by Lunel yet");
  }

  async unrevert(sessionId: string): Promise<Record<string, never>> {
    throw new Error("Codex unrevert is not supported by Lunel yet");
  }

  async share(sessionId: string): Promise<{ share: ShareInfo }> {
    return { share: { url: null } };
  }

  async permissionReply(
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<Record<string, never>> {
    const pending = this.pendingPermissionRequestIds.get(permissionId);
    if (!pending) {
      throw new Error(`Codex permission request ${permissionId} is no longer pending`);
    }

    const decision = response === "reject"
      ? "decline"
      : response === "always"
        ? "acceptForSession"
        : "accept";

    const isCommandApproval = this.isCommandApprovalMethod(pending.method);
    const result = isCommandApproval
      ? { decision }
      : decision;

    this.send({ jsonrpc: "2.0", id: pending.requestId, result });
    this.pendingPermissionRequestIds.delete(permissionId);
    this.emitter?.({
      type: "permission.replied",
      properties: { sessionID: sessionId, permissionId, response },
    });
    return {};
  }

  async questionReply(): Promise<Record<string, never>> {
    throw new Error("Codex structured user input is not supported by Lunel yet");
  }

  async questionReject(): Promise<Record<string, never>> {
    throw new Error("Codex structured user input is not supported by Lunel yet");
  }

  private send(req: JsonRpcOutbound): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify(req) + "\n");
  }

  private call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const key = String(id);
      const timeout = setTimeout(() => {
        const pending = this.pending.get(key);
        if (!pending) {
          return;
        }
        this.pending.delete(key);
        reject(new Error(`Codex RPC timeout: ${method} (id=${id})`));
      }, 30_000);
      this.pending.set(key, { resolve, reject, timeout });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse | JsonRpcInbound;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if ("method" in msg && typeof (msg as JsonRpcInbound).method === "string") {
      const inbound = msg as JsonRpcInbound;
      const params = this.asRecord(inbound.params);
      if (inbound.id != null) {
        this.handleServerRequest(inbound.method, inbound.id, params);
      } else {
        this.handleNotification(inbound.method, params);
      }
      return;
    }

    if ("id" in msg) {
      const resp = msg as JsonRpcResponse;
      const pending = this.pending.get(String(resp.id));
      if (!pending) return;

      this.pending.delete(String(resp.id));
      clearTimeout(pending.timeout);
      if (resp.error) {
        pending.reject(new Error(resp.error.message));
      } else {
        pending.resolve(resp.result ?? null);
      }
    }
  }

  private handleServerRequest(method: string, requestId: number | string, params: Record<string, unknown>): void {
    const session = this.resolveSessionFromPayload(params);

    if (method === "item/tool/requestUserInput") {
      this.send({
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32601, message: "Structured user input is not supported by Lunel yet" },
      });
      return;
    }

    if (
      method === "item/commandExecution/requestApproval"
      || method === "item/fileChange/requestApproval"
      || method.endsWith("requestApproval")
    ) {
      const permissionId = String(requestId);
      const callId = this.extractItemId(params) ?? undefined;
      const messageId = session ? this.ensureAssistantMessage(session, this.extractTurnId(params) ?? `session:${session.id}`) : undefined;
      this.pendingPermissionRequestIds.set(permissionId, {
        sessionId: session?.id ?? "",
        requestId,
        method,
        messageId,
        callId,
      });

      this.emitter?.({
        type: "permission.updated",
        properties: {
          id: permissionId,
          sessionID: session?.id,
          messageID: messageId,
          callID: callId,
          type: method,
          title: this.readString(params.reason) ?? this.readString(params.command) ?? method,
          metadata: params,
        },
      });
      return;
    }

    this.send({
      jsonrpc: "2.0",
      id: requestId,
      error: { code: -32601, message: `Unsupported request method: ${method}` },
    });
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    this.ingestThreadMetadata(params);

    const session = this.resolveSessionFromPayload(params);
    switch (method) {
      case "thread/started":
      case "thread/name/updated":
        if (session) {
          this.upsertSession({
            id: session.id,
            title: this.extractThreadTitle(params),
            createdAt: this.extractCreatedAt(params) ?? session.createdAt,
            updatedAt: this.extractUpdatedAt(params) ?? Date.now(),
            archived: false,
          }, true);
        }
        return;

      case "thread/status/changed":
        if (session) {
          this.upsertSession({
            id: session.id,
            title: this.extractThreadTitle(params),
            createdAt: this.extractCreatedAt(params) ?? session.createdAt,
            updatedAt: this.extractUpdatedAt(params) ?? Date.now(),
            archived: session.archived,
          }, true);
          this.emitter?.({
            type: "session.status",
            properties: { sessionID: session.id, status: params.status ?? params },
          });
        }
        return;

      case "turn/started":
        if (session) {
          const turnId = this.extractTurnId(params);
          if (turnId) session.activeTurnId = turnId;
          session.updatedAt = Date.now();
          this.emitter?.({
            type: "session.status",
            properties: { sessionID: session.id, status: { type: "running" } },
          });
        }
        return;

      case "turn/completed":
      case "turn/failed":
        if (session) {
          session.activeTurnId = undefined;
          session.updatedAt = Date.now();
          this.finishAssistantTurn(session, params, method === "turn/failed");
          this.refreshSessionMetadata(session.id).catch(() => {
            // Best-effort metadata refresh for title/preview updates after a turn ends.
          });
          this.emitter?.({ type: "session.idle", properties: { sessionID: session.id } });
          if (method === "turn/failed") {
            const error = this.readString(this.asRecord(params.error).message) ?? "Turn failed";
            this.emitter?.({ type: "session.error", properties: { sessionID: session.id, error } });
          }
        }
        return;

      case "error":
      case "codex/event/error":
        if (session) {
          const error = this.readString(this.asRecord(params.error).message)
            ?? this.readString(params.message)
            ?? "Codex error";
          this.emitter?.({ type: "session.error", properties: { sessionID: session.id, error } });
        }
        return;

      case "codex/event/user_message":
        this.emitMirroredUserMessage(session, params);
        return;

      case "item/started":
      case "codex/event/item_started":
        this.handleItemStarted(session, params);
        return;

      case "item/agentMessage/delta":
      case "codex/event/agent_message_content_delta":
      case "codex/event/agent_message_delta":
        this.emitTextPart(session, params, "text", false);
        return;

      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded":
      case "item/reasoning/textDelta":
        this.emitTextPart(session, params, "reasoning", false);
        return;

      case "item/fileChange/outputDelta":
      case "item/toolCall/outputDelta":
      case "item/toolCall/output_delta":
      case "item/tool_call/outputDelta":
      case "item/tool_call/output_delta":
      case "item/commandExecution/outputDelta":
      case "item/command_execution/outputDelta":
      case "codex/event/exec_command_output_delta":
      case "codex/event/read":
      case "codex/event/search":
      case "codex/event/list_files":
        this.emitStructuredToolPart(session, method, params, false);
        return;

      case "turn/diff/updated":
      case "codex/event/turn_diff_updated":
      case "codex/event/turn_diff":
        this.emitStructuredToolPart(session, method, params, true);
        return;

      case "item/completed":
      case "codex/event/item_completed":
      case "codex/event/agent_message":
      case "codex/event/exec_command_end":
      case "codex/event/patch_apply_end":
        if (this.handleStructuredItemCompleted(session, params)) {
          return;
        }
        this.emitTextPart(session, params, "text", true);
        return;

      case "serverRequest/resolved": {
        const permissionId = this.readString(params.requestId) ?? this.readString(params.requestID);
        if (permissionId && this.pendingPermissionRequestIds.has(permissionId)) {
          this.pendingPermissionRequestIds.delete(permissionId);
          this.emitter?.({ type: "permission.replied", properties: { permissionId } });
        }
        return;
      }

      default:
        return;
    }
  }

  private isCommandApprovalMethod(method: string): boolean {
    return method === "item/commandExecution/requestApproval"
      || method === "item/command_execution/request_approval";
  }

  private emitMirroredUserMessage(session: CodexSession | undefined, params: Record<string, unknown>): void {
    if (!session) return;
    const text = this.readString(params.message) ?? this.readString(params.text);
    if (!text) return;

    const turnId = this.extractTurnId(params) ?? `mirrored:${crypto.randomUUID()}`;
    const messageId = `user:${turnId}`;
    if (!session.messages.find((message) => message.id === messageId)) {
      session.messages.push({
        id: messageId,
        role: "user",
        parts: [{ id: `${messageId}:text`, type: "text", text }],
        time: Date.now(),
      });
    }

    this.emitter?.({
      type: "message.updated",
      properties: { info: { sessionID: session.id, id: messageId, role: "user" } },
    });
    this.emitter?.({
      type: "message.part.updated",
      properties: {
        part: { id: `${messageId}:text`, sessionID: session.id, messageID: messageId, type: "text", text },
        message: { sessionID: session.id, id: messageId, role: "user" },
      },
    });
  }

  private handleItemStarted(session: CodexSession | undefined, params: Record<string, unknown>): void {
    if (!session) return;

    const item = this.extractIncomingItem(params);
    const itemType = this.normalizedItemType(this.readString(item.type) ?? "");
    if (itemType === "reasoning") {
      this.emitTextPart(session, params, "reasoning", false);
      return;
    }

    if (
      itemType === "toolcall"
      || itemType === "commandexecution"
      || itemType === "filechange"
      || itemType === "diff"
      || itemType === "plan"
      || itemType === "contextcompaction"
      || itemType === "enteredreviewmode"
    ) {
      this.emitStructuredToolPart(session, itemType, params, false);
      return;
    }

    if (this.isAssistantMessageItem(itemType, this.readString(item.role))) {
      this.ensureAssistantMessage(session, this.extractTurnId(params) ?? `session:${session.id}`);
    }
  }

  private handleStructuredItemCompleted(session: CodexSession | undefined, params: Record<string, unknown>): boolean {
    if (!session) return false;

    const item = this.extractIncomingItem(params);
    const itemType = this.normalizedItemType(this.readString(item.type) ?? "");
    if (
      itemType === "toolcall"
      || itemType === "commandexecution"
      || itemType === "filechange"
      || itemType === "diff"
      || itemType === "plan"
      || itemType === "contextcompaction"
      || itemType === "enteredreviewmode"
    ) {
      this.emitStructuredToolPart(session, itemType, params, true);
      return true;
    }

    return false;
  }

  private emitTextPart(
    session: CodexSession | undefined,
    params: Record<string, unknown>,
    partType: "text" | "reasoning",
    preferWholeText: boolean,
  ): void {
    if (!session) return;

    const turnId = this.extractTurnId(params) ?? session.activeTurnId ?? `session:${session.id}`;
    const messageId = this.ensureAssistantMessage(session, turnId);
    const partKey = `${messageId}:${partType}:${this.extractItemId(params) ?? "main"}`;
    const nextChunk = this.extractTextPayload(params);
    if (!nextChunk) return;

    const previousText = this.partTextById.get(partKey) ?? "";
    const nextText = preferWholeText
      ? nextChunk
      : joinStreamingText(previousText, nextChunk);
    this.partTextById.set(partKey, nextText);
    session.updatedAt = Date.now();

    this.upsertLocalMessagePart(session, messageId, {
      id: partKey,
      sessionID: session.id,
      messageID: messageId,
      type: partType,
      text: nextText,
    });

    this.emitMessagePartEvent(session.id, messageId, "assistant", {
      id: partKey,
      sessionID: session.id,
      messageID: messageId,
      type: partType,
      text: nextText,
    });
  }

  private emitStructuredToolPart(
    session: CodexSession | undefined,
    method: string,
    params: Record<string, unknown>,
    completed: boolean,
  ): void {
    if (!session) return;

    const turnId = this.extractTurnId(params) ?? session.activeTurnId ?? `session:${session.id}`;
    const messageId = this.ensureAssistantMessage(session, turnId);
    const item = this.extractIncomingItem(params);
    const normalizedType = this.normalizeStructuredType(this.readString(item.type) ?? method);
    const itemId = this.extractItemId(params) ?? this.readString(item.id) ?? normalizedType ?? "tool";
    const fileChangeLike = this.isFileChangeStructuredItem(normalizedType, item, params);
    const emittedPartType: PartType = normalizedType === "plan"
      ? "reasoning"
      : (fileChangeLike ? "file-change" : "tool");
    const partId = `${messageId}:${emittedPartType}:${itemId}`;
    const nextText = this.extractStructuredOutput(params, item, normalizedType);
    const prevOutput = this.partTextById.get(partId) ?? "";
    const output = completed
      ? nextText ?? prevOutput
      : `${prevOutput}${nextText ?? ""}`;

    if (output) {
      this.partTextById.set(partId, output);
    }

    const state = completed ? "completed" : "running";
    const name = this.describeToolPart(normalizedType, method, item);
    const input = this.extractToolInput(item, params);
    const outputValue = output || this.describeCompletedItemOutput(item, params, normalizedType) || undefined;
    const patch = emittedPartType === "file-change"
      ? this.extractCanonicalPatch(params, item)
      : undefined;

    const part: Record<string, unknown> = {
      id: partId,
      sessionID: session.id,
      messageID: messageId,
      type: emittedPartType,
      ...(emittedPartType === "reasoning"
        ? { text: outputValue ?? "Planning..." }
        : { name, toolName: name, input, output: outputValue, state, ...(patch ? { patch } : {}) }),
    };

    this.upsertLocalMessagePart(session, messageId, part);
    this.emitMessagePartEvent(session.id, messageId, "assistant", part);
  }

  private finishAssistantTurn(session: CodexSession, params: Record<string, unknown>, failed: boolean): void {
    const turnId = this.extractTurnId(params);
    if (!turnId) return;

    const messageId = this.assistantMessageIdByTurnId.get(turnId);
    if (!messageId) return;

    const finishPartId = `${messageId}:finish`;
    const part: Record<string, unknown> = {
      id: finishPartId,
      sessionID: session.id,
      messageID: messageId,
      type: "step-finish",
      title: failed ? "Failed" : "Completed",
      time: { end: Date.now() },
    };
    this.upsertLocalMessagePart(session, messageId, part);
    this.emitMessagePartEvent(session.id, messageId, "assistant", part);
  }

  private emitMessagePartEvent(
    sessionId: string,
    messageId: string,
    role: "user" | "assistant",
    part: Record<string, unknown>,
  ): void {
    this.emitter?.({
      type: "message.updated",
      properties: { info: { sessionID: sessionId, id: messageId, role } },
    });
    this.emitter?.({
      type: "message.part.updated",
      properties: {
        part,
        message: { sessionID: sessionId, id: messageId, role },
      },
    });
  }

  private ensureAssistantMessage(session: CodexSession, turnId: string): string {
    const existing = this.assistantMessageIdByTurnId.get(turnId);
    if (existing) return existing;

    const messageId = crypto.randomUUID();
    this.assistantMessageIdByTurnId.set(turnId, messageId);
    session.messages.push({
      id: messageId,
      role: "assistant",
      parts: [{
        id: `${messageId}:start`,
        type: "step-start",
        title: "Working",
        time: { start: Date.now() },
      }],
      time: Date.now(),
    });
    return messageId;
  }

  private upsertLocalMessagePart(
    session: CodexSession,
    messageId: string,
    part: Record<string, unknown>,
  ): void {
    const message = session.messages.find((entry) => entry.id === messageId);
    if (!message) return;

    const parts = Array.isArray(message.parts) ? [...message.parts] : [];
    const idx = parts.findIndex((entry) => this.asRecord(entry).id === part.id);
    if (idx >= 0) {
      parts[idx] = part;
    } else {
      parts.push(part);
    }
    message.parts = parts;
    message.time = Date.now();
  }

  private async fetchServerThreads(): Promise<ThreadListEntry[]> {
    return this.fetchServerThreadsByArchiveState(false);
  }

  private async refreshSessionMetadata(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const result = await this.call("thread/read", {
      threadId: sessionId,
      includeTurns: false,
    });
    const threadObject = this.extractThreadObject(result);
    if (!threadObject || Object.keys(threadObject).length === 0) {
      return;
    }

    this.upsertSession({
      id: sessionId,
      title: this.extractThreadTitle(threadObject),
      createdAt: this.extractCreatedAt(threadObject) ?? session?.createdAt ?? Date.now(),
      updatedAt: this.extractUpdatedAt(threadObject) ?? session?.updatedAt ?? Date.now(),
      archived: false,
      cwd: this.extractThreadCwd(threadObject) ?? session?.cwd,
    }, true);
  }

  private async fetchServerThreadsByArchiveState(archived: boolean): Promise<ThreadListEntry[]> {
    const threads: ThreadListEntry[] = [];
    let nextCursor: unknown = null;
    let hasRequestedFirstPage = false;

    do {
      const result = await this.call("thread/list", {
        sourceKinds: THREAD_LIST_SOURCE_KINDS,
        archived,
        cursor: nextCursor,
      });
      const payload = this.asRecord(result);
      const page = Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.items)
          ? payload.items
          : Array.isArray(payload.threads)
            ? payload.threads
            : [];
      for (const entry of page) {
        const parsed = this.parseThreadListEntry(entry, archived);
        if (parsed) threads.push(parsed);
      }

      nextCursor = payload.nextCursor ?? payload.next_cursor ?? null;
      hasRequestedFirstPage = true;
    } while (hasRequestedFirstPage && this.hasNextCursor(nextCursor));

    return threads;
  }

  private async fetchModels(): Promise<Array<{
    id: string;
    model: string;
    displayName: string;
    description: string;
    isDefault: boolean;
  }>> {
    const result = await this.call("model/list", {
      cursor: null,
      limit: 50,
      includeHidden: false,
    });
    const payload = this.asRecord(result);
    const items = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.models)
          ? payload.models
          : [];
    return items
      .map((value) => {
        const obj = this.asRecord(value);
        const model = this.readString(obj.model) ?? this.readString(obj.id);
        if (!model) return undefined;
        const displayName = this.readString(obj.displayName)
          ?? this.readString(obj.display_name)
          ?? model;
        return {
          id: this.readString(obj.id) ?? model,
          model,
          displayName,
          description: this.readString(obj.description) ?? "",
          isDefault: Boolean(obj.isDefault ?? obj.is_default),
        };
      })
      .filter((value): value is {
        id: string;
        model: string;
        displayName: string;
        description: string;
        isDefault: boolean;
      } => Boolean(value));
  }

  private parseThreadListEntry(value: unknown, archived = false): ThreadListEntry | undefined {
    const obj = this.asRecord(value);
    const id = this.extractThreadId(obj);
    if (!id) return undefined;

    return {
      id,
      title: this.extractThreadTitle(obj),
      createdAt: this.extractCreatedAt(obj),
      updatedAt: this.extractUpdatedAt(obj),
      archived,
      cwd: this.extractThreadCwd(obj),
    };
  }

  private hasNextCursor(value: unknown): boolean {
    if (value == null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    return true;
  }

  private ingestThreadMetadata(payload: unknown): void {
    const threadId = this.extractThreadId(payload);
    if (!threadId) return;

    const title = this.extractThreadTitleFromUnknown(payload);
    this.upsertSession({
      id: threadId,
      title,
      createdAt: this.extractCreatedAt(payload) ?? Date.now(),
      updatedAt: this.extractUpdatedAt(payload) ?? Date.now(),
      cwd: this.extractThreadCwd(payload),
    });
  }

  private reconcileSessionsWithServer(
    activeThreads: ThreadListEntry[],
    archivedThreads: ThreadListEntry[] = [],
  ): void {
    const localSessions = this.sessions;
    const merged = new Map<string, CodexSession>();

    for (const thread of activeThreads) {
      if (this.deletedThreadIds.has(thread.id)) continue;
      const session = this.mergeSession(localSessions.get(thread.id), { ...thread, archived: false });
      merged.set(thread.id, session);
    }

    for (const thread of archivedThreads) {
      if (this.deletedThreadIds.has(thread.id)) continue;
      if (merged.has(thread.id)) continue;
      const session = this.mergeSession(localSessions.get(thread.id), { ...thread, archived: true });
      merged.set(thread.id, session);
    }

    for (const [id, session] of localSessions.entries()) {
      if (!merged.has(id)) {
        merged.set(id, session);
      }
    }

    this.sessions = merged;
  }

  private mergeSession(existing: CodexSession | undefined, input: ThreadListEntry): CodexSession {
    if (!existing) {
      return {
        id: input.id,
        title: input.title ?? "Conversation",
        createdAt: input.createdAt ?? Date.now(),
        updatedAt: input.updatedAt ?? Date.now(),
        archived: input.archived ?? false,
        cwd: input.cwd,
        messages: [],
      };
    }

    existing.title = input.title ?? existing.title;
    existing.createdAt = input.createdAt ?? existing.createdAt;
    existing.updatedAt = input.updatedAt != null
      ? Math.max(existing.updatedAt, input.updatedAt)
      : existing.updatedAt;
    existing.archived = input.archived ?? existing.archived ?? false;
    existing.cwd = input.cwd ?? existing.cwd;
    return existing;
  }

  private upsertSession(input: ThreadListEntry, emitUpdated = false): CodexSession {
    const existing = this.sessions.get(input.id);
    const before = existing
      ? {
        title: existing.title,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        archived: existing.archived ?? false,
        cwd: existing.cwd,
      }
      : null;
    const session = this.mergeSession(existing, input);
    this.sessions.set(session.id, session);

    const changed = !before
      || before.title !== session.title
      || before.createdAt !== session.createdAt
      || before.updatedAt !== session.updatedAt
      || before.archived !== (session.archived ?? false)
      || before.cwd !== session.cwd;
    if (emitUpdated && changed) {
      this.emitter?.({ type: "session.updated", properties: { info: this.toSessionInfo(session) } });
    }
    return session;
  }

  private ensureLocalSession(sessionId: string): CodexSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    return this.upsertSession({ id: sessionId, title: "Conversation", createdAt: Date.now(), updatedAt: Date.now() });
  }

  private async ensureThreadResumed(threadId: string, force = false): Promise<void> {
    if (!threadId || this.resumedThreadIds.has(threadId)) {
      if (!force) return;
    }

    const session = this.sessions.get(threadId);
    const params: Record<string, unknown> = { threadId };
    if (session?.cwd) {
      params.cwd = session.cwd;
    }

    const result = await this.call("thread/resume", params);
    const payload = this.asRecord(result);
    const threadValue = payload.thread;
    const threadObject = threadValue ? this.asRecord(threadValue) : this.extractThreadObject(result);
    if (threadObject && Object.keys(threadObject).length > 0) {
      const nextSession = this.upsertSession({
        id: threadId,
        title: this.extractThreadTitle(threadObject),
        createdAt: this.extractCreatedAt(threadObject) ?? session?.createdAt ?? Date.now(),
        updatedAt: this.extractUpdatedAt(threadObject) ?? session?.updatedAt ?? Date.now(),
        archived: false,
        cwd: this.extractThreadCwd(threadObject) ?? session?.cwd,
      }, true);

      const historyMessages = this.decodeMessagesFromThreadRead(threadId, threadObject);
      if (historyMessages.length > 0 && (!nextSession.activeTurnId || nextSession.messages.length === 0 || force)) {
        nextSession.messages = historyMessages;
      }
    }

    this.resumedThreadIds.add(threadId);
  }

  private resolveSessionFromPayload(payload: Record<string, unknown>): CodexSession | undefined {
    const threadId = this.extractThreadId(payload);
    if (!threadId) return undefined;
    return this.ensureLocalSession(threadId);
  }

  private async resolveInFlightTurnId(threadId: string): Promise<string | undefined> {
    const result = await this.call("thread/read", { threadId, includeTurns: true });
    const thread = this.extractThreadObject(result);
    const turns = this.readArray(thread.turns);
    for (const turn of turns.slice().reverse()) {
      const turnObj = this.asRecord(turn);
      const status = this.normalizedItemType(this.readString(turnObj.status) ?? this.readString(this.asRecord(turnObj.status).type) ?? "");
      if (
        status.includes("running")
        || status.includes("active")
        || status.includes("processing")
        || status.includes("started")
        || status.includes("pending")
      ) {
        return this.readString(turnObj.id);
      }
    }
    return undefined;
  }

  private decodeMessagesFromThreadRead(threadId: string, threadObject: Record<string, unknown>): MessageInfo[] {
    const turns = this.readArray(threadObject.turns);
    const messages: MessageInfo[] = [];
    let orderOffset = 0;

    for (const turn of turns) {
      const turnObject = this.asRecord(turn);
      const turnId = this.readString(turnObject.id);
      const turnTime = this.extractUpdatedAt(turnObject) ?? this.extractCreatedAt(turnObject) ?? Date.now();
      const items = this.readArray(turnObject.items);

      for (const item of items) {
        const itemObject = this.asRecord(item);
        const type = this.normalizedItemType(this.readString(itemObject.type) ?? "");
        const itemId = this.readString(itemObject.id) ?? crypto.randomUUID();
        const timestamp = this.extractUpdatedAt(itemObject) ?? this.extractCreatedAt(itemObject) ?? (turnTime + orderOffset++);

        if (type === "usermessage") {
          const parts = this.decodeUserMessageParts(itemObject, threadId, itemId);
          if (parts.length === 0) continue;
          messages.push({
            id: itemId,
            role: "user",
            parts,
            time: timestamp,
          });
          continue;
        }

        if (type === "agentmessage" || type === "assistantmessage" || (type === "message" && !this.isUserRole(itemObject))) {
          const text = this.decodeItemText(itemObject);
          if (!text) continue;
          messages.push({
            id: itemId,
            role: "assistant",
            parts: [{ id: `${itemId}:text`, type: "text", text, sessionID: threadId, messageID: itemId }],
            time: timestamp,
          });
          if (turnId) this.assistantMessageIdByTurnId.set(turnId, itemId);
          continue;
        }

        if (type === "reasoning") {
          const text = this.decodeReasoningItemText(itemObject);
          messages.push({
            id: itemId,
            role: "assistant",
            parts: [{ id: `${itemId}:reasoning`, type: "reasoning", text, sessionID: threadId, messageID: itemId }],
            time: timestamp,
          });
          continue;
        }

        if (type === "plan") {
          const text = this.decodePlanItemText(itemObject);
          messages.push({
            id: itemId,
            role: "assistant",
            parts: [{ id: `${itemId}:plan`, type: "reasoning", text, sessionID: threadId, messageID: itemId }],
            time: timestamp,
          });
          continue;
        }

        if (type === "commandexecution" || type === "enteredreviewmode" || type === "contextcompaction") {
          const output = this.decodeCommandExecutionItemText(itemObject, type);
          const input = this.extractCommandExecutionInput(itemObject);
          messages.push({
            id: itemId,
            role: "assistant",
            parts: [{
              id: `${itemId}:tool`,
              type: "tool",
              name: type === "commandexecution" ? "command" : "system",
              toolName: type === "commandexecution" ? "command" : "system",
              ...(input ? { input } : {}),
              output,
              state: "completed",
              sessionID: threadId,
              messageID: itemId,
            }],
            time: timestamp,
          });
          continue;
        }

        if (type === "filechange" || type === "toolcall" || type === "diff") {
          const output = this.decodeFileLikeItemText(itemObject);
          if (!output) continue;
          const emittedPartType: PartType = this.isFileChangeStructuredItem(type, itemObject)
            ? "file-change"
            : "tool";
          const patch = emittedPartType === "file-change"
            ? this.extractCanonicalPatch({}, itemObject)
            : undefined;
          messages.push({
            id: itemId,
            role: "assistant",
            parts: [{
              id: `${itemId}:${emittedPartType}`,
              type: emittedPartType,
              name: type,
              toolName: type,
              output,
              state: "completed",
              ...(patch ? { patch } : {}),
              sessionID: threadId,
              messageID: itemId,
            }],
            time: timestamp,
          });
        }
      }
    }

    return messages;
  }

  private decodeUserMessageParts(
    itemObject: Record<string, unknown>,
    threadId: string,
    itemId: string,
  ): Record<string, unknown>[] {
    const parts: Record<string, unknown>[] = [];
    const content = this.readArray(itemObject.content);
    let fileIndex = 0;

    for (const entry of content) {
      const obj = this.asRecord(entry);
      const type = this.normalizedItemType(this.readString(obj.type) ?? "");
      if (type === "image" || type === "localimage") {
        const url = this.readString(obj.url) ?? this.readString(obj.image_url) ?? this.readString(obj.imageUrl);
        if (!url) continue;
        parts.push({
          id: `${itemId}:file:${fileIndex++}`,
          type: "file",
          mime: this.inferImageMimeFromDataUrl(url),
          filename: this.readString(obj.filename) ?? this.readString(obj.name) ?? undefined,
          url,
          sessionID: threadId,
          messageID: itemId,
        });
      }
    }

    const text = this.decodeItemText(itemObject);
    if (text) {
      parts.push({
        id: `${itemId}:text`,
        type: "text",
        text,
        sessionID: threadId,
        messageID: itemId,
      });
    }

    return parts;
  }

  private decodeItemText(itemObject: Record<string, unknown>): string {
    const content = this.readArray(itemObject.content);
    const parts: string[] = [];

    for (const entry of content) {
      const obj = this.asRecord(entry);
      const type = this.normalizedItemType(this.readString(obj.type) ?? "");
      if (type === "text" || type === "inputtext" || type === "outputtext" || type === "message") {
        const text = this.readString(obj.text) ?? this.readString(this.asRecord(obj.data).text);
        if (text) parts.push(text);
      } else if (type === "skill") {
        const skill = this.readString(obj.id) ?? this.readString(obj.name);
        if (skill) parts.push(`$${skill}`);
      }
    }

    const joined = parts.join("\n").trim();
    return joined || this.readString(itemObject.text) || this.readString(itemObject.message) || "";
  }

  private makeTurnInputPayload(text: string, files: FileAttachment[], imageUrlKey: "url" | "image_url"): Array<Record<string, unknown>> {
    const items: Array<Record<string, unknown>> = [];

    for (const file of files) {
      const url = typeof file.url === "string" ? file.url.trim() : "";
      if (!url) continue;
      items.push({
        type: "image",
        [imageUrlKey]: url,
      });
    }

    const trimmedText = text.trim();
    if (trimmedText) {
      items.push({ type: "text", text: trimmedText });
    }

    return items;
  }

  private shouldRetryTurnStartWithImageURLField(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (!message.includes("image_url")) {
      return false;
    }
    return (
      message.includes("missing")
      || message.includes("unknown field")
      || message.includes("expected")
      || message.includes("invalid")
    );
  }

  private inferImageMimeFromDataUrl(url: string): string {
    const match = /^data:([^;,]+)[;,]/i.exec(url);
    if (match?.[1]) {
      return match[1];
    }
    return "image/jpeg";
  }

  private decodeReasoningItemText(itemObject: Record<string, unknown>): string {
    const summary = this.flattenTextValue(itemObject.summary).trim();
    const content = this.flattenTextValue(itemObject.content).trim();
    return [summary, content].filter(Boolean).join("\n\n") || "Thinking...";
  }

  private decodePlanItemText(itemObject: Record<string, unknown>): string {
    return this.decodeItemText(itemObject) || this.flattenTextValue(itemObject.summary).trim() || "Planning...";
  }

  private decodeCommandExecutionItemText(itemObject: Record<string, unknown>, type: string): string {
    if (type === "enteredreviewmode") {
      return `Reviewing ${this.readString(itemObject.review) ?? "changes"}...`;
    }
    if (type === "contextcompaction") {
      return "Context compacted";
    }

    const status = this.readString(this.asRecord(itemObject.status).type) ?? this.readString(itemObject.status) ?? "completed";
    const command = this.firstString(itemObject, ["command", "cmd", "raw_command", "rawCommand", "input", "invocation"]) ?? "command";
    return `${this.normalizedCommandPhase(status)} ${this.shortCommand(command)}`;
  }

  private decodeFileLikeItemText(itemObject: Record<string, unknown>): string | undefined {
    const status = this.normalizedFileChangeStatus(itemObject, true);
    const changesBody = this.renderFileChangeEntriesBody(itemObject.changes);
    if (changesBody) {
      return `Status: ${status}\n\n${changesBody}`;
    }

    const diff = this.firstString(itemObject, ["diff", "unified_diff", "unifiedDiff", "patch"]);
    if (diff?.trim()) {
      return this.renderUnifiedDiffBody(diff, status);
    }

    const direct = this.firstString(itemObject, [
      "text",
      "message",
      "summary",
      "stdout",
      "stderr",
      "output_text",
      "outputText",
    ]);
    if (direct?.trim()) {
      return `Status: ${status}\n\n${direct.trim()}`;
    }

    return undefined;
  }

  private normalizedCommandPhase(rawStatus: string): string {
    const normalized = rawStatus.trim().toLowerCase();
    if (normalized.includes("fail") || normalized.includes("error")) return "failed";
    if (normalized.includes("cancel") || normalized.includes("abort") || normalized.includes("interrupt")) return "stopped";
    if (normalized.includes("complete") || normalized.includes("success") || normalized.includes("done")) return "completed";
    return "running";
  }

  private shortCommand(rawCommand: string, maxLength = 92): string {
    const normalized = rawCommand.trim().replace(/\s+/g, " ");
    if (!normalized) return "command";
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 1)}...`;
  }

  private flattenTextValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value.map((entry) => this.flattenTextValue(entry)).filter(Boolean).join("\n");
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      return this.readString(obj.text) ?? this.readString(obj.message) ?? this.flattenTextValue(obj.content);
    }
    return "";
  }

  private toSessionInfo(session: CodexSession): SessionInfo {
    return {
      id: session.id,
      title: session.title,
      time: {
        created: session.createdAt,
        updated: session.updatedAt,
      },
    };
  }

  private extractThreadObject(payload: unknown): Record<string, unknown> {
    const obj = this.asRecord(payload);
    const nested = this.asRecord(obj.thread);
    return Object.keys(nested).length > 0 ? nested : obj;
  }

  private extractThreadTitleFromUnknown(payload: unknown): string | undefined {
    return this.extractThreadTitle(this.extractThreadObject(payload));
  }

  private extractThreadTitle(payload: Record<string, unknown>): string | undefined {
    const thread = this.asRecord(payload.thread);
    const explicitName = this.readString(thread.name) ?? this.readString(payload.name);
    if (explicitName) return explicitName;

    const explicitTitle = this.readString(thread.title) ?? this.readString(payload.title);
    if (explicitTitle) return explicitTitle;

    const preview = this.readString(thread.preview) ?? this.readString(payload.preview);
    if (!preview) return undefined;
    return preview.charAt(0).toUpperCase() + preview.slice(1);
  }

  private extractTurnId(payload: Record<string, unknown>): string | undefined {
    return (
      this.readString(payload.turnId)
      ?? this.readString(payload.turn_id)
      ?? this.readString(this.asRecord(payload.turn).id)
      ?? this.readString(this.asRecord(payload.turn).turnId)
      ?? this.readString(this.asRecord(payload.event).id)
      ?? this.readString(this.asRecord(this.asRecord(payload.event).turn).id)
      ?? ((payload.msg != null || payload.event != null) ? this.readString(payload.id) : undefined)
    );
  }

  private extractItemId(payload: Record<string, unknown>): string | undefined {
    return (
      this.readString(payload.itemId)
      ?? this.readString(payload.item_id)
      ?? this.readString(payload.call_id)
      ?? this.readString(payload.callId)
      ?? this.readString(payload.id)
      ?? this.readString(payload.messageId)
      ?? this.readString(payload.message_id)
      ?? this.readString(this.asRecord(payload.item).id)
      ?? this.readString(this.asRecord(payload.item).itemId)
      ?? this.readString(this.asRecord(payload.item).call_id)
      ?? this.readString(this.asRecord(payload.item).callId)
      ?? this.readString(this.asRecord(payload.item).messageId)
      ?? this.readString(this.asRecord(payload.event).itemId)
      ?? this.readString(this.asRecord(payload.event).item_id)
      ?? this.readString(this.asRecord(payload.event).call_id)
      ?? this.readString(this.asRecord(payload.event).callId)
      ?? this.readString(this.asRecord(payload.event).id)
      ?? this.readString(this.asRecord(this.asRecord(payload.event).item).id)
    );
  }

  private extractTextPayload(payload: Record<string, unknown>): string | undefined {
    return (
      this.readRawString(payload.delta)
      ?? this.readRawString(payload.text)
      ?? this.readRawString(payload.message)
      ?? this.readRawString(this.asRecord(payload.item).text)
      ?? this.readRawString(this.asRecord(payload.item).delta)
      ?? this.readRawString(this.asRecord(payload.item).message)
      ?? this.readRawString(this.asRecord(payload.event).text)
      ?? this.readRawString(this.asRecord(payload.event).delta)
      ?? this.readRawString(this.asRecord(payload.event).message)
    );
  }

  private extractThreadId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const obj = payload as Record<string, unknown>;
    const direct = this.readString(obj.threadId) ?? this.readString(obj.thread_id) ?? this.readString(obj.id);
    if (direct) return direct;

    const thread = this.asRecord(obj.thread);
    return this.readString(thread.id) ?? this.readString(thread.threadId) ?? this.readString(thread.thread_id);
  }

  private extractThreadCwd(payload: unknown): string | undefined {
    const obj = this.extractThreadObject(payload);
    const cwd = this.firstString(obj, [
      "cwd",
      "projectPath",
      "project_path",
      "gitWorkingDirectory",
      "git_working_directory",
      "workingDirectory",
      "working_directory",
    ]);
    return cwd ? this.normalizeDirectoryPath(cwd) : undefined;
  }

  private extractCreatedAt(payload: unknown): number | undefined {
    const obj = this.extractThreadObject(payload);
    return this.readTimestamp(obj.createdAt) ?? this.readTimestamp(obj.created_at);
  }

  private extractUpdatedAt(payload: unknown): number | undefined {
    const obj = this.extractThreadObject(payload);
    return this.readTimestamp(obj.updatedAt)
      ?? this.readTimestamp(obj.updated_at)
      ?? this.readTimestamp(obj.time);
  }

  private readTimestamp(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? value : value * 1000;
    }
    if (typeof value === "string" && value.trim()) {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) {
        return asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
      }
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      return this.readTimestamp(obj.updated) ?? this.readTimestamp(obj.created) ?? this.readTimestamp(obj.start) ?? this.readTimestamp(obj.end);
    }
    return undefined;
  }

  private firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.readString(obj[key]);
      if (value) return value;
    }
    return undefined;
  }

  private firstStringFromSources(sources: Record<string, unknown>[], keys: string[]): string | undefined {
    for (const source of sources) {
      const value = this.firstString(source, keys);
      if (value) return value;
    }
    return undefined;
  }

  private readArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private readRawString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  private readString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  private normalizedItemType(rawType: string): string {
    return rawType.replace(/[_-]/g, "").toLowerCase();
  }

  private isUserRole(itemObject: Record<string, unknown>): boolean {
    return (this.readString(itemObject.role) ?? "").toLowerCase().includes("user");
  }

  private isAssistantMessageItem(itemType: string, role?: string): boolean {
    const normalizedRole = (role ?? "").toLowerCase();
    return itemType === "agentmessage"
      || itemType === "assistantmessage"
      || itemType === "exitedreviewmode"
      || (itemType === "message" && !normalizedRole.includes("user"));
  }

  private extractIncomingItem(params: Record<string, unknown>): Record<string, unknown> {
    const direct = this.asRecord(params.item);
    if (Object.keys(direct).length > 0) return direct;
    const eventItem = this.asRecord(this.asRecord(params.event).item);
    if (Object.keys(eventItem).length > 0) return eventItem;
    return this.asRecord(params.event);
  }

  private describeToolPart(
    normalizedType: string,
    method: string,
    item: Record<string, unknown>,
  ): string {
    if (normalizedType === "commandexecution") {
      return "command";
    }
    if (normalizedType === "filechange" || normalizedType === "diff") {
      return "file-change";
    }
    if (normalizedType === "plan") {
      return "plan";
    }
    if (normalizedType === "enteredreviewmode") {
      return "review";
    }
    if (normalizedType === "contextcompaction") {
      return "context";
    }
    return this.readString(item.name) ?? method.replace(/^.*\//, "");
  }

  private normalizeStructuredType(rawType: string): string {
    const normalized = this.normalizedItemType(rawType);
    if (normalized.includes("turndiff") || normalized === "diff") return "diff";
    if (normalized.includes("filechange")) return "filechange";
    if (normalized.includes("toolcall")) return "toolcall";
    if (normalized.includes("commandexecution")) return "commandexecution";
    return normalized;
  }

  private isFileChangeStructuredItem(
    normalizedType: string,
    item: Record<string, unknown>,
    params?: Record<string, unknown>,
  ): boolean {
    if (normalizedType === "filechange" || normalizedType === "diff") {
      return true;
    }
    if (normalizedType !== "toolcall") {
      return false;
    }

    const event = this.asRecord(params?.event);
    const nestedItem = this.asRecord(event.item);
    const sources = [item, params ?? {}, event, nestedItem];

    for (const source of sources) {
      if (this.firstString(source, ["diff", "unified_diff", "unifiedDiff", "patch"])) {
        return true;
      }
      if (this.readArray(source.changes).length > 0) {
        return true;
      }
    }

    const toolName = this.firstString(item, ["name", "toolName", "tool_name", "title"])?.toLowerCase() ?? "";
    return toolName.includes("patch") || toolName.includes("edit") || toolName.includes("write");
  }

  private extractStructuredOutput(
    params: Record<string, unknown>,
    item: Record<string, unknown>,
    normalizedType: string,
  ): string | undefined {
    if (normalizedType === "filechange" || normalizedType === "toolcall" || normalizedType === "diff") {
      return this.extractDiffLikePayload(params, item, normalizedType) ?? this.extractTextPayload(params);
    }

    return this.extractTextPayload(params);
  }

  private extractDiffLikePayload(
    params: Record<string, unknown>,
    item: Record<string, unknown>,
    normalizedType?: string,
  ): string | undefined {
    const event = this.asRecord(params.event);
    const nestedItem = this.asRecord(event.item);
    const sources = [params, item, event, nestedItem];
    const status = this.normalizedFileChangeStatus(item, false);

    const changesBody = this.renderFileChangeEntriesBody(item.changes ?? params.changes ?? event.changes ?? nestedItem.changes);
    if (changesBody) {
      return `Status: ${status}\n\n${changesBody}`;
    }

    for (const source of sources) {
      const diff = this.firstString(source, ["diff", "unified_diff", "unifiedDiff", "patch"]);
      if (diff) {
        return this.renderUnifiedDiffBody(diff, status);
      }
    }

    for (const source of sources) {
      const direct = this.firstString(source, ["text", "message", "summary", "output", "output_text", "outputText"]);
      if (direct) {
        if (normalizedType === "toolcall" && !this.isFileChangeStructuredItem("toolcall", item, params)) {
          return direct;
        }
        return `Status: ${status}\n\n${direct}`;
      }
    }

    return undefined;
  }

  private renderFileChangeEntriesBody(rawChanges: unknown): string | undefined {
    const changes = this.readArray(rawChanges);
    if (changes.length === 0) return undefined;

    const rendered = changes
      .map((change) => {
        const obj = this.asRecord(change);
        const path = this.firstString(obj, [
          "path",
          "file",
          "file_path",
          "filePath",
          "relative_path",
          "relativePath",
          "new_path",
          "newPath",
          "to",
          "target",
          "name",
          "old_path",
          "oldPath",
          "from",
        ]);
        const normalizedPath = this.normalizeDisplayPath(path) ?? "file";
        const kind = this.firstString(obj, ["kind", "type", "action", "status"]) ?? "change";
        const diff = this.firstString(obj, ["diff", "unified_diff", "unifiedDiff", "patch"]) ?? "";
        return diff
          ? `Path: ${normalizedPath}\nKind: ${kind}\n\n\`\`\`diff\n${diff}\n\`\`\``
          : `Path: ${normalizedPath}\nKind: ${kind}`;
      })
      .filter(Boolean);

    return rendered.length > 0 ? rendered.join("\n\n---\n\n") : undefined;
  }

  private renderUnifiedDiffBody(diff: string, status: string): string {
    return `Status: ${status}\n\n\`\`\`diff\n${diff.trim()}\n\`\`\``;
  }

  private extractCanonicalPatch(
    params: Record<string, unknown>,
    item: Record<string, unknown>,
  ): string | undefined {
    const event = this.asRecord(params.event);
    const nestedItem = this.asRecord(event.item);
    const sources = [item, params, event, nestedItem];

    for (const source of sources) {
      const diff = this.firstString(source, ["diff", "unified_diff", "unifiedDiff", "patch"]);
      if (diff?.trim()) {
        return diff.trim();
      }
    }

    const changes = this.readArray(item.changes ?? params.changes ?? event.changes ?? nestedItem.changes);
    if (changes.length === 0) return undefined;

    const patch = changes
      .map((change) => {
        const obj = this.asRecord(change);
        return this.firstString(obj, ["diff", "unified_diff", "unifiedDiff", "patch"]) ?? "";
      })
      .filter((value) => value.trim().length > 0)
      .join("\n");

    return patch.trim() || undefined;
  }

  private normalizeDisplayPath(rawPath: string | undefined): string | undefined {
    if (!rawPath) return undefined;
    const trimmed = rawPath.trim();
    if (!trimmed) return undefined;
    if (!path.isAbsolute(trimmed)) return trimmed;

    const relative = path.relative(process.cwd(), trimmed);
    if (!relative || relative.startsWith("..")) {
      return trimmed;
    }
    return relative;
  }

  private normalizeDirectoryPath(rawPath: string | undefined): string | undefined {
    if (!rawPath) return undefined;
    const trimmed = rawPath.trim();
    if (!trimmed) return undefined;
    return path.resolve(trimmed);
  }

  private belongsToCurrentRoot(session: CodexSession): boolean {
    const sessionCwd = this.normalizeDirectoryPath(session.cwd);
    const currentRoot = this.normalizeDirectoryPath(process.cwd());
    if (!sessionCwd || !currentRoot) {
      return false;
    }
    return sessionCwd === currentRoot;
  }

  private normalizedFileChangeStatus(itemObject: Record<string, unknown>, isCompleted: boolean): string {
    const status = this.readString(itemObject.status)
      ?? this.readString(this.asRecord(itemObject.status).type)
      ?? this.readString(itemObject.state)
      ?? this.readString(this.asRecord(itemObject.state).type);
    if (status) return status;
    return isCompleted ? "completed" : "inProgress";
  }

  private extractToolInput(item: Record<string, unknown>, params: Record<string, unknown>): unknown {
    const normalizedType = this.normalizeStructuredType(this.readString(item.type) ?? "");
    if (normalizedType === "commandexecution") {
      return this.extractCommandExecutionInput(item, params);
    }
    return item.input ?? item.command ?? item.path ?? item.args ?? params.command ?? params.path ?? undefined;
  }

  private extractCommandExecutionInput(
    item: Record<string, unknown>,
    params?: Record<string, unknown>,
  ): unknown {
    const event = this.asRecord(params?.event);
    const nestedItem = this.asRecord(event.item);
    const sources = [item, params ?? {}, event, nestedItem];

    const command = this.firstStringFromSources(sources, [
      "command",
      "cmd",
      "raw_command",
      "rawCommand",
      "invocation",
      "input",
      "fullCommand",
      "full_command",
    ]);
    const cwd = this.firstStringFromSources(sources, [
      "cwd",
      "workdir",
      "workingDirectory",
      "working_directory",
    ]);

    if (command && cwd) return { command, cwd };
    if (command) return { command };
    if (cwd) return { cwd };
    return undefined;
  }

  private describeCompletedItemOutput(
    item: Record<string, unknown>,
    params: Record<string, unknown>,
    normalizedType: string,
  ): string | undefined {
    if (normalizedType === "commandexecution") {
      return this.firstString(item, ["stdout", "stderr", "text", "message", "summary"]);
    }
    if (normalizedType === "plan") {
      return this.decodePlanItemText(item);
    }
    if (normalizedType === "filechange" || normalizedType === "toolcall" || normalizedType === "diff") {
      return this.extractDiffLikePayload(params, item, normalizedType) ?? this.decodeFileLikeItemText(item);
    }
    if (normalizedType === "enteredreviewmode") {
      return `Reviewing ${this.readString(item.review) ?? "changes"}...`;
    }
    if (normalizedType === "contextcompaction") {
      return "Context compacted";
    }
    return this.firstString(item, ["text", "message", "summary", "output", "output_text", "outputText"]);
  }
}
