// Claude AI provider — wraps `claude -p --output-format stream-json`.
// Uses Claude Code's persisted per-project JSONL history for session listing
// and message hydration.

import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { assertCliCommandReady, resolveCliCommand } from "./command-resolution.js";
import type {
  AIProvider,
  AiEventEmitter,
  CodexPromptOptions,
  FileAttachment,
  MessageInfo,
  ModelSelector,
  ProviderInfo,
  SessionInfo,
  ShareInfo,
} from "./interface.js";

const DEBUG_MODE = process.env.LUNEL_DEBUG === "1" || process.env.LUNEL_DEBUG_AI === "1";
const WINDOWS_SPAWN_OPTIONS = process.platform === "win32"
  ? { shell: true as const }
  : {};

type ClaudeAgent = {
  name: string;
  description?: string;
  mode: string;
};

type ClaudeSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  materialized: boolean;
  messages: MessageInfo[];
};

type ClaudeToolUse = {
  name: string;
  input: unknown;
};

type PromptRunState = {
  stderr: string[];
  resultError: string | null;
};

type StoredMessage = Omit<MessageInfo, "parts" | "time"> & {
  parts: Record<string, unknown>[];
  time: {
    created: number;
    updated: number;
  };
  _sortKey: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitizeProjectRoot(rootDir: string): string {
  return rootDir.replace(/[^A-Za-z0-9._-]/g, "-");
}

function buildProjectStorageDir(rootDir: string): string {
  return path.join(os.homedir(), ".claude", "projects", sanitizeProjectRoot(rootDir));
}

function summarizePrompt(prompt: string | undefined, fallback: string): string {
  const normalized = (prompt || "").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content.replace(/\r?\n$/, "");
  }

  if (!Array.isArray(content)) return "";

  const parts = content
    .map((block) => {
      const record = asRecord(block);
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter((value) => value.trim().length > 0);

  return parts.join("\n").replace(/\r?\n$/, "");
}

function formatToolResultOutput(
  block: Record<string, unknown>,
  toolUseResult: Record<string, unknown>,
): string {
  const directContent = block.content;
  if (typeof directContent === "string" && directContent.trim()) {
    return directContent.trim();
  }

  if (Array.isArray(directContent)) {
    const text = extractTextFromContent(directContent);
    if (text.trim()) return text.trim();
  }

  const file = asRecord(toolUseResult.file);
  const filePath = readString(file.filePath);
  const fileContent = readString(file.content);
  const lines: string[] = [];
  if (filePath) lines.push(filePath);
  if (fileContent) lines.push(fileContent);
  if (lines.length > 0) {
    return lines.join("\n");
  }

  const rendered = JSON.stringify(toolUseResult, null, 2);
  return rendered === "{}" ? "" : rendered;
}

function createStoredMessage(id: string, role: string, sortKey: number, createdAt?: number): StoredMessage {
  const timestamp = typeof createdAt === "number" ? createdAt : Date.now();
  return {
    id,
    role,
    parts: [],
    time: {
      created: timestamp,
      updated: timestamp,
    },
    _sortKey: sortKey,
  };
}

function pushPart(message: StoredMessage, part: Record<string, unknown>): void {
  const partId = readString(part.id);
  if (partId && message.parts.some((existing) => readString(asRecord(existing).id) === partId)) {
    return;
  }
  message.parts.push(part);
}

function extractAssistantParts(
  messageId: string,
  content: unknown[],
  toolUses: Map<string, ClaudeToolUse>,
): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];

  for (let index = 0; index < content.length; index += 1) {
    const block = asRecord(content[index]);
    const blockType = readString(block.type);
    if (blockType === "text") {
      const text = readString(block.text);
      if (text) {
        parts.push({
          id: `${messageId}:text:${index}`,
          type: "text",
          text,
        });
      }
      continue;
    }

    if (blockType === "thinking") {
      const thinking = readString(block.thinking);
      if (thinking) {
        parts.push({
          id: `${messageId}:thinking:${index}`,
          type: "reasoning",
          text: thinking,
          reasoning: thinking,
        });
      }
      continue;
    }

    if (blockType === "tool_use") {
      const toolId = readString(block.id) ?? `${messageId}:tool:${index}`;
      const toolName = readString(block.name) ?? "tool";
      const input = block.input;
      toolUses.set(toolId, { name: toolName, input });
      parts.push({
        id: toolId,
        type: "tool-call",
        name: toolName,
        toolName,
        input,
        state: "completed",
      });
    }
  }

  return parts;
}

