import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fenceFor, formatDiff, formatSelection, relativeTime, repoFullNameFromRemote, setupPhase } from '../src/util.ts';

test('extracts owner/repo from git remotes', () => {
  assert.equal(repoFullNameFromRemote('https://github.com/acme/web.git'), 'acme/web');
  assert.equal(repoFullNameFromRemote('git@github.com:acme/web.git'), 'acme/web');
  assert.equal(repoFullNameFromRemote('ssh://git@github.com/acme/web/'), 'acme/web');
  assert.equal(repoFullNameFromRemote('web'), undefined);
});

test('fences a selection with more backticks than it contains', () => {
  assert.equal(fenceFor('plain'), '```');
  assert.equal(fenceFor('a ```` b'), '`````');
  assert.equal(formatSelection('src/a.ts', 3, 4, 'typescript', 'const a = 1;\nconst b = 2;\n'), '`src/a.ts` (lines 3-4):\n```typescript\nconst a = 1;\nconst b = 2;\n```\n');
});

test('renders the API diff as a unified patch', () => {
  const text = formatDiff(
    {
      threadId: 't1',
      mode: 'base',
      files: [
        { path: 'src/new.ts', state: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+export {};\n' },
        { path: 'b.ts', previousPath: 'a.ts', state: 'renamed', patch: '' },
        { path: 'big.bin', truncated: true, truncatedReason: 'binary' },
      ],
    },
    'Demo thread',
  );
  assert.equal(
    text,
    [
      '# Demo thread',
      '# base diff: 3 file(s), +1 -0',
      '',
      'diff --git a/src/new.ts b/src/new.ts',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+export {};',
      '',
      'diff --git a/a.ts b/b.ts',
      '--- a/a.ts',
      '+++ b/b.ts',
      '# no textual changes',
      '',
      'diff --git a/big.bin b/big.bin',
      '--- a/big.bin',
      '+++ b/big.bin',
      '# patch truncated: binary',
      '',
    ].join('\n'),
  );
});

test('keeps a patch that already carries its file headers', () => {
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b';
  const text = formatDiff({ threadId: 't1', mode: 'pr', files: [{ path: 'x', patch }] }, 'T');
  assert.equal(text.split('diff --git').length, 2);
});

test('describes relative time and the setup phase', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  assert.equal(relativeTime('2026-01-01T23:59:40Z', now), 'just now');
  assert.equal(relativeTime('2026-01-01T23:30:00Z', now), '30m ago');
  assert.equal(relativeTime('2026-01-01T00:00:00Z', now), '1d ago');
  assert.equal(relativeTime(undefined, now), '');
  assert.equal(setupPhase({ id: 't', projectId: 'p', status: 'queued', initializationState: 'preparing', initializationPhase: 'allocating_sandbox' }), 'Allocating sandbox');
  assert.equal(setupPhase({ id: 't', projectId: 'p', status: 'running', initializationState: 'completed' }), undefined);
});
