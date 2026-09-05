import { fail } from './diagnostics.js';
import type { AgentProperties, AgentRequirements } from './types.js';

export const LIMITS = Object.freeze({
  sourceBytes: 262_144,
  dataNodes: 20_000,
  dataDepth: 64,
  textLength: 2_000,
  arrayLength: 1_000,
  flowNodes: 256,
  flowDepth: 16,
  loopIterations: 100,
  expandedSteps: 10_000,
  registrySkills: 1_000,
  renderedBytes: 65_536,
});

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

export function safeData(value: unknown, path: string): void {
  const pending = [{ value, path, depth: 0 }];
  const seen = new Set<object>();
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > LIMITS.dataNodes || item.depth > LIMITS.dataDepth) {
      fail('LIMIT', item.path, 'Document is too large or deeply nested.');
    }
    if (typeof item.value === 'number' && !Number.isFinite(item.value)) {
      fail('VALUE', item.path, 'Numbers must be finite.');
    }
    if (
      typeof item.value === 'string' &&
      item.value.length > LIMITS.textLength
    ) {
      fail(
        'LIMIT',
        item.path,
        `Strings must be at most ${LIMITS.textLength} characters.`,
      );
    }
    if (item.value === null || typeof item.value !== 'object') {
      if (
        !['string', 'number', 'boolean'].includes(typeof item.value) &&
        item.value !== null
      ) {
        fail('TYPE', item.path, 'Expected plain data.');
      }
      continue;
    }
    if (seen.has(item.value))
      fail('ALIAS', item.path, 'Aliases and cyclic data are unsupported.');
    seen.add(item.value);
    const prototype: unknown = Object.getPrototypeOf(item.value);
    if (
      !Array.isArray(item.value) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      fail(
        'TYPE',
        item.path,
        'Expected a plain object; dates and custom objects are unsupported.',
      );
    }
    if (Array.isArray(item.value) && item.value.length > LIMITS.arrayLength) {
      fail(
        'LIMIT',
        item.path,
        `Arrays must contain at most ${LIMITS.arrayLength} items.`,
      );
    }
    if (Object.getOwnPropertySymbols(item.value).length)
      fail('TYPE', item.path, 'Symbol keys are unsupported.');
    const object = item.value;
    if (
      Array.isArray(object) &&
      Array.from({ length: object.length }, (_, index) => index).some(
        (index) => !Object.hasOwn(object, index),
      )
    )
      fail('TYPE', item.path, 'Sparse arrays are unsupported.');
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(item.value),
    )) {
      if (Array.isArray(item.value) && key === 'length') continue;
      if (forbiddenKeys.has(key))
        fail('KEY', `${item.path}.${key}`, 'Reserved key.');
      if (!('value' in descriptor))
        fail('TYPE', item.path, 'Accessor properties are unsupported.');
      pending.push({
        value: descriptor.value as unknown,
        path: `${item.path}.${key}`,
        depth: item.depth + 1,
      });
    }
  }
}

export function record(
  value: unknown,
  path: string,
  allowed?: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('TYPE', path, 'Expected a table/object.');
  const result = value as Record<string, unknown>;
  if (allowed)
    for (const key of Object.keys(result)) {
      if (!allowed.includes(key))
        fail(
          'UNKNOWN_FIELD',
          `${path}.${key}`,
          `Unknown field; allowed: ${allowed.join(', ')}.`,
        );
    }
  return result;
}

export function text(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > LIMITS.textLength ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    fail(
      'TYPE',
      path,
      `Expected nonempty, single-line text of at most ${LIMITS.textLength} characters.`,
    );
  }
  return value;
}

export function identifier(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/u.test(result))
    fail(
      'VALUE',
      path,
      'Use an ID starting with a letter, followed by letters, digits, underscores or hyphens (max 80).',
    );
  return result;
}

export function skillId(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,199}$/u.test(result))
    fail(
      'VALUE',
      path,
      'Expected a canonical skill ID (letters, digits, _, -, ., :, @ or /; max 200).',
    );
  return result;
}

export function choice<const T extends string>(
  value: unknown,
  path: string,
  choices: readonly T[],
): T {
  if (typeof value !== 'string' || !choices.includes(value as T))
    fail('VALUE', path, `Expected one of: ${choices.join(', ')}.`);
  return value as T;
}

export function integer(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail('VALUE', path, `Expected an integer between ${min} and ${max}.`);
  return value;
}

export function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > LIMITS.arrayLength)
    fail(
      'TYPE',
      path,
      `Expected an array with at most ${LIMITS.arrayLength} items.`,
    );
  return value as unknown[];
}

export function strings(
  value: unknown,
  path: string,
  parse = identifier,
): string[] {
  const result = list(value, path).map((item, i) =>
    parse(item, `${path}[${i}]`),
  );
  if (new Set(result).size !== result.length)
    fail('DUPLICATE', path, 'Duplicate values are unsupported.');
  return result;
}

export function relativePath(value: unknown, path: string): string {
  const result = text(value, path);
  if (
    result.startsWith('/') ||
    /[\\:`{}]/u.test(result) ||
    result.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    fail(
      'VALUE',
      path,
      'Use a workspace-relative file path without traversal, backslashes, backticks or templates.',
    );
  }
  return result;
}

export function filePattern(value: unknown, path: string): string {
  const result = relativePath(value, path);
  if (
    /[[\]()!]/u.test(result) ||
    result.split('/').some((part) => part.includes('**') && part !== '**')
  ) {
    fail(
      'VALUE',
      path,
      'File patterns support *, ? and whole-segment **; brackets, parentheses and negation are unsupported.',
    );
  }
  return result;
}

export function requirements(value: unknown, path: string): AgentRequirements {
  const data = record(value, path, ['fresh', 'read_only', 'model']);
  const result: AgentRequirements = {};
  for (const property of ['fresh', 'read_only'] as const) {
    if (data[property] !== undefined) {
      if (typeof data[property] !== 'boolean')
        fail('TYPE', `${path}.${property}`, 'Expected a boolean.');
      result[property] = data[property];
    }
  }
  if (data.model !== undefined)
    result.model = choice(data.model, `${path}.model`, [
      'fast',
      'balanced',
      'capable',
    ]);
  return result;
}

export function agentProperties(value: unknown, path: string): AgentProperties {
  return {
    fresh: false,
    read_only: false,
    model: 'balanced',
    ...requirements(value, path),
  };
}

export function version(value: unknown, path: string): 1 {
  if (value !== 1) fail('VERSION', path, 'Expected version = 1.');
  return value;
}