async function moveIfExists(sourcePath: string, destinationPath: string): Promise<void> {
  if (!(await fileExists(sourcePath))) return;
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fs.rm(destinationPath, { recursive: true, force: true });
  } catch {
    // best effort cleanup before rename
  }
  await fs.rename(sourcePath, destinationPath);
}

export class ClaudeProvider implements AIProvider {
  private readonly claudeCommand = resolveCliCommand("claude");
  private emitter: AiEventEmitter | null = null;
  private sessions = new Map<string, ClaudeSession>();
  private deletedSessionIds = new Set<string>();
  private runningPrompts = new Map<string, ChildProcess>();
  private abortedSessionIds = new Set<string>();
  private readonly rootDir = process.cwd();
  private readonly projectStorageDir = buildProjectStorageDir(this.rootDir);

  async init(): Promise<void> {
    assertCliCommandReady("claude");
    const version = this.runClaudeCommand(["--version"]).trim();
    if (!version) {
      throw Object.assign(new Error("Claude Code CLI did not return a version"), {
        code: "EAI_BINARY_NOT_EXECUTABLE",
      });
    }
    await fs.mkdir(this.projectStorageDir, { recursive: true });
    if (DEBUG_MODE) {
      console.log(`[claude] Ready (${version}) using ${this.projectStorageDir}`);
    }
  }

  async destroy(): Promise<void> {
    for (const [sessionId, proc] of this.runningPrompts.entries()) {
      this.abortedSessionIds.add(sessionId);
      proc.kill();
    }
    this.runningPrompts.clear();
  }

  subscribe(emitter: AiEventEmitter): () => void {
    this.emitter = emitter;
    return () => {
      if (this.emitter === emitter) {
        this.emitter = null;
      }
    };
  }

  async createSession(title?: string): Promise<{ session: SessionInfo }> {
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const session: ClaudeSession = {
      id: sessionId,
      title: title?.trim() || "Claude",
      createdAt: now,
      updatedAt: now,
      cwd: this.rootDir,
      materialized: false,
      messages: [],
    };
    this.sessions.set(sessionId, session);
    return { session: this.toSessionInfo(session) };
  }

  async listSessions(): Promise<{ sessions: unknown }> {
    await this.syncSessionsFromDisk();

    const sessions = Array.from(this.sessions.values())
      .filter((session) => !this.deletedSessionIds.has(session.id))
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .map((session) => this.toSessionInfo(session));

    return { sessions };
  }

  async getSession(id: string): Promise<{ session: SessionInfo }> {
    const session = await this.getOrLoadSession(id);
    return { session: this.toSessionInfo(session) };
  }

  async deleteSession(id: string): Promise<{ deleted: boolean }> {
    this.deletedSessionIds.add(id);
    this.sessions.delete(id);

    const trashDir = path.join(this.projectStorageDir, ".lunel-trash");
    await moveIfExists(this.getSessionFilePath(id), path.join(trashDir, `${id}.jsonl`));
    await moveIfExists(this.getSessionDirectoryPath(id), path.join(trashDir, id));

    this.emitter?.({
      type: "session.deleted",
      properties: { info: { id } },
    });
    return { deleted: true };
  }

  async renameSession(id: string, title: string): Promise<{ session: SessionInfo }> {
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("Session title cannot be empty");
    }

    const session = await this.getOrLoadSession(id);
    session.title = nextTitle;
    session.updatedAt = Date.now();

    if (await fileExists(this.getSessionFilePath(id))) {
      const payload = [
        JSON.stringify({ type: "custom-title", customTitle: nextTitle, sessionId: id }),
        JSON.stringify({ type: "agent-name", agentName: nextTitle, sessionId: id }),
      ].join("\n");
      await fs.appendFile(this.getSessionFilePath(id), `${payload}\n`, "utf8");
      session.materialized = true;
    }

