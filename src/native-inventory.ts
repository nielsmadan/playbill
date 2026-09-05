import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionalPath } from './discovery.js';
import { fail } from './diagnostics.js';
import { parseYamlData, readText } from './parsing.js';
import { validateRegistry } from './registry.js';
import { record, skillId, version } from './schema.js';
import type { NativeSkill } from './runtime.js';

export const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
export const bundledSkills = join(pluginRoot, 'skills');

export function skillMetadata(path: string): {
  name: string;
  invocable: boolean;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(readText(path));
  if (!match)
    fail('SKILL_METADATA', path, 'Expected YAML frontmatter with name.');
  const data = record(parseYamlData(match[1]!, path), path);
  const disabled = data['disable-model-invocation'];
  if (disabled !== undefined && typeof disabled !== 'boolean')
    fail('SKILL_METADATA', path, 'disable-model-invocation must be a boolean.');
  return {
    name: skillId(data.name, `${path}.name`),
    invocable: disabled !== true,
  };
}

export function canonicalId(
  name: string,
  path: string,
  ownRoot = bundledSkills,
): string {
  if (optionalPath(ownRoot)) {
    const rel = relative(realpathSync(ownRoot), realpathSync(path));
    if (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))
      return `playbill:${skillMetadata(path).name}`;
  }
  return name;
}

export function normalizeNative(skills: NativeSkill[]): NativeSkill[] {
  const registry = validateRegistry(
    skills.map(({ invocation, unavailableReason, ...skill }) => {
      void invocation;
      void unavailableReason;
      return skill;
    }),
  );
  const names = new Map<string, string>();
  return registry.map((skill, index) => {
    const native = skills[index]!;
    skillId(native.invocation, 'native invocation');
    const previous = names.get(native.invocation);
    if (previous && previous !== skill.path)
      fail(
        'AMBIGUOUS_SKILL',
        native.invocation,
        'One native invocation points to multiple skill files.',
      );
    names.set(native.invocation, skill.path);
    return { ...native, ...skill };
  });
}

export function codexInvocable(path: string): boolean {
  if (!skillMetadata(path).invocable) return false;
  const policyPath = join(dirname(path), 'agents/openai.yaml');
  if (!optionalPath(policyPath)) return true;
  const data = record(
    parseYamlData(readText(policyPath), policyPath),
    policyPath,
  );
  if (data.policy === undefined) return true;
  const policy = record(data.policy, `${policyPath}.policy`);
  const allow = policy.allow_implicit_invocation;
  if (allow !== undefined && typeof allow !== 'boolean')
    fail(
      'SKILL_METADATA',
      policyPath,
      'allow_implicit_invocation must be a boolean.',
    );
  return allow !== false;
}

export function nativeSnapshot(
  path: string,
  host: 'codex' | 'pi' | 'opencode',
): NativeSkill[] {
  if (!isAbsolute(path)) fail('PATH', path, 'Use an absolute inventory path.');
  const data = record(parseYamlData(readText(path), path), path, [
    'version',
    'skills',
  ]);
  version(data.version, `${path}.version`);
  if (!Array.isArray(data.skills) || data.skills.length > 1000)
    fail('INVENTORY', path, 'Expected at most 1000 skills.');
  return normalizeNative(
    data.skills.map((value: unknown) => {
      const entry = record(value, path, [
        'id',
        'path',
        'invocation',
        'model_invocable',
        'requires',
      ]);
      const invocation = skillId(entry.invocation, `${path}.invocation`);
      const { invocation: _invocation, ...raw } = entry;
      void _invocation;
      const skill = validateRegistry([raw], dirname(path))[0]!;
      if (host === 'pi') return { ...skill, invocation };
      const metadata = skillMetadata(skill.path);
      if (invocation.split(':').at(-1) !== metadata.name)
        fail(
          'NATIVE_INVOCATION',
          path,
          `Invocation '${invocation}' must match the native frontmatter name, with an optional namespace.`,
        );
      if (
        skill.model_invocable &&
        !(host === 'codex' ? codexInvocable(skill.path) : metadata.invocable)
      )
        fail(
          'SKILL_INVOCATION',
          skill.path,
          'An inventory cannot enable native disabled model invocation.',
        );
      return { ...skill, invocation };
    }),
  );
}

export function corroborateSnapshot(
  snapshot: NativeSkill[],
  live: NativeSkill[],
): NativeSkill[] {
  return normalizeNative(
    snapshot.map((skill) => {
      const native = live.find(
        (entry) =>
          entry.invocation === skill.invocation && entry.path === skill.path,
      );
      return {
        ...skill,
        model_invocable:
          skill.model_invocable && native?.model_invocable === true,
        ...(!native || !native.model_invocable
          ? {
              unavailableReason:
                native?.unavailableReason ??
                'The current native registry does not expose this exact invocation and file.',
            }
          : {}),
      };
    }),
  );
}
