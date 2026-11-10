import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { HopliteClient } from '../src/api/client.ts';
import type { ActiveRun, Message, Thread } from '../src/api/types.ts';
import { ThreadSession } from '../src/session.ts';
import { MockServer, waitFor } from './helpers/mockServer.ts';

const THREAD = '/api/threads/t1';
// Long safety intervals while live, so these tests prove updates arrive through events.
const timing = { refreshDelayMs: 5, tickMs: 10, pollActiveMs: 30, pollIdleMs: 30, liveActiveMs: 60_000, liveIdleMs: 60_000 };

let server: MockServer;
let session: ThreadSession;
let thread: Thread;
let messages: Message[];
let activeRun: ActiveRun | null;

function message(id: string, role: Message['role'], content: string, second: number): Message {
  return { id, threadId: 't1', role, kind: 'chat', content, createdAt: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z` };
}

function durable(id: string, type: string, cursor: string): void {
  server.emit(type, { id, type, orgId: 'o1', projectId: 'p1', threadId: 't1', runId: 'r1', sequence: '1', data: { id: 'x' }, cursor }, cursor);
}

beforeEach(async () => {
  thread = { id: 't1', projectId: 'p1', status: 'running', title: 'Demo', modelId: 'model-a', latestRunId: 'r1' };
  messages = [message('m1', 'user', 'Fix the login redirect', 1)];
  activeRun = { runId: 'r1', status: 'running' };
  server = await new MockServer().start();
  server
    .enableStream()
    .on('GET', '/api/events/head', () => ({ body: { ok: true, cursor: 'c0' } }))
    .on('GET', THREAD, () => ({ body: { ok: true, thread } }))
    .on('GET', `${THREAD}/messages`, () => ({ body: { ok: true, messages: [...messages].reverse(), hasMore: false, nextCursor: null } }))
    .on('GET', `${THREAD}/active-run`, () => ({ body: { ok: true, activeRun } }))
    .on('GET', `${THREAD}/questions`, () => ({ body: { ok: true, questions: [] } }));
  session = new ThreadSession(new HopliteClient({ baseUrl: server.url, apiKey: 'hop_test' }), 't1', { timing });
});

afterEach(async () => {
  session.dispose();
  await server.stop();
});

test('loads the snapshot, then follows live drafts and persisted messages', async () => {
  await session.start();
  assert.equal(session.thread?.title, 'Demo');
  assert.deepEqual(
    session.messages.map((entry) => entry.id),
    ['m1'],
  );
  assert.equal(session.isRunActive(), true);

  await waitFor(() => session.connection === 'live' && server.streamCount === 1, 'live stream');
  const [stream] = server.requestsTo('GET', '/api/events/stream');
  assert.equal(stream.query.get('threadId'), 't1');
  assert.equal(stream.query.get('cursor'), 'c0');
  assert.equal(stream.headers['x-api-key'], 'hop_test');

  server.emit('draft', { messageId: 'm2', streamId: 's1', revision: 1, content: 'Looking' });
  await waitFor(() => session.drafts[0]?.content === 'Looking', 'first draft');
  server.emit('draft', { messageId: 'm2', streamId: 's1', revision: 3, content: 'Looking at the redirect' });
  server.emit('draft', { messageId: 'm2', streamId: 's1', revision: 2, content: 'stale' });
  await waitFor(() => session.drafts[0]?.content === 'Looking at the redirect', 'newer draft');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(session.drafts[0].content, 'Looking at the redirect', 'an older revision does not replace a newer one');

  messages.push(message('m2', 'assistant', 'Fixed the redirect.', 5));
  activeRun = null;
  thread = { ...thread, status: 'ready' };
  server.emit('draft.removed', { messageId: 'm2' });
  durable('e1', 'message.persisted', 'c1');
  durable('e2', 'run.completed', 'c2');

  await waitFor(() => session.messages.length === 2 && session.drafts.length === 0 && !session.isRunActive(), 'persisted reply');
  assert.deepEqual(
    session.messages.map((entry) => entry.content),
    ['Fix the login redirect', 'Fixed the redirect.'],
  );
  assert.equal(session.thread?.status, 'ready');
});

test('resumes the stream from the last event id after a drop', async () => {
  await session.start();
  await waitFor(() => server.streamCount === 1, 'first stream');
  durable('e1', 'thread.updated', 'c7');
  await waitFor(() => server.requestsTo('GET', THREAD).length >= 2, 'refresh after the event');

  server.dropStreams();
  await waitFor(() => server.requestsTo('GET', '/api/events/stream').length === 2 && server.streamCount === 1, 'reconnect');
  const resumed = server.requestsTo('GET', '/api/events/stream')[1];
  assert.equal(resumed.headers['last-event-id'], 'c7');
  assert.equal(resumed.query.get('cursor'), null);
});

test('sends a follow-up with the selected model and an idempotency key', async () => {
  server.on('POST', `${THREAD}/messages`, () => ({ status: 201, body: { ok: true, message: { id: 'm3' }, run: { id: 'r2' } } }));
  await session.start();
  await session.send('Also add a test', 'model-b');

  const [request] = server.requestsTo('POST', `${THREAD}/messages`);
  assert.deepEqual(request.body, { content: 'Also add a test', model: 'model-b' });
  assert.match(String(request.headers['idempotency-key']), /^[0-9a-f-]{36}$/);
  assert.equal(session.pending.length, 0);
  assert.equal(session.messages.at(-1)?.content, 'Also add a test');
});

test('removes the optimistic message when sending fails', async () => {
  server.on('POST', `${THREAD}/messages`, () => ({ status: 400, body: { ok: false, error: 'invalid_model' } }));
  await session.start();
  await assert.rejects(session.send('Hello', 'nope'), /invalid_model/);
  assert.equal(session.pending.length, 0);
  assert.equal(session.messages.length, 1);
});

test('stops the run reported as active', async () => {
  server.on('POST', `${THREAD}/stop`, () => ({ status: 202, body: { ok: true, result: { threadId: 't1' } } }));
  await session.start();
  assert.equal(await session.stop(), true);
  assert.deepEqual(server.requestsTo('POST', `${THREAD}/stop`)[0].body, { runId: 'r1' });

  activeRun = null;
  assert.equal(await session.stop(), false);
  assert.equal(server.requestsTo('POST', `${THREAD}/stop`).length, 1);
});

test('falls back to polling when the event stream is unavailable', async () => {
  server.on('GET', '/api/events/stream', () => ({ status: 501, body: { ok: false, error: 'not_configured' } }));
  await session.start();
  await waitFor(() => session.connection === 'polling', 'polling mode');

  messages.push(message('m2', 'assistant', 'Done.', 9));
  await waitFor(() => session.messages.length === 2, 'polled message');
  assert.equal(server.requestsTo('GET', '/api/events/stream').length, 1, 'a permanent failure is not retried');
});

test('reads the failure detail of a failed run and answers questions', async () => {
  thread = { ...thread, status: 'failed', runStatus: 'failed' };
  activeRun = null;
  server
    .on('GET', `${THREAD}/runs/r1/failure`, () => ({ body: { ok: true, detail: { code: 'out_of_credits', message: 'You are out of credits' } } }))
    .on('GET', `${THREAD}/questions`, () => ({
      body: { ok: true, questions: [{ questionId: 'q1', runId: 'r1', request: { questions: [{ header: 'DB', question: 'Which database?', multiSelect: false, options: [] }] } }] },
    }))
    .on('POST', `${THREAD}/questions/q1`, () => ({ status: 202, body: { ok: true, result: { threadId: 't1' } } }));
  await session.start();
  assert.deepEqual(session.failure, { code: 'out_of_credits', message: 'You are out of credits', runId: 'r1' });
  assert.equal(session.questions.length, 1);

  await session.answerQuestion('q1', { answer: 'Postgres' });
  assert.deepEqual(server.requestsTo('POST', `${THREAD}/questions/q1`)[0].body, { answer: 'Postgres' });
});
