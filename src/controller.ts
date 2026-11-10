import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { HopliteApiError, HopliteClient } from './api/client.ts';
import type { AnswerRequest, DiffMode, Message, ModelCatalog, ModelInfo, Project, PullRequest, Thread, ThreadsResponse } from './api/types.ts';
import { ThreadSession } from './session.ts';
import { buildCreateThreadRequest, defaultModelId, reasoningOptionsFor, speedOptionsFor, usdToMicros } from './runParams.ts';
import type { AutoMerge, RunParams } from './runParams.ts';
import { errorMessage, formatDiff, repoFullNameFromRemote, setupPhase, usdFromMicros } from './util.ts';
import type { ViewCatalog, ViewDraft, ViewMessage, ViewPullRequest, ViewState } from './protocol.ts';
import type { DiffContentProvider } from './views/diffProvider.ts';

export type ControllerChange = 'auth' | 'project' | 'catalog' | 'params' | 'thread' | 'messages' | 'drafts' | 'threads';

export interface ThreadTarget {
  id: string;
  title?: string | null;
  pullRequests?: PullRequest[];
}

const SECRET_KEY = 'hoplite.apiKey';
const PROJECT_KEY = 'hoplite.projectId';
const THREAD_KEY = 'hoplite.threadId';
const MAX_ACTIVITY_CHARS = 12_000;

const SETTING_DEFAULTS: Record<string, unknown> = { model: '', reasoning: '', speed: '', spendLimitUsd: 0, autoMerge: 'inherit' };

interface GitRemote {
  fetchUrl?: string;
  pushUrl?: string;
}
interface GitApi {
  state?: 'uninitialized' | 'initialized';
  repositories: { state: { remotes: GitRemote[] } }[];
}
interface GitExtension {
  getAPI(version: 1): GitApi;
}

function pullRequestsOf(thread: Thread | undefined): PullRequest[] {
  const all = [...(thread?.pullRequests ?? [])];
  const primary = thread?.primaryPullRequest;
  if (primary && !all.some((pr) => pr.url === primary.url)) all.unshift(primary);
  return all;
}

function describeModel(model: ModelInfo): string {
  const parts: string[] = [];
  const capabilities = model.capabilities;
  if (capabilities?.contextWindowTokens) parts.push(`${Math.round(capabilities.contextWindowTokens / 1000)}k context`);
  if (capabilities?.reasoningLevels.length) parts.push(`reasoning: ${capabilities.reasoningLevels.join(', ')}`);
  if (capabilities?.supportsFast) parts.push('fast tier');
  if (model.requiredPlan) parts.push(`requires ${model.requiredPlan} plan`);
  if (model.usageMultiplier && model.usageMultiplier !== 1) parts.push(`${model.usageMultiplier}x usage`);
  return parts.join(' · ');
}

