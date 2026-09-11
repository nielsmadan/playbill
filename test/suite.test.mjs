import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { loadSkills } from '@earendil-works/pi-coding-agent';
import {
  discoverConfiguration,
  invokeRuntime,
  loadRegistry,
  renderPipeline,
  validatePipeline,
} from '../dist/index.js';
import { claudeContext, handleClaudeEvent } from '../dist/claude.js';
import { discoverClaudeInventory } from '../dist/claude-inventory.js';
import { codexSkills } from '../dist/codex-inventory.js';
import { nativeSnapshot } from '../dist/native-inventory.js';
import { nativeContext } from '../dist/adapter-session.js';
import { piInventory } from '../dist/pi.js';
import { opencodeInventory } from '../dist/opencode.js';
import {
  observationProtocol,
  observerSource,
  originalChecks,
  originalSolution,
  verifySuite,
} from '../scripts/smoke/verify-suite.mjs';
import { artifactNames } from '../scripts/smoke/suite-observer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const write = (path, contents) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};

function fixture(t) {
  const cwd = mkdtempSync(join(root, '.test-runs-suite-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const config = join(cwd, '.playbill/config.toml');
  write(config, '');
  const env = {
    CLAUDE_CONFIG_DIR: join(cwd, 'claude'),
    PLAYBILL_PROJECT_ROOT: cwd,
    PLAYBILL_MACHINE_DIR: join(cwd, 'machine'),
    PLAYBILL_STATE_DIR: join(cwd, 'state'),
  };
  const discovery = {
    projectRoot: cwd,
    machineDir: env.PLAYBILL_MACHINE_DIR,
    defaultsDir: join(root, 'defaults'),
  };
  const registry = loadRegistry(join(root, 'defaults/registry.yaml'));
  const nativePi = () =>
    loadSkills({
      cwd,
      agentDir: join(cwd, 'pi-agent'),
      skillPaths: [join(root, 'skills')],
      includeDefaults: true,
    });
  const nativeCommands = (skills) =>
    skills.map(({ path, invocation }) => ({
      name: invocation,
      source: 'skill',
      template: `${readFileSync(path, 'utf8')
        .replace(/^---\n[\s\S]*?\n---\n/u, '')
        .trim()}\n\nBase directory for this skill: ${dirname(path)}\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.`,
    }));
  const bundled = registry.map((skill) => ({
    ...skill,
    invocation: basename(dirname(skill.path)),
  }));
  const inventories = () => ({
    claude: discoverClaudeInventory(cwd, cwd, root, env).skills,
    codex: codexSkills(
      {
        data: [
          {
            cwd,
            errors: [],
            skills: bundled.map(({ path, invocation }) => ({
              path,
              name: invocation,
              enabled: true,
            })),
          },
        ],
      },
      cwd,
    ),
    pi: piInventory(nativePi().skills, {}),
    opencode: opencodeInventory(nativeCommands(bundled), {}),
  });
  const render = (prompt, inventory, event = 'prompt', resumeWorkflow) =>
    invokeRuntime({
      version: 1,
      cwd,
      event,
      prompt,
      discovery,
      inventory,
      ...(resumeWorkflow ? { resumeWorkflow } : {}),
    });
  return {
    cwd,
    config,
    env,
    discovery,
    registry,
    bundled,
    nativePi,
    nativeCommands,
    inventories,
    render,
  };
}

test('empty project configuration selects every actual bundled workflow through all four native normalization seams', (t) => {
  const f = fixture(t);
  const discovered = discoverConfiguration(f.cwd, f.discovery);
  assert.deepEqual([...discovered.pipelines.keys()].sort(), [
    'debug',
    'longshot',
    'plan',
    'review',
  ]);
  const inventories = f.inventories();
  for (const inventory of Object.values(inventories))
    assert.deepEqual(
      inventory.map(({ id }) => id).sort(),
      f.registry.map(({ id }) => id).sort(),
    );
  for (const [workflow, prompt] of Object.entries({
    debug: 'Fix the incorrect result in the parser',
    longshot: 'Work on this independently',
    plan: 'Write an implementation plan',
    review: 'Review the changed parser',
  })) {
    const pipeline = discovered.pipelines.get(workflow);
    assert.deepEqual(pipeline.inputs, []);
    const expected = renderPipeline(
      validatePipeline(pipeline, discovered.config, f.registry),
    );
    for (const [host, inventory] of Object.entries(inventories)) {
      const result = f.render(prompt, inventory);
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(result.selected, workflow, host);
      assert.equal(result.commonProse, expected, host);
      assert.ok(
        result.invocations.every(({ id }) => id.startsWith('playbill:')),
      );
    }
  }
  const debug = discovered.pipelines.get('debug');
  const visit = (nodes) =>
    nodes.flatMap((node) =>
      node.type === 'step'
        ? [node]
        : visit(node.steps ?? [...(node.then ?? []), ...(node.else ?? [])]),
    );
  for (const step of visit(debug.steps))
    assert.deepEqual(step.agent, {
      fresh: false,
      read_only: false,
      model: 'balanced',
    });
});

test('distinctive bundled names survive Pi native first-name precedence beside ordinary personal skills', (t) => {
  const f = fixture(t);
  for (const name of [
    'plan',
    'code-review',
    'read-docs',
    'debug-log',
    'hard-fix',
  ])
    write(
      join(f.cwd, `pi-agent/skills/${name}/SKILL.md`),
      `---\nname: ${name}\ndescription: Personal technique\n---\nPersonal instructions.\n`,
    );
  const loaded = f.nativePi();
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(
    loaded.skills.find(({ name }) => name === 'plan').filePath,
    join(f.cwd, 'pi-agent/skills/plan/SKILL.md'),
  );
  const inventory = piInventory(loaded.skills, {});
  for (const skill of f.registry)
    assert.equal(inventory.find(({ id }) => id === skill.id).path, skill.path);
  assert.equal(f.render('fix the parser', inventory).selected, 'debug');
});

test('an arbitrary installed replacement binding changes the named reviewer without editing the bundled pipeline', (t) => {
  const f = fixture(t);
  const pipelinePath = join(root, 'defaults/pipelines/review.yaml');
  const original = readFileSync(pipelinePath, 'utf8');
  const path = join(f.cwd, 'skills/custom-review/SKILL.md');
  write(
    path,
    '---\nname: custom-review\ndescription: Custom reviewer\n---\nReturn findings against the task acceptance criteria.\n',
  );
  write(f.config, '[slots]\nfinal_review = "company/custom@v1"\n');
  const custom = {
    id: 'company/custom@v1',
    path,
    invocation: 'custom-review',
    model_invocable: true,
    requires: { fresh: true, read_only: true, model: 'capable' },
  };
  const skills = [...f.bundled, custom];
  const snapshot = join(f.cwd, 'inventory.json');
  write(snapshot, JSON.stringify({ version: 1, skills }));
  const livePi = loadSkills({
    cwd: f.cwd,
    agentDir: join(f.cwd, 'pi-agent'),
    skillPaths: [join(root, 'skills'), dirname(path)],
    includeDefaults: false,
  });
  const inventories = {
    claude: discoverClaudeInventory(f.cwd, f.cwd, root, {
      PLAYBILL_CLAUDE_INVENTORY: snapshot,
    }).skills,
    codex: nativeSnapshot(snapshot, 'codex'),
    pi: piInventory(livePi.skills, { PLAYBILL_PI_INVENTORY: snapshot }),
    opencode: opencodeInventory(f.nativeCommands(skills), {
      PLAYBILL_OPENCODE_INVENTORY: snapshot,
    }),
  };
  for (const [host, inventory] of Object.entries(inventories)) {
    const result = f.render('[playbill:review] Inspect the parser', inventory);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.match(result.commonProse, /invoke `company\/custom@v1`/u, host);
    assert.equal(
      result.invocations.find(({ id }) => id === custom.id).invocation,
      'custom-review',
    );
  }
  assert.equal(readFileSync(pipelinePath, 'utf8'), original);
});

test('project configuration disables default entry and project pipelines replace whole bundled files on every seam', (t) => {
  const f = fixture(t);
  write(f.config, '[workflows.debug]\nentry = "disabled"\n');
  for (const inventory of Object.values(f.inventories())) {
    const automatic = f.render('fix the parser', inventory);
    assert.equal(automatic.ok, true);
    assert.equal(automatic.commonProse, '');
    const explicit = f.render('[playbill:debug] fix it', inventory);
    assert.equal(explicit.ok, false);
    assert.equal(explicit.diagnostics[0].code, 'DISABLED_WORKFLOW');
  }
  write(f.config, '');
  write(
    join(f.cwd, '.playbill/pipelines/custom.yaml'),
    JSON.stringify({
      version: 1,
      id: 'debug',
      title: 'Project diagnosis only',
      artifacts: [{ id: 'result', path: 'diagnosis.md' }],
      outputs: ['result'],
      steps: [
        {
          type: 'step',
          id: 'diagnose',
          title: 'Capture the failure',
          skill: '{{brief}}',
          produces: ['result'],
        },
      ],
    }),
  );
  const discovered = discoverConfiguration(f.cwd, f.discovery);
  assert.equal(discovered.pipelines.get('debug').steps.length, 1);
  assert.deepEqual(discovered.pipelines.get('debug').artifacts, [
    { id: 'result', path: 'diagnosis.md', kind: 'file' },
  ]);
  for (const inventory of Object.values(f.inventories())) {
    const result = f.render('fix the parser', inventory);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.match(result.commonProse, /^Project diagnosis only/u);
    assert.match(result.commonProse, /produce `diagnosis.md`/u);
  }
});

test('every default fits complete restored host contexts including Claude mapping, root, and coexistence warning', async (t) => {
  const f = fixture(t);
  const inventories = f.inventories();
  write(f.config, '[workflows.debug.coordination]\nenabled = false\n');
  for (const workflow of ['debug', 'plan', 'review', 'longshot']) {
    for (const [host, inventory] of Object.entries(inventories)) {
      const result = f.render('', inventory, 'restore', workflow);
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      const context =
        host === 'claude'
          ? claudeContext(result, true, f.cwd)
          : nativeContext(host, result, true, f.cwd);
      assert.match(context, /Workflow reference restored/u);
      assert.ok(context.includes(JSON.stringify(f.cwd)));
      assert.ok(context.includes('playbill:playbill-brief'));
      assert.ok(context.startsWith(result.commonProse));
      for (const field of [
        "current step's title and instruction",
        'task string (current collection item or user request)',
        'input/output artifact paths',
        'declared agent scope',
      ])
        assert.ok(context.includes(field), `${host}: ${field}`);
      if (host === 'claude') assert.match(context, /set Skill args/u);
      else
        assert.match(context, /After loading each skill, apply its technique/u);
      if (host === 'claude') assert.ok(context.length < 10000);
      else assert.ok(Buffer.byteLength(context) < 16384);
    }
    const event = {
      cwd: f.cwd,
      session_id: workflow,
      hook_event_name: 'UserPromptSubmit',
      prompt: `[playbill:${workflow}] Work on the task`,
    };
    const entered = await handleClaudeEvent(event, f.env);
    assert.match(
      entered.hookSpecificOutput.additionalContext,
      /skill invocation:/u,
    );
    write(
      join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'),
      '{"enabledPlugins":{"superpowers@suite-fixture":true}}',
    );
    const restored = (
      await handleClaudeEvent(
        { ...event, hook_event_name: 'SessionStart', source: 'compact' },
        f.env,
      )
    ).hookSpecificOutput.additionalContext;
    assert.match(restored, /Workflow reference restored/u);
    assert.match(restored, /Superpowers may also supply/u);
    assert.ok(restored.length < 10000, `${workflow}: ${restored.length}`);
    rmSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'));
  }
});

function observedTrial(t, variant) {
  const f = fixture(t);
  write(join(f.cwd, 'solution.mjs'), originalSolution);
  write(join(f.cwd, 'test.mjs'), originalChecks);
  write(join(f.cwd, 'original-test.mjs'), originalChecks);
  write(join(f.cwd, observationProtocol.observer), observerSource);
  write(join(f.cwd, 'command.json'), JSON.stringify({ observationProtocol }));
  const context = claudeContext(
    f.render('fix sumUniqueIntegers', f.inventories().claude),
    false,
    f.cwd,
  );
  const events = [
    {
      subtype: 'hook_response',
      hook_event: 'UserPromptSubmit',
      exit_code: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: { additionalContext: context },
      }),
    },
  ];
  let id = 0;
  const observe = (use, event) => {
    const result = spawnSync(
      process.execPath,
      [observationProtocol.observer, f.cwd],
      {
        cwd: f.cwd,
        input: JSON.stringify({
          cwd: f.cwd,
          tool_use_id: use.id,
          tool_name: use.name,
          tool_input: use.input,
          hook_event_name: event,
        }),
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    events.push({
      subtype: 'hook_response',
      hook_event: event,
      exit_code: 0,
      stdout: result.stdout,
    });
  };
  const tool = (name, input, action) => {
    const use = { type: 'tool_use', id: `tool_${++id}`, name, input };
    events.push({ type: 'assistant', message: { content: [use] } });
    observe(use, 'PreToolUse');
    const response = action();
    observe(use, response.is_error ? 'PostToolUseFailure' : 'PostToolUse');
    events.push({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: use.id, ...response }],
      },
    });
    return response.content;
  };
  const skill = (name) =>
    tool(
      'Skill',
      {
        skill: `playbill:playbill-${name}`,
        args: `Apply the current step to sumUniqueIntegers in solution.mjs, using its declared .playbill/debug/ artifact paths in the current context.`,
      },
      () => ({ content: `Launching skill: playbill:playbill-${name}` }),
    );
  const bash = (command) =>
    tool('Bash', { command }, () => {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const run = spawnSync('/bin/sh', ['-c', command], {
        cwd: f.cwd,
        env,
        encoding: 'utf8',
        timeout: 5000,
      });
      return { content: run.stdout + run.stderr, is_error: run.status !== 0 };
    });
  const shellWrite = (files) => {
    const script = `const fs = require('node:fs'); const path = require('node:path'); for (const [file, content] of ${JSON.stringify(Object.entries(files))}) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }`;
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    bash(`${quote(process.execPath)} -e ${quote(script)}`);
  };
  const corrected =
    'export function sumUniqueIntegers(values) { if (!Array.isArray(values)) throw new TypeError(); return [...new Set(values.filter(Number.isSafeInteger))].reduce((sum, value) => sum + value, 0); }\n';
  const path = (name) => `.playbill/debug/${name}.md`;
  const pending = {};
  const artifacts = (files) => {
    if (variant === 'late-artifacts') {
      Object.assign(pending, files);
      bash('true');
    } else
      shellWrite(
        Object.fromEntries(
          Object.entries(files).map(([name, content]) => [
            name,
            variant === 'placeholders'
              ? `No evidence recorded. Revision ${id}.\n`
              : content,
          ]),
        ),
      );
  };
  const brief =
    'Fix sumUniqueIntegers in solution.mjs to sum distinct safe integers. Check: node --test test.mjs. Authorized scope: this fixture.\n';
  skill('brief');
  if (variant === 'early-correction') {
    shellWrite({ 'solution.mjs': corrected });
    shellWrite({ 'solution.mjs': originalSolution });
  }
  if (variant !== 'calls-only')
    artifacts({
      [path('brief')]: brief,
      [path('progress')]: `${brief}Status: investigation pending.\n`,
    });
  skill('debug-log');
  const baseline =
    variant === 'no-reproduction' || variant === 'calls-only'
      ? '# tests 5\n# pass 4\n# fail 1\n'
      : bash('node --test test.mjs');
  const diagnosis =
    'sumUniqueIntegers in solution.mjs adds duplicate integers twice. Deduplicate the filtered integers before summation.\n';
  const baselineEvidence =
    variant === 'equivalent-summary'
      ? 'node --test test.mjs\nExit status: 1. 4/5 passed; one failure: counts repeated integers once (actual 2, expected 3).\n'
      : `node --test test.mjs\n${baseline}`;
  if (variant !== 'calls-only')
    artifacts({
      [path('diagnosis')]: diagnosis,
      [path('checks')]: baselineEvidence,
      [path('progress')]: `${brief}${diagnosis}${baselineEvidence}`,
    });
  skill('implement');
  if (variant !== 'calls-only') {
    shellWrite({ 'solution.mjs': corrected });
    artifacts({
      [path('work')]:
        'solution.mjs now uses a Set to deduplicate safe integers before summation.\n',
    });
  }
  skill('verify');
  const checked =
    variant === 'no-verification' || variant === 'calls-only'
      ? '# tests 5\n# pass 5\n# fail 0\n'
      : bash('node --test test.mjs');
  const finalEvidence =
    variant === 'equivalent-summary'
      ? 'node --test test.mjs\nExit status: 0. 5/5 passed; no failures.\n'
      : variant === 'partial-summary'
        ? 'node --test test.mjs\nExit status: 0. 4/5 passed; no failures.\n'
        : `node --test test.mjs\n${checked}`;
  if (variant !== 'calls-only')
    artifacts({
      [path('checks')]: finalEvidence,
      [path('progress')]:
        `${brief}${diagnosis}${baselineEvidence}\nCorrection: deduplicate in solution.mjs.\n${finalEvidence}`,
    });
  const report = {
    [path('report')]:
      variant === 'linked-report'
        ? 'sumUniqueIntegers now deduplicates safe integers. All five original checks passed; see .playbill/debug/checks.md. No unresolved work.\n'
        : variant === 'report-placeholder'
          ? 'sumUniqueIntegers duplicate correction report pending; see .playbill/debug/checks.md.\n'
          : `${brief}Duplicates are corrected; no remaining failure in these five checks.\n${finalEvidence}`,
  };
  if (variant === 'early-report') artifacts(report);
  skill('report');
  if (variant === 'early-report') bash('true');
  else if (variant !== 'calls-only') artifacts(report);
  if (variant === 'late-artifacts') shellWrite(pending);
  if (variant === 'calls-only') {
    write(join(f.cwd, 'solution.mjs'), corrected);
    for (const name of artifactNames)
      write(join(f.cwd, path(name)), 'No evidence recorded.\n');
  }
  events.push({ type: 'result', subtype: 'success', is_error: false });
  write(
    join(f.cwd, 'stdout.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  return { f, events };
}

test('suite verifier accepts an offline complete trace with native observation receipts and actual failing and passing checks', (t) => {
  const { f } = observedTrial(t);
  const verified = verifySuite(f.cwd);
  assert.equal(verified.passed, true, verified.error);
  assert.equal(verified.execution.observationVersion, 1);
  assert.equal(verified.execution.completedSteps.length, 5);
  assert.equal(verified.independentChecks.exitCode, 0);
});

for (const variant of ['linked-report', 'equivalent-summary'])
  test(`suite verifier accepts ${variant} with complete observed execution`, (t) => {
    const { f } = observedTrial(t, variant);
    const verified = verifySuite(f.cwd);
    assert.equal(verified.passed, true, verified.error);
    assert.equal(verified.execution.completedSteps.length, 5);
    assert.equal(verified.independentChecks.exitCode, 0);
  });

for (const [variant, error] of [
  ['calls-only', /Final files differ from observed execution/u],
  ['placeholders', /Missing fixture evidence/u],
  ['report-placeholder', /Missing fixture evidence/u],
  ['partial-summary', /Missing fixture evidence/u],
  ['late-artifacts', /Missing completed artifact/u],
  ['no-reproduction', /Missing failing original reproduction/u],
  [
    'early-correction',
    /Solution edited before original reproduction and correction step/u,
  ],
  ['no-verification', /Missing verification after correction/u],
  ['early-report', /Step did not produce .playbill\/debug\/report.md/u],
])
  test(`suite verifier rejects ${variant} despite passing final task checks`, (t) => {
    const { f } = observedTrial(t, variant);
    const verified = verifySuite(f.cwd);
    assert.equal(verified.passed, false);
    assert.equal(verified.independentChecks.exitCode, 0);
    assert.match(verified.error, error);
  });

test('suite verifier requires versioned observation provenance and trace-matching receipts', (t) => {
  const { f, events } = observedTrial(t);
  write(join(f.cwd, 'command.json'), '{}');
  assert.match(
    verifySuite(f.cwd).error,
    /Missing or incompatible suite observation protocol/u,
  );
  write(join(f.cwd, 'command.json'), JSON.stringify({ observationProtocol }));
  const receipt = events.find((event) =>
    event.stdout?.startsWith('playbill-suite-observation-v1'),
  );
  const name = receipt.stdout.split(' ')[1];
  write(join(f.cwd, '.suite-observations', name), '{}\n');
  assert.match(
    verifySuite(f.cwd).error,
    /Observation differs from native trace receipt/u,
  );
});

test('the shipped namespaced filesystem registry validates defaults through the documented core CLI', (t) => {
  const f = fixture(t);
  for (const { id, path } of f.registry) {
    const name = basename(dirname(path));
    assert.equal(id, `playbill:${name}`);
    assert.match(
      readFileSync(path, 'utf8'),
      new RegExp(`^---\\nname: ${name}\\n`, 'u'),
    );
  }
  for (const workflow of ['debug', 'plan', 'review', 'longshot']) {
    const result = spawnSync(
      process.execPath,
      [
        'dist/cli.js',
        'validate',
        `defaults/pipelines/${workflow}.yaml`,
        '--config',
        'defaults/config.toml',
        '--registry',
        'defaults/registry.yaml',
      ],
      { cwd: root, encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, `Valid: ${workflow}\n`);
  }
});

test('suite smoke verification preserves host context and usage when checks pass but workflow activation is incomplete', (t) => {
  const f = fixture(t);
  write(join(f.cwd, 'test.mjs'), originalChecks);
  write(join(f.cwd, 'original-test.mjs'), originalChecks);
  write(
    join(f.cwd, 'solution.mjs'),
    'export function sumUniqueIntegers(values) { if (!Array.isArray(values)) throw new TypeError(); return [...new Set(values.filter(Number.isSafeInteger))].reduce((sum, value) => sum + value, 0); }\n',
  );
  const context = 'Debug a reproducible failure\n';
  const events = [
    {
      subtype: 'hook_response',
      hook_event: 'UserPromptSubmit',
      exit_code: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: { additionalContext: context },
      }),
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.01,
    },
  ];
  write(
    join(f.cwd, 'stdout.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  const verification = verifySuite(f.cwd);
  assert.equal(verification.passed, false);
  assert.equal(verification.independentChecks.exitCode, 0);
  assert.equal(verification.adapterContext, context);
  assert.equal(verification.hostResult.total_cost_usd, 0.01);
  assert.equal(verification.missingArtifacts.length, 6);
  assert.match(verification.error, /Missing ordered native activation/u);
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.cwd, 'verification.json'), 'utf8')),
    JSON.parse(JSON.stringify(verification)),
  );
});
