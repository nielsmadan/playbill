import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

const temporary = mkdtempSync(
  join(process.cwd(), '.test-runs-coordinator-tests-'),
);
after(() => rmSync(temporary, { recursive: true, force: true }));
const cliPath = fileURLToPath(
  new URL('../scripts/coordinator/cli.mjs', import.meta.url),
);
const hookPath = fileURLToPath(
  new URL('../scripts/coordinator/hook.mjs', import.meta.url),
);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const write = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const success = (result) => {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const reject = (result, message) => {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, message);
};
const node = (id, next = null, extra = {}) => ({
  id,
  title: `Stage ${id}`,
  skill: `playbill:${id}`,
  instruction: `Perform ${id}.`,
  consumes: [],
  produces: [`${id}.md`],
  allowSourceWrites: false,
  next,
  ...extra,
});

function fixture(options = {}) {
  const root = mkdtempSync(join(temporary, 'case-'));
  write(join(root, 'source.txt'), 'bad');
  const runner =
    options.runner ??
    `const fs=require('node:fs'); const source=fs.readFileSync('source.txt','utf8'); fs.mkdirSync('.replay',{recursive:true}); fs.writeFileSync('.replay/result.json', JSON.stringify({source, pass:source==='good'})); console.log('all results: '+source); console.error('diagnostic'); process.exitCode=source==='good'?0:1;`;
  write(join(root, '.replay/test.cjs'), runner);
  const configPath = join(root, '.playbill/coordinator/config.json');
  const config = {
    version: 1,
    root,
    runId: 'public-boundary-test',
    entry: 'capture',
    steps: [
      node('capture', 'verify'),
      node(
        'verify',
        { pass: 'report', fail: 'fix' },
        { check: 'original', consumes: ['capture.md'] },
      ),
      node('fix', 'verify', { allowSourceWrites: true }),
      node('report'),
    ],
    maxTransitions: 8,
    maxStopBlocks: 2,
    checks: {
      original: {
        executable: process.execPath,
        args: ['.replay/test.cjs'],
        resultFiles: ['.replay/result.json'],
        timeoutMs: 1000,
        maxBufferBytes: 65536,
      },
    },
    sourcePaths: ['source.txt'],
    verificationHashes: { '.replay/test.cjs': sha(runner) },
    ...options.config,
  };
  write(configPath, JSON.stringify(config));
  let receipt = 0;
  const cli = (command, argument, overrides = {}) =>
    spawnSync(
      process.execPath,
      [
        cliPath,
        configPath,
        command,
        ...(argument === undefined ? [] : [argument]),
      ],
      { cwd: root, encoding: 'utf8', timeout: 10000, ...overrides },
    );
  const hook = (hook_event_name, extra = {}, overrides = {}) =>
    spawnSync(process.execPath, [hookPath, configPath], {
      cwd: root,
      input: JSON.stringify({
        hook_event_name,
        session_id: 'session-one',
        cwd: root,
        ...extra,
      }),
      encoding: 'utf8',
      timeout: 10000,
      ...overrides,
    });
  const activate = (skill, response = { success: true }) => {
    const event = {
      tool_name: 'Skill',
      tool_use_id: `skill-${++receipt}`,
      tool_input: { skill },
    };
    const pre = success(hook('PreToolUse', event));
    assert.notEqual(
      pre.hookSpecificOutput?.permissionDecision,
      'deny',
      JSON.stringify(pre),
    );
    return hook('PostToolUse', { ...event, tool_response: response });
  };
  const state = () =>
    json(join(root, '.playbill/coordinator/runtime/state.json'));
  const events = () =>
    readFileSync(
      join(root, '.playbill/coordinator/runtime/events.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map(JSON.parse);
  const produce = (name, content = `fresh ${++receipt}`) =>
    write(join(root, name), content);
  const start = () => success(hook('SessionStart', { source: 'startup' }));
  const finish = (skill, name, token) => {
    success(activate(skill));
    produce(name);
    return success(cli('complete', token));
  };
  return {
    root,
    config,
    configPath,
    cli,
    hook,
    activate,
    state,
    events,
    produce,
    start,
    finish,
  };
}

test('entry, successful native receipt, fresh outputs and exact token control public progression', () => {
  const f = fixture();
  assert.deepEqual(f.start(), {});
  assert.equal(f.state().visit.activation, null);
  assert.match(
    success(
      f.hook('UserPromptSubmit', { prompt: 'Fix the requested behavior.' }),
    ).hookSpecificOutput.additionalContext,
    /current visit v1/u,
  );
  reject(
    f.cli('complete', 'v1'),
    /Missing successful native Skill activation/u,
  );
  const wrong = success(
    f.hook('PreToolUse', {
      tool_name: 'Skill',
      tool_use_id: 'wrong',
      tool_input: { skill: 'playbill:fix' },
    }),
  );
  assert.equal(wrong.hookSpecificOutput.permissionDecision, 'deny');
  success(f.activate('playbill:capture'));
  reject(f.cli('complete', 'v1'), /Missing or stale produced artifact/u);
  f.produce('capture.md', 'Captured actual request');
  const next = success(f.cli('complete', 'v1'));
  assert.equal(next.state.visit.id, 'v2');
  assert.equal(next.state.visit.nodeId, 'verify');
  assert.match(next.context, /current visit v2, Stage verify/u);
  assert.match(next.context, /Technique: playbill:verify/u);
  assert.match(
    next.context,
    /Continue the authorized workflow through the returned visits until the coordinator is done or paused\./u,
  );
  assert.match(next.context, /Complete this exact visit: .* complete v2\./u);
  reject(f.cli('complete', 'v1'), /Stale visit token/u);
  assert.equal(f.state().history.length, 1);
  const artifact = json(join(f.root, f.state().history[0].artifacts.path));
  assert.equal(
    Buffer.from(artifact['capture.md'].base64, 'base64').toString(),
    'Captured actual request',
  );
  f.produce('capture.md', 'later overwrite');
  assert.equal(
    json(join(f.root, f.state().history[0].artifacts.path))['capture.md']
      .sha256,
    sha('Captured actual request'),
  );
});

test('failed, pre-only, orphan and wrong-visit Skill receipts cannot activate a visit', () => {
  const f = fixture();
  f.start();
  const event = {
    tool_name: 'Skill',
    tool_use_id: 'pre-only',
    tool_input: { skill: 'playbill:capture' },
  };
  success(f.hook('PreToolUse', event));
  f.produce('capture.md');
  reject(f.cli('complete', 'v1'), /Missing successful native Skill/u);
  success(f.hook('PostToolUseFailure', { ...event, error: 'Skill failed' }));
  assert.equal(f.state().visit.activation, null);
  success(f.activate('playbill:capture', { is_error: true }));
  assert.equal(f.state().visit.activation, null);
  reject(
    f.hook('PostToolUse', {
      ...event,
      tool_use_id: 'orphan',
      tool_response: { success: true },
    }),
    /Missing or mismatched native Skill receipt/u,
  );
  success(f.activate('playbill:capture'));
  f.produce('capture.md', 'written after successful activation');
  success(f.cli('complete', 'v1'));
  reject(
    f.hook('PostToolUse', { ...event, tool_response: { success: true } }),
    /Missing or mismatched native Skill receipt/u,
  );
  assert.equal(f.state().visit.activation, null);
});

test('configuration, root, session, malformed state and interrupted journal mismatches fail without reset', () => {
  const f = fixture();
  f.start();
  reject(
    f.hook('SessionStart', {
      session_id: 'different-session',
      source: 'resume',
    }),
    /Native session mismatch/u,
  );
  reject(
    f.cli('status', undefined, {
      env: {
        ...process.env,
        PLAYBILL_COORDINATOR_SESSION_ID: 'different-session',
      },
    }),
    /Native session mismatch/u,
  );
  reject(
    f.hook('SessionStart', { cwd: temporary }),
    /Native cwd\/root mismatch/u,
  );
  reject(
    f.cli('status', undefined, { cwd: temporary }),
    /CLI cwd\/root mismatch/u,
  );
  const originalConfig = readFileSync(f.configPath);
  write(f.configPath, originalConfig.toString() + '\n');
  reject(f.cli('status'), /State\/config\/root mismatch/u);
  write(f.configPath, originalConfig);
  const statePath = join(f.root, '.playbill/coordinator/runtime/state.json');
  const originalState = readFileSync(statePath);
  write(
    statePath,
    JSON.stringify({ ...JSON.parse(originalState), nextVisit: 99 }),
  );
  reject(f.cli('status'), /Malformed state history/u);
  write(statePath, originalState);
  write(join(f.root, '.playbill/coordinator/runtime/events.jsonl'), '');
  reject(f.cli('status'), /JSON|journal/u);
  assert.equal(f.state().sessionId, 'session-one');
});

test('ordinary check failure routes to correction; rerun visits require fresh receipt and artifacts', () => {
  const f = fixture();
  f.start();
  f.finish('playbill:capture', 'capture.md', 'v1');
  success(f.activate('playbill:verify'));
  f.produce('verify.md', 'baseline recorded');
  const failed = success(f.cli('check'));
  assert.equal(failed.check.outcome, 'fail');
  assert.equal(failed.check.exitCode, 1);
  assert.equal(failed.check.stdout, 'all results: bad\n');
  assert.equal(failed.check.stderr, 'diagnostic\n');
  const firstCheckPath = failed.check.evidencePath;
  const baselineResult = json(join(f.root, firstCheckPath)).resultFiles[
    '.replay/result.json'
  ];
  assert.equal(success(f.cli('complete', 'v2')).state.visit.nodeId, 'fix');
  success(f.activate('playbill:fix'));
  f.produce('source.txt', 'good');
  f.produce('fix.md');
  assert.equal(success(f.cli('complete', 'v3')).state.visit.id, 'v4');
  reject(f.cli('complete', 'v4'), /Missing successful native Skill/u);
  success(f.activate('playbill:verify'));
  reject(f.cli('complete', 'v4'), /Missing or stale produced artifact/u);
  f.produce('verify.md', 'repair verified');
  reject(f.cli('complete', 'v4'), /Missing configured check/u);
  const passed = success(f.cli('check'));
  assert.equal(passed.check.outcome, 'pass');
  assert.equal(
    json(join(f.root, passed.check.evidencePath)).before['source.txt'],
    sha('good'),
  );
  assert.equal(
    json(join(f.root, firstCheckPath)).resultFiles['.replay/result.json']
      .sha256,
    baselineResult.sha256,
  );
  assert.equal(success(f.cli('complete', 'v4')).state.visit.nodeId, 'report');
  const done = f.finish('playbill:report', 'report.md', 'v5');
  assert.equal(done.state.status, 'done');
  assert.equal(success(f.cli('status')).state.completed, 5);
  assert.deepEqual(success(f.hook('Stop')), {});
  assert.equal(f.events().at(-1).blocked, false);
  reject(f.cli('complete', 'v5'), /Coordinator is done/u);
});

test('linear reproduction accepts a captured test failure and optional checks retain evidence', () => {
  const f = fixture({
    config: {
      steps: [
        node('capture', 'fix', { check: 'original' }),
        node('fix', null, { allowSourceWrites: true }),
      ],
    },
  });
  f.start();
  success(f.activate('playbill:capture'));
  f.produce('capture.md');
  assert.equal(success(f.cli('check')).check.outcome, 'fail');
  success(f.cli('complete', 'v1'));
  success(f.activate('playbill:fix'));
  assert.equal(success(f.cli('check', 'original')).check.outcome, 'fail');
  f.produce('fix.md');
  assert.equal(success(f.cli('complete', 'v2')).state.status, 'done');
});

test('source changes stale check evidence even when a previous run passed', () => {
  const f = fixture({
    config: {
      steps: [
        node('capture', null, { check: 'original', allowSourceWrites: true }),
      ],
    },
  });
  f.start();
  success(f.activate('playbill:capture'));
  f.produce('source.txt', 'good');
  f.produce('capture.md');
  success(f.cli('check'));
  f.produce('source.txt', 'another source revision');
  reject(f.cli('complete', 'v1'), /Stale check/u);
  assert.equal(f.state().history.length, 0);
});

test('immutable inputs reject edits and runtime detects an unguarded changed input', () => {
  const f = fixture();
  f.start();
  const denied = success(
    f.hook('PreToolUse', {
      tool_name: 'Edit',
      tool_use_id: 'protected',
      tool_input: { file_path: join(f.root, '.replay/test.cjs') },
    }),
  );
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  f.produce('.replay/test.cjs', 'changed verification');
  reject(f.hook('Stop'), /Immutable verification input changed/u);
  assert.equal(
    f.events().find((event) => event.violation === 'verification-input-changed')
      .actual['.replay/test.cjs'],
    sha('changed verification'),
  );
});

for (const [label, runner, check, expected] of [
  ['timeout', 'setTimeout(()=>{},3000);', { timeoutMs: 40 }, /ETIMEDOUT/u],
  [
    'spawn failure',
    '',
    { executable: 'coordinator-nonexistent-test-executable' },
    /ENOENT/u,
  ],
  [
    'output limit',
    "process.stdout.write('x'.repeat(100000));",
    { maxBufferBytes: 128 },
    /ENOBUFS/u,
  ],
  [
    'missing result',
    "console.log('no result');",
    {},
    /infrastructure-failure/u,
  ],
])
  test(`check ${label} is infrastructure failure with retained raw outcome`, () => {
    const f = fixture({ runner });
    Object.assign(f.config.checks.original, check);
    f.config.steps = [node('capture', null, { check: 'original' })];
    write(f.configPath, JSON.stringify(f.config));
    f.start();
    success(f.activate('playbill:capture'));
    f.produce('capture.md');
    const result = f.cli('check');
    assert.equal(result.status, 2, result.stderr);
    const captured = JSON.parse(result.stdout);
    assert.equal(captured.check.outcome, 'infrastructure-failure');
    assert.match(JSON.stringify(captured.check), expected);
    assert.equal(
      json(join(f.root, captured.check.evidencePath)).outcome,
      'infrastructure-failure',
    );
    reject(f.cli('complete', 'v1'), /Check infrastructure failure/u);
  });

test('check preserves scratch results before reuse and refuses source mutation during execution', () => {
  const f = fixture({
    runner:
      "const fs=require('node:fs'); fs.writeFileSync('source.txt','mutated'); fs.writeFileSync('.replay/result.json','fresh result');",
  });
  f.config.steps = [node('capture', null, { check: 'original' })];
  write(f.configPath, JSON.stringify(f.config));
  f.produce('.replay/result.json', 'old evidence');
  f.start();
  success(f.activate('playbill:capture'));
  f.produce('capture.md');
  const result = f.cli('check');
  assert.equal(result.status, 2, result.stderr);
  const check = json(
    join(f.root, JSON.parse(result.stdout).check.evidencePath),
  );
  assert.equal(
    check.previousResults['.replay/result.json'].sha256,
    sha('old evidence'),
  );
  assert.equal(
    check.resultFiles['.replay/result.json'].sha256,
    sha('fresh result'),
  );
  assert.equal(check.before['source.txt'], sha('bad'));
  assert.equal(check.after['source.txt'], sha('mutated'));
  assert.equal(
    f.events().find((event) => event.kind === 'violation').kind,
    'violation',
  );
});

test('artifact freshness rejects preexisting and whitespace outputs', () => {
  const f = fixture();
  f.produce('capture.md', 'old');
  f.start();
  success(f.activate('playbill:capture'));
  reject(f.cli('complete', 'v1'), /Missing or stale/u);
  f.produce('capture.md', ' \n');
  reject(f.cli('complete', 'v1'), /Missing or stale/u);
  f.produce('capture.md', 'new evidence');
  assert.equal(success(f.cli('complete', 'v1')).state.visit.id, 'v2');
});

test('outputs staged before successful Skill activation cannot complete the visit', () => {
  const f = fixture();
  f.start();
  f.produce('capture.md', 'written before technique invocation');
  success(f.activate('playbill:capture'));
  reject(f.cli('complete', 'v1'), /Missing or stale produced artifact/u);
  f.produce('capture.md', 'written after native technique activation');
  assert.equal(success(f.cli('complete', 'v1')).state.visit.id, 'v2');
});

test('source permissions begin with native activation and exclude read-only turns', () => {
  const f = fixture({
    config: { steps: [node('capture', null, { allowSourceWrites: true })] },
  });
  f.start();
  const edit = {
    tool_name: 'Edit',
    tool_use_id: 'before-skill',
    tool_input: { file_path: 'source.txt' },
  };
  assert.equal(
    success(f.hook('PreToolUse', edit)).hookSpecificOutput.permissionDecision,
    'deny',
  );
  f.produce('source.txt', 'before activation');
  success(f.activate('playbill:capture'));
  f.produce('capture.md');
  reject(f.cli('complete', 'v1'), /recorded source-write violations/u);
  const g = fixture({
    config: { steps: [node('capture', null, { allowSourceWrites: true })] },
  });
  g.start();
  success(g.activate('playbill:capture'));
  success(g.hook('UserPromptSubmit', { prompt: 'Read-only status only.' }));
  g.produce('source.txt', 'during status');
  success(
    g.hook('PostToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'readonly-shell',
      tool_input: { command: 'mutate' },
      tool_response: { stdout: '' },
    }),
  );
  assert.equal(g.state().visit.violations[0].kind, 'early-source-write');
});

test('every CLI mutation stays blocked throughout an explicit read-only status turn', () => {
  const f = fixture();
  f.start();
  success(f.cli('pause'));
  success(f.hook('UserPromptSubmit', { prompt: 'Read-only status, please.' }));
  for (const command of ['resume', 'pause', 'check', 'complete'])
    reject(
      f.cli(command, command === 'complete' ? 'v1' : undefined),
      /Read-only status turn/u,
    );
  assert.equal(success(f.cli('status')).state.status, 'paused');
  success(f.hook('UserPromptSubmit', { prompt: 'Continue the task.' }));
  assert.equal(success(f.cli('resume')).state.status, 'active');
});

test('state identity cannot be altered while keeping the old journal', () => {
  const f = fixture();
  f.start();
  const path = join(f.root, '.playbill/coordinator/runtime/state.json');
  write(
    path,
    JSON.stringify({ ...f.state(), sessionId: 'substituted-session' }),
  );
  reject(
    f.hook('SessionStart', {
      source: 'resume',
      session_id: 'substituted-session',
    }),
    /State\/journal integrity mismatch/u,
  );
});

test('traversal, output/input overlap and symlink escapes fail at public boundaries', () => {
  const f = fixture();
  f.config.steps[0].produces = ['../escape.md'];
  write(f.configPath, JSON.stringify(f.config));
  reject(f.hook('SessionStart'), /Invalid step contract/u);
  f.config.steps[0].produces = ['source.txt'];
  write(f.configPath, JSON.stringify(f.config));
  reject(f.hook('SessionStart'), /Output overlaps watched input/u);
  f.config.steps[0].produces = ['output/capture.md'];
  write(f.configPath, JSON.stringify(f.config));
  symlinkSync(temporary, join(f.root, 'output'), 'dir');
  reject(f.hook('SessionStart'), /Symlink forbidden/u);
  const g = fixture();
  g.start();
  success(g.activate('playbill:capture'));
  symlinkSync(join(g.root, 'source.txt'), join(g.root, 'capture.md'));
  reject(g.cli('complete', 'v1'), /Symlink forbidden/u);
  const h = fixture();
  mkdirSync(join(h.root, '.playbill/coordinator'), { recursive: true });
  symlinkSync(temporary, join(h.root, '.playbill/coordinator/runtime'), 'dir');
  reject(h.hook('SessionStart'), /Symlink forbidden/u);
});

test('early explicit writes are denied and observed shell writes prevent completion', () => {
  const f = fixture();
  f.start();
  const denied = success(
    f.hook('PreToolUse', {
      tool_name: 'Edit',
      tool_use_id: 'edit',
      tool_input: { file_path: join(f.root, 'source.txt') },
    }),
  );
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  const bash = {
    tool_name: 'Bash',
    tool_use_id: 'shell',
    tool_input: { command: 'edit source; complete v1' },
  };
  assert.deepEqual(success(f.hook('PreToolUse', bash)), {});
  f.produce('source.txt', 'early mutation');
  success(f.activate('playbill:capture'));
  f.produce('capture.md');
  reject(f.cli('complete', 'v1'), /recorded source-write violations/u);
  assert.deepEqual(
    success(
      f.hook('PostToolUse', { ...bash, tool_response: { stdout: 'done' } }),
    ),
    {},
  );
  const violations = f
    .events()
    .filter((event) => event.violation === 'early-source-write');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].originVisitId, 'v1');
  assert.equal(f.state().visit.violations.length, 1);
});

