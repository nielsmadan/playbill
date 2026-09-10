import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

const temporary = mkdtempSync(join(process.cwd(), '.test-runs-conversation-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const script = (name) =>
  fileURLToPath(new URL(`../scripts/coordinator/${name}.mjs`, import.meta.url));
const write = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const success = (result) => {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const reject = (result, pattern) => {
  assert.ok([1, 2].includes(result.status), result.stdout);
  assert.match(result.stderr, pattern);
};

function fixture({ conversation = {}, native = false, runner } = {}) {
  const root = mkdtempSync(join(temporary, 'case-'));
  const configPath = join(root, '.playbill/coordinator/config.json');
  const check = runner ?? 'console.log("checked source");';
  const steps = ['capture', 'verify', 'report'].map((id, index, ids) => ({
    id,
    title: id,
    skill: `playbill:${id}`,
    instruction: `Perform ${id}.`,
    consumes: index ? [`${ids[index - 1]}.md`] : ['TASK.md'],
    produces: [`${id}.md`],
    allowSourceWrites: false,
    next: ids[index + 1] ?? null,
    ...(id === 'verify' ? { check: 'original' } : {}),
  }));
  const skills = Object.fromEntries(
    steps.map((step) => [step.skill, `.agents/skills/${step.id}/SKILL.md`]),
  );
  for (const path of Object.values(skills))
    write(
      join(root, path),
      'Read the requested artifacts and preserve evidence.\n',
    );
  const config = {
    version: 1,
    root,
    runId: 'conversation-test',
    entry: 'capture',
    steps,
    maxTransitions: 5,
    maxStopBlocks: 2,
    sourcePaths: ['source.txt'],
    verificationHashes: {
      'check.mjs': createHash('sha256').update(check).digest('hex'),
    },
    checks: {
      original: {
        executable: process.execPath,
        args: ['check.mjs'],
        resultFiles: [],
        timeoutMs: 5000,
      },
    },
    executionHistory: { reportArtifact: 'report.md' },
    conversation,
    ...(native ? { nativeSkills: skills } : {}),
  };
  write(configPath, JSON.stringify(config));
  write(join(root, 'TASK.md'), 'Investigate the player failure.');
  write(join(root, 'source.txt'), 'original source');
  write(join(root, 'check.mjs'), check);
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [script('cli'), configPath, ...args.map(String)],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
      },
    );
  const hook = (name, event = {}) =>
    spawnSync(
      process.execPath,
      [script(native ? 'codex-hook' : 'hook'), configPath],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        input: JSON.stringify({
          hook_event_name: name,
          session_id: 'conversation-session',
          cwd: root,
          ...event,
        }),
      },
    );
  const state = () =>
    read(join(root, '.playbill/coordinator/runtime/state.json'));
  const events = () =>
    readFileSync(
      join(root, '.playbill/coordinator/runtime/events.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map(JSON.parse);
  let id = 0;
  const activate = (skill = 'capture') => {
    const path = skills[`playbill:${skill}`];
    const event = {
      tool_use_id: `skill-${++id}`,
      tool_name: native ? 'Bash' : 'Skill',
      tool_input: native
        ? { command: `cat '${path}'` }
        : { skill: `playbill:${skill}` },
    };
    success(hook('PreToolUse', event));
    return success(
      hook('PostToolUse', {
        ...event,
        tool_response: native
          ? readFileSync(join(root, path), 'utf8')
          : { success: true },
      }),
    );
  };
  const prompt = (text, turnId = `native-turn-${++id}`) => {
    success(hook('UserPromptSubmit', { prompt: text, turn_id: turnId }));
    return state().conversation.turn;
  };
  const intent = (kind, turn = state().conversation.turn) =>
    cli('intent', turn, kind);
  const start = () => {
    success(hook('SessionStart', { source: 'startup' }));
    return prompt('Investigate the player failure.');
  };
  const verify = () => {
    activate();
    write(join(root, 'capture.md'), 'Captured the actual request.');
    success(cli('complete', 'v1'));
    activate('verify');
  };
  return {
    root,
    configPath,
    cli,
    hook,
    state,
    events,
    activate,
    prompt,
    intent,
    start,
    verify,
  };
}

test('first diversion releases source and skill guards while preserving the current visit', () => {
  const f = fixture();
  f.start();
  f.activate();
  const visit = f.state().visit;
  f.prompt('Let us discuss the architecture of the settings screen.');
  const diverted = success(f.intent('redirect'));
  assert.equal(diverted.state.conversation.mode, 'paused');
  assert.equal(diverted.state.conversation.redirects, 1);
  assert.equal(diverted.question, undefined);
  assert.deepEqual(f.state().visit, visit);
  assert.deepEqual(success(f.hook('Stop')), {});
  const edit = {
    tool_name: 'Edit',
    tool_use_id: 'outside-edit',
    tool_input: { file_path: join(f.root, 'source.txt') },
  };
  assert.deepEqual(success(f.hook('PreToolUse', edit)), {});
  write(join(f.root, 'source.txt'), 'user-authorized unrelated work');
  assert.deepEqual(
    success(f.hook('PostToolUse', { ...edit, tool_response: 'changed' })),
    {},
  );
  assert.deepEqual(f.activate('report'), {});
  assert.deepEqual(f.state().visit.activation, visit.activation);
  assert.deepEqual(f.state().visit.violations, []);
  reject(f.cli('complete', 'v1'), /paused|yield|engaged/iu);
});

test('two distinct redirects offer one choice and preserve that decision across compaction', () => {
  const f = fixture();
  f.start();
  f.prompt('How should settings be organized?');
  success(f.intent('redirect'));
  const before = f.state().conversation.turn;
  success(f.hook('SessionStart', { source: 'compact' }));
  success(f.cli('status'));
  assert.equal(f.state().conversation.turn, before);
  f.prompt('Let us compare a sidebar with tabs.');
  const offer = success(f.intent('redirect'));
  assert.equal(offer.state.conversation.redirects, 2);
  assert.equal(offer.state.conversation.offered, true);
  assert.match(offer.question, /paus/iu);
  assert.match(offer.question, /exit|clos|leave/iu);
  assert.equal(success(f.intent('redirect')).question, undefined);
  success(f.hook('SessionStart', { source: 'compact' }));
  f.prompt('Consider mobile layouts too.');
  assert.equal(success(f.intent('redirect')).question, undefined);
  assert.equal(success(f.cli('status')).question, undefined);
  assert.deepEqual(success(f.hook('Stop')), {});
});

test('duplicate prompt delivery and classification cannot inflate the redirection threshold', () => {
  const f = fixture();
  f.start();
  const turn = f.prompt('Discuss a new feature.', 'same-turn');
  success(f.intent('redirect', turn));
  assert.equal(f.prompt('Discuss a new feature.', 'same-turn'), turn);
  success(f.intent('redirect', turn));
  assert.equal(f.state().conversation.redirects, 1);
  reject(f.intent('replace', turn), /conflict|classif|already/iu);
  f.prompt('Another question about the feature.');
  reject(f.intent('redirect', turn), /stale|current|turn/iu);
  assert.equal(f.state().conversation.redirects, 1);
});

test('a question permits an answer without progression and breaks a consecutive redirect streak', () => {
  const f = fixture();
  f.start();
  f.activate();
  write(join(f.root, 'capture.md'), 'Captured the task.');
  f.prompt('Why does this failure occur?');
  success(f.intent('question'));
  const visit = f.state().visit;
  reject(f.cli('complete', 'v1'), /read.only|question/iu);
  assert.deepEqual(success(f.hook('Stop')), {});
  assert.deepEqual(f.state().visit, visit);
  f.prompt('Discuss a new feature.');
  success(f.intent('redirect'));
  f.prompt('What was the original failure again?');
  success(f.intent('question'));
  assert.equal(f.state().conversation.mode, 'paused');
  f.prompt('Now explain a different architecture.');
  const result = success(f.intent('redirect'));
  assert.equal(result.state.conversation.redirects, 1);
  assert.equal(result.question, undefined);
});

test('unclassified ambiguous turns do not count toward consecutive redirection', () => {
  const f = fixture();
  f.start();
  f.prompt('Discuss a new feature.');
  success(f.intent('redirect'));
  f.prompt('Hmm, I am thinking.');
  assert.deepEqual(success(f.hook('Stop')), {});
  f.prompt('Compare the options for that new feature.');
  assert.equal(success(f.intent('redirect')).state.conversation.redirects, 1);
});

test('threshold and asking are configurable without silently abandoning work', () => {
  for (const askOnRedirect of [true, false]) {
    const f = fixture({
      conversation: { redirectThreshold: 3, askOnRedirect },
    });
    f.start();
    for (let turn = 1; turn <= 4; turn += 1) {
      f.prompt(`New objective discussion ${turn}.`);
      const result = success(f.intent('redirect'));
      assert.equal(
        typeof result.question === 'string',
        askOnRedirect && turn === 3,
      );
      assert.equal(result.state.conversation.mode, 'paused');
    }
  }
  for (const conversation of [
    null,
    { redirectThreshold: 1 },
    { redirectThreshold: 21 },
    { redirectThreshold: 2.5 },
    { askOnRedirect: 'yes' },
    { unknown: true },
  ]) {
    const f = fixture({ conversation });
    reject(f.hook('SessionStart'), /conversation|redirect|askOnRedirect/iu);
  }
});

test('return resumes the same visit and keeps completed snapshots intact', () => {
  const f = fixture();
  f.start();
  f.verify();
  success(f.cli('check'));
  const before = f.state();
  const snapshot = readFileSync(join(f.root, before.history[0].artifacts.path));
  f.prompt('Discuss a new feature.');
  success(f.intent('redirect'));
  f.prompt('Back to fixing the player; continue.');
  const resumed = success(f.intent('return'));
  assert.equal(resumed.state.conversation.mode, 'engaged');
  assert.equal(resumed.state.conversation.redirects, 0);
  assert.equal(resumed.state.status, 'active');
  assert.deepEqual(f.state().visit, before.visit);
  assert.deepEqual(f.state().history, before.history);
  assert.deepEqual(
    readFileSync(join(f.root, before.history[0].artifacts.path)),
    snapshot,
  );
  assert.equal(success(f.hook('Stop')).decision, 'block');
});

test('resuming after outside source changes invalidates current evidence without recording a workflow violation', () => {
  const f = fixture();
  f.start();
  f.verify();
  success(f.cli('check'));
  const check = f.state().visit.check;
  const evidence = readFileSync(join(f.root, check.path));
  success(f.cli('pause'));
  write(join(f.root, 'source.txt'), 'changed during an authorized diversion');
  f.prompt('Return to the player fix.');
  success(f.intent('return'));
  assert.equal(f.state().visit.id, 'v2');
  assert.equal(f.state().visit.activation, null);
  assert.equal(f.state().visit.check, null);
  assert.deepEqual(f.state().visit.violations, []);
  assert.deepEqual(readFileSync(join(f.root, check.path)), evidence);
  assert.equal(f.state().history.length, 1);
  reject(f.cli('complete', 'v2'), /activation/iu);
});

test('replacement intent exits immediately and remains quiet until explicit resume', () => {
  const f = fixture();
  f.start();
  f.prompt('Forget the player bug; write a deployment note.');
  const exited = success(f.intent('replace'));
  assert.equal(exited.state.conversation.mode, 'exited');
  assert.equal(exited.context, '');
  assert.equal(exited.question, undefined);
  assert.equal(f.state().history.length, 0);
  for (const [name, event] of [
    [
      'UserPromptSubmit',
      { prompt: 'Fix another issue using these notes.', turn_id: 'after-exit' },
    ],
    ['SessionStart', { source: 'compact' }],
    ['Stop', {}],
    [
      'PreToolUse',
      {
        tool_name: 'Edit',
        tool_use_id: 'new-work',
        tool_input: { file_path: join(f.root, 'source.txt') },
      },
    ],
  ])
    assert.deepEqual(success(f.hook(name, event)), {});
  assert.equal(success(f.cli('status')).state.conversation.mode, 'exited');
  success(f.cli('resume'));
  assert.equal(f.state().conversation.mode, 'engaged');
  assert.equal(f.state().visit.id, 'v1');
});

test('changed protected inputs cannot trap the user in a workflow', () => {
  const f = fixture();
  f.start();
  write(join(f.root, 'check.mjs'), 'changed protected input');
  assert.equal(success(f.cli('exit')).state.conversation.mode, 'exited');
  assert.deepEqual(success(f.hook('Stop')), {});
  assert.deepEqual(
    success(f.hook('UserPromptSubmit', { prompt: 'Continue the new task.' })),
    {},
  );
  reject(f.cli('resume'), /verification|protected|immutable/iu);
  assert.equal(f.state().conversation.mode, 'exited');
});

test('Codex skill reads while diverted remain ordinary reads and do not activate the workflow', () => {
  const f = fixture({ native: true });
  f.start();
  success(f.cli('pause'));
  assert.deepEqual(f.activate('report'), {});
  assert.equal(f.state().visit.activation, null);
  assert.equal(f.state().conversation.mode, 'paused');
  assert.deepEqual(success(f.hook('Stop')), {});
});

test('watched symlink drift cannot block exit or released work and still prevents unsafe resume', () => {
  for (const mode of ['engaged', 'paused', 'exited']) {
    for (const target of ['source.txt', '.agents']) {
      const f = fixture({ native: true });
      f.start();
      if (mode !== 'engaged')
        success(f.cli(mode === 'paused' ? 'pause' : 'exit'));
      const saved =
        target === 'source.txt' ? 'saved-source.txt' : 'saved-agents';
      renameSync(join(f.root, target), join(f.root, saved));
      symlinkSync(saved, join(f.root, target));
      const outside = {
        tool_name: 'Write',
        tool_use_id: 'outside-document',
        tool_input: { file_path: join(f.root, 'outside.md') },
      };
      if (mode === 'engaged')
        reject(f.hook('PreToolUse', outside), /Symlink forbidden/u);
      const exit = {
        tool_name: 'Bash',
        tool_use_id: 'explicit-exit',
        tool_input: {
          command: `node '${script('cli')}' '${f.configPath}' exit`,
        },
      };
      assert.deepEqual(success(f.hook('PreToolUse', exit)), {});
      const exited = success(f.cli('exit'));
      assert.equal(exited.state.conversation.mode, 'exited');
      assert.deepEqual(
        success(
          f.hook('PostToolUse', {
            ...exit,
            tool_response: JSON.stringify(exited),
          }),
        ),
        {},
      );
      assert.deepEqual(
        success(
          f.hook('UserPromptSubmit', { prompt: 'Continue the outside task.' }),
        ),
        {},
      );
      assert.deepEqual(success(f.hook('PreToolUse', outside)), {});
      write(join(f.root, 'outside.md'), 'Authorized outside work.');
      assert.deepEqual(
        success(
          f.hook('PostToolUse', { ...outside, tool_response: 'written' }),
        ),
        {},
      );
      assert.deepEqual(
        success(f.hook('SessionStart', { source: 'compact' })),
        {},
      );
      assert.deepEqual(success(f.hook('Stop')), {});
      reject(f.cli('resume'), /Symlink forbidden/u);
      assert.equal(success(f.cli('status')).state.conversation.mode, 'exited');
    }
  }
});

test('deleted workflow skills do not interfere with ordinary Codex reads while paused or exited', () => {
  for (const command of ['pause', 'exit']) {
    const f = fixture({ native: true });
    f.start();
    f.activate();
    const visit = f.state().visit;
    success(f.cli(command));
    rmSync(join(f.root, '.agents'), { recursive: true });
    const read = {
      tool_name: 'Bash',
      tool_use_id: 'ordinary-read',
      tool_input: { command: "cat 'TASK.md'" },
    };
    assert.deepEqual(success(f.hook('PreToolUse', read)), {});
    assert.deepEqual(
      success(
        f.hook('PostToolUse', {
          ...read,
          tool_response: readFileSync(join(f.root, 'TASK.md'), 'utf8'),
        }),
      ),
      {},
    );
    assert.deepEqual(f.state().visit, visit);
    assert.deepEqual(success(f.hook('Stop')), {});
  }
});

test('successful completion returns subsequent prompts and ordinary work to the user', () => {
  const f = fixture();
  f.start();
  f.verify();
  success(f.cli('check'));
  write(join(f.root, 'verify.md'), 'The configured check passed.');
  success(f.cli('complete', 'v2'));
  f.activate('report');
  write(join(f.root, 'report.md'), 'Completed the requested workflow.');
  assert.equal(success(f.cli('complete', 'v3')).state.status, 'done');
  assert.deepEqual(
    success(
      f.hook('UserPromptSubmit', { prompt: 'Write a different document.' }),
    ),
    {},
  );
  const edit = {
    tool_name: 'Edit',
    tool_use_id: 'after-completion',
    tool_input: { file_path: join(f.root, 'source.txt') },
  };
  assert.deepEqual(success(f.hook('PreToolUse', edit)), {});
  write(join(f.root, 'source.txt'), 'new authorized work');
  assert.deepEqual(
    success(f.hook('PostToolUse', { ...edit, tool_response: 'changed' })),
    {},
  );
  assert.deepEqual(success(f.hook('SessionStart', { source: 'compact' })), {});
  assert.deepEqual(success(f.hook('Stop')), {});
  assert.equal(f.state().history.length, 3);
});

test('terminal completion freezes the final generated history before later outside events', () => {
  const f = fixture();
  f.start();
  f.verify();
  success(f.cli('check'));
  write(join(f.root, 'verify.md'), 'The configured check passed.');
  success(f.cli('complete', 'v2'));
  f.activate('report');
  const inspection = {
    tool_name: 'Bash',
    tool_use_id: 'final-inspection',
    tool_input: { command: "printf 'final report inspection'" },
  };
  success(f.hook('PreToolUse', inspection));
  success(f.hook('PostToolUse', { ...inspection, tool_response: 'inspected' }));
  write(join(f.root, 'report.md'), 'Completed the requested workflow.');
  const completion = {
    tool_name: 'Bash',
    tool_use_id: 'completion-wrapper',
    tool_input: {
      command: `node '${script('cli')}' '${f.configPath}' complete v3`,
    },
  };
  success(f.hook('PreToolUse', completion));
  const cutoff = f.events().at(-1);
  const completed = success(f.cli('complete', 'v3'));
  assert.equal(completed.state.status, 'done');
  const generated = () =>
    Object.fromEntries(
      ['json', 'md'].map((extension) => [
        extension,
        readFileSync(
          join(
            f.root,
            `.playbill/coordinator/runtime/execution-history.${extension}`,
          ),
          'utf8',
        ),
      ]),
    );
  const frozen = generated();
  const facts = JSON.parse(frozen.json);
  assert.deepEqual(facts.cutoff, {
    sequence: cutoff.sequence,
    timestamp: cutoff.timestamp,
  });
  assert.deepEqual(
    facts.shellInvocations.map(({ toolUseId, receiptState, command }) => ({
      toolUseId,
      receiptState,
      command,
    })),
    [
      {
        toolUseId: inspection.tool_use_id,
        receiptState: 'received',
        command: inspection.tool_input.command,
      },
      {
        toolUseId: completion.tool_use_id,
        receiptState: 'pending',
        command: completion.tool_input.command,
      },
    ],
  );
  assert.equal(facts.configuredChecks[0].outcome, 'pass');
  assert.match(frozen.md, /final report inspection/u);
  assert.match(
    frozen.md,
    new RegExp(`Evidence cutoff: journal event ${cutoff.sequence} `, 'u'),
  );
  success(
    f.hook('PostToolUse', {
      ...completion,
      tool_response: JSON.stringify(completed),
    }),
  );
  success(f.hook('UserPromptSubmit', { prompt: 'Work on another task.' }));
  const outside = {
    tool_name: 'Bash',
    tool_use_id: 'outside-work',
    tool_input: { command: "printf 'outside work'" },
  };
  success(f.hook('PreToolUse', outside));
  success(f.hook('PostToolUse', { ...outside, tool_response: 'outside work' }));
  success(f.hook('SessionStart', { source: 'compact' }));
  success(f.hook('Stop'));
  assert.equal(success(f.cli('history')).history.counts.shellInvocations, 3);
  assert.deepEqual(generated(), frozen);
});

test('an in-flight check retains its result after exit without taking control again', async () => {
  const f = fixture({
    runner:
      'await new Promise(r=>setTimeout(r,1800));console.log("retained late failure");process.exitCode=7;',
  });
  f.start();
  f.verify();
  const child = spawn(
    process.execPath,
    [script('cli'), f.configPath, 'check'],
    { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  try {
    const deadline = Date.now() + 4000;
    while (!f.state().visit.checkLease && Date.now() < deadline)
      await setTimeout(10);
    assert.ok(f.state().visit.checkLease);
    success(f.cli('exit'));
    const result = success(await completed);
    assert.equal(result.check.exitCode, 7);
    assert.equal(result.check.stdout.trim(), 'retained late failure');
    assert.equal(f.state().conversation.mode, 'exited');
    assert.equal(f.state().status, 'paused');
    assert.equal(f.state().history.length, 1);
    assert.deepEqual(success(f.hook('Stop')), {});
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
