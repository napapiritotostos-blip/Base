// Subset of the Hoplite public API (https://hoplite.sh/openapi.json) used by the extension.

export type ThreadStatus = 'queued' | 'running' | 'waiting' | 'blocked' | 'ready' | 'failed' | 'archived';
export type RunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type DiffMode = 'uncommitted' | 'base' | 'pr';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextVariantOf?: string;
  requiredPlan?: string;
  usageMultiplier?: number;
  pricing?: { inputMicrosPerMTok: number; outputMicrosPerMTok: number };
  capabilities?: {
    contextWindowTokens?: number;
    reasoningLevels: string[];
    supportsFast: boolean;
    supportsImages?: boolean;
  };
}

export interface RunConfig {
  defaultModelId: string;
  defaultReasoning: string;
  defaultSpeed: string;
  reasoningOptions: string[];
  speedOptions: string[];
}

export interface ModelCatalog {
  providers: { provider: string; label: string; defaultModelId: string }[];
  runConfig: RunConfig;
  models: ModelInfo[];
}

export interface RepoRef {
  repoFullName: string;
  branch?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  repos?: RepoRef[];
  defaultBranch?: string | null;
  defaultModel?: string | null;
  reasoningEffort?: string | null;
  agentSpeed?: string | null;
}

export interface PullRequest {
  id?: string;
  number: number;
  url: string;
  repoFullName: string;
  state: string;
  draft?: boolean;
  headRef?: string;
  baseRef?: string;
}

export interface Thread {
  id: string;
  projectId: string;
  title?: string | null;
  status: ThreadStatus;
  modelId?: string | null;
  archivedAt?: string | null;
  initializationState?: 'accepted' | 'preparing' | 'completed' | 'failed' | 'cancelled';
  initializationPhase?: string | null;
  initializationErrorMessage?: string | null;
  waitingOn?: string[];
  blockedOn?: string[];
  pullRequests?: PullRequest[];
  primaryPullRequest?: PullRequest | null;
  createdAt?: string;
  updatedAt?: string;
  latestUserMessageAt?: string;
  spendLimitMicros?: number | null;
  latestRunId?: string | null;
  runStatus?: RunStatus | null;
  runSteerable?: boolean | null;
}

export interface Message {
  id: string;
  threadId: string;
  runId?: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  kind: 'chat' | 'thinking' | 'tool' | 'status';
  content: string;
  createdAt: string;
  toolCallId?: string;
  toolName?: string;
  author?: { id: string; name: string; image?: string | null } | null;
  metadata?: Record<string, unknown> | null;
}

export interface ActiveRun {
  runId: string;
  status: RunStatus;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionItem {
  header: string;
  question: string;
  multiSelect: boolean;
  inputType?: 'text' | 'textarea' | 'number' | 'date' | 'email' | 'url' | 'boolean';
  options: QuestionOption[];
}

export interface ThreadQuestion {
  questionId: string;
  runId: string | null;
  request: { questions: QuestionItem[] };
}

/** `answers: null` declines the question. */
export type AnswerRequest = { answer: string } | { answers: Record<string, string> | null };

export interface RunFailureDetail {
  code: string;
  message: string;
  resetsAt?: string;
}

export interface DiffFile {
  path: string;
  previousPath?: string;
  state?: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged' | 'unknown';
  additions?: number;
  deletions?: number;
  patch?: string;
  truncated?: boolean;
  truncatedReason?: string;
}

export interface ThreadDiff {
  threadId: string;
  mode: DiffMode;
  files: DiffFile[];
  stats?: { files: number; additions: number; deletions: number };
  effectiveMode?: DiffMode;
  isFallback?: boolean;
  unavailableReason?: string;
}

export interface PublicEvent {
  id: string;
  type: string;
  projectId: string | null;
  threadId: string | null;
  runId: string | null;
  data: { id: string; status?: string; role?: string };
  cursor: string;
}

export interface EventFilter {
  projectId?: string;
  threadId?: string;
  runId?: string;
  types?: string;
}

export interface CreateThreadRequest {
  projectId: string;
  prompt: string;
  title?: string;
  model?: string;
  speed?: string;
  reasoning?: { mode: string };
  /** Lifetime budget in microdollars: 1 000 000 is $1. */
  spendLimitMicros?: number;
  autoMerge?: boolean;
  repos?: RepoRef[];
  onBehalfOfUserId?: string;
}

export interface CreateThreadResponse {
  thread: Thread;
  message?: Message | null;
  run?: { id: string; status?: string } | null;
}

export interface SendMessageRequest {
  content: string;
  model?: string;
}

export interface SendMessageResponse {
  message: { id: string };
  queued?: boolean;
  run?: { id: string; status?: string } | null;
}

export interface UpdateThreadRequest {
  title?: string | null;
  archived?: boolean;
  spendLimitMicros?: number | null;
}

export interface MessagesResponse {
  messages: Message[];
  hasMore: boolean;
  nextCursor?: string | null;
}

export interface ThreadsResponse {
  threads: Thread[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Capabilities {
  principalId: string;
  orgId: string;
  projectIds: string[] | null;
  permissions: Record<string, string[]> | null;
}
