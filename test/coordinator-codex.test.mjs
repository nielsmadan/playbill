import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const temporary = mkdtempSync(
  join(process.cwd(), '.test-runs-native-boundary-'),
);
after(() => rmSync(temporary, { recursive: true, force: true }));
const hookPath = fileURLToPath(
  new URL('../scripts/coordinator/codex-hook.mjs', import.meta.url),
);
const cliPath = fileURLToPath(
  new URL('../scripts/coordinator/cli.mjs', import.meta.url),
);
const write = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const success = (result) => {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
function fixture() {
  const root = mkdtempSync(join(temporary, 'worker-'));
  const skills = {
    'playbill:brief': '.agents/skills/brief/SKILL.md',
    'playbill:report': '.agents/skills/report/SKILL.md',
  };
  for (const [skill, path] of Object.entries(skills))
    write(
      join(root, path),
      `---\nname: ${skill}\ndescription: Native boundary fixture.\n---\nRead all evidence.\n`,
    );
  write(join(root, 'TASK.md'), 'Record the task exactly.\n');
  const configPath = join(root, '.playbill/coordinator/config.json');
  write(
    configPath,
    JSON.stringify({
      version: 1,
      root,
      runId: 'native-test',
      entry: 'brief',
      maxTransitions: 4,
      maxStopBlocks: 2,
      sourcePaths: [],
      verificationHashes: {},
      checks: {},
      nativeSkills: skills,
      pauseAfter: ['brief'],
      steps: [
        {
          id: 'brief',
          title: 'Brief',
          skill: 'playbill:brief',
          instruction: 'Capture task.',
          consumes: ['TASK.md'],
          produces: ['brief.md'],
          allowSourceWrites: false,
          next: 'report',
        },
        {
          id: 'report',
          title: 'Report',
          skill: 'playbill:report',
          instruction: 'Report evidence.',
          consumes: ['brief.md'],
          produces: ['report.md'],
          allowSourceWrites: false,
          next: null,
        },
      ],
    }),
  );
  const hook = (name, extra = {}) =>
    spawnSync(process.execPath, [hookPath, configPath], {
      cwd: root,
      input: JSON.stringify({
        hook_event_name: name,
        session_id: 'native-one',
        cwd: root,
        ...extra,
      }),
      encoding: 'utf8',
    });
  const cli = (cmd, arg) =>
    spawnSync(
      process.execPath,
      [cliPath, configPath, cmd, ...(arg ? [arg] : [])],
      { cwd: root, encoding: 'utf8' },
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
  const cat = (
    id,
    skill = 'playbill:brief',
    command = `cat '${skills[skill]}'`,
    response = readFileSync(join(root, skills[skill]), 'utf8'),
  ) => {
    const event = {
      tool_name: 'Bash',
      tool_use_id: id,
      tool_input: { command },
    };
    const pre = success(hook('PreToolUse', event));
    return {
      pre,
      post: hook('PostToolUse', { ...event, tool_response: response }),
    };
  };
  success(hook('SessionStart', { source: 'startup' }));
  return { root, hook, cli, state, events, cat, skills };
}

test('native full-file Bash read activates once, retains raw receipts and refreshes without resetting artifacts', () => {
  const f = fixture();
  const first = f.cat('read-1');
  success(first.post);
  const activation = f.state().visit.activation;
  assert.equal(activation.kind, 'native-skill-file-read');
  write(join(f.root, 'brief.md'), 'fresh capture');
  const baseline = f.state().visit.baseline;
  success(f.cat('read-2').post);
  assert.deepEqual(f.state().visit.activation, activation);
  assert.deepEqual(f.state().visit.baseline, baseline);
  const native = f
    .events()
    .filter((e) => ['tool-pre', 'tool-post'].includes(e.kind));
  assert.deepEqual(
    native.map((e) => e.tool),
    ['Bash', 'Bash', 'Bash', 'Bash'],
  );
  assert.deepEqual(native[0].input, {
    command: "cat '.agents/skills/brief/SKILL.md'",
  });
  assert.equal(
    native[1].response,
    readFileSync(join(f.root, f.skills['playbill:brief']), 'utf8'),
  );
  assert.equal(f.events().filter((e) => e.kind === 'activated').length, 1);
  assert.equal(
    f.events().filter((e) => e.kind === 'native-skill-refreshed').length,
    1,
  );
  assert.equal(success(f.cli('complete', 'v1')).state.status, 'paused');
  assert.deepEqual(success(f.hook('Stop')), {});
  const before = f.state().visit;
  success(
    f.hook('UserPromptSubmit', {
      prompt: 'Read-only status after compaction.',
    }),
  );
  assert.equal(success(f.cli('status')).state.visit.id, before.id);
  assert.deepEqual(f.state().visit, before);
  success(
    f.hook('UserPromptSubmit', { prompt: 'Resume the authorized workflow.' }),
  );
  success(f.cli('resume'));
  success(f.cat('report-read', 'playbill:report').post);
  write(join(f.root, 'report.md'), 'complete');
  assert.equal(success(f.cli('complete', 'v2')).state.status, 'done');
  assert.deepEqual(success(f.hook('Stop')), {});
});

test('partial, compound and failed skill reads cannot activate a visit', () => {
  for (const [command, response] of [
    ['head -n 2 .agents/skills/brief/SKILL.md', '---\n'],
    ['cat .agents/skills/brief/SKILL.md | cat', null],
    ['cat .agents/skills/brief/SKILL.md', 'expected failure\n'],
  ]) {
    const f = fixture();
    success(
      f.cat(
        'read',
        'playbill:brief',
        command,
        response ??
          readFileSync(join(f.root, f.skills['playbill:brief']), 'utf8'),
      ).post,
    );
    assert.equal(f.state().visit.activation, null);
    write(join(f.root, 'brief.md'), 'brief');
    const result = f.cli('complete', 'v1');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /activation/iu);
  }
});

test('out-of-order native skill is denied before execution, and replayed receipts cannot activate twice', () => {
  const f = fixture();
  const event = {
    tool_name: 'Bash',
    tool_use_id: 'wrong',
    tool_input: { command: 'cat .agents/skills/report/SKILL.md' },
  };
  const denied = success(f.hook('PreToolUse', event));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(f.state().visit.activation, null);
  success(f.cat('read').post);
  const response = readFileSync(
    join(f.root, f.skills['playbill:brief']),
    'utf8',
  );
  const replay = f.hook('PostToolUse', {
    tool_name: 'Bash',
    tool_use_id: 'read',
    tool_input: { command: "cat '.agents/skills/brief/SKILL.md'" },
    tool_response: response,
  });
  assert.equal(replay.status, 2);
  assert.match(replay.stderr, /receipt/iu);
  assert.equal(f.events().filter((e) => e.kind === 'activated').length, 1);
});

test('Codex Stop blocks an unfinished visit with an explicit reason', () => {
  const f = fixture();
  const output = success(f.hook('Stop'));
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /Continue.*current visit/u);
});
