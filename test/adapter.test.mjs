import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import {
  candidateFiles,
  matchesGlob,
  parseConfig,
  projectRoot,
  selectWorkflow,
} from '../dist/index.js';
import { discoverClaudeInventory } from '../dist/claude-inventory.js';
import { claudeContext } from '../dist/claude.js';
import { sessionStore } from '../dist/session-state.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const hook = join(root, 'adapters/claude/hook.mjs');
const runtime = join(root, 'dist/runtime-cli.js');
const pipeline = (id = 'coding', title = 'Fixture workflow') =>
  JSON.stringify({
    version: 1,
    id,
    title,
    artifacts: [{ id: 'result', path: 'result.txt' }],
    outputs: ['result'],
    steps: [
      {
        type: 'step',
        id: 'implement',
        title: 'Implement',
        skill: '{{implement}}',
        produces: ['result'],
      },
    ],
  });

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixture(t) {
  const base = mkdtempSync(join(root, '.test-runs-adapter-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'workspace');
  const personal = join(base, 'claude');
  const machine = join(base, 'machine');
  const defaults = join(base, 'defaults');
  for (const directory of [cwd, personal, machine, defaults])
    mkdirSync(directory);
  const config = join(cwd, '.playbill/config.toml');
  write(
    config,
    '[slots]\nimplement = "fixture-implement"\n[workflows.coding]\nentry = "auto"\n[workflows.coding.triggers]\nkeywords = ["implement"]\n',
  );
  write(join(cwd, '.playbill/pipelines/coding.yaml'), pipeline());
  const skill = join(cwd, '.claude/skills/fixture-implement/SKILL.md');
  write(
    skill,
    '---\nname: fixture-implement\ndescription: Test implementation skill\n---\nWrite the task result.\n',
  );
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: personal,
    PLAYBILL_PROJECT_ROOT: cwd,
    PLAYBILL_MACHINE_DIR: machine,
    PLAYBILL_DEFAULTS_DIR: defaults,
    PLAYBILL_STATE_DIR: join(base, 'state'),
  };
  delete env.PLAYBILL_CLAUDE_INVENTORY;
  const event = (values = {}, options = {}) => {
    const child = spawnSync(process.execPath, [hook], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd,
        session_id: 'session-one',
        prompt: '[playbill:coding] perform the task',
        ...values,
      }),
      ...options,
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const request = (values = {}) => {
    const child = spawnSync(process.execPath, [runtime], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      input: JSON.stringify({
        version: 1,
        cwd,
        event: 'prompt',
        prompt: '[playbill:coding] perform the task',
        discovery: {
          projectRoot: cwd,
          machineDir: machine,
          defaultsDir: defaults,
        },
        inventory: [
          {
            id: 'fixture-implement',
            path: skill,
            invocation: 'fixture-implement',
            model_invocable: true,
            requires: {},
          },
        ],
        ...values,
      }),
    });
    assert.ok(child.status === 0 || child.status === 1, child.stderr);
    return { status: child.status, ...JSON.parse(child.stdout) };
  };
  return {
    base,
    cwd,
    personal,
    machine,
    defaults,
    config,
    skill,
    env,
    event,
    request,
  };
}

const context = (output) => output.hookSpecificOutput.additionalContext;

function writeContextFixture(f, length, restore = false) {
  const document = JSON.parse(pipeline());
  document.steps = Array.from({ length: 6 }, (_, i) => ({
    ...document.steps[0],
    id: `step${i}`,
    instruction: '雪',
  }));
  const path = join(f.cwd, '.playbill/pipelines/coding.yaml');
  write(path, JSON.stringify(document));
  const result = f.request();
  assert.equal(result.ok, true);
  let remaining = length - claudeContext(result, restore).length;
  assert.ok(remaining >= 0);
  for (const step of document.steps) {
    const extra = Math.min(remaining, 1999);
    step.instruction = '雪'.repeat(extra + 1);
    remaining -= extra;
  }
  assert.equal(remaining, 0);
  write(path, JSON.stringify(document));
}

test('production hook startup validates but does not invent the first request', (t) => {
  const f = fixture(t);
  assert.equal(
    context(f.event({ hook_event_name: 'SessionStart', source: 'startup' })),
    '',
  );
  const output = f.event({ prompt: 'Please IMPLEMENT this task.' });
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(context(output), /Fixture workflow/u);
  assert.match(context(output), /Skill tool with skill="fixture-implement"/u);
});

