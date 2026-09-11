import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { validateConfig, mergeConfig } from '../dist/config.js';
import { validatePipeline } from '../dist/validator.js';
import { loadRegistry } from '../dist/registry.js';
import { runRuntime } from '../dist/runtime.js';
import { compileCoordinator } from '../dist/coordinator-compiler.js';
import { handleCodexEvent } from '../dist/codex.js';
import { handleClaudeEvent } from '../dist/claude.js';
import { canonicalId } from '../dist/native-inventory.js';
import { sessionStore } from '../dist/session-state.js';
import { configuration } from '../scripts/coordinator/config.mjs';
import { execute } from '../scripts/coordinator/core.mjs';
import { commandWords, hash } from '../scripts/coordinator/files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const write = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(t, host = 'codex') {
  const cwd = mkdtempSync(join(root, '.test-runs-installed-unit-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const inventory = loadRegistry(join(root, 'defaults/registry.yaml')).map(
    (skill) => ({ ...skill, invocation: skill.id.split(':').at(-1) }),
  );
  const inventoryPath = join(cwd, 'inventory.json');
  write(inventoryPath, JSON.stringify({ version: 1, skills: inventory }));
  const env = {
    ...process.env,
    PLAYBILL_PROJECT_ROOT: cwd,
    PLAYBILL_MACHINE_DIR: join(cwd, 'machine'),
    PLAYBILL_STATE_DIR: join(cwd, 'state'),
    PLAYBILL_DEFAULTS_DIR: join(root, 'defaults'),
    PLAYBILL_CODEX_INVENTORY: inventoryPath,
    CLAUDE_CONFIG_DIR: join(cwd, 'claude'),
  };
  let tool = 0;
  const hook = (name, extra = {}, session = 'one') =>
    (host === 'codex' ? handleCodexEvent : handleClaudeEvent)(
      { hook_event_name: name, cwd, session_id: session, ...extra },
      env,
    );
  const pointer = (session = 'one') =>
    read(
      join(
        cwd,
        '.playbill/coordinator/sessions',
        hash(`${host}\0${cwd}\0${session}`),
        'current.json',
      ),
    );
  const config = (session = 'one') =>
    configuration(join(cwd, pointer(session).configPath));
  const state = (session = 'one') =>
    read(join(cwd, config(session).runtime, 'state.json'));
  const raw = (session = 'one') => read(join(cwd, pointer(session).configPath));
  const activate = async (session = 'one') => {
    const current = state(session);
    const conf = raw(session);
    const step = conf.steps.find((item) => item.id === current.visit.nodeId);
    const id = `tool${++tool}`;
    const input =
      host === 'codex'
        ? { command: `cat ${quote(conf.nativeSkills[step.skill])}` }
        : { skill: conf.nativeInvocations[step.skill] };
    const event = {
      tool_use_id: id,
      tool_name: host === 'codex' ? 'Bash' : 'Skill',
      tool_input: input,
    };
    assert.deepEqual(await hook('PreToolUse', event, session), {});
    const output = await hook(
      'PostToolUse',
      {
        ...event,
        tool_response:
          host === 'codex'
            ? readFileSync(conf.nativeSkills[step.skill], 'utf8')
            : { success: true },
      },
      session,
    );
    assert.equal(
      state(session).visit.activation.skill,
      step.skill,
      JSON.stringify(output),
    );
    return step;
  };
  const finish = async (session = 'one') => {
    const step = await activate(session);
    for (const path of step.produces)
      write(
        join(cwd, path),
        `${state(session).visit.id} evidence ${step.id}\n`,
      );
    return execute(
      config(session),
      'complete',
      state(session).visit.id,
      session,
    );
  };
  const decide = (
    value,
    rationale = 'Current retained reproduction evidence establishes this condition.',
  ) => {
    const current = state();
    const step = raw().steps.find((item) => item.id === current.visit.nodeId);
    return execute(
      config(),
      'decide',
      {
        visit: current.visit.id,
        condition: step.condition.id,
        value,
        rationale,
      },
      'one',
    );
  };
  return {
    cwd,
    env,
    inventory,
    hook,
    pointer,
    config,
    state,
    raw,
    activate,
    finish,
    decide,
  };
}