test('a permitted source edit and completion in one Bash call do not blame the successor', () => {
  const f = fixture({
    config: {
      steps: [
        node('capture', 'report', { allowSourceWrites: true }),
        node('report'),
      ],
    },
  });
  f.start();
  success(f.activate('playbill:capture'));
  const bash = {
    tool_name: 'Bash',
    tool_use_id: 'combined',
    tool_input: { command: 'edit; complete v1' },
  };
  success(f.hook('PreToolUse', bash));
  f.produce('source.txt', 'allowed edit');
  f.produce('capture.md');
  success(f.cli('complete', 'v1'));
  assert.deepEqual(
    success(
      f.hook('PostToolUse', {
        ...bash,
        tool_response: { stdout: 'completed' },
      }),
    ),
    {},
  );
  const change = f.events().find((event) => event.kind === 'source-change');
  assert.equal(change.allowed, true);
  assert.equal(change.originVisitId, 'v1');
  assert.equal(
    f.events().filter((event) => event.violation === 'early-source-write')
      .length,
    0,
  );
});

test('bounded Stop recovery records every blocked attempt and permits paused/completed boundaries', () => {
  const f = fixture();
  f.start();
  assert.equal(success(f.hook('Stop')).decision, 'block');
  assert.equal(
    success(f.hook('Stop', { stop_hook_active: true })).decision,
    'block',
  );
  assert.deepEqual(success(f.hook('Stop', { stop_hook_active: true })), {});
  assert.equal(f.state().status, 'paused');
  assert.deepEqual(
    f
      .events()
      .filter((event) => event.kind === 'stop')
      .map(({ blocked, status, visitId }) => ({ blocked, status, visitId })),
    [
      { blocked: true, status: 'active', visitId: 'v1' },
      { blocked: true, status: 'active', visitId: 'v1' },
      { blocked: false, status: 'paused', visitId: 'v1' },
    ],
  );
  assert.equal(success(f.cli('resume')).state.visit.id, 'v1');
});