test('Claude delivers complete contexts up to 10,000 characters and diagnoses overflow', (t) => {
  const f = fixture(t);
  for (const length of [9999, 10_000]) {
    writeContextFixture(f, length);
    const result = f.request();
    assert.equal(result.ok, true);
    const expected = claudeContext(result);
    assert.equal(expected.length, length);
    assert.ok(Buffer.byteLength(expected) > 10_000);
    assert.equal(context(f.event()), expected);
  }
  assert.throws(
    () => claudeContext({ ...f.request(), commonProse: '😀'.repeat(5000) }),
    /10,000 characters/u,
  );
  const restored = f.event({
    hook_event_name: 'SessionStart',
    source: 'compact',
  });
  assert.match(context(restored), /LIMIT:.*10,000 characters/u);
  assert.equal(restored.systemMessage, context(restored));
  assert.doesNotMatch(context(restored), /Fixture workflow/u);
  writeContextFixture(f, 10_001);
  const result = f.request();
  assert.equal(result.ok, true);
  assert.throws(() => claudeContext(result), /10,000 characters/u);
  const output = f.event();
  assert.match(context(output), /LIMIT:.*10,000 characters/u);
  assert.equal(output.systemMessage, context(output));
  assert.ok(context(output).length <= 10_000);
  assert.doesNotMatch(context(output), /Fixture workflow/u);
  write(join(f.cwd, '.playbill/pipelines/coding.yaml'), pipeline());
  assert.equal(
    context(f.event({ hook_event_name: 'SessionStart', source: 'compact' })),
    '',
  );
});

test('warnings and restoration text share the complete Claude output bound', (t) => {
  const f = fixture(t);
  f.event();
  f.event({ session_id: 'overflow' });
  const snapshot = join(f.base, 'inventory.json');
  write(
    snapshot,
    JSON.stringify({
      version: 1,
      skills: [
        {
          id: 'fixture-implement',
          path: f.skill,
          invocation: 'fixture-implement',
        },
      ],
      superpowers_bootstrap: { status: 'active', evidence: 'e'.repeat(2000) },
    }),
  );
  f.env.PLAYBILL_CLAUDE_INVENTORY = snapshot;
  const warning = f.event({
    hook_event_name: 'SessionStart',
    session_id: 'warning-probe',
  }).systemMessage;
  assert.match(warning, /Superpowers may also supply workflow instructions/u);
  writeContextFixture(f, 10_000 - warning.length - 2, true);
  const expected = `${claudeContext(f.request(), true)}\n\n${warning}`;
  const output = f.event({
    hook_event_name: 'SessionStart',
    source: 'compact',
  });
  assert.equal(context(output), expected);
  assert.equal(context(output).length, 10_000);
  assert.equal(output.systemMessage, warning);
  writeContextFixture(f, 10_001 - warning.length - 2, true);
  const overflow = f.event({
    hook_event_name: 'SessionStart',
    source: 'resume',
    session_id: 'overflow',
  });
  assert.match(context(overflow), /LIMIT:.*10,000 characters/u);
  assert.ok(context(overflow).length <= 10_000);
  assert.equal(overflow.systemMessage, context(overflow));
  assert.doesNotMatch(context(overflow), /Fixture workflow/u);
  write(join(f.cwd, '.playbill/pipelines/coding.yaml'), pipeline());
  const retry = f.event({
    hook_event_name: 'SessionStart',
    source: 'resume',
    session_id: 'overflow',
  });
  assert.equal(context(retry), warning);
  assert.equal(retry.systemMessage, warning);
});

test('oversized diagnostics remain bounded in both Claude output strings', (t) => {
  const f = fixture(t);
  const document = JSON.parse(pipeline());
  document['invalid'.repeat(2000)] = true;
  write(
    join(f.cwd, '.playbill/pipelines/coding.yaml'),
    JSON.stringify(document),
  );
  const output = f.event();
  assert.match(context(output), /^Playbill configuration error:/u);
  assert.match(
    context(output),
    /No workflow instructions were composed for this event\.$/u,
  );
  assert.ok(context(output).length <= 10_000);
  assert.equal(output.systemMessage, context(output));
});