test('coordination policy validates strict fields and merges overrides', () => {
  const base = {
    workflows: {
      debug: {
        coordination: {
          enabled: true,
          artifact_scope: 'run',
          redirect_threshold: 4,
        },
      },
    },
  };
  assert.deepEqual(
    mergeConfig(base, {
      workflows: {
        debug: { coordination: { enabled: false, ask_on_redirect: false } },
      },
    }).workflows.debug.coordination,
    {
      enabled: false,
      artifact_scope: 'run',
      redirect_threshold: 4,
      ask_on_redirect: false,
    },
  );
  for (const coordination of [
    { enabled: 'yes' },
    { artifact_scope: 'tmp' },
    { extra: true },
    { redirect_threshold: 1 },
    { ask_on_redirect: 'no' },
  ])
    assert.throws(() =>
      validateConfig({ workflows: { debug: { coordination } } }),
    );
});

test('empty configuration enables bundled debug only for native coordination', (t) => {
  const f = fixture(t);
  const request = {
    version: 1,
    cwd: f.cwd,
    event: 'prompt',
    prompt: 'debug this failure',
    inventory: f.inventory,
    discovery: {
      projectRoot: f.cwd,
      machineDir: f.env.PLAYBILL_MACHINE_DIR,
      defaultsDir: join(root, 'defaults'),
    },
  };
  const rendered = runRuntime(request);
  const coordinated = runRuntime({ ...request, coordinationHost: 'codex' });
  assert.equal(coordinated.ok, true, JSON.stringify(coordinated.diagnostics));
  assert.equal(coordinated.coordination.workflow, 'debug');
  assert.equal(coordinated.coordination.artifactScope, 'run');
  assert.equal(coordinated.commonProse, rendered.commonProse);
  assert.equal(rendered.coordination, undefined);
  write(
    join(f.cwd, '.playbill/config.toml'),
    '[workflows.debug.coordination]\nenabled = false\n',
  );
  assert.equal(
    runRuntime({ ...request, coordinationHost: 'claude' }).coordination,
    undefined,
  );
});

test('compiler lowers arbitrary step and condition identities and diagnoses unsupported semantics', (t) => {
  const f = fixture(t);
  const config = { slots: { technique: f.inventory[0].id } };
  const step = (id) => ({
    type: 'step',
    id,
    title: id,
    skill: '{{technique}}',
  });
  const pipeline = {
    version: 1,
    id: 'custom',
    title: 'Custom',
    artifacts: [],
    steps: [
      {
        type: 'if',
        condition: 'the user supplied evidence',
        then: [step('accept')],
        else: [step('collect')],
      },
      step('finish'),
    ],
  };
  const compile = (value, policy = { enabled: true }) =>
    compileCoordinator(
      validatePipeline(
        value,
        config,
        f.inventory.map(({ invocation, ...skill }) => {
          void invocation;
          return skill;
        }),
      ),
      f.cwd,
      f.inventory,
      policy,
    );
  const plan = compile(pipeline);
  assert.equal(plan.artifactScope, 'project');
  const decision = plan.steps.find((item) => item.id === plan.entry);
  assert.equal(decision.condition.expression, 'the user supplied evidence');
  assert.match(decision.next.true, /accept/u);
  assert.match(decision.next.false, /collect/u);
  for (const value of [
    { ...pipeline, steps: [{ ...step('new'), agent: { fresh: true } }] },
    {
      ...pipeline,
      steps: [
        {
          type: 'switch',
          select: 'x',
          cases: [{ when: 'a', steps: [step('a')] }],
        },
      ],
    },
  ])
    assert.throws(() => compile(value), /COORDINATION_UNSUPPORTED/u);
});

