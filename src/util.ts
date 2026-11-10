import type { Thread, ThreadDiff } from './api/types.ts';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `owner/repo` from an HTTPS or SSH git remote URL. */
export function repoFullNameFromRemote(url: string): string | undefined {
  const trimmed = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const match = /[:/]([^/:\s]+)\/([^/\s]+)$/.exec(trimmed);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function usdFromMicros(micros: number | null | undefined): number {
  return typeof micros === 'number' && micros > 0 ? micros / 1_000_000 : 0;
}

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(time).toLocaleDateString();
}

const PHASES: Record<string, string> = {
  provisioning_workspace: 'Provisioning workspace',
  resolving_repository: 'Resolving repository',
  allocating_sandbox: 'Allocating sandbox',
  fetching_repository: 'Fetching repository',
  configuring_workspace: 'Configuring workspace',
  dispatching_run: 'Starting run',
};

/** Human-readable workspace setup phase while a thread is still being prepared. */
export function setupPhase(thread: Thread | undefined): string | undefined {
  if (!thread || (thread.initializationState !== 'accepted' && thread.initializationState !== 'preparing')) return undefined;
  return thread.initializationPhase ? (PHASES[thread.initializationPhase] ?? thread.initializationPhase) : 'Preparing workspace';
}

/** A backtick fence longer than any backtick run inside `text`. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function formatSelection(path: string, startLine: number, endLine: number, languageId: string, text: string): string {
  const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  const fence = fenceFor(text);
  return `\`${path}\` (${lines}):\n${fence}${languageId}\n${text.replace(/\n$/, '')}\n${fence}\n`;
}

/** Renders the API diff as one unified patch document. */
export function formatDiff(diff: ThreadDiff, title: string): string {
  const stats = diff.stats ?? {
    files: diff.files.length,
    additions: diff.files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: diff.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  };
  const mode = diff.effectiveMode ?? diff.mode;
  const lines = [`# ${title}`, `# ${mode} diff${diff.isFallback ? ' (fallback)' : ''}: ${stats.files} file(s), +${stats.additions} -${stats.deletions}`];
  if (diff.unavailableReason) lines.push(`# unavailable: ${diff.unavailableReason}`);
  lines.push('');

  for (const file of diff.files) {
    const from = file.previousPath ?? file.path;
    const patch = (file.patch ?? '').replace(/\n$/, '');
    if (!/^diff --git /m.test(patch)) {
      lines.push(`diff --git a/${from} b/${file.path}`);
      if (!/^--- /m.test(patch)) {
        lines.push(`--- ${file.state === 'added' ? '/dev/null' : `a/${from}`}`, `+++ ${file.state === 'deleted' ? '/dev/null' : `b/${file.path}`}`);
      }
    }
    if (patch) lines.push(patch);
    if (file.truncated) lines.push(`# patch truncated${file.truncatedReason ? `: ${file.truncatedReason}` : ''}`);
    else if (!patch) lines.push('# no textual changes');
    lines.push('');
  }
  return lines.join('\n');
}