test('pauseAfter, read-only status, compact and native resume preserve one visit and complete history', () => {
  const f = fixture({ config: { pauseAfter: ['capture'] } });
  f.start();
  const paused = f.finish('playbill:capture', 'capture.md', 'v1');
  assert.equal(paused.state.status, 'paused');
  assert.equal(paused.state.visit.id, 'v2');
  const original = f.state();
  success(
    f.hook('UserPromptSubmit', {
      prompt: 'Read-only status: what has completed?',
    }),
  );
  assert.equal(success(f.cli('status')).state.status, 'paused');
  assert.deepEqual(success(f.hook('Stop')), {});
  assert.match(
    success(f.hook('SessionStart', { source: 'compact' })).hookSpecificOutput
      .additionalContext,
    /paused at v2/u,
  );
  success(f.hook('SessionStart', { source: 'resume' }));
  assert.deepEqual(f.state().history, original.history);
  assert.equal(f.state().visit.id, original.visit.id);
  success(
    f.hook('UserPromptSubmit', { prompt: 'Continue the existing task.' }),
  );
  const resumed = success(f.cli('resume'));
  assert.equal(resumed.state.visit.id, 'v2');
  assert.deepEqual(f.state().history, original.history);
  success(f.activate('playbill:verify'));
  success(f.cli('pause'));
  success(f.hook('SessionStart', { source: 'compact' }));
  success(f.cli('resume'));
  assert.equal(f.state().visit.activation.visitId, 'v2');
});