test('initial false loop decision reaches report and completed runs release native hooks', async (t) => {
  const f = fixture(t);
  const selected = await f.hook('UserPromptSubmit', {
    prompt: 'debug this failure',
  });
  assert.match(
    selected.hookSpecificOutput.additionalContext,
    /Capture the bug/u,
  );
  await f.finish();
  await f.finish();
  const before = f.state();
  await assert.rejects(
    execute(f.config(), 'complete', before.visit.id, 'one'),
    /Missing recorded condition decision/u,
  );
  await assert.rejects(f.decide(false, ' '), /nonempty rationale/u);
  await f.decide(false);
  const decided = f.state().history.at(-1);
  assert.equal(decided.decision.value, false);
  assert.equal(decided.activation, null);
  assert.equal(
    f.raw().steps.find((item) => item.id === f.state().visit.nodeId).title,
    'Report the outcome',
  );
  await assert.rejects(
    execute(
      f.config(),
      'decide',
      {
        visit: before.visit.id,
        condition: decided.decision.condition,
        value: true,
        rationale: 'old',
      },
      'one',
    ),
    /Stale visit token/u,
  );
  await f.finish();
  assert.equal(f.state().status, 'done');
  const facts = read(join(f.cwd, f.config().runtime, 'execution-history.json'));
  assert.equal(facts.conditionDecisions.length, 1);
  assert.equal(facts.conditionDecisions[0].value, false);
  assert.match(
    readFileSync(join(f.cwd, f.raw().executionHistory.reportArtifact), 'utf8'),
    /Recorded condition decisions/u,
  );
  f.env.PLAYBILL_CODEX_INVENTORY = join(f.cwd, 'missing-inventory');
  assert.deepEqual(
    await f.hook('UserPromptSubmit', { prompt: 'fix another thing' }),
    {},
  );
  assert.deepEqual(await f.hook('Stop'), {});
  assert.deepEqual(await f.hook('SessionStart', { source: 'resume' }), {});
});

test('three true loop entries cap attempts and if decisions select or skip reassessment', async (t) => {
  const f = fixture(t);
  await f.hook('UserPromptSubmit', {
    prompt: '[playbill:debug] repair the failure',
  });
  await f.finish();
  await f.finish();
  for (let iteration = 1; iteration <= 3; iteration++) {
    await f.decide(true);
    await f.finish();
    await f.finish();
    await f.decide(iteration !== 2);
    if (iteration !== 2) await f.finish();
  }
  assert.equal(
    f.raw().steps.find((item) => item.id === f.state().visit.nodeId).title,
    'Report the outcome',
  );
  assert.equal(
    f
      .state()
      .history.filter(
        (visit) =>
          f.raw().steps.find((step) => step.id === visit.nodeId).title ===
          'Apply one correction',
      ).length,
    3,
  );
  assert.deepEqual(
    f
      .state()
      .history.filter((visit) => visit.decision)
      .map((visit) => visit.decision.value),
    [true, true, true, false, true, true],
  );
  await f.finish();
  assert.equal(f.state().status, 'done');
});

