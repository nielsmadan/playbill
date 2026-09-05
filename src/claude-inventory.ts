import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { absoluteDirectory, optionalPath } from './discovery.js';
import { fail } from './diagnostics.js';
import { parseYamlData, readText } from './parsing.js';
import { validateRegistry } from './registry.js';
import { record, skillId, text, version } from './schema.js';
import type { NativeSkill } from './runtime.js';

function metadata(path: string): { name: string; invocable: boolean } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    readText(path),
  );
  if (!frontmatter)
    fail(
      'SKILL_METADATA',
      path,
      'Claude discovery requires YAML frontmatter with name.',
    );
  const data = record(parseYamlData(frontmatter[1]!, path), path);
  const name = text(data.name, `${path}.name`);
  if (!/^[a-z0-9-]{1,64}$/u.test(name))
    fail(
      'SKILL_METADATA',
      path,
      'Supported Claude names use lowercase letters, digits, and hyphens (max 64).',
    );
  const disabled = data['disable-model-invocation'];
  if (disabled !== undefined && typeof disabled !== 'boolean')
    fail(
      'SKILL_METADATA',
      path,
      'Use a YAML boolean for disable-model-invocation.',
    );
  return { name, invocable: disabled !== true };
}

export interface ClaudeInventory {
  skills: NativeSkill[];
  superpowersEvidence?: string;
}

function discoverNativeRoot(root: string, namespace?: string): NativeSkill[] {
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.length > 1000)
    fail('LIMIT', root, 'At most 1000 native skill entries.');
  const skills: NativeSkill[] = [];
  for (const entry of entries) {
    if (
      (!entry.isDirectory() && !entry.isSymbolicLink()) ||
      entry.name.toLowerCase() === 'synced'
    )
      continue;
    const directory = join(root, entry.name);
    if (optionalPath(join(directory, '.claude-plugin/plugin.json'))) continue;
    const path = join(directory, 'SKILL.md');
    if (!optionalPath(path)) continue;
    const identity = metadata(path);
    const mismatch = identity.name !== entry.name;
    const id = namespace ? `${namespace}:${identity.name}` : identity.name;
    const skill = validateRegistry([
      { id, path, model_invocable: identity.invocable && !mismatch },
    ])[0]!;
    skills.push({
      ...skill,
      invocation: id,
      ...(mismatch
        ? {
            unavailableReason: `Claude filesystem discovery requires frontmatter name '${identity.name}' to match directory '${entry.name}'. Rename the directory or provide an attested PLAYBILL_CLAUDE_INVENTORY using the actual native invocation.`,
          }
        : {}),
    });
  }
  validateRegistry(
    skills.map(
      ({ invocation: _invocation, unavailableReason: _reason, ...skill }) => {
        void _invocation;
        void _reason;
        return skill;
      },
    ),
  );
  return skills;
}

function loadSnapshot(path: string): ClaudeInventory {
  const document = record(parseYamlData(readText(path), path), path, [
    'version',
    'skills',
    'superpowers_bootstrap',
  ]);
  version(document.version, `${path}.version`);
  if (!Array.isArray(document.skills) || document.skills.length > 1000)
    fail('INVENTORY', path, 'Expected at most 1000 skills.');
  const skills = document.skills.map((value: unknown) => {
    const entry = record(value, `${path}.skills[]`, [
      'id',
      'path',
      'invocation',
      'model_invocable',
      'requires',
    ]);
    const invocation = skillId(entry.invocation, `${path}.invocation`);
    const { invocation: _invocation, ...registryEntry } = entry;
    void _invocation;
    const skill = validateRegistry([registryEntry], dirname(path))[0]!;
    const installedPath = resolve(dirname(path), String(registryEntry.path));
    const native = metadata(skill.path);
    const tail = invocation.split(':').at(-1);
    const directoryName = basename(dirname(installedPath));
    if (
      !/^[a-z0-9/-]+(?::[a-z0-9-]+)?$/u.test(invocation) ||
      (tail !== native.name && tail !== directoryName)
    )
      fail(
        'NATIVE_INVOCATION',
        path,
        `Invocation '${invocation}' must end in frontmatter name '${native.name}' or installed directory '${directoryName}', with an optional native namespace. The inventory author must attest which identity this host registered.`,
      );
    if (skill.model_invocable && !native.invocable)
      fail(
        'SKILL_INVOCATION',
        skill.path,
        'Inventory cannot enable a skill with disable-model-invocation: true.',
      );
    return { ...skill, invocation };
  });
  validateRegistry(
    skills.map(({ invocation: _invocation, ...skill }) => {
      void _invocation;
      return skill;
    }),
  );
  const names = new Map<string, string>();
  for (const skill of skills) {
    if (
      names.has(skill.invocation) &&
      names.get(skill.invocation) !== skill.path
    )
      fail(
        'AMBIGUOUS_SKILL',
        path,
        `Native invocation '${skill.invocation}' points to multiple files.`,
      );
    names.set(skill.invocation, skill.path);
  }
  const result: ClaudeInventory = { skills };
  if (document.superpowers_bootstrap !== undefined) {
    const evidence = record(
      document.superpowers_bootstrap,
      `${path}.superpowers_bootstrap`,
      ['status', 'evidence'],
    );
    if (!['active', 'likely'].includes(String(evidence.status)))
      fail('INVENTORY', path, 'Bootstrap status must be active or likely.');
    result.superpowersEvidence = `${String(evidence.status)} bootstrap reported by normalized inventory: ${text(evidence.evidence, `${path}.evidence`)}`;
  }
  return result;
}

