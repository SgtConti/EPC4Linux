// SignalR JSON hub protocol v1, server side, as ASP.NET Core 3.1 (EvniaServe) speaks it to the vendor
// renderer's @microsoft/signalr 7.0.14 client (02 §4.2, 05 §3.1). Pure functions only; the socket
// handling lives in signalr-server.ts.
//
// Wire format: every message is one UTF-8 JSON object followed by the ASCII record separator 0x1E.
// A WebSocket message may carry several records, and a non-browser peer may split one record over
// several WebSocket messages, so framing works on bytes (0x1E never occurs inside a multi-byte UTF-8
// sequence). The browser client in turn requires every WebSocket message it receives to consist of
// complete records ("Message is incomplete."), so the server always sends whole records.

export const RECORD_SEPARATOR = 0x1e;
const RS = '\x1e';

/** HubProtocolConstants (message `type` values). */
export const MessageType = {
  Invocation: 1,
  StreamItem: 2,
  Completion: 3,
  StreamInvocation: 4,
  CancelInvocation: 5,
  Ping: 6,
  Close: 7,
  Ack: 8,
  Sequence: 9,
} as const;

/** The only hub protocol EvniaServe registers (JsonHubProtocol, version 1). */
export const HUB_PROTOCOL = 'json';
export const HUB_PROTOCOL_VERSION = 1;

/** Protocol violation; ASP.NET raises InvalidDataException for these and closes the connection. */
export class HubProtocolError extends Error {
  override name = 'InvalidDataException';
}

// ───────────────────────────── Framing ─────────────────────────────

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Splits an incoming byte stream into records. `maxRecordBytes` mirrors
 * HubOptions.MaximumReceiveMessageSize (1 MiB in EvniaServe, Startup.cs; 02 §4.2).
 */
export class RecordReader {
  readonly #maxRecordBytes: number;
  #pending: Buffer[] = [];
  #pendingBytes = 0;

  constructor(maxRecordBytes: number) {
    this.#maxRecordBytes = maxRecordBytes;
  }

  /** Bytes of an incomplete record carried over to the next chunk. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  /** Feed one transport chunk and return every record it completes (decoded, separator removed). */
  push(chunk: Buffer): string[] {
    const records: string[] = [];
    let start = 0;
    for (let end = chunk.indexOf(RECORD_SEPARATOR); end !== -1; end = chunk.indexOf(RECORD_SEPARATOR, start)) {
      const tail = chunk.subarray(start, end);
      this.#checkSize(this.#pendingBytes + tail.length);
      const bytes = this.#pending.length === 0 ? tail : Buffer.concat([...this.#pending, tail]);
      this.#pending = [];
      this.#pendingBytes = 0;
      records.push(decodeRecord(bytes));
      start = end + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.#checkSize(this.#pendingBytes + rest.length);
      this.#pending.push(rest);
      this.#pendingBytes += rest.length;
    }
    return records;
  }

  #checkSize(bytes: number): void {
    if (bytes > this.#maxRecordBytes) {
      throw new HubProtocolError(`The maximum message size of ${this.#maxRecordBytes}B was exceeded.`);
    }
  }
}

function decodeRecord(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new HubProtocolError('Message is not valid UTF-8.');
  }
}

// ───────────────────────────── Handshake ─────────────────────────────

/**
 * Validate the client's handshake record (HandshakeProtocol.TryParseRequestMessage +
 * HubConnectionContext.HandshakeAsync). Returns null on success, otherwise the error text the
 * server sends back in `{"error":"..."}` before closing.
 */
export function checkHandshake(record: string): string | null {
  let request: { protocol: string; version: number };
  try {
    request = parseHandshakeRequest(record);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return `An unexpected error occurred during connection handshake. ${err.name}: ${err.message}`;
  }
  // DefaultHubProtocolResolver looks protocols up case-insensitively.
  if (request.protocol.toLowerCase() !== HUB_PROTOCOL) {
    return `The protocol '${request.protocol}' is not supported.`;
  }
  // JsonHubProtocol.IsVersionSupported in ASP.NET Core 3.1: version == 1.
  if (request.version !== HUB_PROTOCOL_VERSION) {
    return `The server does not support version ${request.version} of the '${HUB_PROTOCOL}' protocol.`;
  }
  return null;
}

function parseHandshakeRequest(record: string): { protocol: string; version: number } {
  const obj = parseObject(record);
  const { protocol, version } = obj;
  if (protocol === undefined) throw new HubProtocolError(`Missing required property 'protocol'. Message content: ${record}`);
  if (typeof protocol !== 'string') throw new HubProtocolError("Expected 'protocol' to be of type String.");
  if (version === undefined) throw new HubProtocolError(`Missing required property 'version'. Message content: ${record}`);
  if (!isInt32(version)) throw new HubProtocolError("Expected 'version' to be of type Number.");
  return { protocol, version };
}

export const HANDSHAKE_OK = `{}${RS}`;

export function handshakeErrorRecord(error: string): string {
  return JSON.stringify({ error }) + RS;
}