for (const value of [false, true])
  test(`recorded ${value} decisions retry completion after repairing successor artifacts`, async (t) => {
    const f = fixture(t);
    await f.hook('UserPromptSubmit', { prompt: 'debug the failure' });
    await f.finish();
    await f.finish();
    const before = f.state();
    const steps = f.raw().steps;
    const condition = steps.find((step) => step.id === before.visit.nodeId);
    const successor = steps.find(
      (step) => step.id === condition.next[String(value)],
    );
    const collision = join(f.cwd, successor.produces[0]);
    mkdirSync(collision, { recursive: true });
    const rationale = "The user's retained evidence supports this branch.";
    await assert.rejects(f.decide(value, rationale), /Unsupported file/u);
    const recorded = f.state().visit.decision;
    assert.equal(recorded.value, value);
    assert.equal(recorded.rationale, rationale);
    assert.equal(f.state().visit.id, before.visit.id);
    assert.ok(
      (await execute(f.config(), 'status', undefined, 'one')).context.includes(
        `complete ${before.visit.id}`,
      ),
    );
    rmSync(collision, { recursive: true });

    await assert.rejects(
      f.decide(!value, rationale),
      /Condition decision already recorded/u,
    );
    await assert.rejects(
      f.decide(value, 'Changed reasoning'),
      /Condition decision already recorded/u,
    );
    assert.deepEqual(f.state().visit.decision, recorded);
    await f.decide(value, rationale);
    assert.equal(f.state().visit.nodeId, successor.id);
    assert.equal(f.state().transitions, before.transitions + 1);
    assert.deepEqual(f.state().history.at(-1).decision, recorded);
    const events = readFileSync(
      join(f.cwd, f.config().runtime, 'events.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      events
        .filter((event) => event.kind === 'condition-decided')
        .map((event) => event.decision),
      [recorded],
    );
    assert.ok(
      events.some(
        (event) =>
          event.kind === 'rejected' && /Unsupported file/u.test(event.error),
      ),
    );
    await f.finish();
    assert.equal(f.state().history.at(-1).nodeId, successor.id);
  });

for (const host of ['claude', 'codex'])
  test(`${host} tool routing reads the journal once and retains integrity validation`, async (t) => {
    const f = fixture(t, host);
    await f.hook('UserPromptSubmit', { prompt: 'debug the failure' });
    const journal = join(f.cwd, f.config().runtime, 'events.jsonl');
    const originalRead = fs.readFileSync;
    let reads = 0;
    const spy = t.mock.method(fs, 'readFileSync', (path, ...args) => {
      if (path === journal) reads += 1;
      return originalRead(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      spy.mock.restore();
      syncBuiltinESMExports();
    });
    const event = {
      tool_use_id: 'ordinary',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
    };
    assert.deepEqual(await f.hook('PreToolUse', event), {});
    assert.equal(reads, 1);
    reads = 0;
    assert.deepEqual(
      await f.hook('PostToolUse', { ...event, tool_response: f.cwd }),
      {},
    );
    assert.equal(reads, 1);
    const events = originalRead(journal, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      events
        .filter((item) => item.toolUseId === event.tool_use_id)
        .map((item) => item.kind),
      ['tool-pre', 'tool-post'],
    );
    events.at(-1).stateHash = 'altered';
    write(
      journal,
      events.map((item) => JSON.stringify(item)).join('\n') + '\n',
    );
    const denied = await f.hook('PreToolUse', {
      ...event,
      tool_use_id: 'after-tampering',
    });
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      denied.hookSpecificOutput.permissionDecisionReason,
      /State\/journal integrity mismatch/u,
    );
  });

test('native sessions, hosts and new runs isolate pointers, receipts and scratch artifacts', async (t) => {
  const f = fixture(t);
  await f.hook('UserPromptSubmit', { prompt: 'debug failure one' });
  await f.hook('UserPromptSubmit', { prompt: 'debug failure two' }, 'two');
  assert.notEqual(f.config().runtime, f.config('two').runtime);
  assert.notEqual(
    f.raw().steps[0].produces[0],
    f.raw('two').steps[0].produces[0],
  );
  await f.activate();
  assert.equal(f.state('two').visit.activation, null);
  const previous = f.pointer();
  await execute(f.config(), 'exit', undefined, 'one');
  assert.deepEqual(
    await f.hook('UserPromptSubmit', { prompt: 'fix another unrelated thing' }),
    {},
  );
  await f.hook('UserPromptSubmit', {
    prompt: '[playbill:debug] start a fresh fix',
  });
  assert.notEqual(f.pointer().runId, previous.runId);
  assert.equal(
    read(join(f.cwd, dirname(previous.configPath), 'runtime/state.json'))
      .conversation.mode,
    'exited',
  );
  const claude = await handleClaudeEvent(
    {
      hook_event_name: 'UserPromptSubmit',
      cwd: f.cwd,
      session_id: 'one',
      prompt: 'debug this failure',
    },
    f.env,
  );
  assert.match(
    claude.hookSpecificOutput.additionalContext,
    /Skill with skill=/u,
  );
  assert.equal(
    readdirSync(join(f.cwd, '.playbill/coordinator/sessions')).length,
    3,
  );
});

test('paused routing bypasses inventory, preserves state on compact and accepts subdirectory tools', async (t) => {
  const f = fixture(t);
  await f.hook('UserPromptSubmit', { prompt: 'debug the failure' });
  await f.finish();
  const visit = f.state().visit.id;
  await execute(f.config(), 'pause', undefined, 'one');
  f.env.PLAYBILL_CODEX_INVENTORY = join(f.cwd, 'missing-inventory');
  const restored = await f.hook('SessionStart', { source: 'compact' });
  assert.match(
    restored.hookSpecificOutput.additionalContext,
    /Original workflow paused/u,
  );
  await f.hook('UserPromptSubmit', {
    prompt: 'explain the current investigation',
  });
  await execute(
    f.config(),
    'intent',
    { turn: f.state().conversation.turn, kind: 'question' },
    'one',
  );
  assert.deepEqual(await f.hook('Stop'), {});
  await f.hook('UserPromptSubmit', { prompt: 'return to the repair' });
  await execute(
    f.config(),
    'intent',
    { turn: f.state().conversation.turn, kind: 'return' },
    'one',
  );
  assert.equal(f.state().visit.id, visit);
  const subdirectory = join(f.cwd, 'src');
  mkdirSync(subdirectory);
  assert.deepEqual(
    await f.hook('PreToolUse', {
      cwd: subdirectory,
      tool_name: 'Bash',
      tool_use_id: 'subdir',
      tool_input: { command: 'pwd' },
    }),
    {},
  );
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'scripts/coordinator/cli.mjs'),
      f.config().configPath,
      'status',
    ],
    { cwd: subdirectory, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state.visit.id, visit);
});