test('defaults, machine and project merge policy fields but replace entire pipelines', (t) => {
  const f = fixture(t);
  write(
    join(f.defaults, 'config.toml'),
    '[slots]\nimplement = "absent-default"\n[workflows.coding]\npriority = 7\n[workflows.coding.triggers]\nkeywords = ["default-keyword"]\n',
  );
  write(
    join(f.defaults, 'pipelines/coding.yaml'),
    pipeline('coding', 'Default title'),
  );
  write(
    join(f.machine, 'config.toml'),
    '[slots]\nimplement = "absent-machine"\n[workflows.coding]\nentry = "explicit"\n',
  );
  write(
    join(f.machine, 'pipelines/coding.yaml'),
    pipeline('coding', 'Machine title'),
  );
  assert.match(f.request().commonProse, /Fixture workflow/u);
  rmSync(join(f.cwd, '.playbill/pipelines/coding.yaml'));
  assert.match(f.request().commonProse, /Machine title/u);
  rmSync(join(f.machine, 'pipelines/coding.yaml'));
  assert.match(f.request().commonProse, /Default title/u);
  assert.equal(f.request({ prompt: 'default-keyword' }).commonProse, '');
  assert.match(
    f.request({ prompt: 'implement' }).commonProse,
    /Default title/u,
  );
});

test('configuration edits are reflected immediately and errors clear restored selection', (t) => {
  const f = fixture(t);
  assert.match(context(f.event()), /Fixture workflow/u);
  write(
    f.config,
    '[slots]\nimplement = "missing"\n[workflows.coding]\nentry = "auto"\n',
  );
  const failed = f.event({
    hook_event_name: 'SessionStart',
    source: 'compact',
  });
  assert.match(context(failed), /UNINSTALLED_SKILL.*missing/u);
  assert.match(failed.systemMessage, /configuration error/u);
  write(
    f.config,
    '[slots]\nimplement = "fixture-implement"\n[workflows.coding]\nentry = "explicit"\n',
  );
  assert.equal(
    context(f.event({ hook_event_name: 'SessionStart', source: 'compact' })),
    '',
  );
  assert.equal(context(f.event({ prompt: 'implement' })), '');
  assert.match(context(f.event()), /Fixture workflow/u);
});

test('all bindings and workflows validate at startup, including unused bindings', (t) => {
  const f = fixture(t);
  write(
    f.config,
    '[slots]\nimplement = "fixture-implement"\nunused = "not-installed"\n',
  );
  assert.match(
    context(f.event({ hook_event_name: 'SessionStart' })),
    /config.slots.unused: UNINSTALLED_SKILL/u,
  );
  write(
    f.config,
    '[slots]\nimplement = "fixture-implement"\n[workflows.missing]\nentry = "disabled"\n',
  );
  assert.match(
    context(f.event({ hook_event_name: 'SessionStart' })),
    /MISSING_PIPELINE/u,
  );
});

test('missing optional files are fine; invalid layers and unreadable file shapes are errors', (t) => {
  const f = fixture(t);
  assert.equal(f.request().ok, true);
  write(join(f.machine, 'config.toml'), '[invalid');
  assert.equal(f.request().diagnostics[0].code, 'TOML_PARSE');
  rmSync(join(f.machine, 'config.toml'));
  mkdirSync(join(f.machine, 'config.toml'));
  assert.equal(f.request().diagnostics[0].code, 'READ');
  rmSync(join(f.machine, 'config.toml'), { recursive: true });
  write(join(f.machine, 'pipelines/one.yaml'), pipeline());
  write(join(f.machine, 'pipelines/two.yaml'), pipeline());
  assert.equal(f.request().diagnostics[0].code, 'AMBIGUOUS_PIPELINE');
});

test('configuration read permission errors are actionable, not optional absence', (t) => {
  const f = fixture(t);
  chmodSync(f.config, 0);
  try {
    const result = f.request();
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, 'READ');
    assert.match(result.diagnostics[0].message, /EACCES|EPERM/u);
  } finally {
    chmodSync(f.config, 0o600);
  }
});

test('explicit selection cannot fall through for disabled, unknown, or malformed requests', (t) => {
  const f = fixture(t);
  write(
    f.config,
    readFileSync(f.config, 'utf8').replace(
      'entry = "auto"',
      'entry = "disabled"',
    ),
  );
  assert.match(context(f.event()), /DISABLED_WORKFLOW/u);
  assert.equal(context(f.event({ prompt: 'implement' })), '');
  assert.match(
    context(f.event({ prompt: '[playbill:missing] implement' })),
    /UNKNOWN_WORKFLOW/u,
  );
  assert.match(
    context(f.event({ prompt: '[playbill:bad name] implement' })),
    /EXPLICIT_REQUEST/u,
  );
});

