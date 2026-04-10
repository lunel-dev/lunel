import { WebSocket } from "ws";
import { createRequire } from "module";
import type {
  EncryptedProtocolEnvelope,
  EventMessage,
  Message,
  Response,
  SystemMessage,
  V2HandshakeFrame,
} from "./protocol.js";
import {
  V2_FRAME_ENCRYPTED_MESSAGE,
  buildSessionV2WsUrl,
  decodeV2BinaryFrame,
  encodeV2EncryptedFrame,
  isEncryptedProtocolEnvelope,
  isProtocolRequest,
  isProtocolResponse,
  isV2HandshakeFrame,
} from "./protocol.js";

type TransportState = "idle" | "connecting" | "open" | "handshaking" | "secure" | "closed";
type SodiumModule = typeof import("libsodium-wrappers");

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

export interface V2TransportHandlers {
  onSystemMessage: (message: SystemMessage) => Promise<void> | void;
  onProtocolRequest: (message: Message) => Promise<Response>;
  onProtocolResponse?: (message: Response) => Promise<void> | void;
  onProtocolEvent?: (message: EventMessage) => Promise<void> | void;
  onClose: (reason: string) => void;
}

export interface V2TransportOptions {
  gatewayUrl: string;
  password: string;
  sessionSecret: string;
  generation?: number | null;
  role: "cli" | "app";
  handlers: V2TransportHandlers;
  debugLog?: (message: string, ...args: unknown[]) => void;
}

interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

interface SessionKeys {
  rx: Uint8Array;
  tx: Uint8Array;
}

interface SessionBootstrapPayload {
  c2s: string;
  s2c: string;
}

function toUint8Array(data: WebSocket.RawData): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data.map((chunk) => Buffer.from(chunk))));
  return new Uint8Array(data as ArrayBufferLike);
}

function encodeUtf8(value: string): Uint8Array {
  return encoder.encode(value);
}

function decodeUtf8(value: Uint8Array): string {
  return decoder.decode(value);
}

export class V2SessionTransport {
  private readonly options: V2TransportOptions;
  private ws: WebSocket | null = null;
  private closed = false;
  private state: TransportState = "idle";
  private keyPair: KeyPair | null = null;
  private remotePublicKey: Uint8Array | null = null;
  private sessionKeys: SessionKeys | null = null;
  private readonly receivedNonceKeys = new Set<string>();
  private readonly receivedNonceOrder: string[] = [];
  private secureReadyResolve: (() => void) | null = null;
  private secureReadyReject: ((error: Error) => void) | null = null;
  private secureReadyPromise: Promise<void> | null = null;

  constructor(options: V2TransportOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      if (this.secureReadyPromise) {
        return await this.secureReadyPromise;
      }
      return;
    }

    await sodium.ready;
    this.secureReadyPromise = new Promise<void>((resolve, reject) => {
      this.secureReadyResolve = resolve;
      this.secureReadyReject = reject;
    });

