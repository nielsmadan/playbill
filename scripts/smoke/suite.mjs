import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';
import {
  checkHash,
  observationProtocol,
  observerSource,
  originalChecks,
  originalSolution,
  verifySuite,
} from './verify-suite.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = mkdtempSync(
  join(root, `.test-runs-suite-smoke-${Date.now()}-`),
);
const write = (file, content) => {
  const path = join(fixture, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
write('.playbill/config.toml', '');
write('solution.mjs', originalSolution);
write('test.mjs', originalChecks);
write('original-test.mjs', originalChecks);
write(observationProtocol.observer, observerSource);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const observerCommand = [
  process.execPath,
  join(fixture, observationProtocol.observer),
  fixture,
]
  .map(quote)
  .join(' ');
write(
  '.suite-settings.json',
  JSON.stringify(
    {
      hooks: Object.fromEntries(
        ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].map((event) => [
          event,
          [
            {
              hooks: [
                { type: 'command', command: observerCommand, timeout: 10 },
              ],
            },
          ],
        ]),
      ),
    },
    null,
    2,
  ),
);
const prompt =
  'Fix sumUniqueIntegers in solution.mjs. It must sum distinct safe integers from an array, ignoring all other values, returning 0 for an empty array, throwing TypeError for a non-array, and preserving the input. Duplicate integers currently inflate the result. Run node --test test.mjs as a standalone Bash command for the original regression checks; preserve test.mjs and original-test.mjs unchanged. Work only inside this task directory, including workflow artifacts. Native tool hooks observe fixture files before and after tools for later execution verification; leave .suite-observer.mjs, .suite-settings.json, .suite-observations/, command.json, and baseline.json unchanged. Do not dispatch agents, install dependencies, use Git, or change external files or global settings.';
const args = [
  '-p',
  '--plugin-dir',
  root,
  '--setting-sources',
  'project,local',
  '--settings',
  join(fixture, '.suite-settings.json'),
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
  '24',
  '--max-budget-usd',
  '2',
  prompt,
];
const environment = {
  PLAYBILL_PROJECT_ROOT: fixture,
  PLAYBILL_MACHINE_DIR: join(fixture, 'machine'),
  PLAYBILL_STATE_DIR: join(fixture, 'state'),
};
const baseline = spawnSync(process.execPath, ['--test', 'test.mjs'], {
  cwd: fixture,
  encoding: 'utf8',
  timeout: 10000,
  maxBuffer: 262144,
});
write(
  'baseline.json',
  JSON.stringify(
    {
      exitCode: baseline.status,
      stdout: baseline.stdout,
      stderr: baseline.stderr,
    },
    null,
    2,
  ),
);
write(
  'command.json',
  JSON.stringify(
    {
      executable: 'claude',
      args,
      cwd: fixture,
      environment,
      clearedEnvironment: [
        'PLAYBILL_DEFAULTS_DIR',
        'PLAYBILL_CLAUDE_INVENTORY',
      ],
      timeoutMs: 120000,
      maxOutputBytes: 2097152,
      originalCheckSha256: checkHash,
      observationProtocol,
    },
    null,
    2,
  ),
);
if (baseline.status !== 1)
  throw new Error('Expected the original regression to fail');
const env = { ...process.env, ...environment };
delete env.PLAYBILL_DEFAULTS_DIR;
delete env.PLAYBILL_CLAUDE_INVENTORY;
const started = Date.now();
const child = spawn('claude', args, {
  cwd: fixture,
  env,
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
  if (Buffer.byteLength(stdout) > 2097152) stop('output limit');
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
const sanitize = (value) =>
  value.replace(
    /\b(sk-(?:proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})/gu,
    '[REDACTED]',
  );
write('stdout.jsonl', sanitize(stdout));
write('stderr.txt', sanitize(stderr));
const verified = verifySuite(fixture);
const summary = {
  fixture,
  exit,
  reason,
  durationMs: Date.now() - started,
  passed: exit.code === 0 && reason === undefined && verified.passed,
  originalCheckSha256: checkHash,
  nativeInvocations: verified.nativeInvocations,
  result: verified.hostResult,
  verificationError: verified.error,
};
write('summary.json', sanitize(JSON.stringify(summary, null, 2)));
process.stdout.write(JSON.stringify(summary) + '\n');
if (!summary.passed) process.exitCode = 1;
