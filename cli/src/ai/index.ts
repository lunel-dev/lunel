// AI manager — runs both OpenCode and Codex simultaneously and routes calls
// by the `backend` field in each request. Backends that fail to init are
// skipped gracefully; the available list is exposed to the app.

import { inspectCliCommand, type CliCommandInspection } from "./command-resolution.js";
import type { AIProvider, AiEvent, AiEventEmitter, ModelSelector, FileAttachment, CodexPromptOptions } from "./interface.js";

export type AiBackend = "opencode" | "codex" | "claude";
export type AiBackendAvailabilityStatus = "ready" | "missing_binary" | "configured_path_missing" | "not_executable" | "unavailable";

export interface AiBackendDiagnostic {
  backend: AiBackend;
  available: boolean;
  status: AiBackendAvailabilityStatus;
  code: string;
  message: string;
  runtime?: {
    executable: string;
    source: string;
    configuredPath?: string;
    configPath?: string;
    envVarName?: string;
    version?: string;
  };
}

const DEBUG_MODE = process.env.LUNEL_DEBUG === "1" || process.env.LUNEL_DEBUG_AI === "1";

function toRuntimeDiagnostic(inspection: CliCommandInspection): AiBackendDiagnostic {
  return {
    backend: inspection.command,
    available: inspection.available,
    status: inspection.status,
    code: inspection.code,
    message: inspection.message,
    runtime: {
      executable: inspection.executable,
      source: inspection.source,
      configuredPath: inspection.configuredPath,
      configPath: inspection.configPath,
      envVarName: inspection.envVarName,
      version: inspection.version,
    },
  };
}

function createGenericUnavailableDiagnostic(backend: AiBackend, err?: Error): AiBackendDiagnostic {
  if (backend === "codex" || backend === "claude") {
    const inspection = inspectCliCommand(backend);
    if (!inspection.available) {
      return toRuntimeDiagnostic(inspection);
    }
    return {
      ...toRuntimeDiagnostic(inspection),
      available: false,
      status: "unavailable",
      code: (err as NodeJS.ErrnoException | undefined)?.code || "EAI_INIT_FAILED",
      message: err?.message || `${inspection.displayName} failed to initialize.`,
    };
  }

  return {
    backend,
    available: false,
    status: "unavailable",
    code: (err as NodeJS.ErrnoException | undefined)?.code || "EAI_INIT_FAILED",
    message: err?.message || `Backend "${backend}" is unavailable.`,
  };
}

export class AiManager {
  private _providers: Partial<Record<AiBackend, AIProvider>> = {};
  private _available: AiBackend[] = [];
  private _diagnostics: Record<AiBackend, AiBackendDiagnostic> = {
    opencode: createGenericUnavailableDiagnostic("opencode"),
    codex: createGenericUnavailableDiagnostic("codex"),
    claude: createGenericUnavailableDiagnostic("claude"),
  };

  async init(): Promise<void> {
    await Promise.allSettled([
      this.tryInit("opencode"),
      this.tryInit("codex"),
      this.tryInit("claude"),
    ]);
    if (this._available.length === 0) {
      console.warn("[ai] No AI backends available. CLI will continue without AI features.");
      return;
    }
    if (DEBUG_MODE) {
      console.log(`[ai] Available backends: ${this._available.join(", ")}`);
    }
  }

  private async tryInit(backend: AiBackend): Promise<void> {
    try {
      if (backend === "opencode") {
        const { OpenCodeProvider } = await import("./opencode.js");
        const p = new OpenCodeProvider();
        await p.init();
        this._providers.opencode = p;
      } else if (backend === "codex") {
        const { CodexProvider } = await import("./codex.js");
        const p = new CodexProvider();
        await p.init();
        this._providers.codex = p;
      } else {
        const { ClaudeProvider } = await import("./claude.js");
        const p = new ClaudeProvider();
        await p.init();
        this._providers.claude = p;
      }
      this._available.push(backend);
      this._diagnostics[backend] = backend === "codex" || backend === "claude"
        ? toRuntimeDiagnostic(inspectCliCommand(backend))
        : {
            backend,
            available: true,
            status: "ready",
            code: "OK",
            message: `Backend "${backend}" is ready.`,
          };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._diagnostics[backend] = createGenericUnavailableDiagnostic(backend, error);
      if (DEBUG_MODE) {
        console.warn(`[ai] ${backend} backend unavailable: ${error.message}`);
      }
    }
  }

  availableBackends(): AiBackend[] {
    return [...this._available];
  }

  backendDiagnostics(): Record<AiBackend, AiBackendDiagnostic> {
    return {
      opencode: { ...this._diagnostics.opencode },
      codex: { ...this._diagnostics.codex },
      claude: { ...this._diagnostics.claude },
    };
  }