export function discoverClaudeInventory(
  cwd: string,
  root: string,
  pluginRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeInventory {
  if (env.PLAYBILL_CLAUDE_INVENTORY !== undefined) {
    if (!env.PLAYBILL_CLAUDE_INVENTORY.startsWith('/'))
      fail(
        'PATH',
        'PLAYBILL_CLAUDE_INVENTORY',
        'Use an absolute inventory file path.',
      );
    return loadSnapshot(env.PLAYBILL_CLAUDE_INVENTORY);
  }
  const personal = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  if (!personal.startsWith('/'))
    fail('PATH', 'CLAUDE_CONFIG_DIR', 'Use an absolute directory.');
  const projectDirectories: string[] = [];
  let current = absoluteDirectory(cwd);
  const rel = relative(root, current);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('/'))
    fail('PROJECT_ROOT', root, 'Project override must contain the hook cwd.');
  for (;;) {
    projectDirectories.unshift(join(current, '.claude'));
    if (current === root) break;
    current = dirname(current);
  }
  const native = new Map<string, NativeSkill>();
  for (const directory of [...projectDirectories, personal]) {
    const skillRoot = join(directory, 'skills');
    if (!optionalPath(skillRoot)) continue;
    for (const skill of discoverNativeRoot(skillRoot)) {
      if (
        directory !== personal &&
        native.has(skill.id) &&
        native.get(skill.id)!.path !== skill.path
      )
        fail(
          'AMBIGUOUS_SKILL',
          skillRoot,
          `Project ancestry has multiple '${skill.id}' skills. Supply PLAYBILL_CLAUDE_INVENTORY with their native qualified identities.`,
        );
      native.set(skill.id, skill);
    }
  }
  const pluginSkills = join(pluginRoot, 'skills');
  if (optionalPath(pluginSkills)) {
    for (const skill of discoverNativeRoot(pluginSkills, 'playbill'))
      native.set(skill.id, skill);
  }
  if (native.size > 1000)
    fail('LIMIT', 'Claude inventory', 'At most 1000 native skills.');
  const enabled = new Map<string, { value: boolean; path: string }>();
  const visibility = new Map<string, string>();
  for (const path of [
    join(personal, 'settings.json'),
    ...projectDirectories.flatMap((directory) => [
      join(directory, 'settings.json'),
      join(directory, 'settings.local.json'),
    ]),
  ]) {
    if (!optionalPath(path)) continue;
    const settings = record(JSON.parse(readText(path)) as unknown, path);
    if (settings.skillOverrides !== undefined) {
      for (const [id, value] of Object.entries(
        record(settings.skillOverrides, `${path}.skillOverrides`),
      )) {
        if (
          !['on', 'name-only', 'user-invocable-only', 'off'].includes(
            String(value),
          )
        )
          fail('SKILL_SETTINGS', path, `Unsupported visibility for '${id}'.`);
        visibility.set(id, String(value));
      }
    }
    if (settings.enabledPlugins === undefined) continue;
    for (const [id, value] of Object.entries(
      record(settings.enabledPlugins, `${path}.enabledPlugins`),
    ))
      if (id.startsWith('superpowers@') && typeof value === 'boolean')
        enabled.set(id, { value, path });
  }
  for (const [id, value] of visibility) {
    const skill = native.get(id);
    if (
      skill &&
      !id.includes(':') &&
      (value === 'off' || value === 'user-invocable-only')
    )
      skill.model_invocable = false;
  }
  const likely = [...enabled].find(([, entry]) => entry.value);
  return {
    skills: [...native.values()],
    ...(likely
      ? {
          superpowersEvidence: `${likely[0]} is enabled in ${likely[1].path}; launch flags and managed settings may change its actual activation`,
        }
      : {}),
  };
}
