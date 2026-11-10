import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

type Handler = (request: MockRequest) => MockReply | Promise<MockReply>;

/** A local stand-in for the Hoplite API, including its server-sent event stream. */
export class MockServer {
  readonly requests: MockRequest[] = [];
  url = '';
  private readonly routes: { method: string; path: string; handler: Handler }[] = [];
  private readonly streams = new Set<ServerResponse>();
  private readonly server: Server;
  private streamPath: string | undefined;

  constructor() {
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Later registrations win, so a test can override an earlier route. */
  on(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, path, handler });
    return this;
  }

  enableStream(path = '/api/events/stream'): this {
    this.streamPath = path;
    return this;
  }

  get streamCount(): number {
    return this.streams.size;
  }

  /** Writes one SSE frame to every open stream. */
  emit(event: string, data: unknown, id?: string): void {
    const frame = `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of this.streams) stream.write(frame);
  }

  dropStreams(): void {
    for (const stream of this.streams) stream.end();
  }

  requestsTo(method: string, path: string): MockRequest[] {
    return this.requests.filter((request) => request.method === method && request.path === path);
  }

  private async handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(incoming.url ?? '/', 'http://mock');
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const request: MockRequest = { method: incoming.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: incoming.headers, body };
    this.requests.push(request);

    const route = [...this.routes].reverse().find((candidate) => candidate.method === request.method && candidate.path === request.path);
    if (!route && request.method === 'GET' && request.path === this.streamPath) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write(': connected\n\n');
      this.streams.add(response);
      response.on('close', () => this.streams.delete(response));
      return;
    }
    const reply = route ? await route.handler(request) : { status: 404, body: { ok: false, error: 'not_found' } };
    response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
    response.end(JSON.stringify(reply.body ?? { ok: true }));
  }
}

export async function waitFor(condition: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
