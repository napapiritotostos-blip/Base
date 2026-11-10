import type {
  ActiveRun,
  AnswerRequest,
  Capabilities,
  CreateThreadRequest,
  CreateThreadResponse,
  DiffMode,
  EventFilter,
  MessagesResponse,
  ModelCatalog,
  Project,
  RunFailureDetail,
  SendMessageRequest,
  SendMessageResponse,
  Thread,
  ThreadDiff,
  ThreadQuestion,
  ThreadsResponse,
  UpdateThreadRequest,
} from './types.ts';

export class HopliteApiError extends Error {
  /** HTTP status, or 0 when the request never reached the API. */
  readonly status: number;
  /** Stable machine-readable code from the response body. */
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'HopliteApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  userAgent?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
}

type Query = Record<string, string | number | boolean | null | undefined>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Makes a write safe to retry; the API replays the first result for a repeated key. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const KNOWN_ERRORS: Record<string, string> = {
  auth_required: 'The API key is missing, invalid, or lacks the permission this action needs.',
  rate_limited: 'Hoplite API rate limit reached. Try again in a moment.',
  rate_limit_unavailable: 'The Hoplite API is temporarily unavailable. Try again in a moment.',
  cursor_expired: 'The event cursor expired.',
};

const STATUS_TEXT: Record<number, string> = {
  400: 'The request was rejected as invalid',
  401: 'The API key is missing, invalid, or lacks the permission this action needs',
  402: 'Your Hoplite workspace does not have access to this capability',
  403: 'The API key no longer has the required workspace membership or role',
  404: 'Not found, or not available to this API key',
  409: 'The request conflicts with the current state',
  429: 'Hoplite API rate limit reached',
};

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Accepts HTTPS origins, and plain HTTP for loopback hosts only, so the key is never sent in clear text. */
export function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid Hoplite API URL: "${value}"`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The Hoplite API URL must use HTTPS.');
  }
  return new URL(url.origin);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class HopliteClient {
  readonly origin: URL;
  private readonly apiKey: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.origin = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.userAgent = options.userAgent ?? 'hoplite-vscode';
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? 4;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  getCapabilities(): Promise<Capabilities> {
    return this.request('GET', '/api/capabilities');
  }

  listModels(): Promise<ModelCatalog> {
    return this.request('GET', '/api/model-providers');
  }

  async listProjects(): Promise<Project[]> {
    const projects: Project[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const response = await this.request<{ projects: Project[]; nextCursor?: string | null }>('GET', '/api/projects', {
        query: { pagination: 'cursor', limit: 100, cursor },
      });
      projects.push(...response.projects);
      if (!response.nextCursor) break;
      cursor = response.nextCursor;
    }
    return projects;
  }

  listThreads(query: { projectId?: string; archived?: boolean; q?: string; limit?: number; cursor?: string } = {}): Promise<ThreadsResponse> {
    return this.request('GET', '/api/threads', { query });
  }

  getThread(id: string): Promise<{ thread: Thread }> {
    return this.request('GET', this.threadPath(id));
  }

  createThread(body: CreateThreadRequest, idempotencyKey: string): Promise<CreateThreadResponse> {
    return this.request('POST', '/api/threads', { body, idempotencyKey });
  }

  updateThread(id: string, body: UpdateThreadRequest): Promise<{ thread: Thread }> {
    return this.request('PATCH', this.threadPath(id), { body });
  }

  listMessages(id: string, query: { cursor?: string; limit?: number; activityLimit?: number } = {}): Promise<MessagesResponse> {
    return this.request('GET', this.threadPath(id, '/messages'), { query });
  }

  sendMessage(id: string, body: SendMessageRequest, idempotencyKey: string): Promise<SendMessageResponse> {
    return this.request('POST', this.threadPath(id, '/messages'), { body, idempotencyKey });
  }

  getActiveRun(id: string): Promise<{ activeRun: ActiveRun | null }> {
    return this.request('GET', this.threadPath(id, '/active-run'));
  }

  stopRun(id: string, runId: string, idempotencyKey: string): Promise<unknown> {
    return this.request('POST', this.threadPath(id, '/stop'), { body: { runId }, idempotencyKey });
  }

  retryThread(id: string, idempotencyKey: string): Promise<unknown> {
    return this.request('POST', this.threadPath(id, '/retry'), { body: {}, idempotencyKey });
  }

  compactThread(id: string, idempotencyKey: string): Promise<unknown> {
    return this.request('POST', this.threadPath(id, '/compact'), { body: {}, idempotencyKey });
  }

  listQuestions(id: string): Promise<{ questions: ThreadQuestion[] }> {
    return this.request('GET', this.threadPath(id, '/questions'));
  }

  answerQuestion(id: string, questionId: string, body: AnswerRequest, idempotencyKey: string): Promise<unknown> {
    return this.request('POST', this.threadPath(id, `/questions/${encodeURIComponent(questionId)}`), { body, idempotencyKey });
  }

  getRunFailure(id: string, runId: string): Promise<{ detail: RunFailureDetail }> {
    return this.request('GET', this.threadPath(id, `/runs/${encodeURIComponent(runId)}/failure`));
  }

  getDiff(id: string, mode: DiffMode): Promise<{ diff: ThreadDiff }> {
    return this.request('GET', this.threadPath(id, '/diff'), { query: { mode } });
  }

  getEventHead(filter: EventFilter): Promise<{ cursor: string }> {
    return this.request('GET', '/api/events/head', { query: { ...filter } });
  }

  /**
   * Opens the server-sent event stream. The first connection starts from `cursor`;
   * a reconnect resumes from the last SSE id through `Last-Event-ID`.
   */
  async openEventStream(filter: EventFilter, resume: { cursor?: string; lastEventId?: string; signal: AbortSignal }): Promise<Response> {
    const url = this.url('/api/events/stream', { ...filter, cursor: resume.lastEventId ? undefined : resume.cursor });
    const headers: Record<string, string> = {
      'X-Api-Key': this.apiKey,
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'User-Agent': this.userAgent,
    };
    if (resume.lastEventId) headers['Last-Event-ID'] = resume.lastEventId;
    const response = await this.fetchImpl(url, { headers, redirect: 'error', signal: resume.signal });
    if (!response.ok) throw this.toError(response, await response.text().catch(() => ''));
    return response;
  }

  private threadPath(id: string, suffix = ''): string {
    return `/api/threads/${encodeURIComponent(id)}${suffix}`;
  }

  private url(path: string, query?: Query): URL {
    const url = new URL(path, this.origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.url(path, options.query);
    const headers: Record<string, string> = {
      'X-Api-Key': this.apiKey,
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    // A write is only repeated when the API can deduplicate it.
    const retryable = method === 'GET' || Boolean(options.idempotencyKey);

    for (let attempt = 1; ; attempt++) {
      const canRetry = retryable && attempt < this.maxAttempts;
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        response = await this.fetchImpl(url, {
          method,
          headers,
          body,
          // Never follow a redirect: it could forward the API key to another origin.
          redirect: 'error',
          signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (!canRetry) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new HopliteApiError(0, 'network_error', `Cannot reach the Hoplite API at ${this.origin.host}: ${reason}`);
        }
        await this.sleep(1000 * attempt);
        continue;
      }

      const text = await response.text();
      if (response.ok) {
        try {
          const payload: unknown = JSON.parse(text);
          if (isRecord(payload)) return payload as T;
        } catch {
          // handled below
        }
        throw new HopliteApiError(response.status, 'invalid_response', 'The Hoplite API returned an unexpected response.', response.headers.get('x-request-id') ?? undefined);
      }

      const error = this.toError(response, text);
      const pending = error.code === 'operation_outcome_pending';
      if (canRetry && (RETRY_STATUSES.has(response.status) || pending)) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : attempt;
        await this.sleep(Math.min(30_000, seconds * 1000));
        continue;
      }
      throw error;
    }
  }

  private toError(response: Response, text: string): HopliteApiError {
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) payload = parsed;
    } catch {
      // non-JSON error body
    }
    const code = typeof payload.error === 'string' ? payload.error : `http_${response.status}`;
    const parts = [KNOWN_ERRORS[code] ?? `${STATUS_TEXT[response.status] ?? `Hoplite API error ${response.status}`} (${code}).`];
    if (typeof payload.message === 'string') parts.push(payload.message);
    const fields = payload.issues ?? payload.details ?? payload.fields;
    if (fields !== undefined) parts.push(JSON.stringify(fields).slice(0, 500));
    const requestId = (typeof payload.requestId === 'string' ? payload.requestId : undefined) ?? response.headers.get('x-request-id') ?? undefined;
    return new HopliteApiError(response.status, code, parts.join(' '), requestId);
  }
}
