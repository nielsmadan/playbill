import { fail } from './diagnostics.js';
import { parseTomlData } from './parsing.js';
import {
  choice,
  filePattern,
  identifier,
  integer,
  record,
  safeData,
  skillId,
  strings,
  text,
  version,
} from './schema.js';
import type { Config, Triggers, WorkflowPolicy } from './types.js';

export function validateConfig(value: unknown, path = 'config'): Config {
  safeData(value, path);
  const data = record(value, path, ['version', 'slots', 'workflows']);
  const slots: Config['slots'] = {};
  for (const [key, value] of Object.entries(
    record(data.slots === undefined ? {} : data.slots, `${path}.slots`),
  )) {
    slots[identifier(key, `${path}.slots.${key}`)] = skillId(
      value,
      `${path}.slots.${key}`,
    );
  }
  const workflows: Config['workflows'] = {};
  for (const [key, value] of Object.entries(
    record(
      data.workflows === undefined ? {} : data.workflows,
      `${path}.workflows`,
    ),
  )) {
    identifier(key, `${path}.workflows.${key}`);
    const at = `${path}.workflows.${key}`;
    const workflow = record(value, at, ['entry', 'priority', 'triggers']);
    const policy: WorkflowPolicy = {};
    if (workflow.entry !== undefined)
      policy.entry = choice(workflow.entry, `${at}.entry`, [
        'auto',
        'explicit',
        'disabled',
      ]);
    if (workflow.priority !== undefined)
      policy.priority = integer(
        workflow.priority,
        `${at}.priority`,
        -1000,
        1000,
      );
    if (workflow.triggers !== undefined) {
      const atTriggers = `${at}.triggers`;
      const data = record(workflow.triggers, atTriggers, [
        'keywords',
        'file_patterns',
        'repo_conditions',
      ]);
      const triggers: Triggers = {};
      if (data.keywords !== undefined)
        triggers.keywords = strings(
          data.keywords,
          `${atTriggers}.keywords`,
          text,
        );
      if (data.file_patterns !== undefined)
        triggers.file_patterns = strings(
          data.file_patterns,
          `${atTriggers}.file_patterns`,
          filePattern,
        );
      if (data.repo_conditions !== undefined)
        triggers.repo_conditions = strings(
          data.repo_conditions,
          `${atTriggers}.repo_conditions`,
          (value, path) => choice(value, path, ['git', 'clean', 'dirty']),
        ) as NonNullable<Triggers['repo_conditions']>;
      if (
        triggers.repo_conditions?.includes('clean') &&
        triggers.repo_conditions.includes('dirty')
      )
        fail(
          'VALUE',
          atTriggers,
          'A repository cannot be both clean and dirty.',
        );
      policy.triggers = triggers;
    }
    workflows[key] = policy;
  }
  return {
    version: version(
      data.version === undefined ? 1 : data.version,
      `${path}.version`,
    ),
    slots,
    workflows,
  };
}

export function parseConfig(source: string, path = 'config.toml'): Config {
  return validateConfig(parseTomlData(source, path), path);
}

export function mergeConfig(machine: unknown, project: unknown): Config {
  const base = validateConfig(machine, 'machine');
  const override = validateConfig(project, 'project');
  const workflows = { ...base.workflows };
  for (const [id, policy] of Object.entries(override.workflows)) {
    workflows[id] = { ...workflows[id], ...policy };
    if (policy.triggers !== undefined)
      workflows[id].triggers = {
        ...base.workflows[id]?.triggers,
        ...policy.triggers,
      };
  }
  return validateConfig({
    version: 1,
    slots: { ...base.slots, ...override.slots },
    workflows,
  });
}