/** Owns the API client, the selected project, the run parameters and the open thread. */
export class HopliteController implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly log: vscode.LogOutputChannel;
  private readonly diffs: DiffContentProvider;
  private readonly changeEmitter = new vscode.EventEmitter<ControllerChange>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly contextKeys = new Map<string, boolean>();
  private apiKey: string | undefined;
  private client: HopliteClient | undefined;
  private catalog: ModelCatalog | undefined;
  private projects: Project[] | undefined;
  private session: ThreadSession | undefined;
  private unsubscribeSession: (() => void) | undefined;
  /** Model picked for the open thread; empty keeps the thread's own model. */
  private threadModel = '';
  private sending = false;
  private notice: string | undefined;

  constructor(context: vscode.ExtensionContext, log: vscode.LogOutputChannel, diffs: DiffContentProvider) {
    this.context = context;
    this.log = log;
    this.diffs = diffs;
  }

  async initialize(): Promise<void> {
    this.disposables.push(
      this.context.secrets.onDidChange((event) => {
        if (event.key === SECRET_KEY) void this.reloadKey(false);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('hoplite.apiBaseUrl')) {
          void this.applyKey(this.apiKey);
        } else if (event.affectsConfiguration('hoplite')) {
          this.syncContext();
          this.fire('params');
        }
      }),
    );
    await this.reloadKey(true);
  }

  dispose(): void {
    this.session?.dispose();
    this.unsubscribeSession?.();
    for (const disposable of this.disposables) disposable.dispose();
    this.changeEmitter.dispose();
  }

  get signedIn(): boolean {
    return Boolean(this.client);
  }

  get projectId(): string | undefined {
    return this.context.workspaceState.get<string>(PROJECT_KEY) || this.config().get<string>('projectId', '').trim() || undefined;
  }

  get project(): Project | undefined {
    const id = this.projectId;
    return id ? this.projects?.find((project) => project.id === id) : undefined;
  }

  get activeThread(): ThreadTarget | undefined {
    const session = this.session;
    return session ? { id: session.threadId, title: session.thread?.title, pullRequests: pullRequestsOf(session.thread) } : undefined;
  }

  // ----- authentication -----

  async promptApiKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: 'Hoplite API key',
      prompt: 'Create a key in Hoplite under Settings → Workspace → API keys.',
      placeHolder: 'hop_…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) =>
        input.trim() && !input.trim().startsWith('hop_')
          ? { message: 'Hoplite API keys start with hop_.', severity: vscode.InputBoxValidationSeverity.Warning }
          : undefined,
    });
    const key = value?.trim();
    if (!key) return;

    try {
      const probe = new HopliteClient({ baseUrl: this.baseUrl(), apiKey: key, userAgent: this.userAgent(), maxAttempts: 2 });
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Hoplite: checking the API key…' }, () => probe.getCapabilities());
    } catch (error) {
      if (error instanceof HopliteApiError && error.isAuthError) {
        void vscode.window.showErrorMessage(`Hoplite rejected this API key. ${error.message}`);
        return;
      }
      const choice = await vscode.window.showWarningMessage(`Hoplite: the key could not be verified. ${errorMessage(error)}`, 'Save Anyway');
      if (choice !== 'Save Anyway') return;
    }
    await this.context.secrets.store(SECRET_KEY, key);
    await this.reloadKey(false);
    void vscode.window.showInformationMessage('Hoplite: API key saved.');
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    await this.reloadKey(false);
    void vscode.window.showInformationMessage('Hoplite: API key removed from this machine.');
  }

  private async reloadKey(force: boolean): Promise<void> {
    let stored: string | undefined;
    try {
      stored = await this.context.secrets.get(SECRET_KEY);
    } catch (error) {
      this.log.warn(`Secret storage is unavailable: ${errorMessage(error)}`);
    }
    const key = stored || process.env.HOPLITE_API_KEY || undefined;
    if (!force && key === this.apiKey) return;
    await this.applyKey(key);
  }

  private async applyKey(key: string | undefined): Promise<void> {
    this.apiKey = key;
    this.closeSession(false);
    this.catalog = undefined;
    this.projects = undefined;
    this.notice = undefined;
    this.client = undefined;
    if (key) {
      try {
        this.client = new HopliteClient({ baseUrl: this.baseUrl(), apiKey: key, userAgent: this.userAgent() });
      } catch (error) {
        this.notice = errorMessage(error);
      }
    }
    this.syncContext();
    this.fire('auth');
    if (this.client) await this.bootstrap(true);
  }

  private async bootstrap(restoreThread: boolean): Promise<void> {
    const client = this.client;
    if (!client) return;
    const [catalog, projects] = await Promise.allSettled([client.listModels(), client.listProjects()]);
    if (client !== this.client) return;

    const problems: string[] = [];
    if (catalog.status === 'fulfilled') this.catalog = catalog.value;
    else problems.push(`Could not load models. ${errorMessage(catalog.reason)}`);
    if (projects.status === 'fulfilled') this.projects = projects.value;
    else problems.push(`Could not load projects. ${errorMessage(projects.reason)}`);
    this.notice = problems.length ? problems.join(' ') : undefined;
    for (const problem of problems) this.log.error(problem);

    this.syncContext();
    this.fire('catalog');
    this.fire('project');
    this.fire('threads');

    const threadId = this.context.workspaceState.get<string>(THREAD_KEY);
    if (restoreThread && threadId && !this.session) this.startSession(client, threadId, { silent: true });
    // Runs last: matching the workspace's git remote may wait for the Git extension.
    if (!this.projectId && this.projects?.length) await this.autoSelectProject(client);
  }

  // ----- project -----

  async pickProject(): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    try {
      this.projects = await client.listProjects();
    } catch (error) {
      this.report('Could not load projects', error);
      return;
    }
    if (this.projects.length === 0) {
      void vscode.window.showInformationMessage('Hoplite: this API key has no projects. Create a project in Hoplite first.');
      return;
    }
    const local = await this.workspaceRepoNames(0);
    const current = this.projectId;
    const items = this.projects.map((project) => {
      const repos = (project.repos ?? []).map((repo) => repo.repoFullName);
      const matches = repos.some((repo) => local.has(repo.toLowerCase()));
      return {
        label: `${project.id === current ? '$(check) ' : ''}${project.name}`,
        description: repos.join(', ') + (matches ? ' · this workspace' : ''),
        detail: project.description ?? undefined,
        project,
        matches,
      };
    });
    items.sort((a, b) => Number(b.matches) - Number(a.matches));
    const picked = await vscode.window.showQuickPick(items, { title: 'Hoplite: select project', matchOnDescription: true, matchOnDetail: true });
    if (picked) await this.setProject(picked.project.id);
  }

  private async setProject(id: string): Promise<void> {
    const changed = id !== this.projectId;
    await this.context.workspaceState.update(PROJECT_KEY, id);
    if (changed && this.session && this.session.thread?.projectId !== id) this.closeSession(true);
    this.syncContext();
    this.fire('project');
    this.fire('threads');
  }

  private async autoSelectProject(client: HopliteClient): Promise<void> {
    const projects = this.projects ?? [];
    if (projects.length === 1) {
      await this.setProject(projects[0].id);
      return;
    }
    const local = await this.workspaceRepoNames(5000);
    // The user may have picked a project, opened a thread or signed out in the meantime.
    if (local.size === 0 || client !== this.client || this.projectId || this.session) return;
    const matches = projects.filter((project) => project.repos?.some((repo) => local.has(repo.repoFullName.toLowerCase())));
    if (matches.length === 1) await this.setProject(matches[0].id);
  }

  /** `owner/repo` names of the git remotes in the open workspace, lower-cased. Waits up to `waitMs` for them to load. */
  private async workspaceRepoNames(waitMs: number): Promise<Set<string>> {
    const names = new Set<string>();
    try {
      const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!extension) return names;
      const git = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
      // The Git extension finds repositories, and then reads their remotes, some time after it activates.
      const deadline = Date.now() + waitMs;
      for (;;) {
        for (const repository of git.repositories) {
          for (const remote of repository.state.remotes) {
            for (const url of [remote.fetchUrl, remote.pushUrl]) {
              const name = url ? repoFullNameFromRemote(url) : undefined;
              if (name) names.add(name.toLowerCase());
            }
          }
        }
        const noRepository = git.state !== 'uninitialized' && git.repositories.length === 0;
        if (names.size > 0 || noRepository || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (error) {
      this.log.debug(`Git remotes unavailable: ${errorMessage(error)}`);
    }
    return names;
  }

  // ----- run parameters -----

  getParams(): RunParams {
    const config = this.config();
    return {
      model: config.get<string>('model', '').trim(),
      reasoning: config.get<string>('reasoning', ''),
      speed: config.get<string>('speed', ''),
      spendLimitUsd: config.get<number>('spendLimitUsd', 0),
      autoMerge: config.get<AutoMerge>('autoMerge', 'inherit'),
      repositories: config.get<string[]>('repositories', []),
      onBehalfOfUserId: config.get<string>('onBehalfOfUserId', '').trim(),
    };
  }

  async setParam(key: string, value: string | number): Promise<void> {
    if (key === 'repositories') {
      const entries = String(value)
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      await this.updateSetting('repositories', entries.length ? entries : undefined);
    } else if (key === 'spendLimitUsd') {
      const usd = Number(value);
      await this.updateSetting(key, Number.isFinite(usd) && usd > 0 ? usd : undefined);
    } else if (key === 'reasoning' || key === 'speed' || key === 'autoMerge') {
      await this.updateSetting(key, value === SETTING_DEFAULTS[key] ? undefined : value);
    }
  }

  /** In an open thread the model applies to its next messages; otherwise it is the default for new threads. */
  async setModel(model: string): Promise<void> {
    if (this.session) {
      this.threadModel = model;
      this.fire('thread');
      return;
    }
    await this.updateSetting('model', model || undefined);
    // Drop a reasoning level or speed the newly selected model does not offer.
    if (!this.catalog) return;
    const params = this.getParams();
    const effective = model || defaultModelId(this.catalog, this.project);
    if (params.reasoning && !reasoningOptionsFor(this.catalog, effective).includes(params.reasoning)) await this.updateSetting('reasoning', undefined);
    if (params.speed && !speedOptionsFor(this.catalog, effective).includes(params.speed)) await this.updateSetting('speed', undefined);
  }

  async pickModel(): Promise<void> {
    const catalog = await this.ensureCatalog();
    if (!catalog) return;
    const inThread = Boolean(this.session);
    const current = inThread ? this.threadModel || this.session?.thread?.modelId || '' : this.getParams().model;
    type Item = vscode.QuickPickItem & { modelId?: string };
    const items: Item[] = [];
    if (!inThread) {
      const fallback = defaultModelId(catalog, this.project);
      items.push({ label: `${current === '' ? '$(check) ' : ''}Default`, description: fallback ? `currently ${fallback}` : undefined, modelId: '' });
    }
    const labels = new Map(catalog.providers.map((provider) => [provider.provider, provider.label]));
    const providers = [...new Set([...catalog.providers.map((provider) => provider.provider), ...catalog.models.map((model) => model.provider)])];
    for (const provider of providers) {
      const models = catalog.models.filter((model) => model.provider === provider);
      if (models.length === 0) continue;
      items.push({ label: labels.get(provider) ?? provider, kind: vscode.QuickPickItemKind.Separator });
      for (const model of models) {
        items.push({ label: `${model.id === current ? '$(check) ' : ''}${model.name}`, description: model.id, detail: describeModel(model) || undefined, modelId: model.id });
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: inThread ? 'Hoplite: model for the next messages in this thread' : 'Hoplite: default model for new threads',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked?.modelId !== undefined) await this.setModel(picked.modelId);
  }

  async pickReasoning(): Promise<void> {
    const catalog = await this.ensureCatalog();
    if (!catalog) return;
    const params = this.getParams();
    const model = params.model || defaultModelId(catalog, this.project);
    await this.pickOption('reasoning', 'Hoplite: reasoning effort for new threads', reasoningOptionsFor(catalog, model), params.reasoning, model);
  }

  async pickSpeed(): Promise<void> {
    const catalog = await this.ensureCatalog();
    if (!catalog) return;
    const params = this.getParams();
    const model = params.model || defaultModelId(catalog, this.project);
    await this.pickOption('speed', 'Hoplite: speed for new threads', speedOptionsFor(catalog, model), params.speed, model);
  }

  private async pickOption(key: 'reasoning' | 'speed', title: string, options: string[], current: string, model: string): Promise<void> {
    const items = [
      { label: `${current === '' ? '$(check) ' : ''}Default`, description: 'Let Hoplite decide', value: '' },
      ...options.map((option) => ({ label: `${option === current ? '$(check) ' : ''}${option}`, description: '', value: option })),
    ];
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder: model ? `Options supported by ${model}` : undefined });
    if (picked) await this.setParam(key, picked.value);
  }

  private async ensureCatalog(): Promise<ModelCatalog | undefined> {
    if (this.catalog) return this.catalog;
    const client = this.requireClient();
    if (!client) return undefined;
    try {
      this.catalog = await client.listModels();
      this.fire('catalog');
    } catch (error) {
      this.report('Could not load models', error);
    }
    return this.catalog;
  }

  private async updateSetting(key: string, value: unknown): Promise<void> {
    const config = this.config();
    const target = config.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update(key, value, target);
  }

  // ----- threads -----

  listThreads(limit: number, cursor?: string): Promise<ThreadsResponse> {
    const client = this.client;
    const projectId = this.projectId;
    if (!client || !projectId) return Promise.resolve({ threads: [], nextCursor: null, hasMore: false });
    return client.listThreads({ projectId, archived: false, limit, cursor });
  }

  newThread(): void {
    this.closeSession(true);
  }

  openThread(threadId: string): void {
    const client = this.requireClient();
    if (!client || this.session?.threadId === threadId) return;
    this.startSession(client, threadId, {});
  }

  /** Starts a thread from the prompt, or sends a follow-up to the open one. Returns false when nothing was sent. */
  async send(text: string, title?: string): Promise<boolean> {
    const content = text.trim();
    const client = this.requireClient();
    if (!content || !client || this.sending) return false;
    this.sending = true;
    this.fire('thread');
    try {
      const session = this.session;
      if (session) {
        const model = this.threadModel && this.threadModel !== session.thread?.modelId ? this.threadModel : undefined;
        await session.send(content, model);
        return true;
      }
      if (!this.projectId) await this.pickProject();
      const projectId = this.projectId;
      if (!projectId) return false;
      const request = buildCreateThreadRequest({ projectId, prompt: content, title, params: this.getParams(), catalog: this.catalog, project: this.project });
      const response = await client.createThread(request, randomUUID());
      this.startSession(client, response.thread.id, { thread: response.thread, messages: response.message ? [response.message] : undefined });
      this.fire('threads');
      return true;
    } catch (error) {
      this.report('Could not send the message', error);
      return false;
    } finally {
      this.sending = false;
      this.fire('thread');
    }
  }

  async stop(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      if (!(await session.stop())) void vscode.window.showInformationMessage('Hoplite: no run is active in this thread.');
    } catch (error) {
      this.report('Could not stop the run', error);
    }
  }

  async retry(): Promise<void> {
    await this.withSession('Could not retry the thread', (session) => session.retry());
  }

  async compact(): Promise<void> {
    await this.withSession('Could not compact the thread', (session) => session.compact());
  }

  async loadEarlier(): Promise<void> {
    await this.withSession('Could not load earlier messages', (session) => session.loadEarlier());
  }

  async answerQuestion(questionId: string, answers: Record<string, string> | null): Promise<void> {
    const values = answers ? Object.values(answers) : [];
    const body: AnswerRequest = answers === null ? { answers: null } : values.length === 1 ? { answer: values[0] } : { answers };
    await this.withSession('Could not submit the answer', (session) => session.answerQuestion(questionId, body));
  }

  async refresh(): Promise<void> {
    if (!this.client) return;
    await Promise.all([this.bootstrap(false), this.session?.refreshAll().catch((error) => this.report('Could not refresh the thread', error))]);
  }

  async renameThread(target = this.activeThread): Promise<void> {
    const client = this.requireClient();
    if (!client || !target) return;
    const title = await vscode.window.showInputBox({ title: 'Rename Hoplite thread', value: target.title ?? '', validateInput: (value) => (value.trim() ? undefined : 'Enter a title.') });
    if (!title?.trim()) return;
    try {
      const { thread } = await client.updateThread(target.id, { title: title.trim() });
      this.applyThreadUpdate(thread);
    } catch (error) {
      this.report('Could not rename the thread', error);
    }
  }

  async archiveThread(target = this.activeThread): Promise<void> {
    const client = this.requireClient();
    if (!client || !target) return;
    const confirmed = await vscode.window.showWarningMessage(`Archive the Hoplite thread "${target.title?.trim() || target.id}"?`, { modal: true }, 'Archive');
    if (confirmed !== 'Archive') return;
    try {
      await client.updateThread(target.id, { archived: true });
      if (this.session?.threadId === target.id) this.closeSession(true);
      this.fire('threads');
    } catch (error) {
      this.report('Could not archive the thread', error);
    }
  }

  async promptSpendLimit(target = this.activeThread): Promise<void> {
    if (!target) return;
    const current = this.session?.threadId === target.id ? usdFromMicros(this.session.thread?.spendLimitMicros) : 0;
    const value = await vscode.window.showInputBox({
      title: 'Hoplite thread spend limit',
      prompt: 'Lifetime budget in US dollars. Leave empty or enter 0 to remove the limit.',
      value: current ? String(current) : '',
      validateInput: (input) => (input.trim() === '' || (Number.isFinite(Number(input)) && Number(input) >= 0) ? undefined : 'Enter a non-negative number.'),
    });
    if (value === undefined) return;
    await this.applySpendLimit(Number(value) || 0, target.id);
  }

  async applySpendLimit(usd: number, threadId = this.session?.threadId): Promise<void> {
    const client = this.requireClient();
    if (!client || !threadId) return;
    try {
      const { thread } = await client.updateThread(threadId, { spendLimitMicros: usdToMicros(usd) ?? null });
      this.applyThreadUpdate(thread);
      void vscode.window.showInformationMessage(usd > 0 ? `Hoplite: spend limit set to $${usd}.` : 'Hoplite: spend limit removed.');
    } catch (error) {
      this.report('Could not update the spend limit', error);
    }
  }

  async showDiff(target = this.activeThread): Promise<void> {
    const client = this.requireClient();
    if (!client || !target) return;
    const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { mode: DiffMode }>(
      [
        { label: 'Against the base branch', description: 'everything the thread changed', mode: 'base' },
        { label: 'Uncommitted changes', description: 'not yet committed in the workspace', mode: 'uncommitted' },
        { label: 'Pull request', description: "the thread's pull request", mode: 'pr' },
      ],
      { title: 'Hoplite: show thread diff' },
    );
    if (!picked) return;
    try {
      const { diff } = await client.getDiff(target.id, picked.mode);
      if (diff.files.length === 0) {
        void vscode.window.showInformationMessage(`Hoplite: no changes to show${diff.unavailableReason ? ` (${diff.unavailableReason})` : ''}.`);
        return;
      }
      await this.diffs.show(target.id, diff.effectiveMode ?? diff.mode, formatDiff(diff, target.title?.trim() || `Hoplite thread ${target.id}`));
    } catch (error) {
      this.report('Could not load the diff', error);
    }
  }

  async openPullRequest(target = this.activeThread): Promise<void> {
    const pullRequests = target?.pullRequests ?? [];
    if (pullRequests.length === 0) {
      void vscode.window.showInformationMessage('Hoplite: this thread has no pull request yet.');
      return;
    }
    let url = pullRequests[0].url;
    if (pullRequests.length > 1) {
      const picked = await vscode.window.showQuickPick(
        pullRequests.map((pr) => ({ label: `${pr.repoFullName}#${pr.number}`, description: pr.state, url: pr.url })),
        { title: 'Hoplite: open pull request' },
      );
      if (!picked) return;
      url = picked.url;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private applyThreadUpdate(thread: Thread): void {
    if (this.session?.threadId === thread.id) {
      this.session.setThread(thread);
      this.session.scheduleRefresh('all', 0);
    }
    this.fire('threads');
  }

  private async withSession(action: string, run: (session: ThreadSession) => Promise<void>): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      await run(session);
    } catch (error) {
      this.report(action, error);
    }
  }

  private startSession(client: HopliteClient, threadId: string, initial: { thread?: Thread; messages?: Message[]; silent?: boolean }): void {
    this.closeSession(false);
    const session = new ThreadSession(client, threadId, {
      log: (message) => this.log.debug(message),
      initialThread: initial.thread,
      initialMessages: initial.messages,
    });
    this.session = session;
    let status = initial.thread?.status;
    let title = initial.thread?.title;
    this.unsubscribeSession = session.onDidChange((change) => {
      if (change === 'thread') {
        this.syncContext();
        const thread = session.thread;
        if (thread && (thread.status !== status || thread.title !== title)) {
          status = thread.status;
          title = thread.title;
          this.fire('threads');
        }
      }
      this.fire(change);
    });
    void this.context.workspaceState.update(THREAD_KEY, threadId);
    this.syncContext();
    this.fire('thread');
    this.fire('messages');
    this.fire('drafts');

    void session.start().then(
      () => {
        // A thread that cannot be read (deleted, or outside this key's scope) is not kept open.
        if (this.session !== session || session.thread) return;
        const reason = session.error ?? 'The thread could not be loaded.';
        this.closeSession(true);
        if (!initial.silent) void vscode.window.showErrorMessage(`Hoplite: ${reason}`);
      },
      (error) => this.report('Could not open the thread', error),
    );
  }

  private closeSession(forget: boolean): void {
    const had = Boolean(this.session);
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.threadModel = '';
    if (forget) void this.context.workspaceState.update(THREAD_KEY, undefined);
    this.syncContext();
    if (had || forget) {
      this.fire('thread');
      this.fire('messages');
      this.fire('drafts');
    }
  }

  // ----- view models -----

  viewState(): ViewState {
    const session = this.session;
    const thread = session?.thread;
    const projectId = this.projectId;
    const project = this.project;
    const params = this.getParams();
    return {
      signedIn: this.signedIn,
      project: projectId
        ? {
            id: projectId,
            name: project?.name ?? projectId,
            repos: (project?.repos ?? []).map((repo) => (repo.branch ? `${repo.repoFullName}@${repo.branch}` : repo.repoFullName)),
            defaultModel: project?.defaultModel ?? undefined,
            reasoningEffort: project?.reasoningEffort ?? undefined,
            agentSpeed: project?.agentSpeed ?? undefined,
          }
        : null,
      catalog: this.catalog ? this.viewCatalog(this.catalog) : null,
      params: {
        model: params.model,
        reasoning: params.reasoning,
        speed: params.speed,
        spendLimitUsd: params.spendLimitUsd,
        autoMerge: params.autoMerge,
        repositories: params.repositories.join(', '),
      },
      thread: session
        ? {
            id: session.threadId,
            title: thread?.title?.trim() || 'New thread',
            status: thread?.status ?? 'queued',
            modelId: thread?.modelId ?? '',
            phase: setupPhase(thread),
            spendLimitUsd: usdFromMicros(thread?.spendLimitMicros),
            pullRequests: pullRequestsOf(thread).map((pr): ViewPullRequest => ({ number: pr.number, url: pr.url, state: pr.state, repoFullName: pr.repoFullName })),
          }
        : null,
      threadModel: session ? this.threadModel || thread?.modelId || '' : '',
      runActive: session?.isRunActive() ?? false,
      sending: this.sending,
      loading: session?.loading ?? false,
      connection: session?.connection ?? 'idle',
      error: session?.error ?? this.notice,
      failure: session?.failure ? { message: session.failure.message, code: session.failure.code, resetsAt: session.failure.resetsAt } : undefined,
      questions: (session?.questions ?? []).map((question) => ({
        questionId: question.questionId,
        questions: question.request.questions.map((item) => ({
          header: item.header,
          question: item.question,
          multiSelect: item.multiSelect,
          inputType: item.inputType,
          options: item.options.map((option) => ({ label: option.label, description: option.description })),
        })),
      })),
      hasEarlier: session?.hasEarlier ?? false,
    };
  }

  viewMessages(): ViewMessage[] {
    const session = this.session;
    if (!session) return [];
    const showActivity = this.showActivity();
    const result: ViewMessage[] = [];
    for (const message of session.messages) {
      const activity = message.kind !== 'chat';
      if (activity && !showActivity) continue;
      if (!message.content.trim() && message.kind !== 'tool') continue;
      const truncated = activity && message.content.length > MAX_ACTIVITY_CHARS;
      result.push({
        id: message.id,
        role: message.role,
        kind: message.kind,
        content: truncated ? message.content.slice(0, MAX_ACTIVITY_CHARS) : message.content,
        createdAt: message.createdAt,
        toolName: message.toolName,
        author: message.author?.name,
        truncated: truncated || undefined,
      });
    }
    for (const pending of session.pending) {
      result.push({ id: pending.localId, role: 'user', kind: 'chat', content: pending.content, createdAt: pending.createdAt, pending: true });
    }
    return result;
  }

  viewDrafts(): ViewDraft[] {
    const showActivity = this.showActivity();
    return (this.session?.drafts ?? [])
      .filter((draft) => draft.content && (showActivity || draft.kind !== 'thinking'))
      .map((draft) => ({ messageId: draft.messageId, content: draft.content, kind: draft.kind }));
  }

  private viewCatalog(catalog: ModelCatalog): ViewCatalog {
    return {
      models: catalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        reasoning: reasoningOptionsFor(catalog, model.id),
        speeds: speedOptionsFor(catalog, model.id),
        requiredPlan: model.requiredPlan,
      })),
      providers: catalog.providers.map((provider) => ({ provider: provider.provider, label: provider.label })),
      defaultModelId: catalog.runConfig.defaultModelId,
      reasoningOptions: catalog.runConfig.reasoningOptions,
      speedOptions: catalog.runConfig.speedOptions,
    };
  }

  // ----- helpers -----

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('hoplite');
  }

  private showActivity(): boolean {
    return this.config().get<boolean>('chat.showActivity', true);
  }

  private baseUrl(): string {
    return this.config().get<string>('apiBaseUrl', 'https://api.hoplite.sh');
  }

  private userAgent(): string {
    return `hoplite-vscode/${String(this.context.extension.packageJSON.version)}`;
  }

  private requireClient(): HopliteClient | undefined {
    if (this.client) return this.client;
    if (this.notice && this.apiKey) {
      void vscode.window.showErrorMessage(`Hoplite: ${this.notice}`);
      return undefined;
    }
    void vscode.window.showInformationMessage('Hoplite: set an API key to connect.', 'Set API Key').then((choice) => {
      if (choice) void this.promptApiKey();
    });
    return undefined;
  }

  private report(action: string, error: unknown): void {
    const message = errorMessage(error);
    this.log.error(`${action}: ${message}`);
    const unauthorized = error instanceof HopliteApiError && error.status === 401;
    void vscode.window.showErrorMessage(`Hoplite: ${action}. ${message}`, ...(unauthorized ? ['Set API Key'] : [])).then((choice) => {
      if (choice) void this.promptApiKey();
    });
  }

  private syncContext(): void {
    const values: Record<string, boolean> = {
      'hoplite.signedIn': this.signedIn,
      'hoplite.hasProject': Boolean(this.projectId),
      'hoplite.hasThread': Boolean(this.session),
      'hoplite.runActive': this.session?.isRunActive() ?? false,
    };
    for (const [key, value] of Object.entries(values)) {
      if (this.contextKeys.get(key) === value) continue;
      this.contextKeys.set(key, value);
      void vscode.commands.executeCommand('setContext', key, value);
    }
  }

  private fire(change: ControllerChange): void {
    this.changeEmitter.fire(change);
  }
}
