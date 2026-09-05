import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { taskChecks } from './verify.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

export function verifyHostSmoke(host, fixture, events) {
  try {
    return verify(host, fixture, events);
  } catch (error) {
    const failed = { error: String(error.message), testIntact: false };
    writeFileSync(
      join(fixture, 'verification.json'),
      JSON.stringify(failed, null, 2) + '\n',
    );
    return failed;
  }
}

function verify(host, fixture, events) {
  const skillName = 'playbill-smoke-implement';
  const skillRelative = `${host === 'codex' ? '.agents' : host === 'pi' ? '.pi' : '.opencode'}/skills/${skillName}/SKILL.md`;
  const skillPath = join(fixture, skillRelative);
  const write = (path, content) => writeFileSync(join(fixture, path), content);
  const json = (path, value) =>
    write(path, JSON.stringify(value, null, 2) + '\n');
  const testIntact =
    readFileSync(join(fixture, 'test.mjs'), 'utf8') === taskChecks &&
    readFileSync(join(fixture, 'original-test.mjs'), 'utf8') === taskChecks;
  const result = spawnSync(process.execPath, ['--test', 'test.mjs'], {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 262144,
  });
  write('independent-checks.txt', result.stdout + result.stderr);
  let activation;
  if (host === 'codex')
    activation = events.find(
      (event) =>
        event.type === 'item.completed' &&
        event.item?.type === 'command_execution' &&
        event.item.exit_code === 0 &&
        event.item.command.includes(skillRelative) &&
        /\b(cat|sed|readFileSync)\b/u.test(event.item.command) &&
        event.item.aggregated_output.includes(`name: ${skillName}`),
    );
  if (host === 'pi') {
    const start = events.find(
      (event) =>
        event.type === 'tool_execution_start' &&
        event.toolName === 'read' &&
        resolve(fixture, event.args.path) === skillPath,
    );
    if (start)
      activation = events.find(
        (event) =>
          event.type === 'tool_execution_end' &&
          event.toolCallId === start.toolCallId &&
          !event.isError &&
          JSON.stringify(event.result).includes(`name: ${skillName}`),
      );
  }
  if (host === 'opencode')
    activation = events.find(
      (event) =>
        event.type === 'tool_use' &&
        event.part?.tool === 'skill' &&
        event.part.state?.input?.name === skillName &&
        event.part.state.status === 'completed',
    );
  let injected = '';
  if (host === 'codex' && existsSync(join(fixture, 'hook-output.jsonl')))
    injected = readFileSync(join(fixture, 'hook-output.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .map((row) => JSON.parse(row.stdout).hookSpecificOutput.additionalContext)
      .join('\n');
  if (host === 'pi' && existsSync(join(fixture, 'context.jsonl')))
    injected = readFileSync(join(fixture, 'context.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .flatMap((line) => JSON.parse(line))
      .map((message) => message.content)
      .join('\n');
  if (host === 'opencode' && existsSync(join(fixture, 'context.jsonl')))
    injected = readFileSync(join(fixture, 'context.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .flatMap((line) => JSON.parse(line))
      .map((part) => part.text)
      .join('\n');
  const verified = {
    testIntact,
    testSha256: hash(readFileSync(join(fixture, 'test.mjs'))),
    testStatus: result.status,
    nativeActivation: Boolean(activation),
    activation,
    mappingMatched:
      injected.includes('Playbill M3 installation seam') &&
      (host === 'opencode'
        ? injected.includes(`name=${JSON.stringify(skillName)}`)
        : injected.includes(skillPath)),
    receiptMatched:
      existsSync(join(fixture, 'receipt.md')) &&
      /^skill-receipt: pb-m3-native-seam/u.test(
        readFileSync(join(fixture, 'receipt.md'), 'utf8'),
      ),
  };
  json('verification.json', verified);
  return verified;
}