    const wsUrl = buildSessionV2WsUrl(
      this.options.gatewayUrl,
      this.options.role,
      this.options.generation,
    );

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          "x-session-password": this.options.password,
        },
      });
      let opened = false;
      this.ws = ws;
      this.closed = false;
      this.state = "connecting";

      ws.on("open", () => {
        opened = true;
        this.state = "open";
        resolve();
      });

      ws.on("message", async (data, isBinary) => {
        try {
          await this.handleMessage(data, isBinary);
        } catch (error) {
          this.options.debugLog?.("[transport:v2] message handling failed", error);
          this.failSecure(new Error(error instanceof Error ? error.message : String(error)));
          this.close();
        }
      });

      ws.on("close", (code, reason) => {
        this.ws = null;
        this.state = "closed";
        if (!opened) {
          reject(new Error(`v2 socket closed during setup (${code}: ${reason.toString()})`));
          return;
        }
        if (!this.closed) {
          this.closed = true;
          this.failSecure(new Error(`v2 socket closed (${code}: ${reason.toString()})`));
          this.options.handlers.onClose(`v2 socket closed (${code}: ${reason.toString()})`);
        }
      });

      ws.on("error", (error) => {
        if (!opened) {
          reject(new Error(`v2 socket error: ${error.message}`));
          return;
        }
        this.options.debugLog?.("[transport:v2] websocket error", error.message);
      });
    });

    if (!this.secureReadyPromise) {
      throw new Error("secure readiness promise missing");
    }
    await this.secureReadyPromise;
  }

  async sendMessage(message: Message): Promise<void> {
    const ciphertext = this.encryptEnvelope({ kind: "request", message });
    this.sendBinaryFrame(ciphertext);
  }

  async sendResponse(response: Response): Promise<void> {
    const ciphertext = this.encryptEnvelope({ kind: "response", message: response });
    this.sendBinaryFrame(ciphertext);
  }

  async sendEvent(message: EventMessage): Promise<void> {
    const ciphertext = this.encryptEnvelope({ kind: "event", message });
    this.sendBinaryFrame(ciphertext);
  }

  close(): void {
    this.closed = true;
    this.state = "closed";
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
    this.ws = null;
  }

  isSecure(): boolean {
    return this.state === "secure";
  }

  private async handleMessage(data: WebSocket.RawData, isBinary: boolean): Promise<void> {
    if (!isBinary) {
      const text = typeof data === "string" ? data : Buffer.from(data as ArrayBufferLike).toString("utf-8");
      const raw = JSON.parse(text) as SystemMessage | Message | Response | V2HandshakeFrame;

      if ("type" in raw) {
        await this.options.handlers.onSystemMessage(raw);
        if (raw.type === "peer_connected") {
          this.resetPeerSession();
          await this.maybeStartHandshake();
        } else if (raw.type === "peer_disconnected" || raw.type === "app_disconnected") {
          this.resetPeerSession();
        }
        return;
      }

      if (isV2HandshakeFrame(raw)) {
        await this.handleHandshakeFrame(raw);
        return;
      }

      throw new Error(
        this.state === "secure"
          ? "received plaintext app message after secure transport"
          : "received plaintext app message before secure transport",
      );
    }

    const bytes = toUint8Array(data);
    const frame = decodeV2BinaryFrame(bytes);
    if (!frame) {
      throw new Error("invalid binary v2 frame");
    }
    if (frame.type !== V2_FRAME_ENCRYPTED_MESSAGE) {
      throw new Error(`unsupported v2 frame type ${frame.type}`);
    }
    if (this.state !== "secure" || !this.sessionKeys) {
      throw new Error("received encrypted frame before secure transport");
    }
    if (frame.payload.length < sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES) {
      throw new Error("encrypted frame missing nonce");
    }

    const nonce = frame.payload.subarray(0, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ciphertext = frame.payload.subarray(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    this.assertFreshNonce(nonce);
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      null,
      nonce,
      this.sessionKeys.rx,
    ) as Uint8Array;

    const parsed = JSON.parse(decodeUtf8(plaintext)) as EncryptedProtocolEnvelope;
    if (!isEncryptedProtocolEnvelope(parsed)) {
      throw new Error("invalid decrypted protocol envelope");
    }
    if (parsed.kind === "response") {
      await this.options.handlers.onProtocolResponse?.(parsed.message);
      return;
    }
    if (parsed.kind === "event") {
      await this.options.handlers.onProtocolEvent?.(parsed.message);
      return;
    }
    if (parsed.kind === "request") {
      const response = await this.options.handlers.onProtocolRequest(parsed.message);
      await this.sendResponse(response);
      return;
    }
    throw new Error("invalid decrypted protocol envelope");
  }

  private async maybeStartHandshake(): Promise<void> {
    if (this.state === "secure" || this.state === "handshaking") return;
    if (this.options.role !== "app") return;
    this.state = "handshaking";

    const keyPair = this.ensureKeyPair();
    const hello: V2HandshakeFrame = {
      t: "lunel_v2",
      kind: "client_hello",
      pubkey: sodium.to_base64(keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
    };
    this.sendJsonFrame(hello);
  }

  private async handleHandshakeFrame(frame: V2HandshakeFrame): Promise<void> {
    this.state = "handshaking";
    if (frame.kind === "client_hello") {
      if (this.options.role !== "cli") {
        throw new Error("unexpected client_hello on app transport");
      }
      this.remotePublicKey = sodium.from_base64(frame.pubkey, sodium.base64_variants.URLSAFE_NO_PADDING);
      const keyPair = this.ensureKeyPair();
      this.sendJsonFrame({
        t: "lunel_v2",
        kind: "server_hello",
        pubkey: sodium.to_base64(keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      });
      return;
    }

    if (frame.kind === "server_hello") {
      if (this.options.role !== "app") {
        throw new Error("unexpected server_hello on cli transport");
      }
      this.remotePublicKey = sodium.from_base64(frame.pubkey, sodium.base64_variants.URLSAFE_NO_PADDING);
      const keyPair = this.ensureKeyPair();
      const c2sKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen() as Uint8Array;
      const s2cKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen() as Uint8Array;
      const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES) as Uint8Array;
      const payload: SessionBootstrapPayload = {
        c2s: sodium.to_base64(c2sKey, sodium.base64_variants.URLSAFE_NO_PADDING),
        s2c: sodium.to_base64(s2cKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      };
      const boxed = sodium.crypto_box_easy(
        encodeUtf8(JSON.stringify(payload)),
        nonce,
        this.remotePublicKey,
        keyPair.privateKey,
      ) as Uint8Array;
      const auth = this.computeHandshakeAuth(
        "client_key",
        "app",
        sodium.to_base64(keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
        nonce,
        boxed,
      );

      this.sessionKeys = { rx: s2cKey, tx: c2sKey };
      this.sendJsonFrame({
        t: "lunel_v2",
        kind: "client_key",
        nonce: sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING),
        box: sodium.to_base64(boxed, sodium.base64_variants.URLSAFE_NO_PADDING),
        auth,
      });
      return;
    }

    if (frame.kind === "client_key") {
      if (this.options.role !== "cli") {
        throw new Error("unexpected client_key on app transport");
      }
      if (!this.remotePublicKey) {
        throw new Error("missing client public key before client_key");
      }

      const keyPair = this.ensureKeyPair();
      const nonce = sodium.from_base64(frame.nonce, sodium.base64_variants.URLSAFE_NO_PADDING);
      const boxed = sodium.from_base64(frame.box, sodium.base64_variants.URLSAFE_NO_PADDING);
      const expectedAuth = this.computeHandshakeAuth(
        "client_key",
        "app",
        sodium.to_base64(this.remotePublicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
        nonce,
        boxed,
      );
      if (frame.auth !== expectedAuth) {
        throw new Error("client_key authentication failed");
      }
      const opened = sodium.crypto_box_open_easy(
        boxed,
        nonce,
        this.remotePublicKey,
        keyPair.privateKey,
      ) as Uint8Array;
      const payload = JSON.parse(decodeUtf8(opened)) as SessionBootstrapPayload;
      this.sessionKeys = {
        rx: sodium.from_base64(payload.c2s, sodium.base64_variants.URLSAFE_NO_PADDING),
        tx: sodium.from_base64(payload.s2c, sodium.base64_variants.URLSAFE_NO_PADDING),
      };
      const auth = this.computeHandshakeAuth(
        "server_ready",
        "cli",
        sodium.to_base64(keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      );
      this.sendJsonFrame({
        t: "lunel_v2",
        kind: "server_ready",
        auth,
      });
      this.markSecure();
      return;
    }

    if (frame.kind === "server_ready") {
      if (this.options.role !== "app") {
        throw new Error("unexpected server_ready on cli transport");
      }
      if (!this.sessionKeys) {
        throw new Error("missing session keys before server_ready");
      }
      const expectedAuth = this.computeHandshakeAuth(
        "server_ready",
        "cli",
        sodium.to_base64(this.remotePublicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      );
      if (frame.auth !== expectedAuth) {
        throw new Error("server_ready authentication failed");
      }
      this.markSecure();
    }
  }

  private encryptEnvelope(envelope: EncryptedProtocolEnvelope): Uint8Array {
    if (this.state !== "secure" || !this.sessionKeys) {
      throw new Error("secure transport is not active");
    }

    const nonce = sodium.randombytes_buf(
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    ) as Uint8Array;
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      encodeUtf8(JSON.stringify(envelope)),
      null,
      null,
      nonce,
      this.sessionKeys.tx,
    ) as Uint8Array;

    const payload = new Uint8Array(nonce.length + ciphertext.length);
    payload.set(nonce, 0);
    payload.set(ciphertext, nonce.length);
    return payload;
  }

  private ensureKeyPair(): KeyPair {
    if (this.keyPair) return this.keyPair;
    const pair = sodium.crypto_box_keypair() as { publicKey: Uint8Array; privateKey: Uint8Array };
    this.keyPair = {
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
    };
    return this.keyPair;
  }

  private resetPeerSession(): void {
    this.remotePublicKey = null;
    this.sessionKeys = null;
    this.receivedNonceKeys.clear();
    this.receivedNonceOrder.length = 0;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.state = "open";
    } else {
      this.state = "idle";
    }
  }

  private computeHandshakeAuth(
    phase: "client_key" | "server_ready",
    senderRole: "cli" | "app",
    peerPubkeyB64: string,
    nonce?: Uint8Array,
    boxed?: Uint8Array,
  ): string {
    const authKey = sodium.crypto_generichash(
      sodium.crypto_auth_KEYBYTES,
      encodeUtf8(this.options.sessionSecret),
      undefined,
    ) as Uint8Array;
    const parts = [
      phase,
      senderRole,
      peerPubkeyB64,
      nonce ? sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING) : "",
      boxed ? sodium.to_base64(boxed, sodium.base64_variants.URLSAFE_NO_PADDING) : "",
    ];
    const tag = sodium.crypto_auth(parts.join(":"), authKey) as Uint8Array;
    return sodium.to_base64(tag, sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  private sendJsonFrame(frame: V2HandshakeFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("v2 transport is not connected");
    }
    this.ws.send(JSON.stringify(frame));
  }

  private sendBinaryFrame(ciphertext: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("v2 transport is not connected");
    }
    const framed = encodeV2EncryptedFrame(ciphertext);
    this.ws.send(framed);
  }

  private assertFreshNonce(nonce: Uint8Array): void {
    const nonceKey = Buffer.from(nonce).toString("hex");
    if (this.receivedNonceKeys.has(nonceKey)) {
      throw new Error("replayed encrypted frame");
    }
    this.receivedNonceKeys.add(nonceKey);
    this.receivedNonceOrder.push(nonceKey);
    if (this.receivedNonceOrder.length > 2048) {
      const oldest = this.receivedNonceOrder.shift();
      if (oldest) {
        this.receivedNonceKeys.delete(oldest);
      }
    }
  }

  private markSecure(): void {
    this.state = "secure";
    if (this.secureReadyResolve) {
      this.secureReadyResolve();
      this.secureReadyResolve = null;
      this.secureReadyReject = null;
    }
  }

  private failSecure(error: Error): void {
    if (this.secureReadyReject) {
      this.secureReadyReject(error);
      this.secureReadyResolve = null;
      this.secureReadyReject = null;
    }
  }
}
