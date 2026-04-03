// AI manager — runs both OpenCode and Codex simultaneously and routes calls
// by the `backend` field in each request. Backends that fail to init are
// skipped gracefully; the available list is exposed to the app.

import type { AIProvider, AiEvent, AiEventEmitter, ModelSelector, FileAttachment } from "./interface.js";

export type AiBackend = "opencode" | "codex" | "pi";
const DEBUG_MODE = process.env.LUNEL_DEBUG === "1" || process.env.LUNEL_DEBUG_AI === "1";

export class AiManager {
  private _providers: Partial<Record<AiBackend, AIProvider>> = {};
  private _available: AiBackend[] = [];

  async init(): Promise<void> {
    await Promise.allSettled([
      this.tryInit("opencode"),
      this.tryInit("codex"),
      this.tryInit("pi"),
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
        const { PiProvider } = await import("./pi.js");
        const p = new PiProvider();
        await p.init();
        this._providers.pi = p;
      }
      this._available.push(backend);
    } catch (err) {
      if (DEBUG_MODE) {
        console.warn(`[ai] ${backend} backend unavailable: ${(err as Error).message}`);
      }
    }
  }

  availableBackends(): AiBackend[] {
    return [...this._available];
  }

  private get(backend: AiBackend): AIProvider {
    const p = this._providers[backend];
    if (!p) {
      throw Object.assign(new Error(`Backend "${backend}" is not available`), { code: "EUNAVAILABLE" });
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
  getMessages(backend: AiBackend, sessionId: string) { return this.get(backend).getMessages(sessionId); }

  prompt(backend: AiBackend, sessionId: string, text: string, model?: ModelSelector, agent?: string, files?: FileAttachment[]) {
    this.get(backend).setActiveSession?.(sessionId);
    return this.get(backend).prompt(sessionId, text, model, agent, files);
  }

  abort(backend: AiBackend, sessionId: string) { return this.get(backend).abort(sessionId); }

  // Metadata — backend is optional, falls back to first available
  agents(backend?: AiBackend) { return this.get(backend ?? this._available[0]).agents(); }
  providers(backend?: AiBackend) { return this.get(backend ?? this._available[0]).providers(); }
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
