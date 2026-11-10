// Messages exchanged between the extension host and the chat webview.

export interface ViewModel {
  id: string;
  name: string;
  provider: string;
  /** Reasoning levels and speeds this model accepts. */
  reasoning: string[];
  speeds: string[];
  requiredPlan?: string;
}

export interface ViewCatalog {
  models: ViewModel[];
  providers: { provider: string; label: string }[];
  defaultModelId: string;
  reasoningOptions: string[];
  speedOptions: string[];
}

export interface ViewParams {
  model: string;
  reasoning: string;
  speed: string;
  spendLimitUsd: number;
  autoMerge: 'inherit' | 'on' | 'off';
  repositories: string;
}

export interface ViewProject {
  id: string;
  name: string;
  repos: string[];
  defaultModel?: string;
  reasoningEffort?: string;
  agentSpeed?: string;
}

export interface ViewPullRequest {
  number: number;
  url: string;
  state: string;
  repoFullName: string;
}

export interface ViewThread {
  id: string;
  title: string;
  status: string;
  modelId: string;
  /** Workspace setup phase while the thread is still being prepared. */
  phase?: string;
  spendLimitUsd: number;
  pullRequests: ViewPullRequest[];
}

export interface ViewQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  inputType?: string;
  options: { label: string; description: string }[];
}

export interface ViewQuestionGroup {
  questionId: string;
  questions: ViewQuestion[];
}

export interface ViewState {
  signedIn: boolean;
  project: ViewProject | null;
  catalog: ViewCatalog | null;
  /** Parameters applied to new threads. */
  params: ViewParams;
  thread: ViewThread | null;
  /** Model used for the next message in the open thread. */
  threadModel: string;
  runActive: boolean;
  sending: boolean;
  loading: boolean;
  connection: 'idle' | 'connecting' | 'live' | 'polling';
  error?: string;
  failure?: { message: string; code: string; resetsAt?: string };
  questions: ViewQuestionGroup[];
  hasEarlier: boolean;
}

export interface ViewMessage {
  id: string;
  role: string;
  kind: string;
  content: string;
  createdAt: string;
  toolName?: string;
  author?: string;
  pending?: boolean;
  truncated?: boolean;
}

export interface ViewDraft {
  messageId: string;
  content: string;
  kind?: string;
}

export type ToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'messages'; messages: ViewMessage[] }
  | { type: 'drafts'; drafts: ViewDraft[] }
  | { type: 'insertText'; text: string }
  | { type: 'restoreText'; text: string };

export type ViewCommand = 'setApiKey' | 'selectProject' | 'stop' | 'retry' | 'loadEarlier' | 'openSettings';

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; title?: string }
  | { type: 'command'; command: ViewCommand }
  | { type: 'setModel'; model: string }
  | { type: 'setParam'; key: 'reasoning' | 'speed' | 'spendLimitUsd' | 'autoMerge' | 'repositories'; value: string | number }
  | { type: 'applySpendLimit'; usd: number }
  /** Answers keyed by question text; `null` declines. */
  | { type: 'answer'; questionId: string; answers: Record<string, string> | null };
