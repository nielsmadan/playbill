import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';
import { taskChecks } from './verify.mjs';
import { verifyHostSmoke } from './verify-hosts.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const host = process.argv[2];
assert.ok(
  ['codex', 'pi', 'opencode'].includes(host),
  'Usage: node scripts/smoke/hosts.mjs codex|pi|opencode [--prepare-only]',
);
const fixture = join(root, `.test-runs-${host}-smoke-${Date.now()}`);
const write = (path, content) => {
  const file = join(fixture, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const json = (path, value) =>
  write(path, JSON.stringify(value, null, 2) + '\n');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const skillName = 'playbill-smoke-implement';
const skillRelative = `${host === 'codex' ? '.agents' : host === 'pi' ? '.pi' : '.opencode'}/skills/${skillName}/SKILL.md`;
const skillPath = join(fixture, skillRelative);
write(
  'TASK.md',
  'Implement export function sumEvenSquares(values) in solution.mjs. Sum the squares of even integers; ignore other values. Return 0 for an empty array and throw TypeError for a non-array. Preserve the input. Run node --test test.mjs.\n',
);
write(
  'solution.mjs',
  'export function sumEvenSquares() { throw new Error("TODO"); }\n',
);
write('test.mjs', taskChecks);
write('original-test.mjs', taskChecks);
write(
  skillRelative,
  `---\nname: ${skillName}\ndescription: Implements the isolated Playbill adapter smoke task when selected by its workflow.\n---\nImplement TASK.md in solution.mjs. Run node --test test.mjs and correct failures. Write receipt.md containing exactly \`skill-receipt: pb-m3-native-seam\` on its first line, then the test outcome.\n`,
);
write(
  '.playbill/config.toml',
  `[slots]\nimplement="${skillName}"\n[workflows.smoke]\nentry="explicit"\n`,
);
write(
  '.playbill/pipelines/smoke.yaml',
  JSON.stringify({
    version: 1,
    id: 'smoke',
    title: 'Playbill M3 installation seam',
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
const environment = {
  PLAYBILL_PROJECT_ROOT: fixture,
  PLAYBILL_MACHINE_DIR: join(fixture, 'machine'),
  PLAYBILL_DEFAULTS_DIR: join(fixture, 'defaults'),
  PLAYBILL_STATE_DIR: join(fixture, 'state'),
  PLAYBILL_NODE: process.execPath,
};
const prompt =
  '[playbill:smoke] Implement TASK.md. Work only in this task directory. Use Node builtins. Preserve the original test files. Do not dispatch agents, install dependencies, or use git.';
const args = [];

async function codexHooks(overrides) {
  return await new Promise((done, reject) => {
    const child = spawn('codex', [...overrides, '-C', fixture, 'app-server'], {
      cwd: fixture,
      env: { ...process.env, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let bytes = 0;
    let finished = false;
    const stop = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else done(value);
    };
    const timer = setTimeout(
      () => stop(new Error('hooks/list preflight timeout')),
      10000,
    );
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', (error) => stop(error));
    child.stdin.on('error', (error) => stop(error));
    child.on('exit', (code) => stop(new Error(`Preflight exited ${code}`)));
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2097152) stop(new Error('Preflight output limit'));
    });
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      buffer += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2097152) return stop(new Error('Preflight output limit'));
      let end;
      while (!finished && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.error) throw new Error(JSON.stringify(message.error));
          if (message.id === 1) {
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'hooks/list', params: { cwds: [fixture] } });
          }
          if (message.id === 2) stop(undefined, message.result);
        } catch (error) {
          stop(error);
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'playbill-smoke-preflight', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

if (host === 'codex') {
  environment.PLAYBILL_CODEX_INVENTORY = join(fixture, 'native-inventory.json');
  json('native-inventory.json', {
    version: 1,
    skills: [{ id: skillName, path: skillPath, invocation: skillName }],
  });
  write(
    'observe-hook.mjs',
    `import {readFileSync,appendFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; const input=readFileSync(0); const result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(join(root, 'adapters/codex/hook.mjs'))}],{input,encoding:'utf8',timeout:12000,maxBuffer:524288}); appendFileSync(${JSON.stringify(join(fixture, 'hook-output.jsonl'))},JSON.stringify({input:JSON.parse(input),stdout:result.stdout,status:result.status})+'\\n'); process.stdout.write(result.stdout??''); process.stderr.write(result.stderr??''); process.exit(result.status??1);\n`,
  );
  const command = `${shellQuote(process.execPath)} ${shellQuote(join(fixture, 'observe-hook.mjs'))}`;
  const hooks = JSON.parse(
    readFileSync(join(root, 'adapters/codex/hooks.json'), 'utf8'),
  );
  for (const group of Object.values(hooks.hooks))
    group[0].hooks[0].command = command;
  json('.codex/hooks.json', hooks);
  write('.codex/config.toml', '[features]\nhooks=true\n');
  const base = [
    '-c',
    'features.hooks=true',
    '-c',
    `projects={${JSON.stringify(fixture)}={trust_level="trusted"}}`,
  ];
  const preflight = await codexHooks(base);
  const entry = preflight.data.find((entry) => entry.cwd === fixture);
  assert.deepEqual(entry.errors, []);
  const own = entry.hooks.filter(
    (hook) => hook.sourcePath === join(fixture, '.codex/hooks.json'),
  );
  assert.equal(own.length, 2);
  json('hooks-before-trust.json', { ...entry, hooks: own });
  const trust = `hooks.state={${own.map((hook) => `${JSON.stringify(hook.key)}={trusted_hash=${JSON.stringify(hook.currentHash)}}`).join(',')}}`;
  const trusted = await codexHooks([...base, '-c', trust]);
  const checked = trusted.data.find((entry) => entry.cwd === fixture);
  json('hooks-trusted.json', {
    ...checked,
    hooks: checked.hooks.filter((hook) =>
      own.some((original) => original.key === hook.key),
    ),
  });
  for (const hook of checked.hooks.filter((hook) =>
    own.some((original) => original.key === hook.key),
  ))
    assert.equal(hook.trustStatus, 'trusted');
  args.push(
    'exec',
    '--json',
    '--ephemeral',
    '-C',
    fixture,
    '--skip-git-repo-check',
    '-s',
    'danger-full-access',
    '-c',
    'approval_policy="never"',
    '-c',
    'features.multi_agent=false',
    '-c',
    'model_reasoning_effort="low"',
    '-m',
    'gpt-5.6-sol',
    ...base,
    '-c',
    trust,
    prompt,
  );
} else if (host === 'pi') {
  write(
    'observe-context.ts',
    `import {appendFileSync} from 'node:fs'; export default function(pi){pi.on('context',event=>{appendFileSync(${JSON.stringify(join(fixture, 'context.jsonl'))},JSON.stringify(event.messages.filter(m=>m.role==='custom'&&m.customType==='playbill:workflow'))+'\\n');}); pi.on('turn_start',(event,ctx)=>{if(event.turnIndex>=12)ctx.abort();});}\n`,
  );
  args.push(
    '-p',
    '--mode',
    'json',
    '--no-session',
    '--no-extensions',
    '-e',
    join(root, 'adapters/pi/playbill.ts'),
    '-e',
    join(fixture, 'observe-context.ts'),
    '--no-skills',
    '--skill',
    dirname(skillPath),
    '--no-context-files',
    '--no-prompt-templates',
    '--no-themes',
    '--approve',
    '--model',
    'openai-codex/gpt-5.6-sol',
    '--thinking',
    'low',
    prompt,
  );
} else {
  write(
    '.opencode/plugins/playbill.js',
    `import {PlaybillPlugin} from ${JSON.stringify(join(root, 'adapters/opencode/playbill.js'))}; import {appendFileSync} from 'node:fs'; export const ObservedPlaybill=async(input)=>{const hooks=await PlaybillPlugin(input); const transform=hooks['experimental.chat.messages.transform']; return {...hooks,'experimental.chat.messages.transform':async(i,o)=>{await transform(i,o); appendFileSync(${JSON.stringify(join(fixture, 'context.jsonl'))},JSON.stringify(o.messages.flatMap(m=>m.parts).filter(p=>p.metadata?.playbill==='workflow-v1'))+'\\n');}};};\n`,
  );
  args.push('run', '--dir', fixture, '--format', 'json', prompt);
}
const metadata = {
  host,
  fixture,
  executable: host,
  args,
  environment,
  timeoutMs: 120000,
  maxOutputBytes: 2097152,
  maxStderrBytes: 262144,
  turnLimit: host === 'pi' ? 12 : null,
  budgetUSD: null,
  testSha256: hash(taskChecks),
  originalTest: taskChecks,
  adapterSha256: hash(readFileSync(join(root, `dist/${host}.js`))),
  inventoryMode:
    host === 'codex'
      ? 'explicit attested snapshot; native .agents/skills registration'
      : host === 'pi'
        ? 'native before_agent_start Skill[]'
        : 'native command/file corroboration',
  harnessVersion:
    host === 'opencode'
      ? '1.18.29 (previously observed; startup blocked)'
      : spawnSync(host, ['--version'], {
          encoding: 'utf8',
          timeout: 5000,
        }).stdout.trim(),
};
json('command.json', metadata);
if (process.argv.includes('--prepare-only')) {
  process.stdout.write(
    JSON.stringify({ fixture, prepared: true, host }) + '\n',
  );
  process.exit(0);
}
const started = Date.now();
const child = spawn(host, args, {
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
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  killTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }, 2000);
};
const timer = setTimeout(() => stop('timeout'), 120000);
child.stdout.setEncoding('utf8').on('data', (chunk) => {
  if (reason) return;
  const available = 2097152 - Buffer.byteLength(stdout);
  const bytes = Buffer.from(chunk);
  stdout += bytes.subarray(0, Math.max(0, available - 3)).toString('utf8');
  if (bytes.length > available - 3) stop('stdout limit');
});
child.stderr.setEncoding('utf8').on('data', (chunk) => {
  if (reason) return;
  const available = 262144 - Buffer.byteLength(stderr);
  const bytes = Buffer.from(chunk);
  stderr += bytes.subarray(0, Math.max(0, available - 3)).toString('utf8');
  if (bytes.length > available - 3) stop('stderr limit');
});
const exit = await new Promise((done) => {
  child.on('error', (error) => done({ error: error.message }));
  child.on('close', (code, signal) => done({ code, signal }));
});
clearTimeout(timer);
clearTimeout(killTimer);
const sanitized = (text) =>
  text.replace(
    /\b(sk-(?:proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})/gu,
    '[REDACTED]',
  );
write('stdout.jsonl', sanitized(stdout));
write('stderr.txt', sanitized(stderr));
const events = stdout.split('\n').flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
const verified = verifyHostSmoke(host, fixture, events);
const assistant = events
  .filter(
    (event) =>
      event.type === 'message_end' && event.message?.role === 'assistant',
  )
  .map((event) => event.message);
const usage =
  host === 'codex'
    ? events.findLast((event) => event.type === 'turn.completed')?.usage
    : assistant.map((message) => message.usage);
const costUSD =
  host === 'pi'
    ? assistant.reduce(
        (sum, message) => sum + (message.usage?.cost?.total ?? 0),
        0,
      )
    : null;
const summary = {
  ...metadata,
  exit,
  reason,
  durationMs: Date.now() - started,
  rawSha256: hash(stdout),
  usage,
  costUSD,
  verification: verified,
};
json('summary.json', summary);
process.stdout.write(
  JSON.stringify({
    fixture,
    exit,
    reason,
    durationMs: summary.durationMs,
    costUSD,
    verification: verified,
  }) + '\n',
);
assert.equal(reason, undefined);
assert.equal(exit.code, 0);
assert.equal(verified.testIntact, true);
assert.equal(verified.testStatus, 0);
assert.equal(verified.nativeActivation, true);
assert.equal(verified.mappingMatched, true);
assert.equal(verified.receiptMatched, true);
