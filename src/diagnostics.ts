import type { Diagnostic } from './types.js';

export class PlaybillError extends Error {
  constructor(public readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join('\n'));
    this.name = 'PlaybillError';
  }
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  return `${diagnostic.path}: ${diagnostic.code}: ${diagnostic.message}`;
}

export function fail(code: string, path: string, message: string): never {
  throw new PlaybillError([{ code, path, message }]);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
