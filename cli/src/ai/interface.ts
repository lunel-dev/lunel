// Shared types for AI provider abstraction.
// No runtime imports — pure TypeScript types only.

export interface AiEvent {
  type: string;
  properties: Record<string, unknown>;
}

// Callback the provider calls to push events to the mobile app.
export type AiEventEmitter = (event: AiEvent) => void;

export interface ModelSelector {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface CodexPromptOptions {
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  speed?: "fast" | "balanced" | "quality";
}

export interface FileAttachment {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
}

export interface MessageInfo {
  id: string;
  role: string;
  parts: unknown[];
  time: unknown;
}

export interface SessionInfo {
  [key: string]: unknown;
}

export interface ShareInfo {
  [key: string]: unknown;
}

export interface ProviderInfo {
  providers: unknown[];
  default: Record<string, string>;
  configDefaults?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Every AI backend (OpenCode, Codex, …) implements this interface.
 * Method names map 1-to-1 with the "ai" namespace actions in index.ts.
 */
export interface AIProvider {
  // Lifecycle
  init(): Promise<void>;
  destroy(): Promise<void>;

  /**
   * Register an event emitter. The provider calls it for every async event
   * (SSE events, streaming tokens, errors, etc.).
   * Returns a cleanup/unsubscribe function.
   */
  subscribe(emitter: AiEventEmitter): () => void;

  // Optional: notify provider of the most recently used session ID so it can
  // validate the session on reconnect. OpenCode needs this; Codex may not.
  setActiveSession?(sessionId: string): void;

  // Session management
  createSession(title?: string): Promise<{ session: SessionInfo }>;
  listSessions(): Promise<{ sessions: unknown }>;
  getSession(id: string): Promise<{ session: SessionInfo }>;
  deleteSession(id: string): Promise<{ deleted: boolean }>;

  // Messages
  getMessages(sessionId: string): Promise<{ messages: MessageInfo[] }>;

  // Interaction — prompt is fire-and-forget; results come via emitter
  prompt(
    sessionId: string,
    text: string,
    model?: ModelSelector,
    agent?: string,
    files?: FileAttachment[],
    codexOptions?: CodexPromptOptions,
  ): Promise<{ ack: true }>;
  abort(sessionId: string): Promise<Record<string, never>>;

  // Metadata
  agents(): Promise<{ agents: unknown }>;
  providers(): Promise<ProviderInfo>;

  // Auth
  setAuth(providerId: string, key: string): Promise<Record<string, never>>;

  // Session operations
  command(sessionId: string, command: string, args: string): Promise<{ result: unknown }>;
  revert(sessionId: string, messageId: string): Promise<Record<string, never>>;
  unrevert(sessionId: string): Promise<Record<string, never>>;
  share(sessionId: string): Promise<{ share: ShareInfo }>;
  permissionReply(
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<Record<string, never>>;
  questionReply?(
    sessionId: string,
    questionId: string,
    answers: string[][],
  ): Promise<Record<string, never>>;
  questionReject?(
    sessionId: string,
    questionId: string,
  ): Promise<Record<string, never>>;
}
