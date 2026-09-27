// Minimal ASP.NET-Core-SignalR-compatible hub server for the vendor renderer (02 §4, §L.4; 05 §2.3-2.4).
//
// What the renderer's client (@microsoft/signalr 7.0.14, `{skipNegotiation:true, transport:WebSockets,
// timeout:120000}` + withAutomaticReconnect, styles-DAnQi2A8.js:7900-7904) needs, and what EvniaServe did:
//   - WebSocket at /EvniaHub, no /negotiate (skipNegotiation), JSON hub protocol v1 (protocol.ts);
//   - one hub method, `Task GetTaskAsync(string)`: the dispatcher result is sent as a "GetTaskAsync"
//     invocation, then the caller gets a void Completion (EvniaHub.cs:62-66). The vendor sent the result to
//     ALL connected clients; this hub sends it to the caller only (see #runTask);
//   - backend events are pushed to all clients as "Notification" (HandleEvent.cs, 02 §6);
//   - ASP.NET defaults: server ping after 15 s without sending (the client gives up after 30 s of
//     silence, 02 §4.6), 30 s client timeout, 15 s handshake timeout, 1 MiB max message (Startup.cs);
//   - invocations from one connection run one at a time in arrival order, as in ASP.NET Core 3.1;
//     receiving (pings, Close) is never queued behind them (20-backend-host-tail §1.4). The queue
//     relies on getTaskAsync settling: the backend's dispatcher bounds every handler with a
//     watchdog (rpc/dispatcher.ts, DEFAULT_HANDLER_TIMEOUT_MS), so one hung call cannot stall it.
// Deliberate differences from the vendor host: bound to 127.0.0.1 instead of *:10010, no REST
// controllers / Swagger / developer exception page, and every upgrade must pass the Host and Origin
// policies and carry the per-launch token (security.ts); rejections are logged rate-limited
// (rejection-log.ts). The keep-alive and timeout clocks are monotonic, so a suspend/resume or a
// wall-clock step neither drops the renderer nor stops the pings. close() waits (bounded) for
// GetTaskAsync calls that are already running, so the services can be stopped right after it.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Logger } from '../types.ts';
import {
  HANDSHAKE_OK,
  MessageType,
  PING_RECORD,
  RecordReader,
  checkHandshake,
  closeRecord,
  completionRecord,
  handshakeErrorRecord,
  invocationRecord,
  parseHubMessage,
  type HubMessage,
  type InvocationMessage,
} from './protocol.ts';
import { RejectionLog } from './rejection-log.ts';
import { ALLOWED_ORIGINS, MIN_TOKEN_LENGTH, hostAllowed, originAllowed, tokenMatches } from './security.ts';

export const HUB_HOST = '127.0.0.1';
export const HUB_PATH = '/EvniaHub';
/** Vendor default port; the Electron side probed upward from here (01 §7, EM:13573-13582). */
export const DEFAULT_HUB_PORT = 10010;
/** The only hub method, and the target of its reply invocation (EvniaHub.cs:62-66). */
export const HUB_METHOD = 'GetTaskAsync';
/** Target of backend push messages (HandleEvent.cs method_0). */
export const NOTIFICATION_TARGET = 'Notification';

export const HUB_DEFAULTS = {
  /** HubOptions.KeepAliveInterval. */
  keepAliveIntervalMs: 15_000,
  /** HubOptions.ClientTimeoutInterval. */
  clientTimeoutMs: 30_000,
  /** HubOptions.HandshakeTimeout. */
  handshakeTimeoutMs: 15_000,
  /** HubOptions.MaximumReceiveMessageSize = 1048576 (Startup.cs). */
  maxMessageBytes: 1_048_576,
} as const;

/** A client that stops reading is dropped once this much output is queued for it. */
export const MAX_BUFFERED_BYTES = 16 * 1_048_576;
/**
 * How long close() waits for clients to acknowledge the WebSocket close and for running GetTaskAsync
 * calls to finish. Electron main gives the whole quit 3 s (EXIT_DEADLINE_MS), backend.stop() included.
 */
export const SHUTDOWN_GRACE_MS = 1_000;

/**
 * Clock for the keep-alive and timeouts: CLOCK_MONOTONIC, which (like Node's timers and Chromium's
 * timer base) does not advance during suspend and never steps. Date.now() jumps by the whole suspend
 * time on resume, which would make every connection look silent for too long and drop the renderer.
 */
const monotonicNow = (): number => performance.now();

