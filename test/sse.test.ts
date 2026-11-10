import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDraft, readSse } from '../src/api/sse.ts';
import type { SseFrame } from '../src/api/sse.ts';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of readSse(streamOf(chunks))) frames.push(frame);
  return frames;
}

test('parses frames with ids, comments and multi-line data', async () => {
  const frames = await collect([': keep-alive\n\nid: c1\nevent: run.completed\ndata: {"a":1}\n\nevent: note\ndata: one\ndata: two\n\n']);
  assert.deepEqual(frames, [
    { event: 'run.completed', data: '{"a":1}', id: 'c1' },
    { event: 'note', data: 'one\ntwo' },
  ]);
});

test('reassembles frames split across chunks, including a split CRLF', async () => {
  const frames = await collect(['id: c', '2\r', '\nevent: dra', 'ft\r\ndata: {"x"', ':"y"}\r\n', '\r\n']);
  assert.deepEqual(frames, [{ event: 'draft', data: '{"x":"y"}', id: 'c2' }]);
});

test('yields id-only frames so the cursor can be tracked, and defaults the event name', async () => {
  const frames = await collect(['id: c3\n\ndata: plain\n\n']);
  assert.deepEqual(frames, [
    { event: 'message', data: '', id: 'c3' },
    { event: 'message', data: 'plain' },
  ]);
});

test('reads draft text from the documented and the alternative field spellings', () => {
  assert.deepEqual(parseDraft({ messageId: 'm1', streamId: 's1', revision: 3, content: 'Hello' }), {
    messageId: 'm1',
    streamId: 's1',
    revision: 3,
    content: 'Hello',
    kind: undefined,
  });
  assert.equal(parseDraft({ messageId: 'm1', revision: '4', text: 'Hi' })?.revision, 4);
  assert.equal(parseDraft({ draft: { messageId: 'm2', content: [{ text: 'a' }, { text: 'b' }] } })?.content, 'ab');
  assert.equal(parseDraft({ messageId: 'm3', revision: 1 }), undefined);
  assert.equal(parseDraft({ content: 'no id' }), undefined);
});