test('an active read-only status turn can end without advancing or pausing the workflow', () => {
  const f = fixture();
  f.start();
  success(
    f.hook('UserPromptSubmit', { prompt: 'Read-only status only, please.' }),
  );
  assert.deepEqual(success(f.hook('Stop')), {});
  assert.equal(f.state().status, 'active');
  assert.equal(f.state().visit.id, 'v1');
  reject(f.cli('complete', 'v1'), /Read-only status turn/u);
  const denied = success(
    f.hook('PreToolUse', {
      tool_name: 'Skill',
      tool_use_id: 'status-skill',
      tool_input: { skill: 'playbill:capture' },
    }),
  );
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  success(f.hook('UserPromptSubmit', { prompt: 'Continue.' }));
  assert.equal(success(f.hook('Stop')).decision, 'block');
});

test('finite transition cap rejects a further loop without silently completing a visit', () => {
  const f = fixture({
    config: { steps: [node('capture', 'capture')], maxTransitions: 1 },
  });
  f.start();
  f.finish('playbill:capture', 'capture.md', 'v1');
  success(f.activate('playbill:capture'));
  f.produce('capture.md', 'second visit result');
  reject(f.cli('complete', 'v2'), /Transition limit reached/u);
  assert.equal(f.state().history.length, 1);
  assert.equal(f.state().visit.id, 'v2');
});

function asynchronous(path, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path, ...args], options);
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => {
      stdout += bytes;
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input);
  });
}

function gatedFixture(config = {}) {
  const f = fixture({
    runner: `const fs = require('node:fs');
fs.writeFileSync('.replay/started', 'ready');
console.log('check started');
const timer = setInterval(() => {
  if (!fs.existsSync('.replay/release')) return;
  clearInterval(timer);
  fs.writeFileSync('.replay/result.json', 'released result');
  console.log('check released');
}, 10);`,
    config: {
      steps: [node('capture', null, { check: 'original' })],
      ...config,
    },
  });
  f.config.checks.original.timeoutMs = 30000;
  write(f.configPath, JSON.stringify(f.config));
  f.start();
  success(f.activate('playbill:capture'));
  f.produce('capture.md');
  return f;
}

async function reserved(f) {
  const deadline = Date.now() + 5000;
  while (
    !f.state().visit.checkLease ||
    !existsSync(join(f.root, '.replay/started'))
  ) {
    assert.ok(Date.now() < deadline, 'Check must reserve and start');
    await setTimeout(10);
  }
  const lease = f.state().visit.checkLease;
  assert.equal(lease.visitId, 'v1');
  assert.equal(lease.sessionId, 'session-one');
  assert.equal(lease.configHash, sha(readFileSync(f.configPath)));
  assert.equal(
    lease.activationHash,
    sha(JSON.stringify(f.state().visit.activation)),
  );
  assert.equal(lease.inputs['source.txt'], sha('bad'));
  assert.deepEqual(
    f.events().find((event) => event.kind === 'check-reserved').lease,
    lease,
  );
  return lease;
}