type RejectKind =
  | 'plain HTTP request'
  | 'server shutting down'
  | 'malformed request target'
  | 'not the hub endpoint'
  | 'unexpected Host'
  | 'foreign Origin'
  | 'missing or wrong token';

export interface HubServerOptions {
  /** First port to try; the following ports are tried while busy, like the vendor. 0 = any free port. */
  port: number;
  /** Per-launch secret the client must send as `?k=<token>` (security.ts). */
  token: string;
  log: Logger;
  /**
   * EvniaHub.GetTaskAsync: request JSON string → serialized JsonResult (05 §2.4). Expected never to
   * throw; if it does, the caller receives an error Completion and no reply.
   */
  getTaskAsync: (requestJson: string) => Promise<string>;
  /** Origins allowed besides "no Origin header" (default ALLOWED_ORIGINS: file:// and null; security.ts). */
  allowedOrigins?: readonly string[];
  keepAliveIntervalMs?: number;
  clientTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
}

export interface HubServer {
  /** The port actually bound on 127.0.0.1. */
  readonly port: number;
  /** Connections that completed the SignalR handshake. */
  readonly connectionCount: number;
  /** Send `{"type":1,"target":<target>,"arguments":[argument]}` to every connected client. */
  broadcast(target: string, argument: string): void;
  /**
   * Send a Close message to every client, disconnect them and stop listening. Resolves once running
   * GetTaskAsync calls have finished (at most SHUTDOWN_GRACE_MS); queued ones are dropped. Idempotent.
   */
  close(): Promise<void>;
}

/** Start the hub on 127.0.0.1, trying `options.port` and then the next ports while they are taken. */
export async function startSignalRServer(options: HubServerOptions): Promise<HubServer> {
  if (options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`hub token must be at least ${MIN_TOKEN_LENGTH} characters (use generateHubToken())`);
  }
  const server = new SignalRHubServer(options);
  await server.listen(options.port);
  return server;
}

class Connection {
  readonly id: number;
  readonly ws: WebSocket;
  readonly remote: string;
  readonly reader: RecordReader;
  readonly closed: Promise<void>;
  /** monotonicNow() timestamps. */
  readonly openedAt: number;
  lastReceivedAt: number;
  lastSentAt: number;
  handshaken = false;
  closing = false;
  /** Tail of this connection's invocation chain (one GetTaskAsync at a time). */
  queue: Promise<void> = Promise.resolve();

  constructor(id: number, ws: WebSocket, remote: string, maxMessageBytes: number) {
    this.id = id;
    this.ws = ws;
    this.remote = remote;
    this.reader = new RecordReader(maxMessageBytes);
    this.openedAt = this.lastReceivedAt = this.lastSentAt = monotonicNow();
    this.closed = new Promise((resolve) => ws.once('close', () => resolve()));
  }
}

type Binding = { request: string } | { error: string; detail: string };

class SignalRHubServer implements HubServer {
  readonly #log: Logger;
  readonly #token: string;
  readonly #getTaskAsync: (requestJson: string) => Promise<string>;
  readonly #allowedOrigins: readonly string[];
  readonly #keepAliveMs: number;
  readonly #clientTimeoutMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #http: http.Server;
  readonly #wss: WebSocketServer;
  readonly #connections = new Set<Connection>();
  /** GetTaskAsync calls currently running in the backend (close() waits for them). */
  readonly #inflight = new Set<Promise<string>>();
  readonly #rejections: RejectionLog;
  #ticker: NodeJS.Timeout | null = null;
  #nextId = 1;
  #port = 0;
  #shutdown: Promise<void> | null = null;

  constructor(o: HubServerOptions) {
    this.#log = o.log;
    this.#token = o.token;
    this.#getTaskAsync = o.getTaskAsync;
    this.#allowedOrigins = o.allowedOrigins ?? ALLOWED_ORIGINS;
    this.#keepAliveMs = o.keepAliveIntervalMs ?? HUB_DEFAULTS.keepAliveIntervalMs;
    this.#clientTimeoutMs = o.clientTimeoutMs ?? HUB_DEFAULTS.clientTimeoutMs;
    this.#handshakeTimeoutMs = o.handshakeTimeoutMs ?? HUB_DEFAULTS.handshakeTimeoutMs;
    this.#maxMessageBytes = o.maxMessageBytes ?? HUB_DEFAULTS.maxMessageBytes;
    this.#rejections = new RejectionLog(o.log);
    this.#http =http.createServer((req, res) => this.#onHttpRequest(req, res));
    this.#http.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => this.#onUpgrade(req, socket, head));
    // One WebSocket message may hold several records, so allow twice the per-record limit;
    // RecordReader enforces the per-record limit itself.
    this.#wss = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: 2 * this.#maxMessageBytes });
  }

