import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { HopliteApiError, HopliteClient, normalizeBaseUrl } from '../src/api/client.ts';
import { MockServer } from './helpers/mockServer.ts';

let server: MockServer;
let delays: number[];

function client(maxAttempts = 3): HopliteClient {
  return new HopliteClient({
    baseUrl: server.url,
    apiKey: 'hop_test',
    maxAttempts,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
}

before(async () => {
  server = await new MockServer().start();
});
after(() => server.stop());
beforeEach(() => {
  server.requests.length = 0;
  delays = [];
});

test('authenticates with X-Api-Key and omits empty query parameters', async () => {
  server.on('GET', '/api/threads', () => ({ body: { ok: true, threads: [], nextCursor: null, hasMore: false } }));
  const page = await client().listThreads({ projectId: 'p1', archived: false, cursor: undefined });
  assert.deepEqual(page.threads, []);
  const [request] = server.requests;
  assert.equal(request.headers['x-api-key'], 'hop_test');
  assert.equal(request.query.toString(), 'projectId=p1&archived=false');
});

test('maps an error response to HopliteApiError', async () => {
  server.on('GET', '/api/model-providers', () => ({ status: 401, headers: { 'x-request-id': 'req-1' }, body: { ok: false, error: 'auth_required' } }));
  await assert.rejects(client().listModels(), (error: unknown) => {
    assert.ok(error instanceof HopliteApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'auth_required');
    assert.equal(error.requestId, 'req-1');
    assert.equal(error.isAuthError, true);
    return true;
  });
  assert.equal(server.requests.length, 1, 'an authentication failure is not retried');
});

test('retries a rate-limited read after Retry-After', async () => {
  let calls = 0;
  server.on('GET', '/api/threads/t1', () =>
    ++calls === 1 ? { status: 429, headers: { 'Retry-After': '7' }, body: { ok: false, error: 'rate_limited' } } : { body: { ok: true, thread: { id: 't1' } } },
  );
  const { thread } = await client().getThread('t1');
  assert.equal(thread.id, 't1');
  assert.deepEqual(delays, [7000]);
});

test('does not repeat a write that has no idempotency key', async () => {
  server.on('PATCH', '/api/threads/t1', () => ({ status: 503, body: { ok: false, error: 'unavailable' } }));
  await assert.rejects(client().updateThread('t1', { title: 'x' }), HopliteApiError);
  assert.equal(server.requestsTo('PATCH', '/api/threads/t1').length, 1);
});

test('repeats an idempotent write with the same key', async () => {
  let calls = 0;
  server.on('POST', '/api/threads/t1/messages', () =>
    ++calls === 1 ? { status: 503, body: { ok: false, error: 'unavailable' } } : { status: 201, body: { ok: true, message: { id: 'm9' } } },
  );
  const response = await client().sendMessage('t1', { content: 'hello', model: 'model-a' }, 'key-1');
  assert.equal(response.message.id, 'm9');
  const requests = server.requestsTo('POST', '/api/threads/t1/messages');
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => request.headers['idempotency-key']),
    ['key-1', 'key-1'],
  );
  assert.deepEqual(requests[1].body, { content: 'hello', model: 'model-a' });
});

test('follows project pagination cursors', async () => {
  server.on('GET', '/api/projects', (request) =>
    request.query.get('cursor') === 'next'
      ? { body: { ok: true, projects: [{ id: 'p2', name: 'Two' }], nextCursor: null } }
      : { body: { ok: true, projects: [{ id: 'p1', name: 'One' }], nextCursor: 'next' } },
  );
  const projects = await client().listProjects();
  assert.deepEqual(
    projects.map((project) => project.id),
    ['p1', 'p2'],
  );
  assert.equal(server.requests[0].query.get('pagination'), 'cursor');
});

test('reports an unreachable API as a network error', async () => {
  const offline = new HopliteClient({ baseUrl: 'http://127.0.0.1:9', apiKey: 'hop_test', maxAttempts: 1 });
  await assert.rejects(offline.getCapabilities(), (error: unknown) => error instanceof HopliteApiError && error.code === 'network_error' && error.status === 0);
});

test('only accepts HTTPS or loopback API URLs', () => {
  assert.equal(normalizeBaseUrl('https://api.hoplite.sh/').origin, 'https://api.hoplite.sh');
  assert.equal(normalizeBaseUrl(' http://localhost:8787/api ').origin, 'http://localhost:8787');
  assert.throws(() => normalizeBaseUrl('http://api.hoplite.sh'), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('not a url'), /Invalid/);
});
