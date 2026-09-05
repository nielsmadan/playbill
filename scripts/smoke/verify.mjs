import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

export const taskChecks = `import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sumEvenSquares} from './solution.mjs';
test('mixed input', () => assert.equal(sumEvenSquares([2, 3, -4, 2.5, '6', null, Infinity]), 20));
test('empty array', () => assert.equal(sumEvenSquares([]), 0));
test('invalid input', () => assert.throws(() => sumEvenSquares('bad'), TypeError));
test('preserves input', () => { const values = Object.freeze([2, 4]); assert.equal(sumEvenSquares(values), 20); });
`;

export function verifySmoke(fixture, expectedInvocation) {
  assert.equal(readFileSync(join(fixture, 'test.mjs'), 'utf8'), taskChecks);
  const checked = spawnSync(process.execPath, ['--test', 'test.mjs'], {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 262144,
  });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /tests 4/u);
  const events = readFileSync(join(fixture, 'stdout.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const blocks = events.flatMap((event) => event.message?.content ?? []);
  const invocation = blocks.find(
    (block) =>
      block.type === 'tool_use' &&
      block.name === 'Skill' &&
      block.input.skill === expectedInvocation,
  );
  assert.ok(invocation, `Expected Skill invocation ${expectedInvocation}`);
  const response = blocks.find(
    (block) =>
      block.type === 'tool_result' && block.tool_use_id === invocation.id,
  );
  assert.ok(response && response.is_error !== true);
  assert.match(String(response.content), /Launching skill:/u);
  assert.match(
    readFileSync(join(fixture, 'receipt.md'), 'utf8'),
    /^skill-receipt: pb-m2-native-seam/u,
  );
  const hook = events.find(
    (event) =>
      event.subtype === 'hook_response' &&
      event.hook_event === 'UserPromptSubmit',
  );
  assert.equal(hook?.exit_code, 0);
  const injection = JSON.parse(hook.stdout).hookSpecificOutput
    .additionalContext;
  assert.match(injection, /Playbill M2 installation seam/u);
  return {
    testSha256: createHash('sha256').update(taskChecks).digest('hex'),
    testStatus: checked.status,
    testOutput: checked.stdout,
    nativeInvocation: expectedInvocation,
    nativeToolResult: response.content,
    mappingMatched: injection.includes(
      `skill=${JSON.stringify(expectedInvocation)}`,
    ),
  };
}
