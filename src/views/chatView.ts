import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ControllerChange, HopliteController } from '../controller.ts';
import type { FromWebview, ToWebview } from '../protocol.ts';

type Part = 'state' | 'messages' | 'drafts';

/** The chat panel: renders the controller's state in a webview and forwards the user's actions. */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'hoplite.chat';
  private readonly extensionUri: vscode.Uri;
  private readonly controller: HopliteController;
  private readonly subscription: vscode.Disposable;
  private readonly dirty = new Set<Part>();
  private readonly pendingInserts: string[] = [];
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(extensionUri: vscode.Uri, controller: HopliteController) {
    this.extensionUri = extensionUri;
    this.controller = controller;
    this.subscription = controller.onDidChange((change) => this.invalidate(change));
  }

  dispose(): void {
    clearTimeout(this.flushTimer);
    this.subscription.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.onDidReceiveMessage((message: FromWebview) => void this.handle(message));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
      }
    });
    view.webview.html = this.html(view.webview);
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  /** Appends text to the composer, opening the chat view first. */
  async insertText(text: string): Promise<void> {
    this.pendingInserts.push(text);
    await this.focus();
    this.flushInserts();
  }

  private invalidate(change: ControllerChange): void {
    if (change === 'messages' || change === 'drafts') {
      this.dirty.add(change);
    } else if (change === 'params') {
      // The activity toggle changes which messages are shown.
      this.dirty.add('state').add('messages').add('drafts');
    } else if (change !== 'threads') {
      this.dirty.add('state');
    }
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 30);
  }

  private flush(): void {
    if (!this.view || !this.ready) return;
    if (this.dirty.delete('state')) this.post({ type: 'state', state: this.controller.viewState() });
    if (this.dirty.delete('messages')) this.post({ type: 'messages', messages: this.controller.viewMessages() });
    if (this.dirty.delete('drafts')) this.post({ type: 'drafts', drafts: this.controller.viewDrafts() });
  }

  private flushInserts(): void {
    if (!this.ready) return;
    for (const text of this.pendingInserts.splice(0)) this.post({ type: 'insertText', text });
  }

  private post(message: ToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private async handle(message: FromWebview): Promise<void> {
    const controller = this.controller;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.dirty.add('state').add('messages').add('drafts');
        this.flush();
        this.flushInserts();
        break;
      case 'send':
        if (!(await controller.send(message.text, message.title))) this.post({ type: 'restoreText', text: message.text });
        break;
      case 'setModel':
        await controller.setModel(message.model);
        break;
      case 'setParam':
        await controller.setParam(message.key, message.value);
        break;
      case 'applySpendLimit':
        await controller.applySpendLimit(message.usd);
        break;
      case 'answer':
        await controller.answerQuestion(message.questionId, message.answers);
        break;
      case 'command':
        switch (message.command) {
          case 'setApiKey':
            await controller.promptApiKey();
            break;
          case 'selectProject':
            await controller.pickProject();
            break;
          case 'stop':
            await controller.stop();
            break;
          case 'retry':
            await controller.retry();
            break;
          case 'loadEarlier':
            await controller.loadEarlier();
            break;
          case 'openSettings':
            await vscode.commands.executeCommand('hoplite.configureRunParameters');
            break;
        }
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    // Scripts run only with the nonce; remote images and inline styles are blocked.
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style.toString()}" rel="stylesheet">
<title>Hoplite</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
