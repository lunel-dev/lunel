// AI types mirroring OpenCode SDK types for mobile-side usage

export type AiBackend = "opencode" | "codex" | "pi";

export interface AIEvent {
  type: string;
  properties: Record<string, unknown>;
  backend?: AiBackend;
}

export interface AISession {
  id: string;
  title: string;
  time: { created: number; updated: number };
  backend?: AiBackend;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface AIFileAttachment {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
}

export interface AIAgent {
  name: string;
  description?: string;
  mode: string;
}

export interface AIModel {
  id: string;
  name: string;
  provider: string;
}

export interface AIProvider {
  id: string;
  name: string;
  models: Record<string, AIModel>;
}

export interface AIPart {
  type: "text" | "tool" | "tool-call" | "tool-result" | "file-change" | "reasoning" | "step-start" | "step-finish" | "file";
  text?: string;
  name?: string;
  toolName?: string;
  mime?: string;
  filename?: string;
  url?: string;
  input?: unknown;
  output?: unknown;
  state?: "pending" | "running" | "completed" | "error";
  title?: string;
  time?: { start?: number; end?: number };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  cost?: number;
  [key: string]: unknown;
}

export interface AIMessage {
  id: string;
  role: "user" | "assistant";
  parts: AIPart[];
  metadata?: Record<string, unknown>;
  time?: { created: number; updated: number };
}

export interface AIPermission {
  id: string;
  type: string;
  title: string;
  metadata: Record<string, unknown>;
  sessionID?: string;
  messageID?: string;
  callID?: string;
}

export type PermissionResponse = "once" | "always" | "reject";

export interface AIQuestionOption {
  label: string;
  description?: string;
}

export interface AIQuestionInfo {
  question: string;
  header: string;
  options: AIQuestionOption[];
  multiple?: boolean;
}

export interface AIQuestion {
  id: string;
  sessionID: string;
  questions: AIQuestionInfo[];
  tool?: {
    messageID?: string;
    callID?: string;
  };
}
