import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { errorMessage, fail, PlaybillError } from './diagnostics.js';
import { parseYamlData, readText } from './parsing.js';
import {
  LIMITS,
  list,
  record,
  requirements,
  safeData,
  skillId,
  text,
  version,
} from './schema.js';
import type { InstalledSkill } from './types.js';

export function validateRegistry(
  value: unknown,
  baseDir = process.cwd(),
): InstalledSkill[] {
  safeData(value, 'registry');
  const entries = list(value, 'registry.skills');
  if (entries.length > LIMITS.registrySkills)
    fail(
      'LIMIT',
      'registry.skills',
      `Registry exceeds ${LIMITS.registrySkills} skills.`,
    );
  const ids = new Set<string>();
  return entries.map((value, i) => {
    const at = `registry.skills[${i}]`;
    const entry = record(value, at, [
      'id',
      'path',
      'requires',
      'model_invocable',
    ]);
    const id = skillId(entry.id, `${at}.id`);
    if (ids.has(id))
      fail(
        'AMBIGUOUS_SKILL',
        `${at}.id`,
        `Skill '${id}' occurs more than once; provide one canonical installation.`,
      );
    ids.add(id);
    const path = resolve(baseDir, text(entry.path, `${at}.path`));
    if (basename(path) !== 'SKILL.md')
      fail(
        'SKILL_INSTALLATION',
        `${at}.path`,
        'Expected a path to an installed SKILL.md file.',
      );
    try {
      if (!statSync(path).isFile())
        fail(
          'SKILL_INSTALLATION',
          `${at}.path`,
          `Skill '${id}' must be a regular SKILL.md file.`,
        );
      if (!readText(path).trim())
        fail(
          'SKILL_INSTALLATION',
          `${at}.path`,
          `Skill '${id}' has an empty SKILL.md file.`,
        );
    } catch (error) {
      if (error instanceof PlaybillError) throw error;
      fail(
        'SKILL_INSTALLATION',
        `${at}.path`,
        `Skill '${id}' is unavailable at ${path}: ${errorMessage(error)}`,
      );
    }
    if (
      entry.model_invocable !== undefined &&
      typeof entry.model_invocable !== 'boolean'
    )
      fail('TYPE', `${at}.model_invocable`, 'Expected a boolean.');
    return {
      id,
      path: realpathSync(path),
      model_invocable:
        entry.model_invocable === undefined ? true : entry.model_invocable,
      requires: requirements(
        entry.requires === undefined ? {} : entry.requires,
        `${at}.requires`,
      ),
    };
  });
}

export function parseRegistry(
  source: string,
  baseDir = process.cwd(),
  path = 'registry.yaml',
): InstalledSkill[] {
  const data = record(parseYamlData(source, path), path, ['version', 'skills']);
  version(data.version, `${path}.version`);
  return validateRegistry(data.skills, baseDir);
}

export function loadRegistry(path: string): InstalledSkill[] {
  return parseRegistry(readText(path), dirname(resolve(path)), path);
}

export function discoverSkills(root: string): InstalledSkill[] {
  const absoluteRoot = resolve(root);
  try {
    const entries = readdirSync(absoluteRoot, { withFileTypes: true });
    if (entries.length > LIMITS.registrySkills)
      fail(
        'LIMIT',
        absoluteRoot,
        `Skill root exceeds ${LIMITS.registrySkills} entries.`,
      );
    const skills: { id: string; path: string; model_invocable: boolean }[] = [];
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(absoluteRoot, entry.name, 'SKILL.md');
      try {
        statSync(path);
      } catch (error) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          continue;
        throw error;
      }
      const contents = readText(path);
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
        contents,
      );
      if (!frontmatter)
        fail(
          'SKILL_METADATA',
          path,
          'Expected YAML frontmatter with a name field; use --registry for an explicitly normalized ID.',
        );
      const metadata = record(parseYamlData(frontmatter[1]!, path), path);
      const id = skillId(metadata.name, `${path}.name`);
      const disabled = metadata['disable-model-invocation'];
      if (disabled !== undefined && typeof disabled !== 'boolean')
        fail(
          'SKILL_METADATA',
          path,
          'disable-model-invocation must be a boolean.',
        );
      skills.push({ id, path, model_invocable: disabled !== true });
    }
    return validateRegistry(skills);
  } catch (error) {
    if (error instanceof PlaybillError) throw error;
    fail('SKILL_ROOT', absoluteRoot, errorMessage(error));
  }
}
