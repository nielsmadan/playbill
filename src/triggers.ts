import { fail } from './diagnostics.js';
import type { Config } from './types.js';

export interface RepositoryStatus {
  git: boolean;
  dirty: boolean;
}

export interface Selection {
  workflow?: string;
  explicit: boolean;
}

export function candidateFiles(prompt: string): string[] {
  return [...prompt.matchAll(/`([^`\r\n]+)`/gu)]
    .map((match) => match[1]!)
    .filter(validCandidate);
}

export function validCandidate(path: string): boolean {
  return (
    path.length <= 2000 &&
    !/[\\:]/u.test(path) &&
    [...path].every(
      (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
    ) &&
    path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function matchesSegment(pattern: string, path: string): boolean {
  const characters = [...path];
  let matches = new Array<boolean>(characters.length + 1).fill(false);
  matches[0] = true;
  for (const char of pattern) {
    const next = new Array<boolean>(characters.length + 1).fill(false);
    next[0] = char === '*' && matches[0]!;
    for (let i = 1; i <= characters.length; i++)
      next[i] =
        char === '*'
          ? matches[i]! || next[i - 1]!
          : matches[i - 1]! && (char === '?' || char === characters[i - 1]);
    matches = next;
  }
  return matches[characters.length]!;
}

export function matchesGlob(pattern: string, path: string): boolean {
  const segments = path.split('/');
  let matches = new Array<boolean>(segments.length + 1).fill(false);
  matches[0] = true;
  for (const segment of pattern.split('/')) {
    const next = new Array<boolean>(segments.length + 1).fill(false);
    next[0] = segment === '**' && matches[0]!;
    for (let i = 1; i <= segments.length; i++)
      next[i] =
        segment === '**'
          ? matches[i]! || next[i - 1]!
          : matches[i - 1]! && matchesSegment(segment, segments[i - 1]!);
    matches = next;
  }
  return matches[segments.length]!;
}

export function selectWorkflow(
  config: Config,
  prompt: string,
  files: string[],
  repo: RepositoryStatus,
): Selection {
  const explicit = /^\s*\[playbill:([^\]\r\n]*)\]/u.exec(prompt);
  if (/^\s*\[playbill:/u.test(prompt)) {
    const id = explicit?.[1];
    if (!id || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/u.test(id))
      fail(
        'EXPLICIT_REQUEST',
        'prompt',
        'Use [playbill:workflow-id] at the start of the request.',
      );
    const policy = config.workflows[id];
    if (!policy)
      fail(
        'UNKNOWN_WORKFLOW',
        'prompt',
        `Workflow '${id}' is not configured; add its workflow policy and pipeline.`,
      );
    if (policy.entry === 'disabled')
      fail(
        'DISABLED_WORKFLOW',
        'prompt',
        `Workflow '${id}' has entry = "disabled".`,
      );
    return { workflow: id, explicit: true };
  }
  const matches = Object.entries(config.workflows)
    .filter(([, policy]) => {
      if (policy.entry === 'disabled' || policy.entry === 'explicit')
        return false;
      const triggers = policy.triggers ?? {};
      const guards = triggers.repo_conditions ?? [];
      if (
        !guards.every(
          (guard) =>
            repo.git &&
            (guard === 'git' || (guard === 'dirty' ? repo.dirty : !repo.dirty)),
        )
      )
        return false;
      const keywords = triggers.keywords ?? [];
      const patterns = triggers.file_patterns ?? [];
      if (keywords.length === 0 && patterns.length === 0)
        return guards.length > 0;
      return (
        keywords.some((phrase) =>
          new RegExp(
            `(?<![\\p{L}\\p{N}_])${escape(phrase)}(?![\\p{L}\\p{N}_])`,
            'iu',
          ).test(prompt),
        ) ||
        patterns.some((pattern) =>
          files.some((file) => matchesGlob(pattern, file)),
        )
      );
    })
    .sort(
      ([a, ap], [b, bp]) =>
        (bp.priority ?? 0) - (ap.priority ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
    );
  const selected = matches[0]?.[0];
  return selected === undefined
    ? { explicit: false }
    : { workflow: selected, explicit: false };
}
