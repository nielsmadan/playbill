import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import {
  discoverAndLoadExtensions,
  loadSkillsFromDir,
} from '@earendil-works/pi-coding-agent';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { PlaybillPlugin } from '../adapters/opencode/playbill.js';
import { nativeContext } from '../dist/adapter-session.js';
import { canonicalId, nativeSnapshot } from '../dist/native-inventory.js';
import { codexSkills } from '../dist/codex-inventory.js';
import { piInventory } from '../dist/pi.js';
import { opencodeInventory } from '../dist/opencode.js';
import { runRuntime } from '../dist/runtime.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};
const skillText =
  '---\nname: fixture-implement\ndescription: Test implementation\n---\nWrite result.txt.\n';
const pipeline = {
  version: 1,
  id: 'coding',
  title: 'Portable workflow',
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
};

async function fixture(
  t,
  { bundled = false, subdirectory = false, opencodeStartup = true } = {},
) {
  const cwd = mkdtempSync(join(root, '.test-runs-conformance-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const packageRoot = bundled ? join(cwd, 'package') : root;
  if (bundled)
    for (const path of ['dist', 'adapters'])
      cpSync(join(root, path), join(packageRoot, path), { recursive: true });
  if (bundled) write(join(packageRoot, 'package.json'), '{"type":"module"}');
  const launch = subdirectory ? join(cwd, 'nested') : cwd;
  mkdirSync(launch, { recursive: true });
  const config = join(cwd, '.playbill/config.toml');
  write(
    config,
    '[slots]\nimplement="company/custom@v1"\n[workflows.coding]\nentry="auto"\n[workflows.coding.triggers]\nkeywords=["implement"]\n',
  );
  write(join(cwd, '.playbill/pipelines/coding.yaml'), JSON.stringify(pipeline));
  const skill = join(
    bundled ? packageRoot : cwd,
    'skills/fixture-implement/SKILL.md',
  );
  write(skill, skillText);
  const snapshot = join(cwd, 'inventory.json');
  write(
    snapshot,
    JSON.stringify({
      version: 1,
      skills: [
        {
          id: 'company/custom@v1',
          path: skill,
          invocation: 'fixture-implement',
        },
      ],
    }),
  );
  const env = {
    PLAYBILL_PROJECT_ROOT: cwd,
    PLAYBILL_MACHINE_DIR: join(cwd, 'machine'),
    PLAYBILL_DEFAULTS_DIR: join(cwd, 'defaults'),
    PLAYBILL_STATE_DIR: join(cwd, 'state'),
    CLAUDE_CONFIG_DIR: join(cwd, 'claude'),
    PLAYBILL_CLAUDE_INVENTORY: snapshot,
    PLAYBILL_CODEX_INVENTORY: snapshot,
    PLAYBILL_PI_INVENTORY: snapshot,
    PLAYBILL_OPENCODE_INVENTORY: snapshot,
    PLAYBILL_NODE: process.execPath,
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const hook = (host, prompt, event = {}) => {
    const child = spawnSync(
      process.execPath,
      [join(packageRoot, `adapters/${host}/hook.mjs`)],
      {
        cwd: launch,
        env: { ...process.env, ...env },
        input: JSON.stringify({
          cwd: launch,
          session_id: 'one',
          hook_event_name: 'UserPromptSubmit',
          prompt,
          ...event,
        }),
        encoding: 'utf8',
        timeout: 9000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout).hookSpecificOutput.additionalContext;
  };
  const loaded = await discoverAndLoadExtensions(
    [join(packageRoot, 'adapters/pi/playbill.ts')],
    launch,
    join(cwd, 'pi-agent'),
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const handlers = loaded.extensions[0].handlers;
  const nativePi = () =>
    loadSkillsFromDir({ dir: dirname(dirname(skill)), source: 'test' }).skills;
  const ctx = {
    cwd: launch,
    hasUI: false,
    sessionManager: { getSessionId: () => 'one' },
  };
  const pi = async (event, values = {}) => {
    let output;
    for (const handler of handlers.get(event) ?? [])
      output = await handler({ type: event, ...values }, ctx);
    return output;
  };
  await pi('session_start', { reason: 'startup' });
  await pi('resources_discover', { cwd, reason: 'startup' });
  let commands = [
    {
      name: 'fixture-implement',
      source: 'skill',
      template: `Write result.txt.\n\nBase directory for this skill: ${dirname(skill)}\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.`,
    },
  ];
  const requests = [];
  let nextCommand;
  const client = createOpencodeClient({
    baseUrl: 'http://native.invalid',
    fetch: async (request) => {
      requests.push(request.url);
      assert.equal(new URL(request.url).pathname, '/command');
      const body = JSON.stringify(commands);
      const delayed = nextCommand;
      nextCommand = undefined;
      if (delayed) {
        delayed.started.resolve();
        await delayed.response.promise;
      }
      return new globalThis.Response(body, {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const factory = bundled
    ? (
        await import(
          pathToFileURL(join(packageRoot, 'adapters/opencode/playbill.js')).href
        )
      ).PlaybillPlugin
    : PlaybillPlugin;
  const createOpencode = () => factory({ client, directory: launch });
  const opencode = await createOpencode();
  const ocConfig = {
    skills: {
      paths: ['/custom/skills'],
      urls: ['https://example.invalid/skills'],
    },
  };
  await opencode.config(ocConfig);
  await opencode.config(ocConfig);
  assert.deepEqual(ocConfig.skills, {
    paths: ['/custom/skills', join(packageRoot, 'skills')],
    urls: ['https://example.invalid/skills'],
  });
  if (opencodeStartup)
    await opencode.event({
      event: { type: 'session.created', properties: { info: { id: 'one' } } },
    });
  let sequence = 0;
  const user = (prompt, id = `user-${++sequence}`) => ({
    info: { role: 'user', id, sessionID: 'one' },
    parts: [
      {
        type: 'text',
        text: prompt,
        id: `part-${id}`,
        sessionID: 'one',
        messageID: id,
      },
    ],
  });
  const transform = async (messages) => {
    const output = { messages };
    await opencode['experimental.chat.messages.transform']({}, output);
    return output.messages;
  };
  const contexts = async (prompt) => {
    const claude = hook('claude', prompt);
    const codex = hook('codex', prompt);
    await pi('before_agent_start', {
      prompt,
      systemPrompt: 'Native system prompt',
      systemPromptOptions: { cwd, skills: nativePi() },
    });
    const piOut = await pi('context', {
      messages: [{ role: 'user', content: prompt, timestamp: 1 }],
    });
    const message = user(prompt);
    await opencode['chat.message'](
      { sessionID: 'one' },
      { message: message.info, parts: message.parts },
    );
    const ocOut = await transform([message]);
    return {
      claude,
      codex,
      pi:
        piOut.messages.find(
          (message) => message.customType === 'playbill:workflow',
        )?.content ?? '',
      opencode:
        ocOut[0].parts.find((part) => part.metadata?.playbill)?.text ?? '',
    };
  };
  return {
    cwd,
    config,
    skill,
    snapshot,
    env,
    hook,
    pi,
    nativePi,
    opencode,
    createOpencode,
    requests,
    user,
    transform,
    contexts,
    delayNextCommand: () => {
      const started = Promise.withResolvers();
      const response = Promise.withResolvers();
      nextCommand = { started, response };
      return { started: started.promise, ...response };
    },
    setCommands: (value) => {
      commands = value;
    },
  };
}

const common = (context, host) =>
  context.split(
    `\n${host === 'claude' ? 'Claude' : host} skill invocation:`,
  )[0];

test('four real adapter entrypoints render byte-identical common prose through the shared executable', async (t) => {
  const f = await fixture(t);
  for (const prompt of [
    'implement the task',
    '[playbill:coding] perform the task',
  ]) {
    const contexts = await f.contexts(prompt);
    const results = Object.entries(contexts).map(([host, context]) => {
      assert.match(context, /company\/custom@v1/);
      assert.match(context, /fixture-implement/);
      return Buffer.from(common(context, host));
    });
    for (const result of results) assert.deepEqual(result, results[0]);
    const direct = runRuntime({
      version: 1,
      cwd: f.cwd,
      event: 'prompt',
      prompt,
      discovery: {
        projectRoot: f.cwd,
        machineDir: f.env.PLAYBILL_MACHINE_DIR,
        defaultsDir: f.env.PLAYBILL_DEFAULTS_DIR,
      },
      inventory: nativeSnapshot(f.snapshot, 'codex'),
    });
    assert.equal(results[0].toString(), direct.commonProse);
  }
  assert.ok(f.requests.length > 0);
});

test('all four entrypoints support nonmatching and explicit disabled entry, and clear failed selection', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.contexts('hello'), {
    claude: '',
    codex: '',
    pi: '',
    opencode: '',
  });
  await f.contexts('implement');
  write(
    f.config,
    readFileSync(f.config, 'utf8').replace('entry="auto"', 'entry="disabled"'),
  );
  for (const context of Object.values(
    await f.contexts('[playbill:coding] perform'),
  ))
    assert.match(context, /DISABLED_WORKFLOW/);
  write(
    f.config,
    readFileSync(f.config, 'utf8').replace('entry="disabled"', 'entry="auto"'),
  );
  for (const host of ['claude', 'codex'])
    assert.equal(
      f.hook(host, '', { hook_event_name: 'SessionStart', source: 'compact' }),
      '',
    );
  await f.pi('session_compact', {});
  assert.deepEqual((await f.pi('context', { messages: [] })).messages, []);
  await f.opencode.event({
    event: { type: 'session.compacted', properties: { sessionID: 'one' } },
  });
  const restored = await f.transform([f.user('summary', 'summary')]);
  assert.equal(restored[0].parts.length, 1);
});

test('all adapters surface invalid startup bindings before model context is delivered', async (t) => {
  const f = await fixture(t);
  write(f.config, '[slots]\nimplement="missing"\n');
  for (const host of ['claude', 'codex'])
    assert.match(
      f.hook(host, '', { hook_event_name: 'SessionStart', source: 'startup' }),
      /UNINSTALLED_SKILL/,
    );
  await f.pi('before_agent_start', {
    prompt: 'hello',
    systemPromptOptions: { cwd: f.cwd, skills: f.nativePi() },
  });
  assert.match(
    (await f.pi('context', { messages: [] })).messages[0].content,
    /UNINSTALLED_SKILL/,
  );
  await f.opencode.event({
    event: { type: 'session.created', properties: { info: { id: 'one' } } },
  });
  const out = await f.transform([f.user('hello')]);
  assert.match(out[0].parts.at(-1).text, /UNINSTALLED_SKILL/);
});

test('Pi and OpenCode preserve native context and reinject once after compaction', async (t) => {
  const f = await fixture(t);
  const initial = await f.contexts('implement');
  write(
    f.config,
    readFileSync(f.config, 'utf8').replace('entry="auto"', 'entry="disabled"'),
  );
  const messages = [
    {
      role: 'compactionSummary',
      summary: 'Completed step one.',
      tokensBefore: 100,
      timestamp: 1,
    },
    { role: 'user', content: 'Continue', timestamp: 2 },
  ];
  await f.pi('session_compact', {});
  const once = await f.pi('context', { messages });
  const twice = await f.pi('context', { messages: once.messages });
  assert.deepEqual(twice, once);
  assert.deepEqual(once.messages.slice(0, 2), messages);
  assert.equal(
    common(once.messages[2].content, 'pi'),
    common(initial.pi, 'pi'),
  );
  assert.match(once.messages[2].content, /Workflow reference restored/);
  await f.pi('session_start', { reason: 'resume' });
  await f.pi('before_agent_start', {
    prompt: 'Continue',
    systemPromptOptions: { cwd: f.cwd, skills: f.nativePi() },
  });
  await f.pi('session_compact', {});
  assert.match(
    (await f.pi('context', { messages })).messages.at(-1).content,
    /Workflow reference restored/,
  );
  const current = f.user('implement', 'user-1');
  const summary = {
    info: { role: 'assistant', id: 'summary', sessionID: 'one' },
    parts: [{ type: 'text', text: 'Completed step one.' }],
  };
  await f.opencode.event({
    event: { type: 'session.compacted', properties: { sessionID: 'one' } },
  });
  const ocOnce = await f.transform([summary, current]);
  const ocTwice = await f.transform(globalThis.structuredClone(ocOnce));
  assert.deepEqual(ocTwice, ocOnce);
  assert.deepEqual(ocOnce[0], summary);
  assert.equal(ocOnce[1].parts[0].text, 'implement');
  assert.equal(
    common(ocOnce[1].parts[1].text, 'opencode'),
    common(initial.opencode, 'opencode'),
  );
});

test('Pi native inventory cannot be enabled through an alias snapshot', async (t) => {
  const f = await fixture(t);
  const skills = f.nativePi();
  skills[0].disableModelInvocation = true;
  assert.equal(piInventory(skills)[0].model_invocable, false);
  assert.match(piInventory([])[0].unavailableReason, /current native registry/);
  const duplicated = [
    skills[0],
    { ...skills[0], filePath: join(f.cwd, 'duplicate/SKILL.md') },
  ];
  write(duplicated[1].filePath, skillText);
  assert.throws(() => piInventory(duplicated), /AMBIGUOUS_SKILL/);
});

test('Pi routes with an unrelated description-only native skill and preserves its explicit alias', async (t) => {
  const f = await fixture(t);
  const implicit = join(f.cwd, 'skills/native-implicit-name/SKILL.md');
  write(
    implicit,
    '---\ndescription: Native implicit name\n---\nRead the task.\n',
  );
  const loaded = loadSkillsFromDir({
    dir: join(f.cwd, 'skills'),
    source: 'test',
  });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(
    piInventory(loaded.skills, {}).map(({ id, model_invocable }) => ({
      id,
      model_invocable,
    })),
    [
      { id: 'fixture-implement', model_invocable: true },
      { id: 'native-implicit-name', model_invocable: true },
    ],
  );
  await f.pi('before_agent_start', {
    prompt: 'implement',
    systemPromptOptions: { cwd: f.cwd, skills: loaded.skills },
  });
  assert.match(
    (await f.pi('context', { messages: [] })).messages[0].content,
    /^Portable workflow/,
  );
  write(
    f.snapshot,
    JSON.stringify({
      version: 1,
      skills: [
        {
          id: 'company/custom@v1',
          path: implicit,
          invocation: 'native-implicit-name',
        },
      ],
    }),
  );
  const alias = piInventory(loaded.skills)[0];
  assert.equal(alias.id, 'company/custom@v1');
  assert.equal(alias.invocation, 'native-implicit-name');
  assert.equal(alias.path, implicit);
  assert.equal(alias.model_invocable, true);
  await f.pi('before_agent_start', {
    prompt: 'implement',
    systemPromptOptions: { cwd: f.cwd, skills: loaded.skills },
  });
  const context = (await f.pi('context', { messages: [] })).messages[0].content;
  assert.match(context, /^Portable workflow/);
  assert.match(context, /native name "native-implicit-name"/);
  write(
    implicit,
    '---\ndescription: Native implicit name\ndisable-model-invocation: true\n---\nRead the task.\n',
  );
  const disabled = loadSkillsFromDir({
    dir: join(f.cwd, 'skills'),
    source: 'test',
  });
  assert.deepEqual(disabled.diagnostics, []);
  assert.equal(piInventory(disabled.skills)[0].model_invocable, false);
});

test('Pi uses the native installed symlink name for description-only skill aliases', async (t) => {
  const f = await fixture(t);
  const target = join(f.cwd, 'external-source/SKILL.md');
  const installed = join(f.cwd, 'skills/installed-name');
  write(
    target,
    '---\ndescription: Installed under an alias\n---\nRead the task.\n',
  );
  symlinkSync(dirname(target), installed, 'dir');
  const loaded = loadSkillsFromDir({ dir: installed, source: 'test' });
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.skills[0].name, 'installed-name');
  assert.equal(piInventory(loaded.skills, {})[0].invocation, 'installed-name');
  write(
    f.snapshot,
    JSON.stringify({
      version: 1,
      skills: [
        {
          id: 'company/custom@v1',
          path: target,
          invocation: 'installed-name',
        },
      ],
    }),
  );
  assert.equal(piInventory(loaded.skills)[0].model_invocable, true);
  assert.equal(piInventory(loaded.skills)[0].id, 'company/custom@v1');
});

test('native Codex policy and ambiguity are preserved, and malformed unrelated metadata is unavailable', async (t) => {
  const f = await fixture(t);
  const entry = {
    name: 'fixture-implement',
    path: f.skill,
    enabled: true,
    scope: 'repo',
    description: 'Fixture',
  };
  const response = (skills) => ({ data: [{ cwd: f.cwd, errors: [], skills }] });
  assert.equal(codexSkills(response([entry]), f.cwd)[0].model_invocable, true);
  write(
    join(dirname(f.skill), 'agents/openai.yaml'),
    'policy:\n  allow_implicit_invocation: false\n',
  );
  assert.equal(codexSkills(response([entry]), f.cwd)[0].model_invocable, false);
  assert.throws(() => nativeSnapshot(f.snapshot, 'codex'), /cannot enable/);
  assert.throws(
    () => codexSkills(response([entry, entry]), f.cwd),
    /AMBIGUOUS_SKILL/,
  );
  write(
    f.skill,
    '---\nname: fixture-implement\ndescription: bad: YAML\n---\nSkill\n',
  );
  const native = codexSkills(response([entry]), f.cwd)[0];
  assert.equal(native.model_invocable, false);
  assert.match(native.unavailableReason, /YAML_PARSE/);
  const bound = runRuntime({
    version: 1,
    cwd: f.cwd,
    event: 'start',
    discovery: {
      projectRoot: f.cwd,
      machineDir: f.env.PLAYBILL_MACHINE_DIR,
      defaultsDir: f.env.PLAYBILL_DEFAULTS_DIR,
    },
    inventory: [{ ...native, id: 'company/custom@v1' }],
  });
  assert.equal(bound.ok, false);
  assert.equal(bound.diagnostics[0].code, 'SKILL_INVOCATION');
  assert.match(bound.diagnostics[0].message, /YAML_PARSE/);
});

test('OpenCode uses authenticated SDK transport and corroborates files without assuming app.skills exists', async (t) => {
  const f = await fixture(t);
  delete process.env.PLAYBILL_OPENCODE_INVENTORY;
  const out = await f.contexts('implement');
  assert.match(out.opencode, /UNINSTALLED_SKILL/);
  const commands = [
    {
      name: 'fixture-implement',
      source: 'skill',
      template: `Different body.\n\nBase directory for this skill: ${dirname(f.skill)}\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.`,
    },
  ];
  assert.throws(() => opencodeInventory(commands), /disagrees/);
  assert.deepEqual(
    opencodeInventory([
      {
        name: 'fixture-implement',
        template: 'shadow command',
        source: 'command',
      },
    ]),
    [],
  );
  process.env.PLAYBILL_OPENCODE_INVENTORY = f.snapshot;
  assert.equal(
    opencodeInventory([
      {
        name: 'fixture-implement',
        source: 'command',
        template: 'shadow command',
      },
    ])[0].id,
    'company/custom@v1',
  );
});

test('OpenCode ignores delayed startup success and failure after a prompt selects a workflow', async (t) => {
  for (const outcome of ['success', 'failure'])
    await t.test(outcome, async (t) => {
      const f = await fixture(t, { opencodeStartup: false });
      const delayed = f.delayNextCommand();
      const startup = f.opencode.event({
        event: { type: 'session.created', properties: { info: { id: 'one' } } },
      });
      await delayed.started;
      const message = f.user('implement');
      await f.opencode['chat.message']({ sessionID: 'one' }, {});
      const selected = await f.transform([message]);
      assert.match(selected[0].parts.at(-1).text, /^Portable workflow/);
      if (outcome === 'success') delayed.resolve();
      else delayed.reject(new Error('Startup inventory failed'));
      await startup;
      assert.deepEqual(
        await f.transform(globalThis.structuredClone(selected)),
        selected,
      );
      const attached = await f.createOpencode();
      const restored = { messages: [f.user('summary', 'summary')] };
      await attached['experimental.chat.messages.transform']({}, restored);
      assert.match(
        restored.messages[0].parts.at(-1).text,
        /^Portable workflow/,
      );
      assert.match(
        restored.messages[0].parts.at(-1).text,
        /Workflow reference restored/,
      );
      await f.opencode.event({
        event: { type: 'session.compacted', properties: { sessionID: 'one' } },
      });
      assert.match(
        (await f.transform([f.user('summary')]))[0].parts.at(-1).text,
        /Workflow reference restored/,
      );
      write(
        join(f.cwd, '.playbill/pipelines/second.yaml'),
        JSON.stringify({ ...pipeline, id: 'second', title: 'Second workflow' }),
      );
      write(
        f.config,
        `${readFileSync(f.config, 'utf8')}\n[workflows.second]\nentry="explicit"\n`,
      );
      await f.opencode['chat.message']({ sessionID: 'one' }, {});
      assert.match(
        (await f.transform([f.user('[playbill:second] continue')]))[0].parts.at(
          -1,
        ).text,
        /^Second workflow/,
      );
    });
});

test('OpenCode retains constructor errors from unawaited startup until transform and recovers after repair', async (t) => {
  const f = await fixture(t, { opencodeStartup: false });
  process.env.PLAYBILL_STATE_DIR = 'relative';
  void f.opencode.event({
    event: { type: 'session.created', properties: { info: { id: 'one' } } },
  });
  await setImmediate();
  await f.opencode['chat.message']({ sessionID: 'one' }, {});
  process.env.PLAYBILL_STATE_DIR = f.env.PLAYBILL_STATE_DIR;
  const message = f.user('implement');
  const failed = await f.transform([message]);
  const diagnostic = failed[0].parts.at(-1).text;
  assert.match(diagnostic, /^Playbill configuration error:/);
  assert.match(diagnostic, /State directory must be absolute/);
  assert.ok(Buffer.byteLength(diagnostic) < 4096);
  const repaired = await f.transform(globalThis.structuredClone(failed));
  assert.equal(repaired[0].parts.length, 2);
  assert.match(repaired[0].parts.at(-1).text, /^Portable workflow/);
});

test('OpenCode defers construction safely from chat and unawaited compaction and retries failed transforms', async (t) => {
  for (const hook of ['chat.message', 'session.compacted', 'transform'])
    await t.test(hook, async (t) => {
      const f = await fixture(t, { opencodeStartup: false });
      process.env.PLAYBILL_PROJECT_ROOT = 'relative';
      if (hook === 'chat.message')
        await f.opencode['chat.message']({ sessionID: 'one' }, {});
      if (hook === 'session.compacted') {
        void f.opencode.event({
          event: {
            type: 'session.compacted',
            properties: { sessionID: 'one' },
          },
        });
        await setImmediate();
      }
      const failed = await f.transform([f.user('implement')]);
      assert.match(
        failed[0].parts.at(-1).text,
        /Expected an absolute directory/,
      );
      process.env.PLAYBILL_PROJECT_ROOT = f.env.PLAYBILL_PROJECT_ROOT;
      const repaired = await f.transform(globalThis.structuredClone(failed));
      assert.equal(repaired[0].parts.length, 2);
      assert.match(repaired[0].parts.at(-1).text, /^Portable workflow/);
    });
});

test('OpenCode bounds pending constructor diagnostics to 128 session records', async (t) => {
  const f = await fixture(t, { opencodeStartup: false });
  process.env.PLAYBILL_STATE_DIR = 'relative';
  for (let index = 0; index < 129; index++)
    void f.opencode.event({
      event: {
        type: 'session.created',
        properties: { info: { id: `session-${index}` } },
      },
    });
  await setImmediate();
  process.env.PLAYBILL_STATE_DIR = f.env.PLAYBILL_STATE_DIR;
  const oldest = f.user('implement');
  oldest.info.sessionID = 'session-0';
  assert.match(
    (await f.transform([oldest]))[0].parts.at(-1).text,
    /^Portable workflow/,
  );
  const newest = f.user('implement');
  newest.info.sessionID = 'session-128';
  assert.match(
    (await f.transform([newest]))[0].parts.at(-1).text,
    /State directory must be absolute/,
  );
});

test('all new adapters bound complete context and reject runtime subprocess failures', async (t) => {
  const f = await fixture(t);
  const result = {
    ok: true,
    commonProse: 'x'.repeat(16384),
    invocations: [{ id: 'fixture', invocation: 'fixture', path: f.skill }],
  };
  for (const host of ['codex', 'pi', 'opencode'])
    assert.throws(
      () => nativeContext(host, result),
      /Complete instructions exceed/,
    );
  process.env.PLAYBILL_NODE = join(f.cwd, 'missing-node');
  f.env.PLAYBILL_NODE = process.env.PLAYBILL_NODE;
  const contexts = await f.contexts('implement');
  for (const host of ['codex', 'pi', 'opencode'])
    assert.match(contexts[host], /ENOENT/);
});

test('Codex hook uses native app-server protocol and terminates a stalled helper within deadline', async (t) => {
  const f = await fixture(t);
  delete f.env.PLAYBILL_CODEX_INVENTORY;
  delete process.env.PLAYBILL_CODEX_INVENTORY;
  const helper = join(f.cwd, 'native-helper');
  const response = {
    data: [
      {
        cwd: f.cwd,
        errors: [],
        skills: [
          {
            name: 'company/custom@v1',
            path: f.skill,
            enabled: true,
            description: 'Fixture',
            scope: 'repo',
          },
        ],
      },
    ],
  };
  write(
    helper,
    `#!${process.execPath}\nimport { createInterface } from 'node:readline';\nconst rl=createInterface({input:process.stdin});\nrl.on('line',line=>{ const m=JSON.parse(line); if(m.method==='initialize') process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n'); if(m.method==='skills/list') process.stdout.write(JSON.stringify({id:2,result:${JSON.stringify(response)}})+'\\n'); });\n`,
  );
  chmodSync(helper, 0o700);
  f.env.PLAYBILL_CODEX_EXECUTABLE = helper;
  assert.match(f.hook('codex', 'implement'), /Portable workflow/);
  write(
    helper,
    `#!${process.execPath}\nprocess.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n`,
  );
  const started = Date.now();
  assert.match(f.hook('codex', 'implement'), /5 second deadline/);
  assert.ok(Date.now() - started < 8000);
});

test('hook import errors preserve native event names, with bounded actionable output', async (t) => {
  const f = await fixture(t);
  cpSync(join(root, 'adapters'), join(f.cwd, 'package/adapters'), {
    recursive: true,
  });
  write(join(f.cwd, 'package/package.json'), '{"type":"module"}');
  for (const host of ['claude', 'codex']) {
    const result = spawnSync(
      process.execPath,
      [join(f.cwd, `package/adapters/${host}/hook.mjs`)],
      {
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.hookEventName, 'UserPromptSubmit');
    assert.match(output.additionalContext, /npm ci && npm run build/);
    assert.ok(Buffer.byteLength(output.additionalContext) < 10000);
  }
});

test('own bundled skill paths canonicalize by frontmatter while external identities remain intact', async (t) => {
  const f = await fixture(t);
  assert.equal(
    canonicalId('fixture-implement', f.skill, join(f.cwd, 'skills')),
    'playbill:fixture-implement',
  );
  assert.equal(
    canonicalId('playbill:fixture-implement', f.skill, join(f.cwd, 'skills')),
    'playbill:fixture-implement',
  );
  assert.equal(
    canonicalId('company/custom@v1', f.skill, join(f.cwd, 'absent')),
    'company/custom@v1',
  );
});

test('explicit aliases of bundled paths remain portable through all four installed adapter roots', async (t) => {
  const f = await fixture(t, { bundled: true });
  const contexts = await f.contexts('implement');
  const expected = common(contexts.claude, 'claude');
  assert.match(expected, /company\/custom@v1/);
  for (const [host, context] of Object.entries(contexts))
    assert.equal(common(context, host), expected);
});

test('each host appendix identifies the project root when the session starts in a subdirectory', async (t) => {
  const f = await fixture(t, { subdirectory: true });
  const contexts = await f.contexts('implement');
  for (const context of Object.values(contexts))
    assert.ok(
      context.includes(
        `Resolve workflow artifact paths relative to project root ${JSON.stringify(f.cwd)}.`,
      ),
    );
});

test('all entrypoints reject unavailable and ambiguous bindings with actionable diagnostics', async (t) => {
  const f = await fixture(t);
  const snapshot = JSON.parse(readFileSync(f.snapshot, 'utf8'));
  snapshot.skills[0].model_invocable = false;
  write(f.snapshot, JSON.stringify(snapshot));
  for (const context of Object.values(await f.contexts('implement')))
    assert.match(context, /SKILL_INVOCATION/);
  snapshot.skills.push(snapshot.skills[0]);
  write(f.snapshot, JSON.stringify(snapshot));
  for (const context of Object.values(await f.contexts('implement')))
    assert.match(context, /AMBIGUOUS_SKILL/);
});

test('complete-context overflow is reported through all entrypoints and cannot restore a prior selection', async (t) => {
  const f = await fixture(t);
  await f.contexts('implement');
  const oversized = {
    ...pipeline,
    steps: Array.from({ length: 20 }, (_, index) => ({
      ...pipeline.steps[0],
      id: `step-${index}`,
      instruction: 'x'.repeat(1000),
    })),
  };
  write(
    join(f.cwd, '.playbill/pipelines/coding.yaml'),
    JSON.stringify(oversized),
  );
  const contexts = await f.contexts('implement');
  for (const [host, context] of Object.entries(contexts)) {
    assert.match(context, /LIMIT/);
    assert.ok(Buffer.byteLength(context) < (host === 'claude' ? 30000 : 16384));
  }
  write(
    join(f.cwd, '.playbill/pipelines/coding.yaml'),
    JSON.stringify(pipeline),
  );
  for (const host of ['claude', 'codex'])
    assert.equal(
      f.hook(host, '', { hook_event_name: 'SessionStart', source: 'compact' }),
      '',
    );
  await f.pi('session_compact', {});
  assert.deepEqual((await f.pi('context', { messages: [] })).messages, []);
  await f.opencode.event({
    event: { type: 'session.compacted', properties: { sessionID: 'one' } },
  });
  assert.equal((await f.transform([f.user('summary')]))[0].parts.length, 1);
});

test('Pi and OpenCode revalidate workflow references on unmatched continuation prompts', async (t) => {
  const f = await fixture(t);
  await f.contexts('implement');
  write(
    join(f.cwd, '.playbill/pipelines/coding.yaml'),
    JSON.stringify({ ...pipeline, title: 'Updated workflow' }),
  );
  const continued = await f.contexts('yes');
  for (const host of ['pi', 'opencode']) {
    assert.match(continued[host], /^Updated workflow/);
    assert.match(continued[host], /Workflow reference restored/);
  }
  write(f.config, '[slots]\nimplement="company/custom@v1"\n');
  const removed = await f.contexts('continue');
  assert.equal(removed.pi, '');
  assert.equal(removed.opencode, '');
  write(f.config, '[slots]\nimplement="missing"\n');
  const invalid = await f.contexts('continue');
  assert.match(invalid.pi, /UNINSTALLED_SKILL/);
  assert.match(invalid.opencode, /UNINSTALLED_SKILL/);
  write(
    f.config,
    '[slots]\nimplement="company/custom@v1"\n[workflows.coding]\nentry="explicit"\n',
  );
  const repaired = await f.contexts('continue');
  assert.equal(repaired.pi, '');
  assert.equal(repaired.opencode, '');
});

test('smoke verification preserves a failure record when the model removed the original tests', async (t) => {
  const f = await fixture(t);
  const { verifyHostSmoke } = await import('../scripts/smoke/verify-hosts.mjs');
  const result = verifyHostSmoke('pi', f.cwd, []);
  assert.match(result.error, /ENOENT/);
  assert.equal(result.testIntact, false);
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.cwd, 'verification.json'), 'utf8')),
    result,
  );
});
