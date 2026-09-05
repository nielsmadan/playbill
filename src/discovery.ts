import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { mergeConfig, parseConfig, validateConfig } from './config.js';
import { errorMessage, fail } from './diagnostics.js';
import { readText } from './parsing.js';
import { parsePipeline } from './pipeline.js';
import type { Config, Pipeline } from './types.js';

export interface DiscoveryOptions {
  projectRoot?: string;
  machineDir?: string;
  defaultsDir?: string;
}

export function optionalPath(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    fail('READ', path, errorMessage(error));
  }
}

export function absoluteDirectory(path: string): string {
  if (!isAbsolute(path)) fail('PATH', path, 'Expected an absolute directory.');
  try {
    if (!statSync(path).isDirectory())
      fail('PATH', path, 'Expected a directory.');
    return realpathSync(path);
  } catch (error) {
    fail('PATH', path, errorMessage(error));
  }
}

export function gitOutput(cwd: string, args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 262_144,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  });
  if (result.error) fail('GIT', cwd, errorMessage(result.error));
  if (result.status === 0) return result.stdout;
  if (result.stderr.includes('not a git repository')) return undefined;
  fail('GIT', cwd, result.stderr.trim() || `git exited ${result.status}`);
}

export function projectRoot(cwd: string, override?: string): string {
  const current = absoluteDirectory(cwd);
  if (override !== undefined) {
    const root = absoluteDirectory(override);
    const rel = relative(root, current);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      fail('PROJECT_ROOT', root, 'Project override must contain the hook cwd.');
    return root;
  }
  const git = gitOutput(current, ['rev-parse', '--show-toplevel']);
  if (git) return absoluteDirectory(git.trim());
  let candidate = current;
  for (;;) {
    if (optionalPath(join(candidate, '.playbill'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return current;
    candidate = parent;
  }
}

export function discoveryFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DiscoveryOptions {
  const result: DiscoveryOptions = {};
  if (env.PLAYBILL_PROJECT_ROOT !== undefined)
    result.projectRoot = env.PLAYBILL_PROJECT_ROOT;
  result.machineDir =
    env.PLAYBILL_MACHINE_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'playbill');
  if (env.PLAYBILL_DEFAULTS_DIR !== undefined)
    result.defaultsDir = env.PLAYBILL_DEFAULTS_DIR;
  return result;
}

export function discoverConfiguration(
  cwd: string,
  options: DiscoveryOptions = {},
): { root: string; config: Config; pipelines: Map<string, Pipeline> } {
  const root = projectRoot(cwd, options.projectRoot);
  const layers = [
    options.defaultsDir,
    options.machineDir ?? join(homedir(), '.config/playbill'),
    join(root, '.playbill'),
  ].filter((path): path is string => path !== undefined);
  let config = validateConfig({});
  const pipelines = new Map<string, Pipeline>();
  for (const layer of layers) {
    if (!isAbsolute(layer))
      fail('PATH', layer, 'Use an absolute layer directory.');
    const path = join(layer, 'config.toml');
    if (optionalPath(path))
      config = mergeConfig(config, parseConfig(readText(path), path));
    const directory = join(layer, 'pipelines');
    if (!optionalPath(directory)) continue;
    const files = readdirSync(directory).sort();
    if (files.length > 128)
      fail('LIMIT', directory, 'At most 128 pipeline files per layer.');
    const seen = new Set<string>();
    for (const file of files) {
      if (!/\.ya?ml$/u.test(file)) continue;
      const path = join(directory, file);
      const pipeline = parsePipeline(readText(path), path);
      if (seen.has(pipeline.id))
        fail(
          'AMBIGUOUS_PIPELINE',
          path,
          `Duplicate pipeline '${pipeline.id}' in this layer.`,
        );
      seen.add(pipeline.id);
      pipelines.set(pipeline.id, pipeline);
    }
  }
  return { root, config, pipelines };
}