test('a reserved check releases the state lock for native hooks and status while blocking completion and another check', async () => {
  const f = gatedFixture();
  f.produce('.replay/result.json', 'previous result');
  const pending = asynchronous(cliPath, [f.configPath, 'check'], {
    cwd: f.root,
    timeout: 35000,
  });
  let result;
  let lease;
  try {
    lease = await reserved(f);
    const status = success(f.cli('status', undefined, { timeout: 5000 }));
    assert.deepEqual(status.state.visit.checkInFlight, lease);
    assert.match(status.context, /no automatic reset/u);
    assert.match(status.context, /current visit v1, Stage capture/u);
    assert.match(
      status.context,
      /Continue the authorized workflow through the returned visits/u,
    );
    assert.deepEqual(
      success(
        f.hook(
          'PostToolUse',
          {
            tool_name: 'Read',
            tool_use_id: 'while-check-runs',
            tool_input: { file_path: 'source.txt' },
            tool_response: { text: 'bad' },
          },
          { timeout: 5000 },
        ),
      ),
      {},
    );
    reject(f.cli('complete', 'v1', { timeout: 5000 }), /Check is in flight/u);
    reject(f.cli('check', undefined, { timeout: 5000 }), /Check is in flight/u);
    const denied = success(
      f.hook('PreToolUse', {
        tool_name: 'Skill',
        tool_use_id: 'repeat-during-check',
        tool_input: { skill: 'playbill:capture' },
      }),
    );
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.deepEqual(f.state().visit.checkLease, lease);
  } finally {
    f.produce('.replay/release', 'release after bounded hook and status');
    result = await pending;
  }
  const checked = success(result);
  assert.equal(checked.check.outcome, 'pass');
  assert.equal(checked.check.stdout, 'check started\ncheck released\n');
  assert.equal(checked.check.evidencePath, lease.path);
  const evidence = json(join(f.root, lease.path));
  assert.equal(
    evidence.previousResults['.replay/result.json'].sha256,
    sha('previous result'),
  );
  assert.equal(
    evidence.resultFiles['.replay/result.json'].sha256,
    sha('released result'),
  );
  assert.equal(
    evidence.raw.sha256,
    sha(readFileSync(join(f.root, lease.rawPath))),
  );
  assert.equal(f.state().visit.checkLease, null);
  assert.equal(success(f.cli('complete', 'v1')).state.status, 'done');
  assert.deepEqual(
    f.events().map((event) => event.sequence),
    Array.from({ length: f.events().length }, (_, index) => index + 1),
  );
});

test('check finalization preserves a concurrent pause and read-only turn', async () => {
  const f = gatedFixture();
  const pending = asynchronous(cliPath, [f.configPath, 'check'], {
    cwd: f.root,
    timeout: 35000,
  });
  let result;
  try {
    await reserved(f);
    assert.equal(success(f.cli('pause')).state.status, 'paused');
    success(f.hook('UserPromptSubmit', { prompt: 'Read-only status only.' }));
    assert.deepEqual(success(f.hook('Stop')), {});
    assert.match(
      success(f.hook('SessionStart', { source: 'compact' })).hookSpecificOutput
        .additionalContext,
      /paused at v1/u,
    );
  } finally {
    f.produce('.replay/release');
    result = await pending;
  }
  const checked = success(result);
  assert.equal(checked.check.outcome, 'pass');
  assert.equal(checked.state.status, 'paused');
  assert.equal(f.state().readOnlyTurn, true);
  assert.equal(f.state().visit.checkLease, null);
  reject(f.cli('complete', 'v1'), /Read-only status turn/u);
  success(f.hook('UserPromptSubmit', { prompt: 'Continue.' }));
  success(f.cli('resume'));
  assert.equal(success(f.cli('complete', 'v1')).state.status, 'done');
});

test('configuration changes during a check retain its raw result and unresolved lease', async () => {
  const f = gatedFixture();
  const configBytes = readFileSync(f.configPath);
  const pending = asynchronous(cliPath, [f.configPath, 'check'], {
    cwd: f.root,
    timeout: 35000,
  });
  let result;
  let lease;
  try {
    lease = await reserved(f);
    write(f.configPath, configBytes.toString() + '\n');
  } finally {
    f.produce('.replay/release');
    result = await pending;
  }
  reject(result, /Check configuration\/root\/native session changed/u);
  const raw = json(join(f.root, lease.rawPath));
  assert.equal(raw.outcome, 'pass');
  assert.equal(
    Buffer.from(raw.stdout.base64, 'base64').toString(),
    'check started\ncheck released\n',
  );
  assert.deepEqual(f.state().visit.checkLease, lease);
  write(f.configPath, configBytes);
  assert.deepEqual(success(f.cli('status')).state.visit.checkInFlight, lease);
  reject(f.cli('check'), /Check is in flight/u);
  reject(f.cli('complete', 'v1'), /Check is in flight/u);
});

test('concurrent completion and hook processes serialize journal writes and advance only once', async () => {
  const f = fixture();
  f.start();
  success(f.activate('playbill:capture'));
  f.produce('capture.md');
  const options = { cwd: f.root };
  const results = await Promise.all([
    asynchronous(cliPath, [f.configPath, 'complete', 'v1'], options),
    asynchronous(cliPath, [f.configPath, 'complete', 'v1'], options),
    asynchronous(hookPath, [f.configPath], {
      ...options,
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 'session-one',
        cwd: f.root,
        tool_name: 'Read',
        tool_use_id: 'concurrent-read',
        tool_input: { file_path: 'source.txt' },
        tool_response: { text: 'bad' },
      }),
    }),
  ]);
  assert.deepEqual(
    results
      .slice(0, 2)
      .map((result) => result.status)
      .sort(),
    [0, 1],
  );
  success(results[2]);
  assert.equal(success(f.cli('status')).state.completed, 1);
  assert.deepEqual(
    f.events().map((event) => event.sequence),
    Array.from({ length: f.events().length }, (_, index) => index + 1),
  );
});

const runtimePath = '.playbill/coordinator/runtime';
const historyConfig = { executionHistory: { reportArtifact: 'report.md' } };
const historyFiles = (f) =>
  Object.fromEntries(
    readdirSync(join(f.root, runtimePath), { recursive: true })
      .map((name) => join(runtimePath, name))
      .filter((name) => statSync(join(f.root, name)).isFile())
      .map((name) => [
        name,
        {
          sha256: sha(readFileSync(join(f.root, name))),
          modified: statSync(join(f.root, name)).mtimeMs,
        },
      ]),
  );
const bash = (id, command) => ({
  tool_name: 'Bash',
  tool_use_id: id,
  tool_input: { command },
});
const factsOf = (f) => success(f.cli('history')).history;
const nativeValue = (f, ref) => f.events()[ref.sequence - 1][ref.field];
const generatedFiles = (f) =>
  Object.fromEntries(
    Object.entries(historyFiles(f)).filter(([path]) =>
      /execution-history\.(json|md)$/u.test(path),
    ),
  );

function historyFixture(options = {}) {
  return fixture({
    ...options,
    config: { ...historyConfig, ...options.config },
  });
}

function nativeCheck(f, id) {
  const event = bash(id, `node '${cliPath}' '${f.configPath}' check`);
  success(f.hook('PreToolUse', event));
  const result = f.cli('check');
  success(
    f.hook('PostToolUse', {
      ...event,
      tool_response: { stdout: result.stdout, stderr: result.stderr },
    }),
  );
  return success(result);
}

