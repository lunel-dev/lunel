export interface Message {
  v: 1;
  id: string;
  ns: string;
  action: string;
  payload: Record<string, unknown>;
}

export interface Response {
  v: 1;
  id: string;
  ns: string;
  action: string;
  ok: boolean;
  payload: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

export interface EventMessage {
  v: 1;
  id: string;
  ns: string;
  action: string;
  payload: Record<string, unknown>;
}

export interface SystemMessage {
  type:
    | "connected"
    | "peer_connected"
    | "peer_disconnected"
    | "error"
    | "app_disconnected"
    | "close_connection";
  role?: string;
  channel?: string;
  peer?: string;
  reconnectDeadline?: number;
  reason?: string;
  payload?: Record<string, unknown>;
}

export type V2HandshakeFrame =
  | {
      t: "lunel_v2";
      kind: "client_hello";
      pubkey: string;
    }
  | {
      t: "lunel_v2";
      kind: "server_hello";
      pubkey: string;
    }
  | {
      t: "lunel_v2";
      kind: "client_key";
      nonce: string;
      box: string;
      auth: string;
    }
  | {
      t: "lunel_v2";
      kind: "server_ready";
      auth: string;
    };

export type EncryptedProtocolEnvelope =
  | {
      kind: "request";
      message: Message;
    }
  | {
      kind: "response";
      message: Response;
    }
  | {
      kind: "event";
      message: EventMessage;
    };

export const V2_BINARY_MAGIC_0 = 0x4c; // L
export const V2_BINARY_MAGIC_1 = 0x32; // 2
export const V2_FRAME_ENCRYPTED_MESSAGE = 0x01;

export function isProtocolRequest(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const msg = value as Partial<Message> & { ok?: unknown };
  return (
    msg.v === 1 &&
    typeof msg.id === "string" &&
    typeof msg.ns === "string" &&
    typeof msg.action === "string" &&
    typeof msg.payload === "object" &&
    msg.payload !== null &&
    typeof msg.ok === "undefined"
  );
}

export function isProtocolResponse(value: unknown): value is Response {
  if (!value || typeof value !== "object") return false;
  const msg = value as Partial<Response>;
  return msg.v === 1 && typeof msg.id === "string" && typeof msg.ok === "boolean";
}

export function isV2HandshakeFrame(value: unknown): value is V2HandshakeFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<V2HandshakeFrame>;
  if (frame.t !== "lunel_v2" || typeof frame.kind !== "string") return false;
  if (frame.kind === "client_hello") return typeof frame.pubkey === "string";
  if (frame.kind === "server_hello") return typeof frame.pubkey === "string";
  if (frame.kind === "client_key") {
    return typeof frame.nonce === "string" && typeof frame.box === "string" && typeof frame.auth === "string";
  }
  if (frame.kind === "server_ready") return typeof frame.auth === "string";
  return false;
}

export function isEncryptedProtocolEnvelope(value: unknown): value is EncryptedProtocolEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<EncryptedProtocolEnvelope>;
  if (envelope.kind === "request") return isProtocolRequest(envelope.message);
  if (envelope.kind === "response") return isProtocolResponse(envelope.message);
  if (envelope.kind === "event") return isProtocolRequest(envelope.message);
  return false;
}

export function encodeV2EncryptedFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 3);
  frame[0] = V2_BINARY_MAGIC_0;
  frame[1] = V2_BINARY_MAGIC_1;
  frame[2] = V2_FRAME_ENCRYPTED_MESSAGE;
  frame.set(payload, 3);
  return frame;
}

export function decodeV2BinaryFrame(data: Uint8Array): { type: number; payload: Uint8Array } | null {
  if (data.length < 3) return null;
  if (data[0] !== V2_BINARY_MAGIC_0 || data[1] !== V2_BINARY_MAGIC_1) return null;
  return {
    type: data[2],
    payload: data.subarray(3),
  };
}

export function buildSessionV2WsUrl(
  gatewayUrl: string,
  role: "cli" | "app",
  generation?: number | null,
): string {
  const wsBase = gatewayUrl.replace(/^https:/, "wss:");
  if (!wsBase.startsWith("wss://")) {
    throw new Error("Gateway URL must use https://");
  }
  const query = new URLSearchParams();
  if (typeof generation === "number" && Number.isFinite(generation) && generation > 0) {
    query.set("generation", String(generation));
  }
  const queryString = query.toString();
  return `${wsBase}/v2/ws/${role}${queryString ? `?${queryString}` : ""}`;
}