for (const host of ['claude', 'codex'])
  test(`${host} can pause an undecided installed visit until correction is authorized`, async (t) => {
    const f = fixture(t, host);
    await f.hook('UserPromptSubmit', {
      prompt:
        '[playbill:debug] Reproduce the failure and record the diagnosis, then pause before code edits. Wait for my authorization to correct it.',
    });
    await f.finish();
    await f.finish();
    const before = f.state();
    assert.deepEqual(
      before.history.map(
        (visit) => f.raw().steps.find((step) => step.id === visit.nodeId).title,
      ),
      ['Capture the bug', 'Reproduce and isolate'],
    );
    const decision = f
      .raw()
      .steps.find((step) => step.id === before.visit.nodeId);
    assert.equal(typeof decision.condition.expression, 'string');
    assert.equal(before.visit.decision, undefined);
    const restored = await f.hook('SessionStart', { source: 'resume' });
    const command = restored.hookSpecificOutput.additionalContext.match(
      /node (?:'[^']*' ){2}pause\b/u,
    )?.[0];
    assert.ok(
      command,
      'Current decision guidance must provide a runnable pause command',
    );
    const event = {
      tool_name: 'Bash',
      tool_use_id: 'requested-pause',
      tool_input: { command },
    };
    assert.deepEqual(await f.hook('PreToolUse', event), {});
    const [executable, ...args] = commandWords(command);
    const paused = spawnSync(executable, args, {
      cwd: f.cwd,
      env: f.env,
      encoding: 'utf8',
    });
    assert.equal(paused.status, 0, paused.stderr);
    assert.equal(JSON.parse(paused.stdout).state.status, 'paused');
    await f.hook('PostToolUse', { ...event, tool_response: paused.stdout });
    assert.equal(f.state().conversation.mode, 'paused');
    assert.equal(f.state().conversation.suspension.visitId, before.visit.id);
    assert.deepEqual(f.state().visit, before.visit);
    assert.deepEqual(f.state().history, before.history);
    assert.deepEqual(await f.hook('Stop'), {});

    await f.hook('SessionStart', { source: 'compact' });
    await f.hook('UserPromptSubmit', {
      prompt: 'Explain the diagnosis while the correction remains on hold.',
    });
    await execute(
      f.config(),
      'intent',
      { turn: f.state().conversation.turn, kind: 'question' },
      'one',
    );
    assert.equal(f.state().status, 'paused');
    assert.equal(f.state().conversation.mode, 'paused');
    assert.equal(f.state().readOnlyTurn, true);
    assert.deepEqual(f.state().visit, before.visit);
    assert.deepEqual(f.state().history, before.history);
    assert.deepEqual(
      (await execute(f.config(), 'history', undefined, 'one')).history
        .conditionDecisions,
      [],
    );
    assert.deepEqual(await f.hook('Stop'), {});

    await f.hook('UserPromptSubmit', {
      prompt: 'Return to the repair. I authorize the correction now.',
    });
    await execute(
      f.config(),
      'intent',
      { turn: f.state().conversation.turn, kind: 'return' },
      'one',
    );
    assert.equal(f.state().status, 'active');
    assert.equal(f.state().conversation.mode, 'engaged');
    assert.deepEqual(f.state().visit, before.visit);
    await f.decide(
      true,
      'The reproduction and diagnosis remain valid; the user now authorizes correction.',
    );
    assert.equal(f.state().history.at(-1).id, before.visit.id);
    assert.equal(f.state().history.at(-1).decision.value, true);
    assert.equal(f.state().visit.activation, null);
    await assert.rejects(
      execute(f.config(), 'complete', f.state().visit.id, 'one'),
      /Missing successful native Skill activation/u,
    );
    const correction = await f.activate();
    assert.equal(correction.title, 'Apply one correction');
    assert.equal(f.state().visit.activation.skill, correction.skill);
  });

