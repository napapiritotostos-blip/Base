import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelCatalog } from '../src/api/types.ts';
import { buildCreateThreadRequest, parseRepositories, reasoningOptionsFor, speedOptionsFor, usdToMicros } from '../src/runParams.ts';
import type { RunParams } from '../src/runParams.ts';

const catalog: ModelCatalog = {
  providers: [{ provider: 'anthropic', label: 'Anthropic', defaultModelId: 'deep' }],
  runConfig: {
    defaultModelId: 'deep',
    defaultReasoning: 'medium',
    defaultSpeed: 'standard',
    reasoningOptions: ['off', 'low', 'medium', 'high', 'max'],
    speedOptions: ['standard', 'fast'],
  },
  models: [
    { id: 'deep', name: 'Deep', provider: 'anthropic', capabilities: { reasoningLevels: ['low', 'medium', 'high'], supportsFast: false } },
    { id: 'quick', name: 'Quick', provider: 'openai', capabilities: { reasoningLevels: ['low'], supportsFast: true } },
    { id: 'plain', name: 'Plain', provider: 'openai' },
  ],
};

const defaults: RunParams = { model: '', reasoning: '', speed: '', spendLimitUsd: 0, autoMerge: 'inherit', repositories: [], onBehalfOfUserId: '' };

test('omits every default so Hoplite resolves it', () => {
  assert.deepEqual(buildCreateThreadRequest({ projectId: 'p1', prompt: 'Fix it', params: defaults, catalog }), { projectId: 'p1', prompt: 'Fix it' });
});

test('maps every run parameter to the create-thread body', () => {
  const request = buildCreateThreadRequest({
    projectId: 'p1',
    prompt: 'Fix it',
    title: '  Login bug ',
    catalog,
    params: {
      model: 'quick',
      reasoning: 'low',
      speed: 'fast',
      spendLimitUsd: 2.5,
      autoMerge: 'off',
      repositories: ['acme/web@develop', 'acme/api'],
      onBehalfOfUserId: 'user_1',
    },
  });
  assert.deepEqual(request, {
    projectId: 'p1',
    prompt: 'Fix it',
    title: 'Login bug',
    model: 'quick',
    reasoning: { mode: 'low' },
    speed: 'fast',
    spendLimitMicros: 2_500_000,
    autoMerge: false,
    repos: [{ repoFullName: 'acme/web', branch: 'develop' }, { repoFullName: 'acme/api' }],
    onBehalfOfUserId: 'user_1',
  });
});

test('drops a reasoning level or speed the model does not offer', () => {
  const request = buildCreateThreadRequest({ projectId: 'p1', prompt: 'x', catalog, params: { ...defaults, model: 'deep', reasoning: 'max', speed: 'fast', autoMerge: 'on' } });
  assert.deepEqual(request, { projectId: 'p1', prompt: 'x', model: 'deep', autoMerge: true });
});

test('checks reasoning against the project default model when none is selected', () => {
  const project = { id: 'p1', name: 'P', defaultModel: 'quick' };
  const high = buildCreateThreadRequest({ projectId: 'p1', prompt: 'x', catalog, project, params: { ...defaults, reasoning: 'high' } });
  assert.equal(high.reasoning, undefined);
  const low = buildCreateThreadRequest({ projectId: 'p1', prompt: 'x', catalog, project, params: { ...defaults, reasoning: 'low' } });
  assert.deepEqual(low.reasoning, { mode: 'low' });
});

test('sends parameters unchecked when the model catalog is unavailable', () => {
  const request = buildCreateThreadRequest({ projectId: 'p1', prompt: 'x', params: { ...defaults, model: 'custom', reasoning: 'xhigh', speed: 'fast' } });
  assert.deepEqual(request, { projectId: 'p1', prompt: 'x', model: 'custom', reasoning: { mode: 'xhigh' }, speed: 'fast' });
});

test('lists the options a model supports', () => {
  assert.deepEqual(reasoningOptionsFor(catalog, 'deep'), ['low', 'medium', 'high']);
  assert.deepEqual(reasoningOptionsFor(catalog, 'plain'), ['off', 'low', 'medium', 'high', 'max']);
  assert.deepEqual(speedOptionsFor(catalog, 'deep'), ['standard']);
  assert.deepEqual(speedOptionsFor(catalog, 'quick'), ['standard', 'fast']);
});

test('parses repositories and rejects malformed entries', () => {
  assert.deepEqual(parseRepositories([' acme/web ', '', 'acme/api@release/1.0']), [{ repoFullName: 'acme/web' }, { repoFullName: 'acme/api', branch: 'release/1.0' }]);
  assert.throws(() => parseRepositories(['web']), /owner\/repo/);
});

test('converts dollars to microdollars', () => {
  assert.equal(usdToMicros(1), 1_000_000);
  assert.equal(usdToMicros(0.000_000_4), 1);
  assert.equal(usdToMicros(0), undefined);
  assert.equal(usdToMicros(Number.NaN), undefined);
});
