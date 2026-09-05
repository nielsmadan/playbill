import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { taskChecks, verifySmoke } from './verify.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = join(root, `.test-runs-claude-smoke-${Date.now()}`);
const write = (file, content) => {
  const path = join(fixture, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
write(
  'TASK.md',
  'Implement export function sumEvenSquares(values) in solution.mjs. Sum the squares of even integers in the input array; ignore all other values. Return 0 for an empty array and throw TypeError for a non-array. Preserve the input. Run node --test test.mjs.\n',
);
write(
  'solution.mjs',
  'export function sumEvenSquares() { throw new Error("TODO"); }\n',
);
write('test.mjs', taskChecks);
write(
  '.claude/skills/playbill-smoke-implement/SKILL.md',
  '---\nname: playbill-smoke-implement\ndescription: Implements the isolated Playbill adapter smoke task when selected by a workflow.\n---\nImplement TASK.md in solution.mjs. Run node --test test.mjs and correct failures. Write receipt.md containing exactly `skill-receipt: pb-m2-native-seam` on its first line, then the test outcome.\n',
);
write(
  '.playbill/config.toml',
  '[slots]\nimplement = "smoke-implementation"\n[workflows.smoke]\nentry = "explicit"\n',
);
write(
  '.playbill/pipelines/smoke.yaml',
  JSON.stringify({
    version: 1,
    id: 'smoke',
    title: 'Playbill M2 installation seam',
    artifacts: [
      { id: 'task', path: 'TASK.md' },
      { id: 'solution', path: 'solution.mjs' },
      { id: 'receipt', path: 'receipt.md' },
    ],
    inputs: ['task'],
    outputs: ['solution', 'receipt'],
    steps: [
      {
        type: 'step',
        id: 'implementation',
        title: 'Implement and verify',
        skill: '{{implement}}',
        consumes: ['task'],
        produces: ['solution', 'receipt'],
      },
    ],
  }),
);
write(
  'native-inventory.json',
  JSON.stringify({
    version: 1,
    skills: [
      {
        id: 'smoke-implementation',
        path: '.claude/skills/playbill-smoke-implement/SKILL.md',
        invocation: 'playbill-smoke-implement',
      },
    ],
  }),
);
const prompt =
  '[playbill:smoke] Implement TASK.md. Work only in this task directory. Use Node builtins. Do not dispatch agents, install dependencies, or use git.';
const args = [
  '-p',
  '--plugin-dir',
  root,
  '--setting-sources',
  'project,local',
  '--strict-mcp-config',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-hook-events',
  '--no-session-persistence',
  '--permission-mode',
  'dontAsk',
  '--allowedTools',
  'Read,Write,Edit,Bash,Skill,Glob,Grep',
  '--effort',
  'low',
  '--max-turns',
  '12',
  '--max-budget-usd',
  '2',
  prompt,
];
const environment = {
  PLAYBILL_PROJECT_ROOT: fixture,
  PLAYBILL_MACHINE_DIR: join(fixture, 'machine'),
  PLAYBILL_DEFAULTS_DIR: join(fixture, 'defaults'),
  PLAYBILL_STATE_DIR: join(fixture, 'state'),
  PLAYBILL_CLAUDE_INVENTORY: join(fixture, 'native-inventory.json'),
};
write(
  'command.json',
  JSON.stringify(
    {
      executable: 'claude',
      args,
      cwd: fixture,
      environment,
      timeoutMs: 120000,
      maxOutputBytes: 2_097_152,
      testSha256: createHash('sha256').update(taskChecks).digest('hex'),
    },
    null,
    2,
  ),
);
const started = Date.now();
const child = spawn('claude', args, {
  cwd: fixture,
  env: { ...process.env, ...environment },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
let reason;
let killTimer;
const stop = (why) => {
  if (reason) return;
  reason = why;
  process.kill(-child.pid, 'SIGTERM');
  killTimer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 2000);
};
const timer = setTimeout(() => stop('timeout'), 120000);
child.stdout.setEncoding('utf8').on('data', (data) => {
  stdout += data;
  if (Buffer.byteLength(stdout) > 2_097_152) stop('output limit');
});
child.stderr.setEncoding('utf8').on('data', (data) => {
  stderr += data;
  if (Buffer.byteLength(stderr) > 262144) stop('stderr limit');
});
const exit = await new Promise((done) => {
  child.on('error', (error) => done({ error: error.message }));
  child.on('close', (code, signal) => done({ code, signal }));
});
clearTimeout(timer);
clearTimeout(killTimer);
const sanitized = (value) =>
  value.replace(
    /\b(sk-(?:proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})/gu,
    '[REDACTED]',
  );
write('stdout.jsonl', sanitized(stdout));
write('stderr.txt', sanitized(stderr));
const events = stdout
  .trim()
  .split('\n')
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const toolUses = events
  .flatMap((event) => event.message?.content ?? [])
  .filter((block) => block.type === 'tool_use');
const summary = {
  fixture,
  exit,
  reason,
  durationMs: Date.now() - started,
  result: events.findLast((event) => event.type === 'result'),
  skills: toolUses
    .filter((tool) => tool.name === 'Skill')
    .map((tool) => tool.input),
  hooks: events.filter((event) => event.subtype?.startsWith('hook_')),
  toolNames: toolUses.map((tool) => tool.name),
};
write('summary.json', sanitized(JSON.stringify(summary, null, 2)));
process.stdout.write(
  JSON.stringify({
    fixture,
    exit,
    reason,
    durationMs: summary.durationMs,
    skills: summary.skills,
    toolNames: summary.toolNames,
    result: summary.result?.subtype,
  }) + '\n',
);
assert.equal(reason, undefined);
assert.equal(exit.code, 0);
assert.equal(summary.result?.is_error, false);
const verified = verifySmoke(fixture, 'playbill-smoke-implement');
write('verification.json', JSON.stringify(verified, null, 2));
assert.equal(verified.mappingMatched, true);
process.stdout.write(JSON.stringify(verified) + '\n');
