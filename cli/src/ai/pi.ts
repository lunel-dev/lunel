import { rm } from "fs/promises";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type SessionInfo as PiSessionInfo,
} from "@mariozechner/pi-coding-agent";
import type {
  AIProvider,
  AiEventEmitter,
  FileAttachment,
  MessageInfo,
  ModelSelector,
  ProviderInfo,
  SessionInfo,
  ShareInfo,
} from "./interface.js";

type PiMessageRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "bashExecution"
  | "custom"
  | "branchSummary"
  | "compactionSummary";

type PiContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "image"; data: string; mimeType: string };

type PiMessage = {
  role: PiMessageRole;
  timestamp?: number;
  content?: string | PiContentBlock[];
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  command?: string;
  output?: string;
  customType?: string;
  display?: boolean;
  summary?: string;
  [key: string]: unknown;
};

interface LivePiSession {
  session: AgentSession;
  sessionManager: SessionManager;
  unsubscribe: () => void;
  rawMessages: PiMessage[];
  lastMessages: LunelMessage[];
  createdAt: number;
}

interface LunelPart extends Record<string, unknown> {
  id: string;
  type: string;
}

interface LunelMessage extends MessageInfo {
  id: string;
  role: "user" | "assistant";
  parts: LunelPart[];
  time: {
    created: number;
    updated: number;
  };
}

interface LunelSession extends SessionInfo {
  id: string;
  title: string;
  time: {
    created: number;
    updated: number;
  };
}

const DEBUG_MODE = process.env.LUNEL_DEBUG === "1" || process.env.LUNEL_DEBUG_AI === "1";

