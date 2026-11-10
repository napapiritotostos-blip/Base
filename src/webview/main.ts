import MarkdownIt from 'markdown-it';
import type { FromWebview, ToWebview, ViewDraft, ViewMessage, ViewPullRequest, ViewQuestionGroup, ViewState } from '../protocol.ts';

interface VsCodeApi {
  postMessage(message: FromWebview): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
// Raw HTML stays escaped and images are not loaded, so agent output cannot inject markup or beacons.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true }).disable('image');
// Only explicit URLs become links; otherwise file names such as README.md would.
markdown.linkify.set({ fuzzyLink: false, fuzzyEmail: false }).add('//', null);

interface Persisted {
  text: string;
  title: string;
  advancedOpen: boolean;
}
const persisted: Persisted = { text: '', title: '', advancedOpen: false, ...(vscode.getState() as Partial<Persisted> | undefined) };

let state: ViewState | undefined;
let messages: ViewMessage[] = [];
let drafts: ViewDraft[] = [];

function post(message: FromWebview): void {
  vscode.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

$('app').innerHTML = `
<header id="topbar" class="topbar">
  <button id="project" class="link"></button>
  <span class="grow"></span>
  <span id="conn" class="conn" hidden></span>
</header>
<div id="threadbar" class="threadbar" hidden>
  <span id="status" class="badge"></span>
  <span id="title" class="title"></span>
  <span id="prs" class="prs"></span>
</div>
<div id="error" class="banner error" hidden></div>
<main id="scroll" class="scroll">
  <div id="welcome" class="welcome" hidden></div>
  <button id="earlier" class="link earlier" hidden>Load earlier messages</button>
  <div id="messages"></div>
  <div id="drafts"></div>
  <div id="working" class="working" hidden><span class="spinner"></span><span id="workingText"></span></div>
  <div id="questions"></div>
  <div id="failure" class="banner failure" hidden><span id="failureText"></span><button id="retry">Retry</button></div>
</main>
<footer id="composer" class="composer" hidden>
  <div class="params">
    <select id="model" title="Model"></select>
    <select id="reasoning" title="Reasoning effort"></select>
    <select id="speed" title="Speed"></select>
    <button id="advancedToggle" class="icon" title="More run parameters">⚙</button>
  </div>
  <div id="advanced" class="advanced" hidden>
    <label id="titleRow">Thread title<input id="threadTitle" type="text" placeholder="Generated automatically when empty"></label>
    <label>Spend limit, USD<span class="row"><input id="spend" type="number" min="0" step="0.5" placeholder="No limit"><button id="applySpend" class="secondary" hidden>Apply</button></span></label>
    <label id="autoMergeRow">Auto-merge pull requests<select id="autoMerge"><option value="inherit">Workspace default</option><option value="on">On</option><option value="off">Off</option></select></label>
    <label id="reposRow">Repositories and base branches<input id="repos" type="text"></label>
    <div id="threadNote" class="note" hidden>Reasoning effort, speed, auto-merge and repositories are fixed when a thread is created.</div>
    <button id="openSettings" class="link">All settings…</button>
  </div>
  <textarea id="input" rows="3"></textarea>
  <div class="actions">
    <span id="hint" class="hint"></span>
    <button id="stop" class="secondary" hidden>Stop</button>
    <button id="send">Send</button>
  </div>
</footer>`;

const topbar = $('topbar');
const projectButton = $<HTMLButtonElement>('project');
const conn = $('conn');
const threadbar = $('threadbar');
const statusBadge = $('status');
const titleEl = $('title');
const prsEl = $('prs');
const errorEl = $('error');
const scrollEl = $('scroll');
const welcomeEl = $('welcome');
const earlierButton = $<HTMLButtonElement>('earlier');
const messagesEl = $('messages');
const draftsEl = $('drafts');
const workingEl = $('working');
const workingText = $('workingText');
const questionsEl = $('questions');
const failureEl = $('failure');
const failureText = $('failureText');
const composer = $('composer');
const modelSelect = $<HTMLSelectElement>('model');
const reasoningSelect = $<HTMLSelectElement>('reasoning');
const speedSelect = $<HTMLSelectElement>('speed');
const advanced = $('advanced');
const titleRow = $('titleRow');
const titleInput = $<HTMLInputElement>('threadTitle');
const spendInput = $<HTMLInputElement>('spend');
const applySpend = $<HTMLButtonElement>('applySpend');
const autoMergeRow = $('autoMergeRow');
const autoMergeSelect = $<HTMLSelectElement>('autoMerge');
const reposRow = $('reposRow');
const reposInput = $<HTMLInputElement>('repos');
const threadNote = $('threadNote');
const input = $<HTMLTextAreaElement>('input');
const hint = $('hint');
const stopButton = $<HTMLButtonElement>('stop');
const sendButton = $<HTMLButtonElement>('send');

function persist(): void {
  persisted.text = input.value;
  persisted.title = titleInput.value;
  vscode.setState(persisted);
}

function autoGrow(): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

function nearBottom(): boolean {
  return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
}

function scrollToBottom(): void {
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

// ----- selects -----

interface Option {
  value: string;
  label: string;
  group?: string;
}

/** Rebuilds a select only when its options change, so an open dropdown is not closed by a state update. */
function fillSelect(select: HTMLSelectElement, options: Option[], value: string): void {
  const all = options.some((option) => option.value === value) ? options : [...options, { value, label: value ? `${value} (unavailable)` : 'Default' }];
  const signature = JSON.stringify(all);
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren();
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const option of all) {
      const node = el('option', undefined, option.label);
      node.value = option.value;
      if (!option.group) {
        select.append(node);
        continue;
      }
      let group = groups.get(option.group);
      if (!group) {
        group = el('optgroup');
        group.label = option.group;
        groups.set(option.group, group);
        select.append(group);
      }
      group.append(node);
    }
  }
  if (select.value !== value) select.value = value;
}

function renderParams(view: ViewState): void {
  const { catalog, thread, project, params } = view;
  const inThread = Boolean(thread);
  const modelName = (id: string): string => catalog?.models.find((model) => model.id === id)?.name ?? id;
  const providerLabel = (provider: string): string => catalog?.providers.find((entry) => entry.provider === provider)?.label ?? provider;

  const fallbackModel = project?.defaultModel || catalog?.defaultModelId || '';
  const modelOptions: Option[] = [];
  if (!inThread) modelOptions.push({ value: '', label: fallbackModel ? `Default · ${modelName(fallbackModel)}` : 'Default model' });
  for (const model of catalog?.models ?? []) {
    modelOptions.push({ value: model.id, label: model.requiredPlan ? `${model.name} (${model.requiredPlan})` : model.name, group: providerLabel(model.provider) });
  }
  fillSelect(modelSelect, modelOptions, inThread ? view.threadModel : params.model);
  modelSelect.title = inThread ? 'Model for your next message in this thread' : 'Model for the new thread';

  const selected = catalog?.models.find((model) => model.id === (params.model || fallbackModel));
  const levels = selected?.reasoning ?? catalog?.reasoningOptions ?? [];
  const speeds = selected?.speeds ?? catalog?.speedOptions ?? [];
  fillSelect(
    reasoningSelect,
    [
      { value: '', label: project?.reasoningEffort ? `Reasoning: default (${project.reasoningEffort})` : 'Reasoning: default' },
      ...levels.map((level) => ({ value: level, label: `Reasoning: ${level}` })),
    ],
    params.reasoning,
  );
  fillSelect(
    speedSelect,
    [{ value: '', label: project?.agentSpeed ? `Speed: default (${project.agentSpeed})` : 'Speed: default' }, ...speeds.map((speed) => ({ value: speed, label: `Speed: ${speed}` }))],
    params.speed,
  );
  reasoningSelect.hidden = inThread;
  speedSelect.hidden = inThread;

  titleRow.hidden = inThread;
  autoMergeRow.hidden = inThread;
  reposRow.hidden = inThread;
  threadNote.hidden = !inThread;
  applySpend.hidden = !inThread;
  autoMergeSelect.value = params.autoMerge;
  reposInput.placeholder = project?.repos.length ? `Project default: ${project.repos.join(', ')}` : 'owner/repo@branch, …';
  if (document.activeElement !== reposInput) reposInput.value = params.repositories;
  if (document.activeElement !== spendInput) {
    const limit = thread ? thread.spendLimitUsd : params.spendLimitUsd;
    spendInput.value = limit > 0 ? String(limit) : '';
  }
}

// ----- header, banners, welcome -----

function renderPullRequests(pullRequests: ViewPullRequest[]): void {
  prsEl.replaceChildren(
    ...pullRequests.map((pr) => {
      const link = el('a', `pr ${pr.state}`, `#${pr.number}`);
      link.href = pr.url;
      link.title = `${pr.repoFullName}#${pr.number} (${pr.state})`;
      return link;
    }),
  );
}

let welcomeMode = '';

function renderWelcome(view: ViewState): void {
  const mode = !view.signedIn ? 'signin' : !view.project ? 'project' : !view.thread ? 'new' : '';
  welcomeEl.hidden = mode === '';
  const signature = `${mode}|${view.project?.name ?? ''}`;
  if (signature === welcomeMode) return;
  welcomeMode = signature;
  welcomeEl.replaceChildren();
  if (mode === 'signin') {
    const button = el('button', undefined, 'Set API Key');
    button.addEventListener('click', () => post({ type: 'command', command: 'setApiKey' }));
    welcomeEl.append(
      el('h2', undefined, 'Connect to Hoplite'),
      el('p', undefined, 'Create an API key in Hoplite under Settings → Workspace → API keys, then paste it here. The key is kept in the VS Code secret storage.'),
      button,
    );
  } else if (mode === 'project') {
    const button = el('button', undefined, 'Select Project');
    button.addEventListener('click', () => post({ type: 'command', command: 'selectProject' }));
    welcomeEl.append(el('h2', undefined, 'Choose a project'), el('p', undefined, 'Threads run in a Hoplite project and its repositories.'), button);
  } else if (mode === 'new') {
    welcomeEl.append(
      el('h2', undefined, 'New thread'),
      el('p', undefined, `Describe a task and Hoplite starts working on it in ${view.project?.name ?? 'the project'}. Pick the model and run parameters below, or open an existing thread from the Threads list.`),
    );
  }
}

function renderState(): void {
  if (!state) return;
  const view = state;
  const thread = view.thread;

  topbar.hidden = !view.signedIn;
  projectButton.textContent = view.project ? view.project.name : 'Select project';
  projectButton.title = view.project ? `Project ${view.project.name}${view.project.repos.length ? ` · ${view.project.repos.join(', ')}` : ''}. Click to change.` : 'Select a Hoplite project';
  conn.hidden = !thread;
  conn.className = `conn ${view.connection}`;
  conn.title = view.connection === 'live' ? 'Live updates' : view.connection === 'polling' ? 'Polling for updates' : 'Connecting…';

  threadbar.hidden = !thread;
  if (thread) {
    statusBadge.textContent = thread.status;
    statusBadge.className = `badge ${thread.status}`;
    titleEl.textContent = thread.title;
    titleEl.title = thread.title;
    renderPullRequests(thread.pullRequests);
  }

  errorEl.hidden = !view.error;
  errorEl.textContent = view.error ?? '';
  renderWelcome(view);
  earlierButton.hidden = !view.hasEarlier;

  workingEl.hidden = !(thread && view.runActive);
  workingText.textContent = thread?.phase ? `${thread.phase}…` : thread?.status === 'queued' ? 'Queued…' : thread?.status === 'waiting' ? 'Waiting for your input…' : 'Hoplite is working…';

  renderQuestions(view.questions);
  failureEl.hidden = !view.failure;
  failureText.textContent = view.failure ? `${view.failure.message}${view.failure.resetsAt ? ` (resets ${formatTime(view.failure.resetsAt)})` : ''}` : '';

  composer.hidden = !view.signedIn;
  renderParams(view);
  input.placeholder = thread ? 'Reply to Hoplite…' : view.project ? `Describe a task for Hoplite in ${view.project.name}…` : 'Select a project to start…';
  sendButton.disabled = view.sending;
  sendButton.textContent = view.sending ? 'Sending…' : thread ? 'Send' : 'Start thread';
  stopButton.hidden = !(thread && view.runActive);
  hint.textContent = thread && view.runActive ? 'Your message steers the run or queues behind it' : 'Enter to send · Shift+Enter for a new line';
}

// ----- messages -----

const ROLE_LABELS: Record<string, string> = { assistant: 'Hoplite', system: 'System', tool: 'Tool' };

function messageNode(message: ViewMessage): HTMLElement {
  if (message.kind === 'status') return el('div', 'activity status', message.content.trim().split('\n')[0]);

  if (message.kind === 'chat') {
    const node = el('div', `msg ${message.role === 'user' ? 'user' : 'assistant'}${message.pending ? ' pending' : ''}`);
    const head = el('div', 'msg-head', message.role === 'user' ? (message.author ?? 'You') : (ROLE_LABELS[message.role] ?? message.role));
    head.append(el('span', 'time', message.pending ? 'sending…' : formatTime(message.createdAt)));
    const body = el('div', 'md');
    body.innerHTML = markdown.render(message.content);
    node.append(head, body);
    return node;
  }

  const details = el('details', `activity ${message.kind}`);
  const firstLine = message.content.trim().split('\n')[0].slice(0, 120);
  const summary = el('summary', undefined, message.kind === 'thinking' ? 'Thinking' : (message.toolName ?? 'Tool'));
  if (message.kind === 'tool' && firstLine) summary.append(el('span', 'summary-detail', firstLine));
  details.append(summary, el('pre', undefined, message.truncated ? `${message.content}\n… (truncated)` : message.content));
  return details;
}

const rendered = new Map<string, { message: ViewMessage; node: HTMLElement }>();
let scrollOnNextRender = true;

function sameMessage(a: ViewMessage, b: ViewMessage): boolean {
  return a.content === b.content && a.kind === b.kind && a.role === b.role && a.pending === b.pending && a.toolName === b.toolName && a.createdAt === b.createdAt;
}

/** Updates the list in place: only new or changed messages are rendered again. */
function renderMessages(): void {
  const stick = scrollOnNextRender || nearBottom();
  scrollOnNextRender = false;
  const keep = new Set<string>();
  let index = 0;
  for (const message of messages) {
    keep.add(message.id);
    let entry = rendered.get(message.id);
    if (!entry || !sameMessage(entry.message, message)) {
      const node = messageNode(message);
      if (entry) {
        if (entry.node instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) node.open = entry.node.open;
        entry.node.replaceWith(node);
      }
      entry = { message, node };
      rendered.set(message.id, entry);
    }
    const current = messagesEl.children[index];
    if (current !== entry.node) messagesEl.insertBefore(entry.node, current ?? null);
    index++;
  }
  for (const [id, entry] of rendered) {
    if (keep.has(id)) continue;
    entry.node.remove();
    rendered.delete(id);
  }
  if (stick) scrollToBottom();
}

let draftFrame = 0;

function renderDrafts(): void {
  draftFrame = 0;
  const stick = nearBottom();
  draftsEl.replaceChildren(
    ...drafts.map((draft) => {
      const thinking = draft.kind === 'thinking';
      const node = el('div', `msg assistant draft${thinking ? ' thinking' : ''}`);
      const body = el('div', 'md');
      body.innerHTML = markdown.render(draft.content);
      node.append(el('div', 'msg-head', thinking ? 'Thinking…' : 'Hoplite'), body);
      return node;
    }),
  );
  if (stick) scrollToBottom();
}

// ----- questions -----

interface AnswerDraft {
  selected: Set<string>;
  text: string;
}
const answerDrafts = new Map<string, AnswerDraft>();
let questionsSignature = '';

function renderQuestions(groups: ViewQuestionGroup[]): void {
  const signature = JSON.stringify(groups);
  if (signature === questionsSignature) return;
  questionsSignature = signature;
  const stick = nearBottom();
  questionsEl.replaceChildren();

  for (const group of groups) {
    const card = el('div', 'question-card');
    card.append(el('div', 'question-title', 'Hoplite needs your input'));

    group.questions.forEach((question, index) => {
      const key = `${group.questionId}:${index}`;
      const draft = answerDrafts.get(key) ?? { selected: new Set<string>(), text: '' };
      answerDrafts.set(key, draft);

      const block = el('div', 'question');
      const head = el('div', 'question-head');
      head.append(el('span', 'chip', question.header), el('span', undefined, question.question));
      block.append(head);

      const yesNo = question.inputType === 'boolean' && question.options.length === 0;
      const options = yesNo ? [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] : question.options;
      if (options.length > 0) {
        const list = el('div', 'options');
        for (const option of options) {
          const button = el('button', 'option');
          button.type = 'button';
          button.dataset.label = option.label;
          button.append(el('span', 'option-label', option.label));
          if (option.description) button.append(el('span', 'option-desc', option.description));
          button.classList.toggle('selected', draft.selected.has(option.label));
          button.addEventListener('click', () => {
            const wasSelected = draft.selected.has(option.label);
            if (!question.multiSelect) draft.selected.clear();
            if (wasSelected) draft.selected.delete(option.label);
            else draft.selected.add(option.label);
            for (const child of Array.from(list.children)) child.classList.toggle('selected', draft.selected.has((child as HTMLElement).dataset.label ?? ''));
          });
          list.append(button);
        }
        block.append(list);
      }
      if (!yesNo) {
        const field = question.inputType === 'textarea' ? el('textarea', 'answer-input') : el('input', 'answer-input');
        if (field instanceof HTMLInputElement) field.type = question.inputType && question.inputType !== 'boolean' ? question.inputType : 'text';
        field.placeholder = options.length > 0 ? 'Or type your own answer' : 'Your answer';
        field.value = draft.text;
        field.addEventListener('input', () => (draft.text = field.value));
        block.append(field);
      }
      card.append(block);
    });

    const actions = el('div', 'question-actions');
    const problem = el('span', 'hint');
    const decline = el('button', 'secondary', 'Decline');
    const submit = el('button', undefined, 'Submit');
    decline.addEventListener('click', () => post({ type: 'answer', questionId: group.questionId, answers: null }));
    submit.addEventListener('click', () => {
      const answers: Record<string, string> = {};
      for (let index = 0; index < group.questions.length; index++) {
        const draft = answerDrafts.get(`${group.questionId}:${index}`);
        const value = [...(draft?.selected ?? []), draft?.text.trim() ?? ''].filter(Boolean).join(', ');
        if (!value) {
          problem.textContent = 'Answer every question first.';
          return;
        }
        answers[group.questions[index].question] = value;
      }
      post({ type: 'answer', questionId: group.questionId, answers });
    });
    actions.append(problem, decline, submit);
    card.append(actions);
    questionsEl.append(card);
  }
  if (stick) scrollToBottom();
}

// ----- composer -----

function send(): void {
  const text = input.value.trim();
  if (!text || !state?.signedIn || state.sending) return;
  if (!state.thread && !state.project) {
    post({ type: 'command', command: 'selectProject' });
    return;
  }
  post({ type: 'send', text, title: state.thread ? undefined : titleInput.value.trim() || undefined });
  input.value = '';
  titleInput.value = '';
  persist();
  autoGrow();
}

function insertText(text: string): void {
  const prefix = input.value && !input.value.endsWith('\n') ? `${input.value}\n` : input.value;
  input.value = `${prefix}${text}`;
  persist();
  autoGrow();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

projectButton.addEventListener('click', () => post({ type: 'command', command: 'selectProject' }));
earlierButton.addEventListener('click', () => post({ type: 'command', command: 'loadEarlier' }));
$('retry').addEventListener('click', () => post({ type: 'command', command: 'retry' }));
$('openSettings').addEventListener('click', () => post({ type: 'command', command: 'openSettings' }));
stopButton.addEventListener('click', () => post({ type: 'command', command: 'stop' }));
sendButton.addEventListener('click', send);

modelSelect.addEventListener('change', () => post({ type: 'setModel', model: modelSelect.value }));
reasoningSelect.addEventListener('change', () => post({ type: 'setParam', key: 'reasoning', value: reasoningSelect.value }));
speedSelect.addEventListener('change', () => post({ type: 'setParam', key: 'speed', value: speedSelect.value }));
autoMergeSelect.addEventListener('change', () => post({ type: 'setParam', key: 'autoMerge', value: autoMergeSelect.value }));
reposInput.addEventListener('change', () => post({ type: 'setParam', key: 'repositories', value: reposInput.value }));
spendInput.addEventListener('change', () => {
  // In an open thread the limit is applied explicitly with the Apply button.
  if (!state?.thread) post({ type: 'setParam', key: 'spendLimitUsd', value: Number(spendInput.value) || 0 });
});
applySpend.addEventListener('click', () => post({ type: 'applySpendLimit', usd: Number(spendInput.value) || 0 }));
titleInput.addEventListener('input', persist);

$('advancedToggle').addEventListener('click', () => {
  persisted.advancedOpen = !persisted.advancedOpen;
  advanced.hidden = !persisted.advancedOpen;
  vscode.setState(persisted);
});

input.addEventListener('input', () => {
  persist();
  autoGrow();
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
});

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'state': {
      const previousThread = state?.thread?.id;
      state = message.state;
      if (previousThread !== state.thread?.id) scrollOnNextRender = true;
      renderState();
      break;
    }
    case 'messages':
      messages = message.messages;
      renderMessages();
      break;
    case 'drafts':
      drafts = message.drafts;
      draftFrame ||= requestAnimationFrame(renderDrafts);
      break;
    case 'insertText':
      insertText(message.text);
      break;
    case 'restoreText':
      if (!input.value.trim()) {
        input.value = message.text;
        persist();
        autoGrow();
      }
      break;
  }
});

input.value = persisted.text;
titleInput.value = persisted.title;
advanced.hidden = !persisted.advancedOpen;
autoGrow();
post({ type: 'ready' });