    this.emitter?.({
      type: "session.updated",
      properties: {
        info: {
          id: session.id,
          title: session.title,
          time: {
            created: session.createdAt,
            updated: session.updatedAt,
          },
        },
      },
    });

    return { session: this.toSessionInfo(session) };
  }

  async getMessages(sessionId: string): Promise<{ messages: MessageInfo[] }> {
    const session = await this.getOrLoadSession(sessionId);
    if (!(await fileExists(this.getSessionFilePath(sessionId)))) {
      return { messages: session.messages };
    }

    session.messages = await this.readMessagesFromDisk(sessionId);
    session.materialized = true;
    return { messages: session.messages };
  }

  async prompt(
    sessionId: string,
    text: string,
    model?: ModelSelector,
    agent?: string,
    files: FileAttachment[] = [],
    _codexOptions?: CodexPromptOptions,
  ): Promise<{ ack: true }> {
    if (files.length > 0) {
      throw new Error("Claude file attachments are not supported by Lunel yet");
    }
    if (this.runningPrompts.has(sessionId)) {
      throw new Error("Claude is already running for this session");
    }

    const session = await this.getOrLoadSession(sessionId);
    session.updatedAt = Date.now();
    if (!session.title || session.title === "Claude") {
      session.title = summarizePrompt(text, "Claude");
    }

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ];

    if (model?.modelID) {
      args.push("--model", model.modelID);
    }
    if (agent) {
      args.push("--agent", agent);
    }

    const sessionFilePath = this.getSessionFilePath(session.id);
    const sessionExistsOnDisk = session.materialized || await fileExists(sessionFilePath);
    if (sessionExistsOnDisk) {
      args.push("-r", session.id);
    } else {
      args.push("--session-id", session.id);
      if (session.title.trim()) {
        args.push("-n", session.title.trim());
      }
    }

    const proc = spawn(this.claudeCommand, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      ...WINDOWS_SPAWN_OPTIONS,
    });
    this.runningPrompts.set(session.id, proc);

    const runState: PromptRunState = {
      stderr: [],
      resultError: null,
    };

    this.emitSessionStatus(session.id, "busy");

    const stdoutReader = createInterface({ input: proc.stdout! });
    stdoutReader.on("line", (line) => {
      this.handleStreamLine(session, line, runState);
    });

    proc.stderr?.on("data", (chunk) => {
      runState.stderr.push(String(chunk));
    });

    proc.on("error", (err) => {
      runState.resultError = err.message;
    });

    proc.on("exit", async (code) => {
      this.runningPrompts.delete(session.id);
      const aborted = this.abortedSessionIds.delete(session.id);
      const stderrText = runState.stderr.join("").trim();

      if (aborted) {
        this.emitSessionIdle(session.id);
        return;
      }

      if (code === 0 && !runState.resultError) {
        try {
          const diskSummary = await this.readSessionSummaryFromDisk(session.id);
          const refreshed = diskSummary ?? await this.getOrLoadSession(session.id);
          refreshed.materialized = true;
          refreshed.messages = await this.readMessagesFromDisk(session.id);
          this.sessions.set(session.id, refreshed);
          this.emitter?.({
            type: "session.updated",
            properties: {
              info: {
                id: refreshed.id,
                title: refreshed.title,
                time: {
                  created: refreshed.createdAt,
                  updated: refreshed.updatedAt,
                },
              },
            },
          });
        } catch (err) {
          if (DEBUG_MODE) {
            console.warn("[claude] Failed to refresh messages:", (err as Error).message);
          }
        }
        this.emitSessionIdle(session.id);
        return;
      }

      const errorMessage = runState.resultError || stderrText || `Claude exited with code ${code}`;
      this.emitter?.({
        type: "prompt_error",
        properties: {
          sessionId: session.id,
          error: errorMessage,
        },
      });
      this.emitSessionIdle(session.id);
    });

    proc.stdin?.write(text);
    proc.stdin?.end();

    return { ack: true };
  }

  async abort(sessionId: string): Promise<Record<string, never>> {
    const proc = this.runningPrompts.get(sessionId);
    if (!proc) {
      throw new Error(`Claude session ${sessionId} is not running`);
    }
    this.abortedSessionIds.add(sessionId);
    proc.kill();
    return {};
  }

  async agents(): Promise<{ agents: unknown }> {
    const output = this.runClaudeCommand(["agents"]);
    const agents: ClaudeAgent[] = [];

    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s{2}(.+?)\s+·\s+(.+?)\s*$/);
      if (!match) continue;
      const name = match[1].trim();
      const source = match[2].trim();
      agents.push({
        name,
        mode: name,
        description: source === "inherit" ? undefined : source,
      });
    }

    return { agents };
  }

  async providers(): Promise<ProviderInfo> {
    let source = "oauth";
    try {
      const parsed = JSON.parse(this.runClaudeCommand(["auth", "status"])) as Record<string, unknown>;
      const authMethod = readString(parsed.authMethod);
      if (authMethod?.toLowerCase().includes("api")) {
        source = "env";
      } else if (authMethod) {
        source = authMethod;
      }
    } catch {
      // Keep a reasonable default even when auth status is unavailable.
    }

    return {
      providers: [{
        id: "claude",
        name: "Claude Code",
        source,
        models: {
          sonnet: { id: "sonnet", name: "Sonnet", provider: "claude" },
          opus: { id: "opus", name: "Opus", provider: "claude" },
          haiku: { id: "haiku", name: "Haiku", provider: "claude" },
        },
      }],
      default: { claude: "sonnet" },
    };
  }

  async setAuth(_providerId: string, _key: string): Promise<Record<string, never>> {
    throw new Error("Claude auth configuration is not supported by Lunel yet. Run `claude auth login` on your PC.");
  }

  async command(_sessionId: string, _command: string, _args: string): Promise<{ result: unknown }> {
    throw new Error("Claude command execution is not supported by Lunel yet");
  }

  async revert(_sessionId: string, _messageId: string): Promise<Record<string, never>> {
    throw new Error("Claude undo is not supported by Lunel yet");
  }

  async unrevert(_sessionId: string): Promise<Record<string, never>> {
    throw new Error("Claude redo is not supported by Lunel yet");
  }

  async share(_sessionId: string): Promise<{ share: ShareInfo }> {
    return { share: { url: null } };
  }

  async permissionReply(
    _sessionId: string,
    _permissionId: string,
    _response: "once" | "always" | "reject",
  ): Promise<Record<string, never>> {
    throw new Error("Claude permission prompts are not supported by Lunel yet");
  }

  async questionReply(
    _sessionId: string,
    _questionId: string,
    _answers: string[][],
  ): Promise<Record<string, never>> {
    throw new Error("Claude structured user input is not supported by Lunel yet");
  }

  async questionReject(
    _sessionId: string,
    _questionId: string,
  ): Promise<Record<string, never>> {
    throw new Error("Claude structured user input is not supported by Lunel yet");
  }

  private emitSessionStatus(sessionId: string, type: "busy" | "idle"): void {
    this.emitter?.({
      type: type === "idle" ? "session.idle" : "session.status",
      properties: type === "idle"
        ? { sessionID: sessionId }
        : { sessionID: sessionId, status: { type } },
    });
  }

  private emitSessionIdle(sessionId: string): void {
    this.emitSessionStatus(sessionId, "idle");
  }

  private emitAssistantMessage(
    sessionId: string,
    messageId: string,
    role: "assistant" | "user",
    part: Record<string, unknown>,
  ): void {
    const now = Date.now();
    this.emitter?.({
      type: "message.updated",
      properties: {
        info: {
          sessionID: sessionId,
          id: messageId,
          role,
          time: {
            created: now,
            updated: now,
          },
        },
      },
    });
    this.emitter?.({
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        messageID: messageId,
        part,
      },
    });
  }

  private handleStreamLine(session: ClaudeSession, line: string, runState: PromptRunState): void {
    const record = parseJsonLine(line);
    if (!record) return;

    const recordType = readString(record.type);
    if (recordType === "assistant") {
      const message = asRecord(record.message);
      const messageId = readString(message.id) ?? crypto.randomUUID();
      const content = Array.isArray(message.content) ? message.content : [];
      const toolUses = new Map<string, ClaudeToolUse>();
      for (const part of extractAssistantParts(messageId, content, toolUses)) {
        this.emitAssistantMessage(session.id, messageId, "assistant", part);
      }
      return;
    }

    if (recordType === "user") {
      const message = asRecord(record.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (let index = 0; index < content.length; index += 1) {
        const block = asRecord(content[index]);
        if (readString(block.type) !== "tool_result") continue;
        const toolUseId = readString(block.tool_use_id) ?? readString(block.toolUseId) ?? `${session.id}:tool-result:${index}`;
        const toolUseResult = asRecord(record.tool_use_result);
        const output = formatToolResultOutput(block, toolUseResult);
        const messageId = `${toolUseId}:result`;
        this.emitAssistantMessage(session.id, messageId, "assistant", {
          id: `${messageId}:part`,
          type: "tool-result",
          name: readString(toolUseResult.name) ?? "tool",
          toolName: readString(toolUseResult.name) ?? "tool",
          output,
          state: "completed",
        });
      }
      return;
    }

    if (recordType === "result" && record.subtype === "error") {
      runState.resultError = readString(record.result) ?? "Claude request failed";
    }
  }

  private runClaudeCommand(args: string[]): string {
    const result = spawnSync(this.claudeCommand, args, {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
      ...WINDOWS_SPAWN_OPTIONS,
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      const errorText = (result.stderr || result.stdout || `Claude command failed (${result.status})`).trim();
      throw new Error(errorText);
    }

    return result.stdout || "";
  }

  private getSessionFilePath(sessionId: string): string {
    return path.join(this.projectStorageDir, `${sessionId}.jsonl`);
  }

  private getSessionDirectoryPath(sessionId: string): string {
    return path.join(this.projectStorageDir, sessionId);
  }

  private async syncSessionsFromDisk(): Promise<void> {
    const entries = await fs.readdir(this.projectStorageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = entry.name.slice(0, -".jsonl".length);
      if (this.deletedSessionIds.has(sessionId)) continue;
      const summary = await this.readSessionSummaryFromDisk(sessionId);
      if (!summary) continue;
      const existing = this.sessions.get(sessionId);
      this.sessions.set(sessionId, existing
        ? {
            ...existing,
            ...summary,
            messages: existing.messages.length > 0 ? existing.messages : summary.messages,
          }
        : summary);
    }
  }

  private async getOrLoadSession(sessionId: string): Promise<ClaudeSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const summary = await this.readSessionSummaryFromDisk(sessionId);
    if (!summary) {
      throw Object.assign(new Error(`Session ${sessionId} not found`), { code: "ENOENT" });
    }
    this.sessions.set(sessionId, summary);
    return summary;
  }

  private async readSessionSummaryFromDisk(sessionId: string): Promise<ClaudeSession | null> {
    const filePath = this.getSessionFilePath(sessionId);
    if (!(await fileExists(filePath))) return null;

    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    let title = "";
    let lastPrompt = "";
    let createdAt: number | undefined;
    let updatedAt: number | undefined;
    let cwd = this.rootDir;

    for (const line of lines) {
      if (!line.trim()) continue;
      const record = parseJsonLine(line);
      if (!record) continue;

      const timestamp = parseTimestamp(record.timestamp);
      if (timestamp != null) {
        createdAt = createdAt == null ? timestamp : Math.min(createdAt, timestamp);
        updatedAt = updatedAt == null ? timestamp : Math.max(updatedAt, timestamp);
      }

      const nextCwd = readString(record.cwd);
      if (nextCwd) cwd = nextCwd;

      if (record.type === "custom-title") {
        title = readString(record.customTitle) ?? title;
        continue;
      }

      if (!title && record.type === "agent-name") {
        title = readString(record.agentName) ?? title;
        continue;
      }

      if (record.type === "last-prompt") {
        lastPrompt = readString(record.lastPrompt) ?? lastPrompt;
        continue;
      }

      if (!lastPrompt && record.type === "user") {
        const message = asRecord(record.message);
        lastPrompt = extractTextFromContent(message.content) || lastPrompt;
      }
    }

    const stats = await fs.stat(filePath);
    return {
      id: sessionId,
      title: title || summarizePrompt(lastPrompt, "Claude"),
      createdAt: createdAt ?? stats.birthtimeMs ?? stats.mtimeMs,
      updatedAt: updatedAt ?? stats.mtimeMs ?? stats.birthtimeMs,
      cwd,
      materialized: true,
      messages: [],
    };
  }

  private async readMessagesFromDisk(sessionId: string): Promise<MessageInfo[]> {
    const filePath = this.getSessionFilePath(sessionId);
    if (!(await fileExists(filePath))) return [];

    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    const toolUses = new Map<string, ClaudeToolUse>();
    const orderedMessages = new Map<string, StoredMessage>();
    let sortCounter = 0;

    const ensureMessage = (id: string, role: string, timestamp?: number): StoredMessage => {
      const existing = orderedMessages.get(id);
      if (existing) {
        if (timestamp != null && existing.time) {
          existing.time.updated = Math.max(existing.time.updated, timestamp);
          existing.time.created = Math.min(existing.time.created, timestamp);
        }
        return existing;
      }

      const created = timestamp ?? Date.now();
      const message = createStoredMessage(id, role, sortCounter, created);
      sortCounter += 1;
      orderedMessages.set(id, message);
      return message;
    };

    for (const line of lines) {
      if (!line.trim()) continue;
      const record = parseJsonLine(line);
      if (!record) continue;

      const timestamp = parseTimestamp(record.timestamp);
      if (record.type === "assistant") {
        const message = asRecord(record.message);
        const messageId = readString(message.id) ?? readString(record.uuid) ?? `assistant-${sortCounter}`;
        const stored = ensureMessage(messageId, "assistant", timestamp);
        const parts = extractAssistantParts(
          messageId,
          Array.isArray(message.content) ? message.content : [],
          toolUses,
        );
        for (const part of parts) {
          pushPart(stored, part);
        }
        continue;
      }

      if (record.type !== "user") continue;

      const message = asRecord(record.message);
      const messageRole = readString(message.role);
      if (messageRole !== "user") continue;

      const text = extractTextFromContent(message.content);
      if (text.trim()) {
        const messageId = readString(record.promptId) ?? readString(record.uuid) ?? `user-${sortCounter}`;
        const stored = ensureMessage(messageId, "user", timestamp);
        pushPart(stored, {
          id: `${messageId}:text`,
          type: "text",
          text,
        });
      }

      if (!Array.isArray(message.content)) continue;

      for (let index = 0; index < message.content.length; index += 1) {
        const block = asRecord(message.content[index]);
        if (readString(block.type) !== "tool_result") continue;

        const toolUseId = readString(block.tool_use_id) ?? readString(block.toolUseId) ?? `${sortCounter}:tool`;
        const toolUse = toolUses.get(toolUseId);
        const toolUseResult = asRecord(record.tool_use_result);
        const syntheticMessageId = `${toolUseId}:result`;
        const stored = ensureMessage(syntheticMessageId, "assistant", timestamp);
        pushPart(stored, {
          id: `${syntheticMessageId}:part`,
          type: "tool-result",
          name: toolUse?.name ?? "tool",
          toolName: toolUse?.name ?? "tool",
          input: toolUse?.input,
          output: formatToolResultOutput(block, toolUseResult),
          state: "completed",
        });
      }
    }

    return Array.from(orderedMessages.values())
      .sort((left, right) => left._sortKey - right._sortKey)
      .map(({ _sortKey, ...message }) => message);
  }

  private toSessionInfo(session: ClaudeSession): SessionInfo {
    return {
      id: session.id,
      title: session.title,
      time: {
        created: session.createdAt,
        updated: session.updatedAt,
      },
      cwd: session.cwd,
    };
  }
}
