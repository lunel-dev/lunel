// AI manager — runs both OpenCode and Codex simultaneously and routes calls
// by the `backend` field in each request. Backends that fail to init are
// skipped gracefully; the available list is exposed to the app.

import type { AIProvider, AiEvent, AiEventEmitter, ModelSelector, FileAttachment, CodexPromptOptions } from "./interface.js";

export type AiBackend = "opencode" | "codex";
const DEBUG_MODE = process.env.LUNEL_DEBUG === "1" || process.env.LUNEL_DEBUG_AI === "1";

export class AiManager {
  private _providers: Partial<Record<AiBackend, AIProvider>> = {};
  private _available: AiBackend[] = [];
  private _initializing = new Map<AiBackend, Promise<AIProvider>>();

  async init(): Promise<void> {
    // Lazy backend initialization. Backends are started on first use so opening
    // the AI UI does not eagerly boot every local runtime.
  }

  private async ensureBackend(backend: AiBackend): Promise<AIProvider> {
    const existing = this._providers[backend];
    if (existing) {
      return existing;
    }

    const inFlight = this._initializing.get(backend);
    if (inFlight) {
      return await inFlight;
    }

    const initPromise = (async () => {
      try {
        let provider: AIProvider;
        if (backend === "opencode") {
          const { OpenCodeProvider } = await import("./opencode.js");
          provider = new OpenCodeProvider();
        } else {
          const { CodexProvider } = await import("./codex.js");
          provider = new CodexProvider();
        }

        await provider.init();
        this._providers[backend] = provider;
        if (!this._available.includes(backend)) {
          this._available.push(backend);
        }
        return provider;
      } catch (err) {
        if (DEBUG_MODE) {
          console.warn(`[ai] ${backend} backend unavailable: ${(err as Error).message}`);
        }
        throw err;
      } finally {
        this._initializing.delete(backend);
      }
    })();

    this._initializing.set(backend, initPromise);
    return await initPromise;
  }

  availableBackends(): AiBackend[] {
    return this._available.length > 0 ? [...this._available] : ["opencode", "codex"];
  }

  // Wire each provider's events to the emitter, tagged with backend name.
  subscribe(emitter: (backend: AiBackend, event: AiEvent) => void): () => void {
    const cleanups = this._available
      .map((backend) => this._providers[backend])
      .filter((provider): provider is AIProvider => Boolean(provider))
      .map((provider) => {
        const backend = (Object.entries(this._providers).find(([, value]) => value === provider)?.[0] ?? "opencode") as AiBackend;
        return provider.subscribe((event) => emitter(backend, event));
      });
    return () => cleanups.forEach((c) => c());
  }

  async destroy(): Promise<void> {
    await Promise.allSettled(Array.from(this._initializing.values()));
    await Promise.allSettled(
      this._available
        .map((b) => this._providers[b])
        .filter((provider): provider is AIProvider => Boolean(provider))
        .map((provider) => provider.destroy())
    );
    this._providers = {};
    this._available = [];
  }

  // List sessions from all available backends, each tagged with its backend.
  async listAllSessions(): Promise<{ sessions: Array<Record<string, unknown> & { backend: AiBackend }> }> {
    const results = await Promise.allSettled(
      (["opencode", "codex"] as AiBackend[]).map(async (backend) => {
        const provider = await this.ensureBackend(backend);
        const res = await provider.listSessions();
        const sessions = (res.sessions as unknown[]) ?? [];
        return (sessions as Array<Record<string, unknown>>).map((s) => ({ ...s, backend }));
      })
    );
    const sessions = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    return { sessions };
  }

  // Session management — all require explicit backend
  async createSession(backend: AiBackend, title?: string) { return (await this.ensureBackend(backend)).createSession(title); }
  async getSession(backend: AiBackend, id: string) { return (await this.ensureBackend(backend)).getSession(id); }
  async deleteSession(backend: AiBackend, id: string) { return (await this.ensureBackend(backend)).deleteSession(id); }
  async getMessages(backend: AiBackend, sessionId: string) { return (await this.ensureBackend(backend)).getMessages(sessionId); }

  prompt(
    backend: AiBackend,
    sessionId: string,
    text: string,
    model?: ModelSelector,
    agent?: string,
    files?: FileAttachment[],
    codexOptions?: CodexPromptOptions,
  ) {
    return this.ensureBackend(backend).then((provider) => {
      provider.setActiveSession?.(sessionId);
      return provider.prompt(sessionId, text, model, agent, files, codexOptions);
    });
  }

  async abort(backend: AiBackend, sessionId: string) { return (await this.ensureBackend(backend)).abort(sessionId); }

  // Metadata — backend is optional, falls back to first available
  async agents(backend?: AiBackend) { return (await this.ensureBackend(backend ?? "opencode")).agents(); }
  async providers(backend?: AiBackend) { return (await this.ensureBackend(backend ?? "opencode")).providers(); }
  async setAuth(backend: AiBackend, providerId: string, key: string) { return (await this.ensureBackend(backend)).setAuth(providerId, key); }

  // Session operations
  async command(backend: AiBackend, sessionId: string, command: string, args: string) { return (await this.ensureBackend(backend)).command(sessionId, command, args); }
  async revert(backend: AiBackend, sessionId: string, messageId: string) { return (await this.ensureBackend(backend)).revert(sessionId, messageId); }
  async unrevert(backend: AiBackend, sessionId: string) { return (await this.ensureBackend(backend)).unrevert(sessionId); }
  async share(backend: AiBackend, sessionId: string) { return (await this.ensureBackend(backend)).share(sessionId); }
  async permissionReply(backend: AiBackend, sessionId: string, permissionId: string, response: "once" | "always" | "reject") {
    return (await this.ensureBackend(backend)).permissionReply(sessionId, permissionId, response);
  }
  async questionReply(backend: AiBackend, sessionId: string, questionId: string, answers: string[][]) {
    const provider = await this.ensureBackend(backend);
    if (!provider.questionReply) {
      throw new Error(`Backend "${backend}" does not support question replies`);
    }
    return provider.questionReply(sessionId, questionId, answers);
  }
  async questionReject(backend: AiBackend, sessionId: string, questionId: string) {
    const provider = await this.ensureBackend(backend);
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
