import * as vscode from 'vscode';

/** Serves thread diffs as read-only documents. */
export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'hoplite-diff';
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  async show(threadId: string, mode: string, text: string): Promise<void> {
    // The .diff extension selects the diff language mode.
    const uri = vscode.Uri.from({ scheme: DiffContentProvider.scheme, path: `/${encodeURIComponent(threadId)}/${mode}.diff` });
    this.contents.set(uri.toString(), text);
    this.emitter.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  dispose(): void {
    this.emitter.dispose();
    this.contents.clear();
  }
}