  private get(backend: AiBackend): AIProvider {
    const p = this._providers[backend];
    if (!p) {
      const diagnostic = this._diagnostics[backend];
      throw Object.assign(new Error(diagnostic.message || `Backend "${backend}" is not available`), {
        code: diagnostic.code || "EUNAVAILABLE",
      });
    }
    return p;
  }

  // Wire each provider's events to the emitter, tagged with backend name.
  subscribe(emitter: (backend: AiBackend, event: AiEvent) => void): () => void {
    const cleanups = this._available.map((backend) =>
      this._providers[backend]!.subscribe((event) => emitter(backend, event))
    );
    return () => cleanups.forEach((c) => c());
  }

  async destroy(): Promise<void> {
    await Promise.allSettled(
      this._available.map((b) => this._providers[b]!.destroy())
    );
  }

  // List sessions from all available backends, each tagged with its backend.
  async listAllSessions(): Promise<{ sessions: Array<Record<string, unknown> & { backend: AiBackend }> }> {
    const results = await Promise.allSettled(
      this._available.map(async (backend) => {
        const res = await this._providers[backend]!.listSessions();
        const sessions = (res.sessions as unknown[]) ?? [];
        return (sessions as Array<Record<string, unknown>>).map((s) => ({ ...s, backend }));
      })
    );
    const sessions = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    return { sessions };
  }

  // Session management — all require explicit backend
  createSession(backend: AiBackend, title?: string) { return this.get(backend).createSession(title); }
  getSession(backend: AiBackend, id: string) { return this.get(backend).getSession(id); }
  deleteSession(backend: AiBackend, id: string) { return this.get(backend).deleteSession(id); }
  renameSession(backend: AiBackend, id: string, title: string) { return this.get(backend).renameSession(id, title); }
  getMessages(backend: AiBackend, sessionId: string) { return this.get(backend).getMessages(sessionId); }

  prompt(
    backend: AiBackend,
    sessionId: string,
    text: string,
    model?: ModelSelector,
    agent?: string,
    files?: FileAttachment[],
    codexOptions?: CodexPromptOptions,
  ) {
    this.get(backend).setActiveSession?.(sessionId);
    return this.get(backend).prompt(sessionId, text, model, agent, files, codexOptions);
  }

  abort(backend: AiBackend, sessionId: string) { return this.get(backend).abort(sessionId); }

  // Metadata — backend is optional, falls back to first available
  async agents(backend?: AiBackend) {
    const target = backend ?? this._available[0];
    if (!target) {
      return { agents: [], availability: this.backendDiagnostics() };
    }
    if (!this._providers[target]) {
      return { agents: [], availability: this._diagnostics[target] };
    }
    return await this.get(target).agents();
  }

  async providers(backend?: AiBackend) {
    const target = backend ?? this._available[0];
    if (!target) {
      return { providers: [], default: {}, availability: this.backendDiagnostics() };
    }
    if (!this._providers[target]) {
      return { providers: [], default: {}, availability: this._diagnostics[target] };
    }
    const result = await this.get(target).providers();
    return {
      ...result,
      availability: this._diagnostics[target],
    };
  }

  setAuth(backend: AiBackend, providerId: string, key: string) { return this.get(backend).setAuth(providerId, key); }

  // Session operations
  command(backend: AiBackend, sessionId: string, command: string, args: string) { return this.get(backend).command(sessionId, command, args); }
  revert(backend: AiBackend, sessionId: string, messageId: string) { return this.get(backend).revert(sessionId, messageId); }
  unrevert(backend: AiBackend, sessionId: string) { return this.get(backend).unrevert(sessionId); }
  share(backend: AiBackend, sessionId: string) { return this.get(backend).share(sessionId); }
  permissionReply(backend: AiBackend, sessionId: string, permissionId: string, response: "once" | "always" | "reject") {
    return this.get(backend).permissionReply(sessionId, permissionId, response);
  }
  questionReply(backend: AiBackend, sessionId: string, questionId: string, answers: string[][]) {
    const provider = this.get(backend);
    if (!provider.questionReply) {
      throw new Error(`Backend "${backend}" does not support question replies`);
    }
    return provider.questionReply(sessionId, questionId, answers);
  }
  questionReject(backend: AiBackend, sessionId: string, questionId: string) {
    const provider = this.get(backend);
    if (!provider.questionReject) {
      throw new Error(`Backend "${backend}" does not support question rejection`);
    }
    return provider.questionReject(sessionId, questionId);
  }
}

export async function createAiManager(): Promise<AiManager> {
  const manager = new AiManager();
  await manager.init();
  return manager;
}

export type { AIProvider, AiEventEmitter, AiEvent, ModelSelector } from "./interface.js";
