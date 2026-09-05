#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mergeConfig, parseConfig } from './config.js';
import { errorMessage, fail, PlaybillError } from './diagnostics.js';
import { readText } from './parsing.js';
import { parsePipeline } from './pipeline.js';
import { discoverSkills, loadRegistry } from './registry.js';
import { renderPipeline } from './renderer.js';
import { validatePipeline } from './validator.js';

const help = `Usage: playbill <validate|render> <pipeline.yaml> [options]

Validate a model-executed skill pipeline, or print its deterministic instructions.

Options:
  --config PATH          Project TOML config (overrides machine fields)
  --machine-config PATH  Machine TOML defaults
  --registry PATH        Installed skill registry YAML/JSON; repeatable
  --skill-root DIR       Read immediate */SKILL.md frontmatter names; repeatable
  --help, -h             Show this help

Examples:
  playbill validate flow.yaml --config config.toml --skill-root ./skills
  playbill render flow.yaml --config config.toml --registry registry.yaml

Registry: {version: 1, skills: [{id: custom-review, path: ./skills/review/SKILL.md}]}
Registry paths are relative to that file. Config bindings are never a registry.
No automatic file discovery or workflow execution occurs in this command.
Exit statuses: 0 success/help; 1 invalid data or unavailable files; 2 CLI usage.
`;

function argumentsFromProcess() {
  return parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      config: { type: 'string' },
      'machine-config': { type: 'string' },
      registry: { type: 'string', multiple: true },
      'skill-root': { type: 'string', multiple: true },
    },
  });
}

function main(): void {
  let args: ReturnType<typeof argumentsFromProcess>;
  try {
    args = argumentsFromProcess();
  } catch (error) {
    process.stderr.write(
      `playbill: ${errorMessage(error)}\nRun playbill --help for usage.\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (args.values.help) {
    process.stdout.write(help);
    return;
  }
  const [command, path, ...extra] = args.positionals;
  if (
    (command !== 'validate' && command !== 'render') ||
    !path ||
    extra.length
  ) {
    process.stderr.write(help);
    process.exitCode = 2;
    return;
  }
  try {
    const configFile = args.values.config;
    const machineFile = args.values['machine-config'];
    if (configFile !== undefined && typeof configFile !== 'string')
      fail('CLI', 'config', 'Expected one config path.');
    if (machineFile !== undefined && typeof machineFile !== 'string')
      fail('CLI', 'machine-config', 'Expected one config path.');
    const config = mergeConfig(
      machineFile ? parseConfig(readText(machineFile), machineFile) : {},
      configFile ? parseConfig(readText(configFile), configFile) : {},
    );
    const registryPaths = args.values.registry;
    const roots = args.values['skill-root'];
    const registry = [
      ...(Array.isArray(registryPaths)
        ? registryPaths.flatMap(loadRegistry)
        : []),
      ...(Array.isArray(roots) ? roots.flatMap(discoverSkills) : []),
    ];
    const validated = validatePipeline(
      parsePipeline(readText(path), path),
      config,
      registry,
    );
    process.stdout.write(
      command === 'render'
        ? renderPipeline(validated)
        : `Valid: ${validated.pipeline.id}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof PlaybillError ? error.message : `playbill: ${errorMessage(error)}`}\n`,
    );
    process.exitCode = 1;
  }
}

main();
