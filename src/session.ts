import { randomUUID } from 'node:crypto';
import { HopliteApiError } from './api/client.ts';
import type { HopliteClient } from './api/client.ts';
import { EventStreamConnection } from './api/sse.ts';
import type { DraftFrame, StreamState } from './api/sse.ts';
import type { ActiveRun, AnswerRequest, Message, MessagesResponse, PublicEvent, RunFailureDetail, Thread, ThreadQuestion } from './api/types.ts';
import { errorMessage } from './util.ts';

export type SessionChange = 'thread' | 'messages' | 'drafts';
export type ConnectionState = 'idle' | 'connecting' | 'live' | 'polling';

export interface SessionTiming {
  /** Debounce for refreshes triggered by events. */
  refreshDelayMs: number;
  tickMs: number;
  /** Refresh intervals without a live event stream. */
  pollActiveMs: number;
  pollIdleMs: number;
  /** Safety refresh intervals while the event stream is live. */
  liveActiveMs: number;
  liveIdleMs: number;
}

const DEFAULT_TIMING: SessionTiming = {
  refreshDelayMs: 400,
  tickMs: 1000,
  pollActiveMs: 3000,
  pollIdleMs: 15_000,
  liveActiveMs: 20_000,
  liveIdleMs: 60_000,
};

export interface SessionOptions {
  log?: (message: string) => void;
  initialThread?: Thread;
  initialMessages?: Message[];
  pageSize?: number;
  timing?: Partial<SessionTiming>;
}

export interface SessionDraft {
  messageId: string;
  revision: number;
  content: string;
  kind?: string;
  /** Superseded by a persisted message that has not been loaded yet. */
  removed?: boolean;
}

export interface PendingMessage {
  localId: string;
  content: string;
  createdAt: string;
}

export interface SessionFailure extends RunFailureDetail {
  runId: string;
}

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'waiting']);

/** Live state of one open thread: a snapshot kept current by the event stream, with polling as fallback. */
export class ThreadSession {
  readonly threadId: string;
  thread: Thread | undefined;
  activeRun: ActiveRun | null = null;
  questions: ThreadQuestion[] = [];
  failure: SessionFailure | undefined;
  pending: PendingMessage[] = [];
  connection: ConnectionState = 'idle';
  loading = false;
  hasEarlier = false;
  error: string | undefined;

  private readonly client: HopliteClient;
  private readonly log: (message: string) => void;
  private readonly timing: SessionTiming;
  private readonly pageSize: number;
  private readonly listeners = new Set<(change: SessionChange) => void>();
  private readonly byId = new Map<string, Message>();
  private readonly order = new Map<string, number>();
  private readonly draftsById = new Map<string, SessionDraft>();
  private sorted: Message[] | undefined;
  private sequence = 0;
  private earlierCursor: string | undefined;
  private firstPageLoaded = false;
  private stream: EventStreamConnection | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;
  private wanted: 'none' | 'messages' | 'all' = 'none';
  private lastRefreshAt = 0;
  private disposed = false;

  constructor(client: HopliteClient, threadId: string, options: SessionOptions = {}) {
    this.client = client;
    this.threadId = threadId;
    this.log = options.log ?? (() => undefined);
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.pageSize = options.pageSize ?? 200;
    this.thread = options.initialThread;
    if (options.initialMessages?.length) this.mergeMessages(options.initialMessages);
  }

  get messages(): Message[] {
    if (!this.sorted) {
      this.sorted = [...this.byId.values()].sort((a, b) => {
        const left = Date.parse(a.createdAt);
        const right = Date.parse(b.createdAt);
        if (left !== right && !Number.isNaN(left) && !Number.isNaN(right)) return left - right;
        return (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0);
      });
    }
    return this.sorted;
  }

  get drafts(): SessionDraft[] {
    return [...this.draftsById.values()];
  }

  isRunActive(): boolean {
    if (this.activeRun) return ACTIVE_RUN_STATUSES.has(this.activeRun.status);
    return this.thread?.status === 'queued' || this.thread?.status === 'running';
  }

