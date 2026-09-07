import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const observationVersion = 1;
export const artifactNames = [
  'brief',
  'diagnosis',
  'work',
  'checks',
  'progress',
  'report',
];
export const observedPaths = [
  'solution.mjs',
  'test.mjs',
  'original-test.mjs',
  ...artifactNames.map((name) => `.playbill/debug/${name}.md`),
];
export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

export function snapshot(fixture) {
  return Object.fromEntries(
    observedPaths.map((path) => {
      try {
        const file = join(fixture, path);
        const stat = lstatSync(file);
        assert.ok(
          stat.isFile() && stat.size <= 32768,
          `Unbounded file: ${path}`,
        );
        assert.ok(
          realpathSync(file).startsWith(`${realpathSync(fixture)}${sep}`),
          `File outside fixture: ${path}`,
        );
        const content = readFileSync(file, 'utf8');
        return [path, { sha256: sha256(content), content }];
      } catch (error) {
        if (error.code === 'ENOENT') return [path, null];
        throw error;
      }
    }),
  );
}

export function observe(fixture, input) {
  assert.equal(resolve(input.cwd), resolve(fixture));
  assert.match(input.tool_use_id, /^[A-Za-z0-9_-]+$/u);
  assert.ok(
    ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(
      input.hook_event_name,
    ),
  );
  const observation = {
    version: observationVersion,
    event: input.hook_event_name,
    toolUseId: input.tool_use_id,
    tool: input.tool_name,
    input: input.tool_input,
    files: snapshot(fixture),
  };
  const bytes = JSON.stringify(observation) + '\n';
  const name = `${observation.event}-${observation.toolUseId}.json`;
  const directory = join(fixture, '.suite-observations');
  mkdirSync(directory, { recursive: true });
  assert.equal(
    realpathSync(directory),
    join(realpathSync(fixture), '.suite-observations'),
  );
  writeFileSync(join(directory, name), bytes, {
    flag: 'wx',
  });
  return `playbill-suite-observation-v${observationVersion} ${name} ${sha256(bytes)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(observe(process.argv[2], JSON.parse(input)));
}