test('keywords are bounded literal Unicode-aware phrases, with deterministic priority and ties', () => {
  const config = parseConfig(
    '[workflows.zed.triggers]\nkeywords = ["fix bug", "C++"]\n[workflows.alpha.triggers]\nkeywords = ["fix bug"]\n[workflows.manual]\nentry = "explicit"\npriority = 100\n[workflows.manual.triggers]\nkeywords = ["fix bug"]\n',
  );
  const select = (prompt) =>
    selectWorkflow(config, prompt, [], { git: false, dirty: false });
  assert.deepEqual(select('Please FIX BUG.'), {
    workflow: 'alpha',
    explicit: false,
  });
  assert.deepEqual(select('prefix bug'), { explicit: false });
  assert.deepEqual(select('éfix bug'), { explicit: false });
  assert.deepEqual(select('fix bug_more'), { explicit: false });
  assert.deepEqual(select('Use C++ today'), {
    workflow: 'zed',
    explicit: false,
  });
  config.workflows.zed.priority = 1;
  assert.equal(select('fix bug').workflow, 'zed');
  assert.equal(select('  [playbill:manual] fix bug').workflow, 'manual');
});

test('portable globs match whole path segments and candidate files are explicit mentions', (t) => {
  assert.deepEqual(
    candidateFiles(
      'Work in `src/a.ts` and `README.md`, avoid `../escape` and `/absolute`.',
    ),
    ['src/a.ts', 'README.md'],
  );
  for (const [pattern, path, expected] of [
    ['src/**/a?.ts', 'src/a1.ts', true],
    ['src/**/a?.ts', 'src/x/y/a2.ts', true],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/x/a.ts', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'A.TS', false],
    ['src/?.ts', 'src/ab.ts', false],
    ['src/?.ts', 'src/😀.ts', true],
    ['src/?.ts', 'src/é.ts', false],
    ['src/*.ts', 'src/.ts', true],
    ['src/**', 'src', true],
    ['src/**', 'src/a/b', true],
    ['src/**/**', 'src', true],
    ['src/**/**', 'src/a/b', true],
    ['src/**/**/a?.ts', 'src/a😀.ts', true],
    ['src/**/**/a?.ts', 'src/x/y/a😀.ts', true],
    ['src/**/**/a?.ts', 'src/a/😀.ts', false],
    ['**/**', 'src/a.ts', true],
    ['**/src/**', 'src', true],
    ['**/src/**', 'other/src', true],
    ['src/**', 'other/src', false],
    ['src/**', 'SRC/a', false],
  ])
    assert.equal(matchesGlob(pattern, path), expected, `${pattern} ${path}`);
  const f = fixture(t);
  write(
    f.config,
    '[slots]\nimplement = "fixture-implement"\n[workflows.coding.triggers]\nfile_patterns = ["src/**"]\n',
  );
  assert.equal(context(f.event({ prompt: 'src/a.ts' })), '');
  assert.match(
    context(f.event({ prompt: 'Change `src/new.ts`.' })),
    /Fixture workflow/u,
  );
  assert.match(
    f.request({ prompt: 'change this', candidateFiles: ['src/new.ts'] })
      .commonProse,
    /Fixture workflow/u,
  );
  assert.equal(
    f.request({ candidateFiles: ['../outside.ts'] }).diagnostics[0].code,
    'CANDIDATE_FILES',
  );
});

