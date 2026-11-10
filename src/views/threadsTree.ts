import * as vscode from 'vscode';
import type { Thread } from '../api/types.ts';
import type { HopliteController, ThreadTarget } from '../controller.ts';
import { errorMessage, relativeTime, setupPhase } from '../util.ts';

export type ThreadNode = { kind: 'thread'; thread: Thread } | { kind: 'more' } | { kind: 'error'; message: string };

const PAGE_SIZE = 30;

const STATUS_ICONS: Record<string, string> = {
  queued: 'clock',
  running: 'sync~spin',
  waiting: 'question',
  blocked: 'warning',
  ready: 'check',
  failed: 'error',
  archived: 'archive',
};

export function threadTarget(thread: Thread): ThreadTarget {
  const pullRequests = [...(thread.pullRequests ?? [])];
  const primary = thread.primaryPullRequest;
  if (primary && !pullRequests.some((pr) => pr.url === primary.url)) pullRequests.unshift(primary);
  return { id: thread.id, title: thread.title, pullRequests };
}

/** Threads of the selected project, most recently active first. */
export class ThreadsTreeProvider implements vscode.TreeDataProvider<ThreadNode>, vscode.Disposable {
  private readonly controller: HopliteController;
  private readonly emitter = new vscode.EventEmitter<ThreadNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  private threads: Thread[] = [];
  private nextCursor: string | null = null;
  private error: string | undefined;
  private loadedFor: string | undefined;
  private loading: Promise<void> | undefined;

  constructor(controller: HopliteController) {
    this.controller = controller;
    this.subscription = controller.onDidChange((change) => {
      if (change === 'auth' || change === 'project' || change === 'threads') void this.reload();
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  /** Reloads the list, keeping as many threads as are currently shown. */
  reload(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
      this.emitter.fire(undefined);
    });
    return this.loading;
  }

  async loadMore(): Promise<void> {
    if (!this.nextCursor) return;
    try {
      const page = await this.controller.listThreads(PAGE_SIZE, this.nextCursor);
      const known = new Set(this.threads.map((thread) => thread.id));
      this.threads.push(...page.threads.filter((thread) => !known.has(thread.id)));
      this.nextCursor = page.hasMore ? page.nextCursor : null;
    } catch (error) {
      this.error = errorMessage(error);
    }
    this.emitter.fire(undefined);
  }

  async getChildren(element?: ThreadNode): Promise<ThreadNode[]> {
    if (element) return [];
    const projectId = this.controller.projectId;
    if (!this.controller.signedIn || !projectId) return [];
    if (this.loadedFor !== projectId) await (this.loading ?? this.reload());
    const nodes: ThreadNode[] = this.threads.map((thread) => ({ kind: 'thread', thread }));
    if (this.error) nodes.unshift({ kind: 'error', message: this.error });
    if (this.nextCursor) nodes.push({ kind: 'more' });
    return nodes;
  }

  getTreeItem(node: ThreadNode): vscode.TreeItem {
    if (node.kind === 'more') {
      const item = new vscode.TreeItem('Load more…');
      item.command = { command: 'hoplite.loadMoreThreads', title: 'Load More Threads' };
      return item;
    }
    if (node.kind === 'error') {
      const item = new vscode.TreeItem('Could not load threads');
      item.description = node.message;
      item.tooltip = node.message;
      item.iconPath = new vscode.ThemeIcon('warning');
      return item;
    }
    const thread = node.thread;
    const target = threadTarget(thread);
    const item = new vscode.TreeItem(thread.title?.trim() || 'Untitled thread');
    item.id = thread.id;
    const when = relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt);
    item.description = [setupPhase(thread) ?? thread.status, when].filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(STATUS_ICONS[thread.status] ?? 'circle-outline');
    item.contextValue = target.pullRequests?.length ? 'thread.pr' : 'thread';
    item.command = { command: 'hoplite.openThread', title: 'Open Thread', arguments: [node] };
    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(`${item.label as string}\n`);
    tooltip.appendMarkdown(`\nStatus: **${thread.status}**`);
    if (thread.modelId) tooltip.appendMarkdown(`  \nModel: \`${thread.modelId}\``);
    for (const pr of target.pullRequests ?? []) tooltip.appendMarkdown(`  \n[${pr.repoFullName}#${pr.number}](${pr.url}) (${pr.state})`);
    item.tooltip = tooltip;
    return item;
  }

  private async load(): Promise<void> {
    const projectId = this.controller.projectId;
    if (!this.controller.signedIn || !projectId) {
      this.threads = [];
      this.nextCursor = null;
      this.error = undefined;
      this.loadedFor = undefined;
      return;
    }
    const sameProject = this.loadedFor === projectId;
    const limit = Math.min(100, Math.max(PAGE_SIZE, sameProject ? this.threads.length : 0));
    try {
      const page = await this.controller.listThreads(limit);
      this.threads = page.threads;
      this.nextCursor = page.hasMore ? page.nextCursor : null;
      this.error = undefined;
    } catch (error) {
      if (!sameProject) this.threads = [];
      this.error = errorMessage(error);
    }
    this.loadedFor = projectId;
  }
}
