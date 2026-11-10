import type { CreateThreadRequest, ModelCatalog, ModelInfo, Project, RepoRef } from './api/types.ts';

export type AutoMerge = 'inherit' | 'on' | 'off';

/** Run parameters for new threads. An empty string means "use the Hoplite default". */
export interface RunParams {
  model: string;
  reasoning: string;
  speed: string;
  spendLimitUsd: number;
  autoMerge: AutoMerge;
  repositories: string[];
  onBehalfOfUserId: string;
}

export function findModel(catalog: ModelCatalog | undefined, id: string): ModelInfo | undefined {
  return id ? catalog?.models.find((model) => model.id === id) : undefined;
}

/** The model a thread gets when none is requested: the project default, then the workspace default. */
export function defaultModelId(catalog: ModelCatalog | undefined, project: Project | undefined): string {
  return project?.defaultModel || catalog?.runConfig.defaultModelId || '';
}

export function reasoningOptionsFor(catalog: ModelCatalog | undefined, modelId: string): string[] {
  const levels = findModel(catalog, modelId)?.capabilities?.reasoningLevels;
  return levels ?? catalog?.runConfig.reasoningOptions ?? [];
}

export function speedOptionsFor(catalog: ModelCatalog | undefined, modelId: string): string[] {
  const all = catalog?.runConfig.speedOptions ?? [];
  const capabilities = findModel(catalog, modelId)?.capabilities;
  return capabilities && !capabilities.supportsFast ? all.filter((speed) => speed !== 'fast') : all;
}

/** Parses `owner/repo` and `owner/repo@branch` entries. */
export function parseRepositories(entries: string[]): RepoRef[] {
  const repos: RepoRef[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const at = entry.indexOf('@');
    const repoFullName = at === -1 ? entry : entry.slice(0, at);
    const branch = at === -1 ? '' : entry.slice(at + 1).trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
      throw new Error(`Invalid repository "${entry}". Use owner/repo or owner/repo@branch.`);
    }
    repos.push(branch ? { repoFullName, branch } : { repoFullName });
  }
  return repos;
}

export function usdToMicros(usd: number): number | undefined {
  return Number.isFinite(usd) && usd > 0 ? Math.max(1, Math.round(usd * 1_000_000)) : undefined;
}

export interface CreateThreadInput {
  projectId: string;
  prompt: string;
  title?: string;
  params: RunParams;
  catalog?: ModelCatalog;
  project?: Project;
}

/**
 * Builds the create-thread body. Defaults are omitted so Hoplite resolves them, and a
 * reasoning level or speed the chosen model does not offer is dropped rather than rejected.
 */
export function buildCreateThreadRequest(input: CreateThreadInput): CreateThreadRequest {
  const { params, catalog } = input;
  const request: CreateThreadRequest = { projectId: input.projectId, prompt: input.prompt };

  const title = input.title?.trim();
  if (title) request.title = title;

  const model = params.model.trim();
  if (model) request.model = model;
  const effectiveModel = model || defaultModelId(catalog, input.project);

  if (params.reasoning && (!catalog || reasoningOptionsFor(catalog, effectiveModel).includes(params.reasoning))) {
    request.reasoning = { mode: params.reasoning };
  }
  if (params.speed && (!catalog || speedOptionsFor(catalog, effectiveModel).includes(params.speed))) {
    request.speed = params.speed;
  }

  const spendLimitMicros = usdToMicros(params.spendLimitUsd);
  if (spendLimitMicros !== undefined) request.spendLimitMicros = spendLimitMicros;

  if (params.autoMerge === 'on') request.autoMerge = true;
  else if (params.autoMerge === 'off') request.autoMerge = false;

  const repos = parseRepositories(params.repositories);
  if (repos.length > 0) request.repos = repos;

  const onBehalfOfUserId = params.onBehalfOfUserId.trim();
  if (onBehalfOfUserId) request.onBehalfOfUserId = onBehalfOfUserId;

  return request;
}