  get port(): number {
    return this.#port;
  }

  get connectionCount(): number {
    let n = 0;
    for (const c of this.#connections) if (c.handshaken && !c.closing) n++;
    return n;
  }

  async listen(firstPort: number): Promise<void> {
    for (let port = firstPort; ; port++) {
      try {
        await listenOnce(this.#http, port);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // Vendor getFreePort: any failure moves on to the next port until 65535. Only "port taken"
        // and "port not permitted" can be cured by that; anything else is reported immediately.
        if (port === 0 || port >= 65535 || (code !== 'EADDRINUSE' && code !== 'EACCES')) throw e;
        this.#log.info(`Port ${port} is unavailable (${code}), trying ${port + 1}`);
      }
    }
    this.#port = (this.#http.address() as AddressInfo).port;
    const tickMs = Math.max(5, Math.min(1000, Math.floor(Math.min(this.#keepAliveMs, this.#clientTimeoutMs, this.#handshakeTimeoutMs) / 4)));
    this.#ticker = setInterval(() => this.#tick(), tickMs);
    this.#ticker.unref();
    this.#log.info(`hub listening on ws://${HUB_HOST}:${this.#port}${HUB_PATH}`);
  }

  broadcast(target: string, argument: string): void {
    const record = invocationRecord(target, [argument]);
    for (const conn of this.#connections) {
      if (conn.handshaken && !conn.closing) this.#send(conn, record);
    }
  }

  close(): Promise<void> {
    this.#shutdown ??= this.#stop();
    return this.#shutdown;
  }

  // ───────────── HTTP / upgrade ─────────────

  #onHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Only WebSocket upgrades are served. POST /EvniaHub/negotiate is not needed: the client runs
    // with skipNegotiation (02 §4.1).
    this.#logRejection('plain HTTP request', `rejected HTTP ${req.method} ${clip(pathOf(req))} from ${remoteOf(req)}: not a hub WebSocket upgrade`);
    res.writeHead(404, { 'Content-Length': '0', Connection: 'close' });
    res.end();
  }

  #onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const onSocketError = (): void => {
      socket.destroy();
    };
    socket.on('error', onSocketError);
    const remote = remoteOf(req);
    const path = pathOf(req);
    const reject = (status: number, statusText: string, kind: RejectKind, detail = ''): void => {
      // Never log the query string: it carries the token.
      this.#logRejection(kind, `rejected hub connection from ${remote} (${clip(path)}, origin ${clip(req.headers.origin ?? '-')}): ${kind}${detail}`);
      socket.once('finish', () => socket.destroy());
      socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };

    if (this.#shutdown) return reject(503, 'Service Unavailable', 'server shutting down');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${HUB_HOST}`);
    } catch {
      return reject(400, 'Bad Request', 'malformed request target');
    }
    // ASP.NET endpoint routing matches the hub path case-insensitively.
    if (url.pathname.toLowerCase() !== HUB_PATH.toLowerCase() || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      return reject(404, 'Not Found', 'not the hub endpoint');
    }
    if (!hostAllowed(req.headers.host, this.#port)) return reject(403, 'Forbidden', 'unexpected Host', ` ${clip(req.headers.host ?? '-')}`);
    if (!originAllowed(req.headers.origin, this.#allowedOrigins)) return reject(403, 'Forbidden', 'foreign Origin');
    if (!tokenMatches(this.#token, url.searchParams.get('k'))) return reject(403, 'Forbidden', 'missing or wrong token');

    socket.off('error', onSocketError);
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, remote));
  }

  #logRejection(kind: RejectKind, message: string): void {
    this.#rejections.record(kind, message, monotonicNow());
  }

  #accept(ws: WebSocket, remote: string): void {
    if (this.#shutdown) {
      ws.terminate();
      return;
    }
    const conn = new Connection(this.#nextId++, ws, remote, this.#maxMessageBytes);
    this.#connections.add(conn);
    this.#log.debug(`connection ${conn.id} opened from ${remote}`);
    ws.on('message', (data: RawData) => this.#receive(conn, toBuffer(data)));
    ws.on('error', (e: Error) => this.#log.warn(`connection ${conn.id}: ${e.message}`));
    ws.on('close', (code: number) => {
      this.#connections.delete(conn);
      conn.closing = true;
      if (conn.handshaken) this.#log.info(`EvniaHub OnDisconnectedAsync (connection ${conn.id}, code ${code})`);
      else this.#log.debug(`connection ${conn.id} closed before handshake (code ${code})`);
    });
  }

  // ───────────── Incoming data ─────────────

  #receive(conn: Connection, chunk: Buffer): void {
    if (conn.closing) return;
    conn.lastReceivedAt = monotonicNow();
    let records: string[];
    try {
      records = conn.reader.push(chunk);
    } catch (e) {
      this.#abort(conn, e);
      return;
    }
    for (const record of records) {
      if (conn.closing) return;
      if (!conn.handshaken) {
        this.#handshake(conn, record);
        continue;
      }
      let message: HubMessage;
      try {
        message = parseHubMessage(record);
      } catch (e) {
        this.#abort(conn, e);
        return;
      }
      this.#onMessage(conn, message);
    }
  }

  #handshake(conn: Connection, record: string): void {
    const error = checkHandshake(record);
    if (error !== null) {
      this.#log.warn(`connection ${conn.id}: handshake failed: ${error}`);
      this.#send(conn, handshakeErrorRecord(error));
      this.#closeConnection(conn, 1000);
      return;
    }
    conn.handshaken = true;
    this.#send(conn, HANDSHAKE_OK);
    this.#log.info(`EvniaHub OnConnectedAsync (connection ${conn.id} from ${conn.remote})`);
  }

  #onMessage(conn: Connection, message: HubMessage): void {
    switch (message.type) {
      case MessageType.Invocation:
      case MessageType.StreamInvocation:
        this.#invoke(conn, message);
        return;
      case MessageType.Close:
        this.#log.debug(`connection ${conn.id}: client sent Close${message.error ? ` (${message.error})` : ''}`);
        this.#closeConnection(conn, 1000);
        return;
      default:
        // Ping only refreshes lastReceivedAt; the other types answer server-to-client calls we never make.
        return;
    }
  }

  #invoke(conn: Connection, message: InvocationMessage): void {
    const binding = bindGetTaskAsync(message);
    if ('error' in binding) {
      this.#log.warn(`connection ${conn.id}: rejected invocation of '${message.target}': ${binding.detail}`);
      if (message.invocationId !== undefined) this.#send(conn, completionRecord(message.invocationId, binding.error));
      return;
    }
    const { invocationId } = message;
    conn.queue = conn.queue.then(() => this.#runTask(conn, binding.request, invocationId));
  }

  async #runTask(conn: Connection, request: string, invocationId: string | undefined): Promise<void> {
    // ASP.NET stops reading a connection once it closes, so queued invocations are dropped with it.
    if (conn.closing) return;
    const task = (async () => this.#getTaskAsync(request))();
    this.#inflight.add(task);
    let reply: string;
    try {
      reply = await task;
    } catch (e) {
      this.#log.error(`${HUB_METHOD} failed`, e);
      if (invocationId !== undefined) {
        this.#send(conn, completionRecord(invocationId, `An unexpected error occurred invoking '${HUB_METHOD}' on the server.`));
      }
      return;
    } finally {
      this.#inflight.delete(task);
    }
    // EvniaHub.GetTaskAsync sent the reply with Clients.All.SendAsync("GetTaskAsync", arg), then the void
    // Completion. The rebuilt hub answers the caller only (20-online-sweep-tail §10.7, vendor finding S4):
    // another token holder (a debugging client, the e2e hubRpc helper) must not see the renderer's replies,
    // which carry device serials and file paths. With the one renderer client the wire bytes are the same.
    // Backend Notifications still go to every client (broadcast()).
    this.#send(conn, invocationRecord(HUB_METHOD, [reply]));
    if (invocationId !== undefined) this.#send(conn, completionRecord(invocationId));
  }

  // ───────────── Outgoing data / connection control ─────────────

  #send(conn: Connection, record: string): void {
    const { ws } = conn;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.#log.warn(`connection ${conn.id}: client is not reading (${ws.bufferedAmount} bytes queued), dropping it`);
      conn.closing = true;
      ws.terminate();
      return;
    }
    conn.lastSentAt = monotonicNow();
    // Strings go out as text frames, which the client's JSON protocol requires.
    ws.send(record, (err) => {
      if (err) this.#log.debug(`connection ${conn.id}: send failed: ${err.message}`);
    });
  }

  /** Protocol violation: tell the client why (it reconnects on its own) and close, as ASP.NET does. */
  #abort(conn: Connection, e: unknown): void {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    this.#log.warn(`connection ${conn.id}: protocol error, closing: ${reason}`);
    if (conn.handshaken) this.#send(conn, closeRecord('Connection closed with an error.'));
    this.#closeConnection(conn, 1011);
  }

  #closeConnection(conn: Connection, code: number, reason?: string): void {
    if (conn.closing) return;
    conn.closing = true;
    conn.ws.close(code, reason);
  }

  #tick(): void {
    const now = monotonicNow();
    this.#rejections.flush(now);
    for (const conn of this.#connections) {
      if (conn.closing) continue;
      if (!conn.handshaken) {
        if (now - conn.openedAt >= this.#handshakeTimeoutMs) {
          this.#log.warn(`connection ${conn.id}: no handshake within ${this.#handshakeTimeoutMs} ms, dropping it`);
          conn.closing = true;
          conn.ws.terminate();
        }
        continue;
      }
      if (now - conn.lastReceivedAt >= this.#clientTimeoutMs) {
        this.#log.warn(`connection ${conn.id}: nothing received for ${this.#clientTimeoutMs} ms, dropping it`);
        conn.closing = true;
        conn.ws.terminate();
        continue;
      }
      if (now - conn.lastSentAt >= this.#keepAliveMs) this.#send(conn, PING_RECORD);
    }
  }

  async #stop(): Promise<void> {
    if (this.#ticker) clearInterval(this.#ticker);
    // From here on no invocation starts: new upgrades get 503, and closing connections neither read
    // nor run what they still had queued (#receive, #runTask).
    const open = [...this.#connections];
    for (const conn of open) {
      if (conn.handshaken && !conn.closing) this.#send(conn, closeRecord());
      this.#closeConnection(conn, 1001, 'server shutting down');
    }
    // Calls that are already running finish first, so that `await hub.close(); await backend.stop();`
    // never stops a service under a running handler (e.g. halfway through a DDC write).
    const running = [...this.#inflight];
    const drained = await waitAtMost(Promise.all([...open.map((c) => c.closed), Promise.allSettled(running)]), SHUTDOWN_GRACE_MS);
    if (!drained && this.#inflight.size > 0) {
      this.#log.warn(`${this.#inflight.size} ${HUB_METHOD} call(s) still running after ${SHUTDOWN_GRACE_MS} ms, stopping anyway`);
    }
    for (const conn of this.#connections) conn.ws.terminate();
    await new Promise<void>((resolve) => {
      this.#http.close(() => resolve());
      this.#http.closeAllConnections();
    });
    this.#wss.close();
    this.#rejections.flush(Infinity);
    this.#log.info('hub server stopped');
  }
}

/**
 * Bind an invocation to `Task GetTaskAsync(string parm)` the way ASP.NET's hub dispatcher does:
 * method names are case-insensitive; exactly one string (or null) argument; no streams.
 * Error texts are ASP.NET's (non-HubException details are hidden from the client).
 */
function bindGetTaskAsync(m: InvocationMessage): Binding {
  if (m.target.toLowerCase() !== HUB_METHOD.toLowerCase()) {
    return { error: `Failed to invoke '${m.target}' due to an error on the server. HubException: Method does not exist.`, detail: 'unknown hub method' };
  }
  if (m.type === MessageType.StreamInvocation) {
    return { error: `The client attempted to invoke the non-streaming '${m.target}' method with a streaming invocation.`, detail: 'streaming invocation' };
  }
  const generic = `Failed to invoke '${m.target}' due to an error on the server.`;
  if (m.streamIds !== undefined && m.streamIds.length > 0) {
    return { error: generic, detail: `client sent ${m.streamIds.length} stream(s), hub method expects 0` };
  }
  if (m.arguments.length !== 1) {
    return { error: generic, detail: `invocation provides ${m.arguments.length} argument(s) but target expects 1` };
  }
  const arg = m.arguments[0];
  if (arg !== null && typeof arg !== 'string') return { error: generic, detail: 'argument is not a string' };
  // A null string reaches Class0 as null, which fails exactly like "" (JsonDeserialize → default).
  return { request: arg ?? '' };
}

function listenOnce(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: HUB_HOST, exclusive: true });
  });
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function remoteOf(req: http.IncomingMessage): string {
  return `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`;
}

/** Client-controlled text in log lines is shortened. */
function clip(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 120)}…`;
}

function pathOf(req: http.IncomingMessage): string {
  const target = req.url ?? '/';
  const q = target.indexOf('?');
  return q === -1 ? target : target.slice(0, q);
}

/** Wait for `p` for at most `ms`; true when it settled in time. */
async function waitAtMost(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    p.then(() => true, () => true),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]);
  clearTimeout(timer);
  return settled;
}