test('explicit rendered selection after exit survives compaction on both native hosts', async (t) => {
  for (const host of ['claude', 'codex']) {
    const f = fixture(t, host);
    await f.hook('UserPromptSubmit', { prompt: 'debug the failure' });
    const prior = f.pointer();
    await execute(f.config(), 'exit', undefined, 'one');
    const rendered = await f.hook('UserPromptSubmit', {
      prompt: '[playbill:plan] plan the next feature',
    });
    assert.match(
      rendered.hookSpecificOutput.additionalContext,
      /skill invocation:/u,
    );
    const restored = await f.hook('SessionStart', { source: 'compact' });
    assert.match(
      restored.hookSpecificOutput.additionalContext,
      /Workflow reference restored/u,
    );
    assert.equal(f.pointer().mode, 'rendered');
    assert.equal(
      read(join(f.cwd, dirname(prior.configPath), 'runtime/state.json'))
        .conversation.mode,
      'exited',
    );
  }
});

for (const host of ['claude', 'codex'])
  for (const policy of ['enabled override', 'bundled default'])
    test(`${host} restores rendered debug after coordination switches to ${policy}`, async (t) => {
      const f = fixture(t, host);
      const path = join(f.cwd, '.playbill/config.toml');
      write(path, '[workflows.debug.coordination]\nenabled = false\n');
      const rendered = await f.hook('UserPromptSubmit', {
        prompt: '[playbill:debug] investigate this failure',
      });
      const context = rendered.hookSpecificOutput.additionalContext;
      assert.match(context, /skill invocation:/u);
      const store = sessionStore(
        f.env.PLAYBILL_STATE_DIR,
        `${host}\0${f.cwd}\0one`,
      );
      const saved = store.read();
      assert.equal(saved.selected, 'debug');
      if (policy === 'enabled override')
        write(path, '[workflows.debug.coordination]\nenabled = true\n');
      else rmSync(path);

      for (const source of ['compact', 'resume']) {
        const restored = await f.hook('SessionStart', { source });
        assert.equal(
          restored.hookSpecificOutput.additionalContext,
          `${context}\nWorkflow reference restored. Continue from the conversation summary and existing artifacts.`,
        );
        assert.deepEqual(store.read(), saved);
        assert.equal(
          existsSync(join(f.cwd, '.playbill/coordinator/sessions')),
          false,
        );
      }

      const entered = await f.hook('UserPromptSubmit', {
        prompt: '[playbill:debug] start a new investigation',
      });
      assert.match(
        entered.hookSpecificOutput.additionalContext,
        /Capture the bug/u,
      );
      assert.equal(f.raw().workflow, 'debug');
      assert.equal(f.state().status, 'active');
      const pointer = f.pointer();
      const visit = f.state().visit.id;
      write(path, '[workflows.debug.coordination]\nenabled = false\n');
      const resumed = await f.hook('SessionStart', { source: 'compact' });
      assert.ok(
        resumed.hookSpecificOutput.additionalContext.includes(
          `Coordinator ${pointer.runId}: current visit ${visit}, Capture the bug.`,
        ),
      );
      assert.deepEqual(f.pointer(), pointer);
      assert.equal(f.state().visit.id, visit);
    });

