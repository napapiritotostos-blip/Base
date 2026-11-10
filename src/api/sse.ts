import { HopliteApiError } from './client.ts';
import type { PublicEvent } from './types.ts';

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/** Parses a `text/event-stream` body. Frames that only carry an `id` are yielded too, so the caller can track it. */
export async function* readSse(body: ReadableStream<Uint8Array>, onActivity?: () => void): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;
  let dirty = false;

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      onActivity?.();
      buffer += decoder.decode(chunk.value, { stream: true });

      let start = 0;
      for (;;) {
        let end = -1;
        let next = -1;
        for (let i = start; i < buffer.length; i++) {
          const code = buffer.charCodeAt(i);
          if (code === 10) {
            end = i;
            next = i + 1;
            break;
          }
          if (code === 13) {
            // A trailing CR may be the first half of a CRLF split across chunks.
            if (i + 1 >= buffer.length) break;
            end = i;
            next = buffer.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
            break;
          }
        }
        if (end === -1) break;
        const line = buffer.slice(start, end);
        start = next;

        if (line === '') {
          if (dirty) {
            const frame: SseFrame = { event: event || 'message', data: data.join('\n') };
            if (id !== undefined) frame.id = id;
            event = '';
            data = [];
            id = undefined;
            dirty = false;
            yield frame;
          }
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') {
          event = value;
          dirty = true;
        } else if (field === 'data') {
          data.push(value);
          dirty = true;
        } else if (field === 'id' && !value.includes('\0')) {
          id = value;
          dirty = true;
        }
      }
      buffer = buffer.slice(start);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** In-progress assistant reply. A newer revision replaces the previous snapshot. */
export interface DraftFrame {
  messageId: string;
  streamId?: string;
  revision: number;
  content: string;
  kind?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map((part) => (typeof part === 'string' ? part : isRecord(part) && typeof part.text === 'string' ? part.text : ''));
    return parts.join('');
  }
  return undefined;
}

/**
 * The API documents `messageId`, `streamId` and `revision` on draft frames but not the
 * text field, so the common spellings are accepted. A frame without text is ignored and
 * the persisted message still arrives through the durable events.
 */
export function parseDraft(payload: unknown): DraftFrame | undefined {
  if (!isRecord(payload)) return undefined;
  const nested = isRecord(payload.draft) ? payload.draft : isRecord(payload.data) ? payload.data : undefined;
  const source = nested ? { ...payload, ...nested } : payload;
  const messageId = asString(source.messageId) ?? asString(source.id);
  const content = textOf(source.content) ?? textOf(source.text);
  if (!messageId || content === undefined) return undefined;
  const revision = Number(source.revision);
  return {
    messageId,
    streamId: asString(source.streamId),
    revision: Number.isFinite(revision) ? revision : 0,
    content,
    kind: asString(source.kind),
  };
}

export type StreamState = 'connecting' | 'open' | 'retrying' | 'unavailable';

export interface EventStreamOptions {
  open(resume: { cursor?: string; lastEventId?: string; signal: AbortSignal }): Promise<Response>;
  initialCursor?: string;
  onEvent(event: PublicEvent): void;
  onDraft(draft: DraftFrame): void;
  onDraftRemoved(messageId: string): void;
  onState(state: StreamState): void;
  /** Called when the cursor expired: reload the snapshot and return a fresh cursor. */
  resync(): Promise<string>;
  log?(message: string): void;
  /** Heartbeats arrive every 15 seconds; a silent stream is reopened after this long. */
  idleTimeoutMs?: number;
  maxBackoffMs?: number;
}

const PERMANENT_STATUSES = new Set([400, 401, 402, 403, 404, 501]);

/** Keeps one event stream open, resuming from the last cursor after a drop. */
export class EventStreamConnection {
  private readonly options: EventStreamOptions;
  private readonly seen: string[] = [];
  private readonly seenSet = new Set<string>();
  private cursor: string | undefined;
  private lastEventId: string | undefined;
  private abort: AbortController | undefined;
  private stopped = false;

  constructor(options: EventStreamOptions) {
    this.options = options;
    this.cursor = options.initialCursor;
  }

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  private async run(): Promise<void> {
    const idleTimeoutMs = this.options.idleTimeoutMs ?? 45_000;
    const maxBackoffMs = this.options.maxBackoffMs ?? 15_000;
    let failures = 0;

    while (!this.stopped) {
      const abort = new AbortController();
      this.abort = abort;
      let watchdog: ReturnType<typeof setInterval> | undefined;
      try {
        this.options.onState('connecting');
        const response = await this.options.open({ cursor: this.cursor, lastEventId: this.lastEventId, signal: abort.signal });
        if (!response.body) throw new Error('The event stream has no body.');
        this.options.onState('open');
        failures = 0;
        let lastActivity = Date.now();
        watchdog = setInterval(() => {
          if (Date.now() - lastActivity > idleTimeoutMs) abort.abort();
        }, Math.min(5000, idleTimeoutMs));
        for await (const frame of readSse(response.body, () => (lastActivity = Date.now()))) {
          if (this.stopped) break;
          this.dispatch(frame);
        }
      } catch (error) {
        if (this.stopped) break;
        if (error instanceof HopliteApiError && error.status === 410) {
          try {
            this.cursor = await this.options.resync();
            this.lastEventId = undefined;
            continue;
          } catch (resyncError) {
            this.options.log?.(`Event resync failed: ${String(resyncError)}`);
          }
        } else if (error instanceof HopliteApiError && PERMANENT_STATUSES.has(error.status)) {
          this.options.log?.(`Event stream unavailable: ${error.message}`);
          this.options.onState('unavailable');
          return;
        } else {
          this.options.log?.(`Event stream interrupted: ${error instanceof Error ? error.message : String(error)}`);
        }
        failures++;
      } finally {
        clearInterval(watchdog);
      }
      if (this.stopped) break;
      this.options.onState('retrying');
      await new Promise((resolve) => setTimeout(resolve, Math.min(maxBackoffMs, 500 * 2 ** Math.min(failures, 5))));
    }
  }

  private dispatch(frame: SseFrame): void {
    if (frame.id) this.lastEventId = frame.id;
    if (!frame.data) return;
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      return;
    }
    if (!isRecord(payload)) return;

    if (frame.event === 'draft.removed') {
      const messageId = asString(payload.messageId) ?? asString(payload.id);
      if (messageId) this.options.onDraftRemoved(messageId);
      return;
    }
    if (frame.event === 'draft' || frame.event.startsWith('draft.')) {
      const draft = parseDraft(payload);
      if (draft) this.options.onDraft(draft);
      return;
    }

    // Heartbeats carry a replay cursor but no event.
    if (!frame.id && typeof payload.cursor === 'string') this.lastEventId = payload.cursor;
    if (typeof payload.id !== 'string' || typeof payload.type !== 'string') return;
    if (this.seenSet.has(payload.id)) return;
    this.seenSet.add(payload.id);
    this.seen.push(payload.id);
    if (this.seen.length > 1000) this.seenSet.delete(this.seen.shift() as string);
    this.options.onEvent(payload as unknown as PublicEvent);
  }
}