test('execution history retains filtered shell receipts, all configured checks and scratch reuse without double counting', () => {
  const f = historyFixture();
  f.start();
  const command = "node .replay/test.cjs 2>&1 | sed -n '1p'";
  const unmanaged = bash('filtered-baseline', command);
  success(f.hook('PreToolUse', unmanaged));
  const result = spawnSync('/bin/sh', ['-c', command], {
    cwd: f.root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const response = {
    stdout: result.stdout,
    stderr: result.stderr,
    interrupted: false,
  };
  success(f.hook('PostToolUse', { ...unmanaged, tool_response: response }));
  const mention = bash(
    'read-runner',
    'cat .replay/test.cjs; git diff -- .replay/test.cjs',
  );
  success(f.hook('PreToolUse', mention));
  success(
    f.hook('PostToolUse', {
      ...mention,
      tool_response: { stdout: "process.exitCode=source==='good'?0:1;" },
    }),
  );
  f.finish('playbill:capture', 'capture.md', 'v1');
  success(f.activate('playbill:verify'));
  const baseline = nativeCheck(f, 'baseline');
  const repeated = nativeCheck(f, 'repeated-baseline');
  assert.equal(baseline.check.outcome, 'fail');
  assert.equal(repeated.check.outcome, 'fail');
  f.produce('verify.md');
  success(f.cli('complete', 'v2'));
  success(f.activate('playbill:fix'));
  f.produce('source.txt', 'good');
  nativeCheck(f, 'correction');
  f.produce('fix.md');
  success(f.cli('complete', 'v3'));
  success(f.activate('playbill:verify'));
  nativeCheck(f, 'verification');
  f.produce('verify.md');
  success(f.cli('complete', 'v4'));
  const facts = factsOf(f);
  assert.deepEqual(facts.counts, {
    shellInvocations: 6,
    configuredChecks: 4,
    finalizedChecks: 4,
    pendingChecks: 0,
  });
  assert.deepEqual(
    facts.configuredChecks.map((check) => [
      check.visitId,
      check.outcome,
      check.exitCode,
    ]),
    [
      ['v2', 'fail', 1],
      ['v2', 'fail', 1],
      ['v3', 'pass', 0],
      ['v4', 'pass', 0],
    ],
  );
  assert.equal(
    new Set(facts.configuredChecks.map((check) => check.id)).size,
    4,
  );
  assert.equal(facts.shellInvocations[0].command, command);
  assert.deepEqual(
    nativeValue(f, facts.shellInvocations[0].response),
    response,
  );
  assert.equal(facts.shellInvocations[0].receiptState, 'received');
  assert.deepEqual(
    Object.keys(facts.shellInvocations[0]).sort(),
    [
      'command',
      'denied',
      'error',
      'id',
      'input',
      'nativeEvent',
      'post',
      'pre',
      'receiptState',
      'response',
      'toolUseId',
      'visitId',
    ].sort(),
  );
  assert.equal(facts.shellInvocations[1].command, mention.tool_input.command);
  const originalResult = JSON.stringify({ source: 'bad', pass: false });
  assert.equal(
    facts.configuredChecks[0].previousResults['.replay/result.json'].sha256,
    sha(originalResult),
  );
  f.produce('.replay/result.json', 'scratch overwritten after verification');
  assert.deepEqual(factsOf(f), facts);
  const retained = json(join(f.root, baseline.check.evidencePath));
  assert.equal(
    Buffer.from(retained.stdout.base64, 'base64').toString(),
    'all results: bad\n',
  );
  assert.equal(
    Buffer.from(
      retained.resultFiles['.replay/result.json'].base64,
      'base64',
    ).toString(),
    originalResult,
  );
});

test('report completion appends a bounded snapshot, preserves inaccurate narrative and leaves enclosing receipts pending', () => {
  const f = historyFixture({
    config: { steps: [node('capture', null, { produces: ['report.md'] })] },
  });
  f.start();
  success(f.activate('playbill:capture'));
  const checkEvent = bash(
    'check-wrapper',
    `node '${cliPath}' '${f.configPath}' check`,
  );
  success(f.hook('PreToolUse', checkEvent));
  const checkResult = success(f.cli('check'));
  assert.equal(checkResult.check.outcome, 'fail');
  const completion = bash(
    'complete-wrapper',
    `node '${cliPath}' '${f.configPath}' complete v1`,
  );
  success(f.hook('PreToolUse', completion));
  const narrative = Buffer.from(
    '## My report\r\nAll tests passed. No baseline was run.\n',
  );
  f.produce('report.md', narrative);
  const done = success(f.cli('complete', 'v1'));
  assert.equal(done.state.status, 'done');
  assert.match(done.context, /execution-history\.json/u);
  const report = readFileSync(join(f.root, 'report.md'));
  assert.deepEqual(report.subarray(0, narrative.length), narrative);
  assert.match(
    report.toString(),
    /<!-- playbill:generated-execution-history:start -->/u,
  );
  assert.match(report.toString(), /Evidence cutoff: journal event/u);
  assert.match(report.toString(), /check-wrapper.*pending/u);
  assert.match(report.toString(), /complete-wrapper.*pending/u);
  assert.match(report.toString(), /\| fail \| 1/u);
  assert.ok(report.length < 128 * 1024);
  const attachment = f.state().history[0].executionHistory;
  const generatedAtCompletion = generatedFiles(f);
  const frozen = json(join(f.root, attachment.json.path));
  assert.deepEqual(frozen.counts, {
    shellInvocations: 2,
    configuredChecks: 1,
    finalizedChecks: 1,
    pendingChecks: 0,
  });
  assert.deepEqual(
    frozen.shellInvocations.map((shell) => shell.receiptState),
    ['pending', 'pending'],
  );
  const savedNarrative = json(join(f.root, attachment.narrative.path));
  assert.deepEqual(
    Buffer.from(savedNarrative['report.md'].base64, 'base64'),
    narrative,
  );
  const savedArtifact = json(join(f.root, f.state().history[0].artifacts.path));
  assert.deepEqual(
    Buffer.from(savedArtifact['report.md'].base64, 'base64'),
    report,
  );
  success(
    f.hook('PostToolUse', {
      ...checkEvent,
      tool_response: {
        stdout: 'configured check failed',
        detail: 'x'.repeat(20000),
      },
    }),
  );
  success(
    f.hook('PostToolUse', { ...completion, tool_response: { stdout: 'done' } }),
  );
  assert.deepEqual(
    factsOf(f).shellInvocations.map((shell) => shell.receiptState),
    ['received', 'received'],
  );
  assert.deepEqual(readFileSync(join(f.root, 'report.md')), report);
  assert.deepEqual(json(join(f.root, attachment.json.path)), frozen);
  assert.deepEqual(generatedFiles(f), generatedAtCompletion);
  const statusCall = bash(
    'done-status',
    `node '${cliPath}' '${f.configPath}' status`,
  );
  success(f.hook('PreToolUse', statusCall));
  const statusResult = f.cli('status');
  success(statusResult);
  success(
    f.hook('PostToolUse', {
      ...statusCall,
      tool_response: { stdout: statusResult.stdout },
    }),
  );
  assert.deepEqual(generatedFiles(f), generatedAtCompletion);
  const before = historyFiles(f);
  success(f.cli('status'));
  factsOf(f);
  assert.deepEqual(historyFiles(f), before);
});

test('native history and status reads preserve generated files during ordinary active turns and retain live receipts', () => {
  const f = historyFixture();
  f.start();
  success(f.hook('UserPromptSubmit', { prompt: 'Continue the workflow.' }));
  const before = generatedFiles(f);
  const saved = json(join(f.root, `${runtimePath}/execution-history.json`));
  const visit = f.state().visit;
  for (const command of ['history', 'status']) {
    assert.equal(f.state().status, 'active');
    assert.equal(f.state().readOnlyTurn, false);
    const event = bash(
      `active-${command}`,
      `node '${cliPath}' '${f.configPath}' ${command}`,
    );
    success(f.hook('PreToolUse', event));
    assert.deepEqual(generatedFiles(f), before);
    const result = f.cli(command);
    success(result);
    const pending = factsOf(f).shellInvocations.at(-1);
    assert.equal(pending.command, event.tool_input.command);
    assert.equal(pending.receiptState, 'pending');
    assert.deepEqual(generatedFiles(f), before);
    const response = { stdout: result.stdout, stderr: result.stderr };
    success(f.hook('PostToolUse', { ...event, tool_response: response }));
    const live = factsOf(f);
    const received = live.shellInvocations.at(-1);
    assert.equal(received.id, `bash:active-${command}`);
    assert.equal(received.receiptState, 'received');
    assert.deepEqual(nativeValue(f, received.response), response);
    assert.ok(live.cutoff.sequence > saved.cutoff.sequence);
    assert.deepEqual(generatedFiles(f), before);
    assert.deepEqual(f.state().visit, visit);
    assert.equal(f.state().transitions, 0);
  }
  success(f.activate('playbill:capture'));
  const activated = json(join(f.root, `${runtimePath}/execution-history.json`));
  assert.deepEqual(activated, factsOf(f));
  assert.deepEqual(
    activated.shellInvocations.map((shell) => shell.receiptState),
    ['received', 'received'],
  );
  nativeCheck(f, 'active-check');
  const checked = json(join(f.root, `${runtimePath}/execution-history.json`));
  assert.equal(checked.configuredChecks[0].receiptState, 'finalized');
  assert.equal(checked.configuredChecks[0].outcome, 'fail');
  assert.equal(checked.shellInvocations.at(-1).receiptState, 'pending');
  f.produce('capture.md');
  success(f.cli('complete', 'v1'));
  const completed = json(join(f.root, `${runtimePath}/execution-history.json`));
  assert.deepEqual(completed, factsOf(f));
  assert.equal(completed.shellInvocations.at(-1).receiptState, 'received');
});

test('history and status preserve files during active, paused, compacted and read-only turns', () => {
  const f = historyFixture();
  f.start();
  const event = bash('still-pending', 'node --test missing.test.mjs');
  success(f.hook('PreToolUse', event));
  for (const paused of [false, true]) {
    if (paused) success(f.cli('pause'));
    const before = historyFiles(f);
    success(f.cli('status'));
    const history = factsOf(f);
    assert.equal(history.shellInvocations[0].receiptState, 'pending');
    reject(
      f.cli('history', undefined, {
        env: { ...process.env, PLAYBILL_COORDINATOR_SESSION_ID: 'wrong' },
      }),
      /Native session mismatch/u,
    );
    assert.deepEqual(historyFiles(f), before);
    const restored = success(f.hook('SessionStart', { source: 'compact' }));
    assert.match(
      restored.hookSpecificOutput.additionalContext,
      /Read-only history: .* history\./u,
    );
    assert.match(
      restored.hookSpecificOutput.additionalContext,
      /execution-history\.md/u,
    );
    for (const path of ['execution-history.json', 'execution-history.md']) {
      const full = `${runtimePath}/${path}`;
      assert.deepEqual(historyFiles(f)[full], before[full]);
    }
    success(f.hook('UserPromptSubmit', { prompt: 'Read-only status only.' }));
    const readOnly = historyFiles(f);
    factsOf(f);
    success(f.cli('status'));
    assert.deepEqual(historyFiles(f), readOnly);
    const frozenFiles = generatedFiles(f);
    const statusCall = bash(
      `read-only-status-${paused}`,
      `node '${cliPath}' '${f.configPath}' history`,
    );
    success(f.hook('PreToolUse', statusCall));
    const statusResult = f.cli('history');
    const projected = success(statusResult);
    assert.equal(
      projected.history.shellInvocations.at(-1).command,
      statusCall.tool_input.command,
    );
    success(
      f.hook('PostToolUse', {
        ...statusCall,
        tool_response: { stdout: statusResult.stdout },
      }),
    );
    assert.deepEqual(generatedFiles(f), frozenFiles);
    success(f.hook('UserPromptSubmit', { prompt: 'Continue.' }));
  }
});

test('history reports missing native receipts and tool failures without manufacturing shell process outcomes', () => {
  const f = historyFixture();
  f.start();
  success(f.hook('PreToolUse', bash('pre-only', 'node --test')));
  const failed = bash('failure', 'false | true');
  success(f.hook('PreToolUse', failed));
  success(
    f.hook('PostToolUseFailure', {
      ...failed,
      error: 'Native tool transport failed',
    }),
  );
  const empty = bash('empty-result', 'echo no receipt body');
  success(f.hook('PreToolUse', empty));
  success(f.hook('PostToolUse', empty));
  success(
    f.hook('PostToolUse', {
      ...bash('post-only', 'node --test'),
      tool_response: { stdout: 'unknown origin' },
    }),
  );
  const facts = factsOf(f);
  assert.deepEqual(
    facts.shellInvocations.map((shell) => [
      shell.id,
      shell.receiptState,
      shell.nativeEvent,
    ]),
    [
      ['bash:pre-only', 'pending', null],
      ['bash:failure', 'received', 'PostToolUseFailure'],
      ['bash:empty-result', 'missing-result', 'PostToolUse'],
      ['bash:post-only', 'missing-pre', 'PostToolUse'],
    ],
  );
  assert.equal(
    nativeValue(f, facts.shellInvocations[1].error),
    'Native tool transport failed',
  );
  assert.deepEqual(facts.counts, {
    shellInvocations: 4,
    configuredChecks: 0,
    finalizedChecks: 0,
    pendingChecks: 0,
  });
});

test('in-flight history remains responsive and never treats an unfinished check as completed', async () => {
  const f = gatedFixture({
    executionHistory: { reportArtifact: 'capture.md' },
  });
  const event = bash(
    'in-flight-wrapper',
    `node '${cliPath}' '${f.configPath}' check`,
  );
  success(f.hook('PreToolUse', event));
  const pending = asynchronous(cliPath, [f.configPath, 'check'], {
    cwd: f.root,
    timeout: 35000,
  });
  let result;
  try {
    const lease = await reserved(f);
    const before = historyFiles(f);
    const current = success(f.cli('history', undefined, { timeout: 5000 }));
    assert.deepEqual(current.history.counts, {
      shellInvocations: 1,
      configuredChecks: 1,
      finalizedChecks: 0,
      pendingChecks: 1,
    });
    assert.equal(current.history.configuredChecks[0].id, lease.id);
    assert.equal(current.history.configuredChecks[0].outcome, null);
    assert.equal(current.history.configuredChecks[0].evidence, null);
    assert.deepEqual(
      json(join(f.root, `${runtimePath}/execution-history.json`)),
      current.history,
    );
    assert.deepEqual(historyFiles(f), before);
    success(f.cli('pause'));
    success(f.hook('SessionStart', { source: 'compact' }));
    assert.equal(factsOf(f).configuredChecks[0].receiptState, 'pending');
  } finally {
    f.produce('.replay/release');
    result = await pending;
  }
  success(result);
  const facts = factsOf(f);
  assert.equal(facts.configuredChecks[0].receiptState, 'finalized');
  assert.equal(facts.configuredChecks[0].outcome, 'pass');
  assert.equal(facts.shellInvocations[0].receiptState, 'pending');
});

test('history validates optional config, report ownership and generated path ownership', () => {
  for (const executionHistory of [
    null,
    false,
    {},
    { reportArtifact: '../escape.md' },
    { reportArtifact: 'missing.md' },
    { reportArtifact: 'capture.md' },
    { reportArtifact: 'report.md', json: 'outside.json' },
  ]) {
    const f = fixture({ config: { executionHistory } });
    reject(
      f.hook('SessionStart', { source: 'startup' }),
      /executionHistory|Execution history/u,
    );
  }
  for (const report of [
    '.replay/result.json',
    '.playbill/coordinator/runtime/report.md',
    'source.txt',
  ]) {
    const f = fixture({
      config: {
        steps: [node('capture', null, { produces: [report] })],
        executionHistory: { reportArtifact: report },
      },
    });
    reject(f.hook('SessionStart'), /overlap|overlaps/u);
  }
  const f = historyFixture();
  f.produce(`${runtimePath}/execution-history.md`, 'existing owner');
  reject(f.hook('SessionStart'), /Unowned generated history path/u);
  assert.equal(
    readFileSync(join(f.root, `${runtimePath}/execution-history.md`), 'utf8'),
    'existing owner',
  );
  const linked = historyFixture();
  const outside = join(temporary, 'outside-history.json');
  write(outside, '{}');
  mkdirSync(join(linked.root, runtimePath), { recursive: true });
  symlinkSync(
    outside,
    join(linked.root, `${runtimePath}/execution-history.json`),
  );
  reject(linked.hook('SessionStart'), /Symlink forbidden/u);
  assert.equal(readFileSync(outside, 'utf8'), '{}');
});

test('history refuses altered superseded checks, raw evidence, journal receipts and generated files without read mutations', () => {
  for (const target of ['check', 'raw', 'journal', 'generated', 'missing']) {
    const f = historyFixture();
    f.start();
    success(f.activate('playbill:capture'));
    const first = nativeCheck(f, 'first-check');
    nativeCheck(f, 'superseding-check');
    const evidence = json(join(f.root, first.check.evidencePath));
    if (target === 'check')
      f.produce(
        first.check.evidencePath,
        JSON.stringify({ ...evidence, exitCode: 0, outcome: 'pass' }),
      );
    if (target === 'raw') f.produce(evidence.raw.path, '{}');
    if (target === 'missing') rmSync(join(f.root, first.check.evidencePath));
    if (target === 'generated')
      f.produce(`${runtimePath}/execution-history.md`, 'Everything passed.');
    if (target === 'journal') {
      const events = f.events();
      events.find(
        (event) => event.kind === 'tool-pre' && event.tool === 'Bash',
      ).input.command = 'fabricated command';
      f.produce(
        `${runtimePath}/events.jsonl`,
        events.map((event) => JSON.stringify(event)).join('\n') + '\n',
      );
    }
    const before = historyFiles(f);
    reject(f.cli('history'), /integrity mismatch|evidence changed|ENOENT/u);
    reject(f.cli('status'), /integrity mismatch|evidence changed|ENOENT/u);
    assert.deepEqual(historyFiles(f), before);
  }
});

test('disabled configurations keep narrative bytes and create no history outputs', () => {
  const f = fixture({
    config: { steps: [node('capture', null, { produces: ['report.md'] })] },
  });
  f.start();
  success(f.activate('playbill:capture'));
  f.produce('report.md', 'User narrative only.\n');
  const done = success(f.cli('complete', 'v1'));
  assert.equal(
    done.context,
    'Coordinator public-boundary-test: completed 1 visits. Report the retained results and any repair limitations.',
  );
  assert.equal(
    readFileSync(join(f.root, 'report.md'), 'utf8'),
    'User narrative only.\n',
  );
  assert.deepEqual(
    Object.keys(f.state()).filter((key) => key === 'executionHistory'),
    [],
  );
  assert.deepEqual(readdirSync(join(f.root, runtimePath)).sort(), [
    'artifacts',
    'events.jsonl',
    'state.json',
  ]);
});

test('repeated native history reads return bounded projections with exact results retained by reference', () => {
  const f = historyFixture();
  f.start();
  success(f.activate('playbill:capture'));
  nativeCheck(f, 'configured-baseline');
  success(f.cli('pause'));
  const frozen = generatedFiles(f);
  const firstSize = Buffer.byteLength(f.cli('history').stdout);
  let lastResponse;
  for (let index = 0; index < 12; index += 1) {
    const event = bash(
      `history-${index}`,
      `node '${cliPath}' '${f.configPath}' history`,
    );
    success(f.hook('PreToolUse', event));
    const result = f.cli('history');
    success(result);
    assert.ok(
      Buffer.byteLength(result.stdout) < firstSize + (index + 1) * 4000,
      'History output must grow with receipt references, without embedding earlier history bodies',
    );
    lastResponse = { stdout: result.stdout, stderr: result.stderr };
    success(f.hook('PostToolUse', { ...event, tool_response: lastResponse }));
  }
  const facts = factsOf(f);
  assert.equal(facts.shellInvocations.length, 13);
  assert.equal(facts.configuredChecks.length, 1);
  assert.deepEqual(
    nativeValue(f, facts.shellInvocations.at(-1).response),
    lastResponse,
  );
  const check = facts.configuredChecks[0];
  const original = json(join(f.root, check.evidence.path));
  assert.equal(
    original.resultFiles['.replay/result.json'].sha256,
    check.resultFiles['.replay/result.json'].sha256,
  );
  assert.equal(
    check.resultFiles['.replay/result.json'].evidence.field,
    'resultFiles',
  );
  assert.deepEqual(generatedFiles(f), frozen);
});

test('malformed native execution evidence fails without replacing generated facts or accepting a clean history', () => {
  const f = historyFixture();
  f.start();
  const before = historyFiles(f);
  reject(
    f.hook('PreToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'bad-command',
      tool_input: { command: ['node', '--test'] },
    }),
    /Malformed native Bash evidence/u,
  );
  assert.deepEqual(historyFiles(f), before);
  assert.deepEqual(factsOf(f).counts, {
    shellInvocations: 0,
    configuredChecks: 0,
    finalizedChecks: 0,
    pendingChecks: 0,
  });
});