// ───────────────────────────── Hub messages ─────────────────────────────

export interface InvocationMessage {
  type: typeof MessageType.Invocation | typeof MessageType.StreamInvocation;
  invocationId?: string;
  target: string;
  arguments: unknown[];
  streamIds?: unknown[];
}

export interface CloseMessage {
  type: typeof MessageType.Close;
  error?: string;
}

/** Valid messages that need no server action (pings, client-side stream/ack traffic). */
export interface PassiveMessage {
  type:
    | typeof MessageType.StreamItem
    | typeof MessageType.Completion
    | typeof MessageType.CancelInvocation
    | typeof MessageType.Ping
    | typeof MessageType.Ack
    | typeof MessageType.Sequence;
}

export type HubMessage = InvocationMessage | CloseMessage | PassiveMessage;

/** Parse one record after the handshake (JsonHubProtocol.ParseMessage). Throws HubProtocolError. */
export function parseHubMessage(record: string): HubMessage {
  const obj = parseObject(record);
  const type = obj.type;
  if (type === undefined) throw new HubProtocolError("Missing required property 'type'.");
  if (!isInt32(type)) throw new HubProtocolError("Expected 'type' to be of type Number.");
  switch (type) {
    case MessageType.Invocation:
    case MessageType.StreamInvocation: {
      const { invocationId, target, arguments: args, streamIds } = obj;
      if (invocationId !== undefined && typeof invocationId !== 'string') {
        throw new HubProtocolError("Expected 'invocationId' to be of type String.");
      }
      if (type === MessageType.StreamInvocation && invocationId === undefined) {
        throw new HubProtocolError("Missing required property 'invocationId'.");
      }
      if (target === undefined) throw new HubProtocolError("Missing required property 'target'.");
      if (typeof target !== 'string') throw new HubProtocolError("Expected 'target' to be of type String.");
      if (args === undefined) throw new HubProtocolError("Missing required property 'arguments'.");
      if (!Array.isArray(args)) throw new HubProtocolError("Expected 'arguments' to be of type Array.");
      if (streamIds !== undefined && streamIds !== null && !Array.isArray(streamIds)) {
        throw new HubProtocolError("Expected 'streamIds' to be of type Array.");
      }
      const message: InvocationMessage = { type, target, arguments: args };
      if (invocationId !== undefined) message.invocationId = invocationId;
      if (Array.isArray(streamIds)) message.streamIds = streamIds;
      return message;
    }
    case MessageType.Close: {
      const message: CloseMessage = { type };
      if (typeof obj.error === 'string') message.error = obj.error;
      return message;
    }
    case MessageType.StreamItem:
    case MessageType.Completion:
    case MessageType.CancelInvocation:
    case MessageType.Ping:
    case MessageType.Ack:
    case MessageType.Sequence: {
      const message: PassiveMessage = { type };
      return message;
    }
    default:
      throw new HubProtocolError(`Unknown message type: ${type}`);
  }
}

function parseObject(record: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(record);
  } catch (e) {
    throw new HubProtocolError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HubProtocolError(`Unexpected JSON Token Type '${Array.isArray(value) ? 'StartArray' : jsonKind(value)}'. Expected a JSON Object.`);
  }
  return value as Record<string, unknown>;
}

function jsonKind(v: unknown): string {
  if (v === null) return 'Null';
  if (typeof v === 'string') return 'String';
  if (typeof v === 'number') return 'Number';
  return typeof v === 'boolean' ? (v ? 'True' : 'False') : 'None';
}

function isInt32(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff;
}

// ───────────────────────────── Server → client records ─────────────────────────────
// Key order follows ASP.NET's JsonHubProtocol writer: type, invocationId, target/error, arguments.

export const PING_RECORD = `{"type":${MessageType.Ping}}${RS}`;

/** Server-to-client invocation, e.g. the "GetTaskAsync" broadcast and "Notification" events. */
export function invocationRecord(target: string, args: readonly unknown[]): string {
  return JSON.stringify({ type: MessageType.Invocation, target, arguments: args }) + RS;
}

/**
 * Completion for a client invocation. Success is ASP.NET Core 3.1's
 * `CompletionMessage.WithResult(id, null)` for the void `Task GetTaskAsync`, which JsonHubProtocol
 * writes as `"result":null` (20-backend-host-tail §1.4); a failure carries `error` instead.
 */
export function completionRecord(invocationId: string, error?: string): string {
  const message = error === undefined
    ? { type: MessageType.Completion, invocationId, result: null }
    : { type: MessageType.Completion, invocationId, error };
  return JSON.stringify(message) + RS;
}

/**
 * Close message. `allowReconnect: true` makes the 7.x client enter its automatic-reconnect loop
 * instead of stopping (HubConnection._processIncomingData).
 */
export function closeRecord(error?: string, allowReconnect = true): string {
  const message: Record<string, unknown> = { type: MessageType.Close };
  if (error !== undefined) message.error = error;
  if (allowReconnect) message.allowReconnect = true;
  return JSON.stringify(message) + RS;
}