test('external skill receipts require exact bytes and shell quoting accepts spaces and apostrophes', async (t) => {
  const f = fixture(t);
  const path = join(f.cwd, "installed skills' directory/SKILL.md");
  const first = f.inventory.find(
    (item) => item.id === 'playbill:playbill-brief',
  );
  write(path, readFileSync(first.path));
  first.path = path;
  write(
    f.env.PLAYBILL_CODEX_INVENTORY,
    JSON.stringify({ version: 1, skills: f.inventory }),
  );
  assert.deepEqual(commandWords(`cat ${quote(path)}`), ['cat', path]);
  assert.equal(commandWords('cat "$(whoami)"'), null);
  await f.hook('UserPromptSubmit', { prompt: 'debug the failure' });
  const conf = f.raw();
  const outside = f.inventory.find(
    (item) => item.id === 'playbill:playbill-debug-log',
  ).path;
  assert.equal(outside.startsWith(f.cwd), false);
  const event = {
    tool_use_id: 'partial',
    tool_name: 'Bash',
    tool_input: { command: `cat ${quote(path)}` },
  };
  await f.hook('PreToolUse', event);
  await f.hook('PostToolUse', {
    ...event,
    tool_response: readFileSync(path, 'utf8').slice(0, 10),
  });
  assert.equal(f.state().visit.activation, null);
  await f.activate();
  assert.equal(
    f.state().visit.activation.skillPath,
    conf.nativeSkills[first.id],
  );
  assert.equal(
    canonicalId('native-name', outside),
    'playbill:playbill-debug-log',
  );
});