test('adversarial portable globs finish within a bounded subprocess', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { matchesGlob } from './dist/index.js';
process.stdout.write(JSON.stringify([
  matchesGlob('*a'.repeat(20) + 'b', 'a'.repeat(40)),
  matchesGlob('*a'.repeat(20) + 'b', 'a'.repeat(40) + 'b'),
  matchesGlob('**/a/'.repeat(20) + 'b', 'a/'.repeat(40) + 'c'),
  matchesGlob('**/a/'.repeat(20) + 'b', 'a/'.repeat(40) + 'b'),
]));`,
    ],
    { cwd: root, encoding: 'utf8', timeout: 2000 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [false, true, false, true]);
});

test('repository guards are conjunctive and clean/dirty require Git', () => {
  const config = parseConfig(
    '[workflows.coding.triggers]\nrepo_conditions = ["git", "dirty"]\n',
  );
  assert.deepEqual(selectWorkflow(config, '', [], { git: true, dirty: true }), {
    workflow: 'coding',
    explicit: false,
  });
  assert.deepEqual(
    selectWorkflow(config, '', [], { git: false, dirty: true }),
    { explicit: false },
  );
  assert.deepEqual(
    selectWorkflow(config, '', [], { git: true, dirty: false }),
    { explicit: false },
  );
  config.workflows.coding.triggers.repo_conditions = ['clean'];
  assert.equal(
    selectWorkflow(config, '', [], { git: true, dirty: false }).workflow,
    'coding',
  );
  assert.equal(
    selectWorkflow(config, '[playbill:coding]', [], {
      git: false,
      dirty: false,
    }).workflow,
    'coding',
  );
});

test('project discovery works below Git root and with a nearest non-Git Playbill ancestor', (t) => {
  const f = fixture(t);
  const subdirectory = join(f.cwd, 'one/two');
  mkdirSync(subdirectory, { recursive: true });
  assert.equal(projectRoot(subdirectory), resolve(root));
  assert.equal(projectRoot(subdirectory, f.cwd), f.cwd);
  assert.throws(
    () => projectRoot(subdirectory, f.personal),
    /must contain the hook cwd/u,
  );
  const code =
    'import {projectRoot} from "./dist/index.js"; process.stdout.write(projectRoot(process.argv[1]));';
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code, subdirectory],
    {
      cwd: root,
      env: { ...f.env, GIT_CEILING_DIRECTORIES: f.base },
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, f.cwd);
  rmSync(join(f.cwd, '.playbill'), { recursive: true });
  const noConfig = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code, subdirectory],
    {
      cwd: root,
      env: { ...f.env, GIT_CEILING_DIRECTORIES: f.base },
      encoding: 'utf8',
    },
  );
  assert.equal(noConfig.status, 0, noConfig.stderr);
  assert.equal(noConfig.stdout, subdirectory);
});

test('native inventory uses frontmatter and personal precedence, and rechecks visibility', (t) => {
  const f = fixture(t);
  const personal = join(f.personal, 'skills/fixture-implement/SKILL.md');
  write(personal, readFileSync(f.skill, 'utf8'));
  const skills = discoverClaudeInventory(f.cwd, f.cwd, root, f.env).skills;
  assert.equal(
    skills.find((skill) => skill.id === 'fixture-implement').path,
    personal,
  );
  write(
    join(f.cwd, '.claude/settings.local.json'),
    '{"skillOverrides":{"fixture-implement":"user-invocable-only"}}',
  );
  assert.match(
    context(f.event({ hook_event_name: 'SessionStart' })),
    /SKILL_INVOCATION/u,
  );
  write(
    join(f.cwd, '.claude/settings.local.json'),
    '{"skillOverrides":{"fixture-implement":"on"}}',
  );
  assert.match(context(f.event()), /Fixture workflow/u);
  write(
    personal,
    readFileSync(f.skill, 'utf8').replace(
      'name: fixture-implement',
      'name: fixture-implement\ndisable-model-invocation: true',
    ),
  );
  assert.match(context(f.event()), /SKILL_INVOCATION/u);
});

test('arbitrary files and skill-directory plugins do not fabricate native installation', (t) => {
  const f = fixture(t);
  rmSync(f.skill);
  write(
    join(f.cwd, 'arbitrary/SKILL.md'),
    '---\nname: fixture-implement\n---\nA skill elsewhere.',
  );
  assert.match(
    context(f.event({ hook_event_name: 'SessionStart' })),
    /UNINSTALLED_SKILL/u,
  );
  write(f.skill, '---\nname: fixture-implement\n---\nA plugin root skill.');
  write(
    join(dirname(f.skill), '.claude-plugin/plugin.json'),
    '{"name":"fixture-plugin"}',
  );
  assert.match(context(f.event()), /UNINSTALLED_SKILL/u);
});

test('normalized inventory separates canonical prose from namespace-qualified native invocation', (t) => {
  const f = fixture(t);
  const snapshot = join(f.base, 'inventory.json');
  write(
    snapshot,
    JSON.stringify({
      version: 1,
      skills: [
        {
          id: 'fixture-implement',
          path: f.skill,
          invocation: 'company:fixture-implement',
        },
      ],
    }),
  );
  f.env.PLAYBILL_CLAUDE_INVENTORY = snapshot;
  assert.match(
    context(f.event()),
    /Skill tool with skill="company:fixture-implement"/u,
  );
  const first = f.request();
  const second = f.request({
    inventory: [
      {
        id: 'fixture-implement',
        path: f.skill,
        invocation: 'company:fixture-implement',
        model_invocable: true,
        requires: {},
      },
    ],
  });
  assert.equal(first.commonProse, second.commonProse);
  assert.equal(second.invocations[0].invocation, 'company:fixture-implement');
  assert.ok(claudeContext(second).startsWith(second.commonProse));
  write(
    snapshot,
    JSON.stringify({
      version: 1,
      skills: [
        {
          id: 'fixture-implement',
          path: f.skill,
          invocation: 'company:wrong-name',
        },
      ],
    }),
  );
  assert.match(context(f.event()), /NATIVE_INVOCATION/u);
});

test('ambiguous native project skills require an explicit inventory', (t) => {
  const f = fixture(t);
  const nested = join(f.cwd, 'nested');
  write(
    join(nested, '.claude/skills/fixture-implement/SKILL.md'),
    readFileSync(f.skill, 'utf8'),
  );
  assert.match(context(f.event({ cwd: nested })), /AMBIGUOUS_SKILL/u);
});

test('a directory/frontmatter mismatch fails only when bound, and explicit inventory can attest the observed basename', (t) => {
  const f = fixture(t);
  const path = join(f.cwd, '.claude/skills/native-name/SKILL.md');
  write(path, '---\nname: canonical-name\n---\nNative identity fixture.');
  assert.match(context(f.event()), /Fixture workflow/u);
  write(
    f.config,
    readFileSync(f.config, 'utf8').replace(
      'fixture-implement',
      'canonical-name',
    ),
  );
  assert.match(context(f.event()), /PLAYBILL_CLAUDE_INVENTORY/u);
  const snapshot = join(f.base, 'mismatch-inventory.json');
  write(
    snapshot,
    JSON.stringify({
      version: 1,
      skills: [{ id: 'canonical-name', path, invocation: 'native-name' }],
    }),
  );
  f.env.PLAYBILL_CLAUDE_INVENTORY = snapshot;
  assert.match(context(f.event()), /Skill tool with skill="native-name"/u);
});

test('attested symlink directory aliases retain canonical registry and ambiguity checks', (t) => {
  const f = fixture(t);
  const shared = join(f.base, 'shared/playbill-smoke-implement/SKILL.md');
  write(shared, '---\nname: playbill-smoke-implement\n---\nShared skill.');
  const installed = join(f.cwd, '.claude/skills/native-alias');
  const second = join(f.personal, 'skills/native-alias');
  mkdirSync(dirname(second), { recursive: true });
  symlinkSync(dirname(shared), installed, 'dir');
  symlinkSync(dirname(shared), second, 'dir');
  const snapshot = join(f.base, 'inventory.json');
  write(
    snapshot,
    JSON.stringify({
      version: 1,
      skills: [
        {
          id: 'fixture-implement',
          path: relative(dirname(snapshot), join(installed, 'SKILL.md')),
          invocation: 'native-alias',
        },
        {
          id: 'shared-alias',
          path: join(second, 'SKILL.md'),
          invocation: 'native-alias',
        },
      ],
    }),
  );
  f.env.PLAYBILL_CLAUDE_INVENTORY = snapshot;
  const inventory = discoverClaudeInventory(f.cwd, f.cwd, root, f.env);
  assert.deepEqual(
    inventory.skills.map(({ path, invocation }) => ({ path, invocation })),
    [
      { path: realpathSync(shared), invocation: 'native-alias' },
      { path: realpathSync(shared), invocation: 'native-alias' },
    ],
  );
  assert.match(context(f.event()), /Skill tool with skill="native-alias"/u);
  rmSync(second);
  write(join(second, 'SKILL.md'), readFileSync(shared, 'utf8'));
  assert.match(context(f.event()), /AMBIGUOUS_SKILL/u);
});

test('Superpowers installation alone does not warn; enabled settings warn once per session', (t) => {
  const f = fixture(t);
  write(
    join(f.personal, 'skills/using-superpowers/SKILL.md'),
    '---\nname: using-superpowers\n---\nBootstrap.',
  );
  assert.equal(
    f.event({ hook_event_name: 'SessionStart' }).systemMessage,
    undefined,
  );
  write(
    join(f.personal, 'settings.json'),
    '{"enabledPlugins":{"superpowers@marketplace":true}}',
  );
  assert.match(
    f.event().systemMessage,
    /Superpowers may also supply workflow instructions/u,
  );
  assert.equal(f.event().systemMessage, undefined);
  assert.equal(
    f.event({ hook_event_name: 'SessionStart', source: 'compact' })
      .systemMessage,
    undefined,
  );
  assert.match(
    f.event({ session_id: 'another-session' }).systemMessage,
    /Superpowers/u,
  );
});

test('compaction/resume restores the current declaration while clear and errors forget selection', (t) => {
  const f = fixture(t);
  f.event();
  write(
    join(f.cwd, '.playbill/pipelines/coding.yaml'),
    pipeline('coding', 'Edited workflow'),
  );
  const compact = f.event({
    hook_event_name: 'SessionStart',
    source: 'compact',
  });
  assert.match(context(compact), /Edited workflow/u);
  assert.match(context(compact), /Continue from the conversation summary/u);
  assert.match(
    context(f.event({ hook_event_name: 'SessionStart', source: 'resume' })),
    /Edited workflow/u,
  );
  assert.match(
    context(f.event({ hook_event_name: 'SessionStart', source: 'compact' })),
    /Edited workflow/u,
  );
  assert.equal(
    context(f.event({ hook_event_name: 'SessionStart', source: 'clear' })),
    '',
  );
  assert.equal(
    context(f.event({ hook_event_name: 'SessionStart', source: 'compact' })),
    '',
  );
});

test('entry policy changes affect future entry and preserve the active workflow reference', (t) => {
  const f = fixture(t);
  f.event();
  write(
    f.config,
    readFileSync(f.config, 'utf8').replace(
      'entry = "auto"',
      'entry = "disabled"',
    ),
  );
  assert.match(
    context(f.event({ hook_event_name: 'SessionStart', source: 'compact' })),
    /Fixture workflow/u,
  );
  assert.match(context(f.event()), /DISABLED_WORKFLOW/u);
  assert.equal(
    context(f.event({ hook_event_name: 'SessionStart', source: 'compact' })),
    '',
  );
});

test('JSON protocol preserves quotes, newlines, and Unicode without shell interpolation', (t) => {
  const f = fixture(t);
  write(
    join(f.cwd, '.playbill/pipelines/coding.yaml'),
    pipeline('coding', 'Workflow "雪"'),
  );
  const command = JSON.parse(
    readFileSync(join(root, 'adapters/claude/hooks.json'), 'utf8'),
  ).hooks.UserPromptSubmit[0].hooks[0].command;
  const plugin = join(f.base, 'plugin $(touch INJECTED) with spaces');
  symlinkSync(root, plugin, 'dir');
  const child = spawnSync('sh', ['-c', command], {
    cwd: f.cwd,
    env: { ...f.env, CLAUDE_PLUGIN_ROOT: plugin },
    encoding: 'utf8',
    timeout: 10_000,
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd: f.cwd,
      session_id: 'quotes',
      prompt: '[playbill:coding]\n"$(touch INJECTED)" 雪',
    }),
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(context(JSON.parse(child.stdout)), /Workflow "雪"/u);
  assert.deepEqual(readdirSync(f.cwd).sort(), ['.claude', '.playbill']);
});

test('subprocess rejects oversized and malformed input with a complete error response', (t) => {
  const f = fixture(t);
  for (const input of [
    '{"broken":',
    JSON.stringify({ prompt: 'x'.repeat(262_145) }),
  ]) {
    const child = spawnSync(process.execPath, [runtime], {
      cwd: f.cwd,
      env: f.env,
      encoding: 'utf8',
      input,
      timeout: 10_000,
    });
    assert.equal(child.status, 1, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.commonProse, '');
    assert.equal(result.diagnostics.length, 1);
  }
});

test('session storage bounds history and stores only composition identity and warning state', (t) => {
  const f = fixture(t);
  const directory = join(f.base, 'bounded-state');
  for (let i = 0; i < 132; i++)
    sessionStore(directory, `session-${i}`).write({
      version: 1,
      warned: true,
      selected: 'coding',
    });
  assert.equal(readdirSync(directory).length, 128);
  assert.deepEqual(sessionStore(directory, 'session-131').read(), {
    version: 1,
    warned: true,
    selected: 'coding',
  });
});