function formatProviderLabel(provider: string): string {
  return provider
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function truncateTitle(text: string | undefined, fallback: string): string {
  const value = (text || "").trim();
  if (!value) return fallback;
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function extractDataUrlPayload(url: string): { data: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(url);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

export class PiProvider implements AIProvider {
  private emitter: AiEventEmitter | null = null;
  private readonly cwd = process.cwd();
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly settingsManager = SettingsManager.create(this.cwd);
  private readonly liveSessions = new Map<string, LivePiSession>();
  private readonly pendingSessions = new Map<string, { id: string; title: string; createdAt: number; filePath?: string }>();

  async init(): Promise<void> {
    this.modelRegistry.refresh();
  }

  async destroy(): Promise<void> {
    for (const live of this.liveSessions.values()) {
      live.unsubscribe();
      live.session.dispose();
    }
    this.liveSessions.clear();
    this.pendingSessions.clear();
  }

  subscribe(emitter: AiEventEmitter): () => void {
    this.emitter = emitter;
    return () => {
      this.emitter = null;
    };
  }

  setActiveSession(_sessionId: string): void {
    // Pi sessions are independently addressable; no extra active-session coordination needed.
  }

  async createSession(title?: string): Promise<{ session: SessionInfo }> {
    const sessionManager = SessionManager.create(this.cwd);
    const { session } = await createAgentSession({
      cwd: this.cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      sessionManager,
    });

    if (title?.trim()) {
      session.setSessionName(title.trim());
    }

    const live = this.attachLiveSession(session, sessionManager);
    const resolvedTitle = truncateTitle(session.sessionName, title?.trim() || "Conversation");
    const createdAt = Date.now();

    this.pendingSessions.set(session.sessionId, {
      id: session.sessionId,
      title: resolvedTitle,
      createdAt,
      filePath: session.sessionFile,
    });

    live.createdAt = createdAt;

    return {
      session: {
        id: session.sessionId,
        title: resolvedTitle,
        time: { created: createdAt, updated: createdAt },
      },
    };
  }

  async listSessions(): Promise<{ sessions: unknown }> {
    const listed = await SessionManager.list(this.cwd);
    const byId = new Map<string, LunelSession>();

    for (const item of listed) {
      byId.set(item.id, {
        id: item.id,
        title: truncateTitle(item.name || item.firstMessage, "Conversation"),
        time: {
          created: item.created.getTime(),
          updated: item.modified.getTime(),
        },
      });
    }

    for (const pending of this.pendingSessions.values()) {
      if (!byId.has(pending.id)) {
        byId.set(pending.id, {
          id: pending.id,
          title: pending.title,
          time: {
            created: pending.createdAt,
            updated: pending.createdAt,
          },
        });
      }
    }

    for (const [sessionId, live] of this.liveSessions.entries()) {
      const latestTimestamp = live.rawMessages.reduce((max, message) => {
        return typeof message.timestamp === "number" ? Math.max(max, message.timestamp) : max;
      }, live.createdAt);
      const existing = byId.get(sessionId);
      byId.set(sessionId, {
        id: sessionId,
        title: truncateTitle(live.session.sessionName || existing?.title, existing?.title || "Conversation"),
        time: {
          created: existing?.time?.created ?? live.createdAt,
          updated: latestTimestamp,
        },
      });
    }

    return { sessions: Array.from(byId.values()).sort((a, b) => (a.time?.updated ?? 0) - (b.time?.updated ?? 0)) };
  }

  async getSession(id: string): Promise<{ session: SessionInfo }> {
    const live = this.liveSessions.get(id);
    if (live) {
      const latestTimestamp = live.rawMessages.reduce((max, message) => {
        return typeof message.timestamp === "number" ? Math.max(max, message.timestamp) : max;
      }, live.createdAt);
      return {
        session: {
          id,
          title: truncateTitle(live.session.sessionName, "Conversation"),
          time: { created: live.createdAt, updated: latestTimestamp },
        } satisfies LunelSession,
      };
    }

    const sessions = await SessionManager.list(this.cwd);
    const found = sessions.find((entry) => entry.id === id);
    if (found) {
      return {
        session: {
          id: found.id,
          title: truncateTitle(found.name || found.firstMessage, "Conversation"),
          time: {
            created: found.created.getTime(),
            updated: found.modified.getTime(),
          },
        } satisfies LunelSession,
      };
    }

    const pending = this.pendingSessions.get(id);
    if (pending) {
      return {
        session: {
          id: pending.id,
          title: pending.title,
          time: { created: pending.createdAt, updated: pending.createdAt },
        } satisfies LunelSession,
      };
    }

    throw Object.assign(new Error(`Session ${id} not found`), { code: "ENOENT" });
  }

  async deleteSession(id: string): Promise<{ deleted: boolean }> {
    const live = this.liveSessions.get(id);
    const filePath = live?.session.sessionFile || this.pendingSessions.get(id)?.filePath || (await this.findSessionPath(id));

    if (live) {
      live.unsubscribe();
      live.session.dispose();
      this.liveSessions.delete(id);
    }
    this.pendingSessions.delete(id);

    if (filePath) {
      await rm(filePath, { force: true }).catch(() => {});
    }

    return { deleted: true };
  }

  async getMessages(sessionId: string): Promise<{ messages: MessageInfo[] }> {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      return { messages: this.transformMessages(sessionId, live.rawMessages) };
    }

    const sessionPath = await this.findSessionPath(sessionId);
    if (!sessionPath) {
      const pending = this.pendingSessions.get(sessionId);
      if (pending) return { messages: [] };
      throw Object.assign(new Error(`Session ${sessionId} not found`), { code: "ENOENT" });
    }

    const sessionManager = SessionManager.open(sessionPath);
    const context = sessionManager.buildSessionContext();
    return { messages: this.transformMessages(sessionId, context.messages as PiMessage[]) };
  }

  async prompt(
    sessionId: string,
    text: string,
    model?: ModelSelector,
    _agent?: string,
    files: FileAttachment[] = [],
  ): Promise<{ ack: true }> {
    const live = await this.ensureLiveSession(sessionId);

    if (model) {
      const selectedModel = live.session.modelRegistry.find(model.providerID, model.modelID);
      if (!selectedModel) {
        throw new Error(`Pi model not found: ${model.providerID}/${model.modelID}`);
      }
      if (live.session.model?.provider !== selectedModel.provider || live.session.model?.id !== selectedModel.id) {
        await live.session.setModel(selectedModel);
      }
    }

    const images = files
      .map((file) => extractDataUrlPayload(file.url))
      .filter((value): value is { data: string; mimeType: string } => value != null)
      .map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));

    void live.session.prompt(text, { images }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.emitter?.({
        type: "prompt_error",
        properties: { sessionId, error: message },
      });
    });

    return { ack: true };
  }

  async abort(sessionId: string): Promise<Record<string, never>> {
    const live = await this.ensureLiveSession(sessionId);
    await live.session.abort();
    this.emitter?.({
      type: "session.status",
      properties: { status: { type: "idle" }, sessionID: sessionId },
    });
    return {};
  }

  async agents(): Promise<{ agents: unknown }> {
    return { agents: [] };
  }

  async providers(): Promise<ProviderInfo> {
    this.modelRegistry.refresh();

    const allModels = this.modelRegistry.getAll() as Array<{
      id: string;
      name: string;
      provider: string;
    }>;

    const grouped = new Map<string, Array<{ id: string; name: string; provider: string }>>();
    for (const model of allModels) {
      const current = grouped.get(model.provider) || [];
      current.push(model);
      grouped.set(model.provider, current);
    }

    const providers = Array.from(grouped.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([providerId, models]) => {
        const configured = this.authStorage.hasAuth(providerId);
        return {
          id: providerId,
          name: formatProviderLabel(providerId),
          key: configured,
          source: configured && !this.authStorage.has(providerId) ? "env" : "manual",
          models: configured
            ? Object.fromEntries(
                models
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((model) => [
                    model.id,
                    {
                      id: model.id,
                      name: model.name || model.id,
                      provider: providerId,
                    },
                  ])
              )
            : {},
        };
      });

    const defaultProvider = this.settingsManager.getDefaultProvider();
    const defaultModel = this.settingsManager.getDefaultModel();

    return {
      providers,
      default: defaultProvider && defaultModel ? { [defaultProvider]: defaultModel } : {},
    };
  }

  async setAuth(providerId: string, key: string): Promise<Record<string, never>> {
    this.authStorage.set(providerId, { type: "api_key", key });
    this.modelRegistry.refresh();
    return {};
  }

  async command(_sessionId: string, _command: string, _args: string): Promise<{ result: unknown }> {
    throw new Error("Pi slash command execution is not supported by Lunel yet");
  }

  async revert(_sessionId: string, _messageId: string): Promise<Record<string, never>> {
    throw new Error("Pi undo is not supported by Lunel yet");
  }

  async unrevert(_sessionId: string): Promise<Record<string, never>> {
    throw new Error("Pi redo is not supported by Lunel yet");
  }

  async share(_sessionId: string): Promise<{ share: ShareInfo }> {
    return { share: { url: null } };
  }

  async permissionReply(
    _sessionId: string,
    _permissionId: string,
    _response: "once" | "always" | "reject",
  ): Promise<Record<string, never>> {
    throw new Error("Pi permission prompts are not supported by Lunel yet");
  }

  async questionReply(
    _sessionId: string,
    _questionId: string,
    _answers: string[][],
  ): Promise<Record<string, never>> {
    throw new Error("Pi question replies are not supported by Lunel yet");
  }

  async questionReject(_sessionId: string, _questionId: string): Promise<Record<string, never>> {
    throw new Error("Pi question rejection is not supported by Lunel yet");
  }

  private attachLiveSession(session: AgentSession, sessionManager: SessionManager): LivePiSession {
    const live: LivePiSession = {
      session,
      sessionManager,
      unsubscribe: () => {},
      rawMessages: [...(session.messages as PiMessage[])],
      lastMessages: this.transformMessages(session.sessionId, session.messages as PiMessage[]),
      createdAt: Date.now(),
    };

    live.unsubscribe = session.subscribe((event) => this.handleSessionEvent(live, event));
    this.liveSessions.set(session.sessionId, live);
    return live;
  }

  private async ensureLiveSession(sessionId: string): Promise<LivePiSession> {
    const existing = this.liveSessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const sessionPath = this.pendingSessions.get(sessionId)?.filePath || (await this.findSessionPath(sessionId));
    if (!sessionPath) {
      throw Object.assign(new Error(`Session ${sessionId} not found`), { code: "ENOENT" });
    }

    const sessionManager = SessionManager.open(sessionPath);
    const { session } = await createAgentSession({
      cwd: this.cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      sessionManager,
    });

    const live = this.attachLiveSession(session, sessionManager);
    const context = sessionManager.buildSessionContext();
    live.rawMessages = [...(context.messages as PiMessage[])];
    live.lastMessages = this.transformMessages(session.sessionId, live.rawMessages);
    return live;
  }

  private async findSessionPath(sessionId: string): Promise<string | undefined> {
    const sessions = await SessionManager.list(this.cwd);
    const match = sessions.find((entry) => entry.id === sessionId);
    return match?.path;
  }

  private handleSessionEvent(live: LivePiSession, event: AgentSessionEvent): void {
    const sessionId = live.session.sessionId;

    if (event.type === "turn_start" || event.type === "agent_start") {
      this.emitter?.({
        type: "session.status",
        properties: { status: { type: "busy" }, sessionID: sessionId },
      });
    }

    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      this.upsertRawMessage(live, event.message as PiMessage);
      this.emitMessagesDiff(live);

      const assistantMessage = event.message as PiMessage;
      if (
        assistantMessage.role === "assistant" &&
        (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") &&
        assistantMessage.errorMessage
      ) {
        this.emitter?.({
          type: "prompt_error",
          properties: { sessionId, error: assistantMessage.errorMessage },
        });
      }
    }

    if (event.type === "turn_end" || event.type === "agent_end") {
      live.rawMessages = [...(live.session.messages as PiMessage[])];
      this.emitMessagesDiff(live);
      this.emitter?.({
        type: "session.status",
        properties: { status: { type: "idle" }, sessionID: sessionId },
      });
    }
  }

  private upsertRawMessage(live: LivePiSession, message: PiMessage): void {
    const nextKey = this.getRawMessageKey(message, 0);
    const index = live.rawMessages.findIndex((entry, position) => this.getRawMessageKey(entry, position) === nextKey);

    if (index === -1) {
      live.rawMessages = [...live.rawMessages, message];
      return;
    }

    const next = [...live.rawMessages];
    next[index] = message;
    live.rawMessages = next;
  }

  private emitMessagesDiff(live: LivePiSession): void {
    const sessionId = live.session.sessionId;
    const nextMessages = this.transformMessages(sessionId, live.rawMessages);
    const previousById = new Map(live.lastMessages.map((message) => [message.id, JSON.stringify(message)]));

    const sessionTitle = truncateTitle(
      live.session.sessionName || this.pendingSessions.get(sessionId)?.title,
      "Conversation"
    );
    const updatedAt = nextMessages.reduce((max, message) => {
      return typeof message.time?.updated === "number" ? Math.max(max, message.time.updated) : max;
    }, live.createdAt);

    this.emitter?.({
      type: "session.updated",
      properties: {
        info: {
          id: sessionId,
          title: sessionTitle,
          time: {
            created: live.createdAt,
            updated: updatedAt,
          },
        },
      },
    });

    for (const message of nextMessages) {
      const serialized = JSON.stringify(message);
      if (previousById.get(message.id) === serialized) {
        continue;
      }

      this.emitter?.({
        type: "message.updated",
        properties: {
          info: {
            id: message.id,
            sessionID: sessionId,
            role: message.role,
            time: message.time,
          },
        },
      });

      for (let index = 0; index < message.parts.length; index += 1) {
        const part = message.parts[index] as Record<string, unknown>;
        this.emitter?.({
          type: "message.part.updated",
          properties: {
            message: {
              id: message.id,
              sessionID: sessionId,
              role: message.role,
            },
            part: {
              ...part,
              id: part.id ?? `${message.id}:part:${index}`,
              sessionID: sessionId,
              messageID: message.id,
            },
          },
        });
      }
    }

    live.lastMessages = nextMessages;
  }

  private transformMessages(sessionId: string, rawMessages: PiMessage[]): LunelMessage[] {
    const occurrenceCounts = new Map<string, number>();
    const transformed: LunelMessage[] = [];

    for (const rawMessage of rawMessages) {
      if (rawMessage.role === "custom" && rawMessage.display === false) {
        continue;
      }

      const baseId = this.getRawMessageKey(rawMessage, 0);
      const occurrence = occurrenceCounts.get(baseId) ?? 0;
      occurrenceCounts.set(baseId, occurrence + 1);
      const messageId = occurrence === 0 ? baseId : `${baseId}:${occurrence}`;
      const timestamp = typeof rawMessage.timestamp === "number" ? rawMessage.timestamp : Date.now();

      if (rawMessage.role === "user") {
        transformed.push({
          id: messageId,
          role: "user",
          parts: this.transformUserParts(messageId, rawMessage),
          time: { created: timestamp, updated: timestamp },
        });
        continue;
      }

      if (rawMessage.role === "assistant") {
        transformed.push({
          id: messageId,
          role: "assistant",
          parts: this.transformAssistantParts(messageId, rawMessage),
          time: { created: timestamp, updated: timestamp },
        });
        continue;
      }

      if (rawMessage.role === "toolResult") {
        transformed.push({
          id: messageId,
          role: "assistant",
          parts: [
            {
              id: `${messageId}:tool`,
              type: "tool-result",
              name: rawMessage.toolName || "tool",
              toolName: rawMessage.toolName || "tool",
              output: Array.isArray(rawMessage.content)
                ? rawMessage.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n")
                : "",
              state: rawMessage.isError ? "error" : "completed",
            },
          ],
          time: { created: timestamp, updated: timestamp },
        });
        continue;
      }

      if (rawMessage.role === "bashExecution") {
        transformed.push({
          id: messageId,
          role: "assistant",
          parts: [
            {
              id: `${messageId}:bash`,
              type: "tool-result",
              name: "bash",
              toolName: "bash",
              input: { command: rawMessage.command },
              output: rawMessage.output || "",
              state: "completed",
            },
          ],
          time: { created: timestamp, updated: timestamp },
        });
        continue;
      }

      if (rawMessage.role === "branchSummary" || rawMessage.role === "compactionSummary") {
        transformed.push({
          id: messageId,
          role: "assistant",
          parts: [{ id: `${messageId}:summary`, type: "text", text: String(rawMessage.summary || "") }],
          time: { created: timestamp, updated: timestamp },
        });
        continue;
      }

      if (rawMessage.role === "custom") {
        const text = typeof rawMessage.content === "string"
          ? rawMessage.content
          : Array.isArray(rawMessage.content)
            ? rawMessage.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n")
            : "";

        transformed.push({
          id: messageId,
          role: "assistant",
          parts: [{ id: `${messageId}:custom`, type: "text", text }],
          time: { created: timestamp, updated: timestamp },
        });
      }
    }

    return transformed;
  }

  private transformUserParts(messageId: string, rawMessage: PiMessage): LunelPart[] {
    if (typeof rawMessage.content === "string") {
      return [{ id: `${messageId}:text:0`, type: "text", text: rawMessage.content }];
    }

    if (!Array.isArray(rawMessage.content)) {
      return [];
    }

    const parts: LunelPart[] = [];
    rawMessage.content.forEach((block, index) => {
      if (block.type === "text") {
        parts.push({ id: `${messageId}:text:${index}`, type: "text", text: block.text });
        return;
      }
      if (block.type === "image") {
        parts.push({
          id: `${messageId}:file:${index}`,
          type: "file",
          mime: block.mimeType,
          filename: `image-${index + 1}`,
          url: `data:${block.mimeType};base64,${block.data}`,
        });
      }
    });
    return parts;
  }

  private transformAssistantParts(messageId: string, rawMessage: PiMessage): LunelPart[] {
    const usage = rawMessage.usage || {};
    const tokens = {
      input: usage.input,
      output: usage.output,
      cache: {
        read: usage.cacheRead,
        write: usage.cacheWrite,
      },
    };

    const blocks = Array.isArray(rawMessage.content) ? rawMessage.content : [];
    const parts: LunelPart[] = [];
    blocks.forEach((block, index) => {
      if (block.type === "text") {
        parts.push({
          id: `${messageId}:text:${index}`,
          type: "text",
          text: block.text,
        });
        return;
      }
      if (block.type === "thinking") {
        parts.push({
          id: `${messageId}:thinking:${index}`,
          type: "reasoning",
          text: block.thinking,
          reasoning: block.thinking,
        });
        return;
      }
      if (block.type === "toolCall") {
        parts.push({
          id: `${messageId}:tool:${block.id || index}`,
          type: "tool-call",
          name: block.name,
          toolName: block.name,
          input: block.arguments,
          state: "completed",
        });
      }
    });

    if (parts.length === 0 && rawMessage.errorMessage) {
      parts.push({
        id: `${messageId}:error`,
        type: "text",
        text: rawMessage.errorMessage,
      });
    }

    if (parts.length > 0) {
      const lastPart = parts[parts.length - 1];
      lastPart.tokens = tokens;
      lastPart.cost = rawMessage.usage?.cost?.total;
    }

    return parts;
  }

  private getRawMessageKey(message: PiMessage, index: number): string {
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : index;
    if (message.role === "toolResult") {
      return `toolResult:${message.toolCallId || message.toolName || "tool"}:${timestamp}`;
    }
    return `${message.role}:${timestamp}`;
  }
}