test('coordinated aliases sharing one skill file activate each canonical visit', async (t) => {
  const f = fixture(t);
  const first = f.inventory.find(
    (skill) => skill.id === 'playbill:playbill-brief',
  );
  const second = { ...first, id: 'fixture:second-alias' };
  write(
    f.env.PLAYBILL_CODEX_INVENTORY,
    JSON.stringify({ version: 1, skills: [...f.inventory, second] }),
  );
  write(
    join(f.cwd, '.playbill/config.toml'),
    `[slots]\nfirst = "${first.id}"\nsecond = "${second.id}"\n[workflows.aliases.coordination]\nenabled = true\n`,
  );
  write(
    join(f.cwd, '.playbill/pipelines/aliases.yaml'),
    JSON.stringify({
      version: 1,
      id: 'aliases',
      title: 'Shared skill aliases',
      artifacts: [
        { id: 'first', path: 'first.md' },
        { id: 'second', path: 'second.md' },
      ],
      outputs: ['second'],
      steps: [
        {
          type: 'step',
          id: 'first',
          title: 'First',
          skill: '{{first}}',
          produces: ['first'],
        },
        {
          type: 'step',
          id: 'second',
          title: 'Second',
          skill: '{{second}}',
          consumes: ['first'],
          produces: ['second'],
        },
      ],
    }),
  );
  const selected = await f.hook('UserPromptSubmit', {
    prompt: '[playbill:aliases] capture both stages',
  });
  assert.match(selected.hookSpecificOutput.additionalContext, /First/u);
  await f.finish();
  const completed = f.state().history[0];
  assert.equal(completed.activation.skill, first.id);
  const replay = await f.hook('PostToolUse', {
    tool_use_id: completed.activation.toolUseId,
    tool_name: 'Bash',
    tool_input: { command: `cat ${quote(first.path)}` },
    tool_response: readFileSync(first.path, 'utf8'),
  });
  assert.match(replay.hookSpecificOutput.additionalContext, /receipt/u);
  assert.equal(f.state().visit.activation, null);
  await f.finish();
  assert.equal(f.state().status, 'done');
  assert.deepEqual(
    f.state().history.map((visit) => visit.activation.skill),
    [first.id, second.id],
  );
});

test('Claude invocation names remain separate from canonical technique receipts', async (t) => {
  const f = fixture(t, 'claude');
  await f.hook('UserPromptSubmit', { prompt: 'debug the failure' });
  const step = await f.activate();
  assert.equal(step.skill, 'playbill:playbill-brief');
  assert.equal(
    f.state().visit.activation.invocation,
    f.raw().nativeInvocations[step.skill],
  );
});

test('native failure and inactive Stop shapes match host hooks without discovery', async (t) => {
  const f = fixture(t);
  f.env.PLAYBILL_CODEX_INVENTORY = join(f.cwd, 'unavailable');
  assert.deepEqual(await f.hook('Stop'), {});
  assert.deepEqual(
    await f.hook('PreToolUse', {
      tool_use_id: 'ordinary',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
    }),
    {},
  );
  const failed = await handleCodexEvent(
    { hook_event_name: 'Stop', cwd: f.cwd },
    f.env,
  );
  assert.equal(failed.decision, 'block');
  assert.deepEqual(Object.keys(failed).sort(), ['decision', 'reason']);
});

test('packed plugin contains the coordinator and imports with isolated bundled dependencies', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'playbill-installed-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pack = spawnSync(
    'npm',
    ['pack', '--json', '--pack-destination', directory],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(pack.status, 0, pack.stderr);
  const info = JSON.parse(pack.stdout)[0];
  assert.ok(
    info.files.some((file) => file.path === 'scripts/coordinator/core.mjs'),
  );
  assert.deepEqual(info.bundled.sort(), ['smol-toml', 'yaml']);
  const extracted = spawnSync(
    'tar',
    ['-xzf', join(directory, info.filename), '-C', directory],
    { encoding: 'utf8' },
  );
  assert.equal(extracted.status, 0, extracted.stderr);
  const hook = spawnSync(
    process.execPath,
    [join(directory, 'package/adapters/codex/hook.mjs')],
    {
      cwd: directory,
      input: JSON.stringify({
        hook_event_name: 'Stop',
        cwd: directory,
        session_id: 'package',
      }),
      encoding: 'utf8',
      env: { ...process.env, PLAYBILL_PROJECT_ROOT: directory },
    },
  );
  assert.equal(hook.status, 0, hook.stderr);
  assert.deepEqual(JSON.parse(hook.stdout), {});
  for (const host of ['claude', 'codex']) {
    const hooks = read(
      join(directory, `package/adapters/${host}/hooks.json`),
    ).hooks;
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ])
      assert.equal(hooks[event][0].hooks[0].type, 'command');
    assert.deepEqual(Object.keys(hooks.Stop[0].hooks[0]).sort(), [
      'command',
      'timeout',
      'type',
    ]);
  }
});
