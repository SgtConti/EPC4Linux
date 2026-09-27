// Shared helpers for the hub tests (not a test file itself).

import * as signalR from '@microsoft/signalr';
import { WebSocket } from 'ws';

export const RS = '\x1e';
export const HANDSHAKE = `{"protocol":"json","version":1}${RS}`;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(check: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export interface ClientOptions {
  headers?: Record<string, string>;
  serverTimeoutMs?: number;
  keepAliveMs?: number;
  path?: string;
}

/**
 * The real @microsoft/signalr 7.0.14 client, built exactly like the vendor renderer's class Jc
 * (styles-DAnQi2A8.js:7900-7904) except for the URL, which carries the port's token
 * (and 127.0.0.1 instead of localhost), and logging, which is silenced.
 */
export function vendorClient(port: number, token: string, o: ClientOptions = {}): signalR.HubConnection {
  const url = `http://127.0.0.1:${port}${o.path ?? '/EvniaHub'}?k=${encodeURIComponent(token)}`;
  const options: signalR.IHttpConnectionOptions = { skipNegotiation: true, transport: signalR.HttpTransportType.WebSockets, timeout: 120000 };
  if (o.headers) options.headers = o.headers;
  const hub = new signalR.HubConnectionBuilder().configureLogging(signalR.LogLevel.None).withUrl(url, options).withAutomaticReconnect().build();
  if (o.serverTimeoutMs !== undefined) hub.serverTimeoutInMilliseconds = o.serverTimeoutMs;
  if (o.keepAliveMs !== undefined) hub.keepAliveIntervalInMilliseconds = o.keepAliveMs;
  return hub;
}

interface Reply {
  err_code: number;
  err_msg: string | null;
  RequestId: string | null;
  FunctionName: string | null;
  Tag: unknown;
}

/**
 * Minimal copy of the vendor client's request/response logic (Jc.invoke + handleResponse,
 * styles-DAnQi2A8.js:7918-7995): double-encoded request, reply matched by RequestId from the
 * "GetTaskAsync" event, `err_code !== 0 || err_msg` rejects with {code, msg}.
 */
export class VendorRpc {
  readonly hub: signalR.HubConnection;
  readonly notifications: { name: string; tag: unknown }[] = [];
  readonly #pending = new Map<string, { resolve: (tag: unknown) => void; reject: (e: unknown) => void }>();
  #nextId = 0;

  constructor(hub: signalR.HubConnection) {
    this.hub = hub;
    for (const target of ['GetTaskAsync', 'Notification']) hub.on(target, (json: string) => this.#handle(JSON.parse(json) as Reply));
  }

  invoke(functionName: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = `req-${++this.#nextId}-${Math.random().toString(16).slice(2)}`;
      this.#pending.set(requestId, { resolve, reject });
      this.hub.invoke('GetTaskAsync', JSON.stringify({ functionName, requestId, parms: args.length > 0 ? args : null })).catch(reject);
    });
  }

  #handle(r: Reply): void {
    if (r.RequestId) {
      const p = this.#pending.get(r.RequestId);
      if (!p) return; // not ours (the vendor hub broadcast replies; this one answers the caller only)
      this.#pending.delete(r.RequestId);
      if (r.err_code !== 0 || r.err_msg) p.reject({ code: r.err_code, msg: r.err_msg });
      else p.resolve(r.Tag);
    } else {
      this.notifications.push({ name: r.FunctionName ?? '', tag: r.Tag });
    }
  }
}

/** A bare WebSocket peer for protocol-level tests. */
export class RawClient {
  readonly ws: WebSocket;
  readonly records: string[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  #cursor = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      for (const r of String(data).split(RS)) if (r !== '') this.records.push(r);
    });
    this.closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
  }

  /** Open a WebSocket; rejects with the HTTP status code when the server refuses the upgrade. */
  static open(port: number, query: string, headers: Record<string, string> = {}, path = '/EvniaHub'): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${query}`, { headers });
      ws.once('open', () => resolve(new RawClient(ws)));
      ws.once('unexpected-response', (req, res) => {
        req.destroy();
        reject(new Error(`HTTP ${res.statusCode}`));
      });
      ws.once('error', reject);
    });
  }

  send(data: string | Buffer): void {
    this.ws.send(data);
  }

  /** Next unread record, parsed. */
  async next(timeoutMs = 3000): Promise<Record<string, unknown>> {
    await waitFor(() => this.records.length > this.#cursor, timeoutMs, 'a record from the server');
    return JSON.parse(this.records[this.#cursor++]) as Record<string, unknown>;
  }

  /** Skip pings and return the next other record. */
  async nextNonPing(timeoutMs = 3000): Promise<Record<string, unknown>> {
    for (;;) {
      const r = await this.next(timeoutMs);
      if (r.type !== 6) return r;
    }
  }

  async handshake(): Promise<void> {
    this.send(HANDSHAKE);
    const r = await this.next();
    if (Object.keys(r).length !== 0) throw new Error(`handshake failed: ${JSON.stringify(r)}`);
  }
}

export function invocation(request: string, invocationId?: string, target = 'GetTaskAsync'): string {
  const m: Record<string, unknown> = { type: 1, target, arguments: [request] };
  if (invocationId !== undefined) m.invocationId = invocationId;
  return JSON.stringify(m) + RS;
}