  onDidChange(listener: (change: SessionChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Captures the event cursor before the snapshot, so events committed while it loads are replayed. */
  async start(): Promise<void> {
    this.loading = true;
    this.emit('thread');
    let cursor: string | undefined;
    try {
      cursor = (await this.client.getEventHead({ threadId: this.threadId })).cursor;
    } catch (error) {
      this.log(`Live events unavailable, polling instead: ${errorMessage(error)}`);
    }
    try {
      await this.refreshAll();
    } finally {
      this.loading = false;
      this.emit('thread');
    }
    if (this.disposed) return;
    if (cursor) this.startStream(cursor);
    else this.setConnection('polling');
    this.tickTimer = setInterval(() => this.tick(), this.timing.tickMs);
  }

  dispose(): void {
    this.disposed = true;
    this.stream?.stop();
    clearTimeout(this.refreshTimer);
    clearInterval(this.tickTimer);
    this.listeners.clear();
  }

  async refreshAll(): Promise<void> {
    const id = this.threadId;
    const [thread, page, active, questions] = await Promise.allSettled([
      this.client.getThread(id),
      this.client.listMessages(id, { limit: this.pageSize }),
      this.client.getActiveRun(id),
      this.client.listQuestions(id),
    ]);
    if (this.disposed) return;
    this.lastRefreshAt = Date.now();

    let failure: unknown;
    if (thread.status === 'fulfilled') this.thread = thread.value.thread;
    else failure = thread.reason;
    let messagesChanged = false;
    if (page.status === 'fulfilled') messagesChanged = this.applyPage(page.value, this.firstPageLoaded ? 'latest' : 'first');
    else failure ??= page.reason;
    if (active.status === 'fulfilled') this.activeRun = active.value.activeRun;
    else this.log(`Could not read the active run: ${errorMessage(active.reason)}`);
    if (questions.status === 'fulfilled') this.questions = questions.value.questions;
    else this.log(`Could not read questions: ${errorMessage(questions.reason)}`);
    this.error = failure === undefined ? undefined : errorMessage(failure);

    const draftsChanged = this.dropStaleDrafts(!this.isRunActive());
    await this.refreshFailure();
    if (this.disposed) return;
    this.emit('thread');
    if (messagesChanged) this.emit('messages');
    if (draftsChanged || messagesChanged) this.emit('drafts');
  }

  async loadEarlier(): Promise<void> {
    if (!this.hasEarlier || !this.earlierCursor) return;
    const page = await this.client.listMessages(this.threadId, { limit: this.pageSize, cursor: this.earlierCursor });
    if (this.disposed) return;
    this.applyPage(page, 'earlier');
    this.emit('thread');
    this.emit('messages');
  }

  /** Sends a follow-up. While a run is active the API either steers it or queues the message behind it. */
  async send(content: string, model?: string): Promise<void> {
    const localId = `local:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.pending.push({ localId, content, createdAt });
    this.emit('messages');
    try {
      const response = await this.client.sendMessage(this.threadId, model ? { content, model } : { content }, randomUUID());
      this.pending = this.pending.filter((message) => message.localId !== localId);
      if (!this.byId.has(response.message.id)) {
        this.mergeMessages([{ id: response.message.id, threadId: this.threadId, role: 'user', kind: 'chat', content, createdAt, runId: response.run?.id }]);
      }
      this.failure = undefined;
      this.emit('messages');
      this.scheduleRefresh('all', 0);
    } catch (error) {
      this.pending = this.pending.filter((message) => message.localId !== localId);
      this.emit('messages');
      throw error;
    }
  }

  /** Stops the active run. Returns false when nothing is running. */
  async stop(): Promise<boolean> {
    const { activeRun } = await this.client.getActiveRun(this.threadId);
    if (!activeRun) {
      this.scheduleRefresh('all', 0);
      return false;
    }
    await this.client.stopRun(this.threadId, activeRun.runId, randomUUID());
    this.scheduleRefresh('all', 0);
    return true;
  }

  async retry(): Promise<void> {
    await this.client.retryThread(this.threadId, randomUUID());
    this.failure = undefined;
    this.scheduleRefresh('all', 0);
  }

  async compact(): Promise<void> {
    await this.client.compactThread(this.threadId, randomUUID());
    this.scheduleRefresh('all', 0);
  }

  async answerQuestion(questionId: string, body: AnswerRequest): Promise<void> {
    await this.client.answerQuestion(this.threadId, questionId, body, randomUUID());
    this.questions = this.questions.filter((question) => question.questionId !== questionId);
    this.emit('thread');
    this.scheduleRefresh('all', 0);
  }

  setThread(thread: Thread): void {
    this.thread = thread;
    this.emit('thread');
  }

  scheduleRefresh(scope: 'messages' | 'all', delayMs = this.timing.refreshDelayMs): void {
    if (this.disposed) return;
    if (scope === 'all' || this.wanted === 'none') this.wanted = scope;
    if (this.refreshTimer || this.refreshing) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.runRefresh();
    }, delayMs);
  }

  private async runRefresh(): Promise<void> {
    if (this.disposed || this.refreshing) return;
    const scope = this.wanted;
    this.wanted = 'none';
    if (scope === 'none') return;
    this.refreshing = true;
    try {
      if (scope === 'all') await this.refreshAll();
      else await this.refreshMessages();
    } catch (error) {
      this.log(`Refresh failed: ${errorMessage(error)}`);
    } finally {
      this.refreshing = false;
      if (this.wanted !== 'none') this.scheduleRefresh(this.wanted);
    }
  }

  private async refreshMessages(): Promise<void> {
    const page = await this.client.listMessages(this.threadId, { limit: this.pageSize });
    if (this.disposed) return;
    const messagesChanged = this.applyPage(page, this.firstPageLoaded ? 'latest' : 'first');
    const draftsChanged = this.dropStaleDrafts(false);
    if (messagesChanged) this.emit('messages');
    if (draftsChanged || messagesChanged) this.emit('drafts');
  }

  private applyPage(page: MessagesResponse, kind: 'first' | 'latest' | 'earlier'): boolean {
    const changed = this.mergeMessages(page.messages);
    // Only the oldest loaded page decides whether earlier history exists.
    if (kind !== 'latest') {
      this.firstPageLoaded = true;
      this.earlierCursor = page.nextCursor ?? undefined;
      this.hasEarlier = page.hasMore && Boolean(page.nextCursor);
    }
    return changed;
  }

  private mergeMessages(messages: Message[]): boolean {
    let list = messages;
    // Keep arrival order ascending so messages with equal timestamps stay in server order.
    if (list.length > 1 && Date.parse(list[0].createdAt) > Date.parse(list[list.length - 1].createdAt)) list = [...list].reverse();
    let changed = false;
    for (const message of list) {
      const previous = this.byId.get(message.id);
      if (!previous) {
        this.order.set(message.id, this.sequence++);
        changed = true;
      } else if (previous.content !== message.content || previous.kind !== message.kind || previous.createdAt !== message.createdAt) {
        changed = true;
      }
      this.byId.set(message.id, message);
      // The persisted message supersedes its draft.
      if (this.draftsById.delete(message.id)) changed = true;
    }
    if (changed) this.sorted = undefined;
    return changed;
  }

  private dropStaleDrafts(all: boolean): boolean {
    let changed = false;
    for (const [id, draft] of this.draftsById) {
      if (all || draft.removed) {
        this.draftsById.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  private async refreshFailure(): Promise<void> {
    const runId = this.thread?.latestRunId;
    const failed = this.thread?.status === 'failed' || this.thread?.runStatus === 'failed';
    if (!failed || !runId) {
      this.failure = undefined;
      return;
    }
    if (this.failure?.runId === runId) return;
    try {
      const { detail } = await this.client.getRunFailure(this.threadId, runId);
      this.failure = { ...detail, runId };
    } catch (error) {
      this.log(`Could not read the run failure: ${errorMessage(error)}`);
      this.failure = { runId, code: 'unknown', message: this.thread?.initializationErrorMessage ?? 'The run failed.' };
    }
  }

  private startStream(cursor: string): void {
    this.stream = new EventStreamConnection({
      open: (resume) => this.client.openEventStream({ threadId: this.threadId }, resume),
      initialCursor: cursor,
      onEvent: (event) => this.handleEvent(event),
      onDraft: (draft) => this.handleDraft(draft),
      onDraftRemoved: (messageId) => this.handleDraftRemoved(messageId),
      onState: (state) => this.handleStreamState(state),
      resync: async () => {
        const head = await this.client.getEventHead({ threadId: this.threadId });
        await this.refreshAll();
        return head.cursor;
      },
      log: this.log,
    });
    this.stream.start();
  }

  private handleStreamState(state: StreamState): void {
    if (state === 'open') {
      // Drafts and events may have been missed while disconnected.
      if (this.connection === 'polling') this.scheduleRefresh('all', 0);
      this.setConnection('live');
    } else if (state === 'connecting') {
      if (this.connection === 'idle') this.setConnection('connecting');
    } else {
      this.setConnection('polling');
    }
  }

  private handleEvent(event: PublicEvent): void {
    const messagesOnly = event.type === 'message.persisted' || event.type === 'tool.updated';
    this.scheduleRefresh(messagesOnly ? 'messages' : 'all');
  }

  private handleDraft(draft: DraftFrame): void {
    if (this.byId.has(draft.messageId)) return;
    const current = this.draftsById.get(draft.messageId);
    if (current && current.revision > draft.revision) return;
    this.draftsById.set(draft.messageId, { messageId: draft.messageId, revision: draft.revision, content: draft.content, kind: draft.kind });
    this.emit('drafts');
  }

  private handleDraftRemoved(messageId: string): void {
    const draft = this.draftsById.get(messageId);
    if (!draft) return;
    // Keep showing it until the persisted message has been loaded, to avoid a flicker.
    draft.removed = true;
    this.scheduleRefresh('messages', 0);
  }

  private tick(): void {
    const active = this.isRunActive();
    const interval = this.connection === 'live' ? (active ? this.timing.liveActiveMs : this.timing.liveIdleMs) : active ? this.timing.pollActiveMs : this.timing.pollIdleMs;
    if (Date.now() - this.lastRefreshAt >= interval) this.scheduleRefresh('all', 0);
  }

  private setConnection(connection: ConnectionState): void {
    if (this.connection === connection) return;
    this.connection = connection;
    this.emit('thread');
  }

  private emit(change: SessionChange): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener(change);
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof HopliteApiError && error.status === 404;
}
