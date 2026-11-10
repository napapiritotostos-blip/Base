import * as vscode from 'vscode';
import { HopliteController } from './controller.ts';
import type { ThreadTarget } from './controller.ts';
import { ChatViewProvider } from './views/chatView.ts';
import { DiffContentProvider } from './views/diffProvider.ts';
import { ThreadsTreeProvider, threadTarget } from './views/threadsTree.ts';
import type { ThreadNode } from './views/threadsTree.ts';
import { formatSelection } from './util.ts';

const TREE_REFRESH_MS = 30_000;

/** Commands run from the tree receive its node; from the palette they act on the open thread. */
function targetOf(arg: unknown): ThreadTarget | undefined {
  const node = arg as ThreadNode | undefined;
  return node && typeof node === 'object' && node.kind === 'thread' ? threadTarget(node.thread) : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Hoplite', { log: true });
  const diffs = new DiffContentProvider();
  const controller = new HopliteController(context, log, diffs);
  const chat = new ChatViewProvider(context.extensionUri, controller);
  const threads = new ThreadsTreeProvider(controller);
  const tree = vscode.window.createTreeView('hoplite.threads', { treeDataProvider: threads });

  const timer = setInterval(() => {
    if (tree.visible && controller.signedIn) void threads.reload();
  }, TREE_REFRESH_MS);

  context.subscriptions.push(
    log,
    diffs,
    controller,
    chat,
    threads,
    tree,
    { dispose: () => clearInterval(timer) },
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(DiffContentProvider.scheme, diffs),
  );

  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register('hoplite.setApiKey', () => controller.promptApiKey());
  register('hoplite.clearApiKey', () => controller.clearApiKey());
  register('hoplite.selectProject', () => controller.pickProject());
  register('hoplite.selectModel', () => controller.pickModel());
  register('hoplite.selectReasoning', () => controller.pickReasoning());
  register('hoplite.selectSpeed', () => controller.pickSpeed());
  register('hoplite.configureRunParameters', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`));
  register('hoplite.showLog', () => log.show());

  register('hoplite.newThread', async () => {
    controller.newThread();
    await chat.focus();
  });
  register('hoplite.refresh', async () => {
    await controller.refresh();
    await threads.reload();
  });
  register('hoplite.openThread', async (arg) => {
    const id = typeof arg === 'string' ? arg : targetOf(arg)?.id;
    if (!id) return;
    controller.openThread(id);
    await chat.focus();
  });
  register('hoplite.loadMoreThreads', () => threads.loadMore());

  // Accepts the prompt as an argument, so it can be bound to a key or run from a task.
  register('hoplite.sendPrompt', async (arg) => {
    const text = typeof arg === 'string' ? arg : await vscode.window.showInputBox({ title: 'Hoplite', prompt: 'Message for the Hoplite agent', ignoreFocusOut: true });
    if (!text?.trim()) return false;
    void chat.focus();
    return controller.send(text);
  });
  register('hoplite.addSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Hoplite: select some code first.');
      return;
    }
    const { start, end } = editor.selection;
    // A selection ending at column 0 does not include that line.
    const lastLine = end.character === 0 && end.line > start.line ? end.line : end.line + 1;
    const path = vscode.workspace.asRelativePath(editor.document.uri, false);
    await chat.insertText(formatSelection(path, start.line + 1, lastLine, editor.document.languageId, editor.document.getText(editor.selection)));
  });

  register('hoplite.stopRun', () => controller.stop());
  register('hoplite.retryThread', () => controller.retry());
  register('hoplite.compactThread', () => controller.compact());
  register('hoplite.showDiff', (arg) => controller.showDiff(targetOf(arg)));
  register('hoplite.openPullRequest', (arg) => controller.openPullRequest(targetOf(arg)));
  register('hoplite.renameThread', (arg) => controller.renameThread(targetOf(arg)));
  register('hoplite.setSpendLimit', (arg) => controller.promptSpendLimit(targetOf(arg)));
  register('hoplite.archiveThread', (arg) => controller.archiveThread(targetOf(arg)));

  await controller.initialize();
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
}
