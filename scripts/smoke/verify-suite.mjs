import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import {
  artifactNames,
  observationVersion,
  observedPaths,
  sha256,
  snapshot,
} from './suite-observer.mjs';

export const originalSolution =
  'export function sumUniqueIntegers(values) {\n  if (!Array.isArray(values)) throw new TypeError("Expected an array");\n  return values.filter(Number.isSafeInteger).reduce((sum, value) => sum + value, 0);\n}\n';
export const observerSource = readFileSync(
  new URL('./suite-observer.mjs', import.meta.url),
  'utf8',
);
export const observationProtocol = {
  version: observationVersion,
  observer: '.suite-observer.mjs',
  observerSha256: sha256(observerSource),
  command: 'node --test test.mjs',
};

export const originalChecks = `import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sumUniqueIntegers} from './solution.mjs';
test('counts repeated integers once', () => assert.equal(sumUniqueIntegers([2, 2, 4, -3, -3]), 3));
test('ignores values that are not safe integers', () => assert.equal(sumUniqueIntegers([2, 3.5, '4', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]), 2));
test('empty input', () => assert.equal(sumUniqueIntegers([]), 0));
test('invalid input', () => { for (const value of [null, '2', {}, 4]) assert.throws(() => sumUniqueIntegers(value), TypeError); });
test('preserves frozen input', () => assert.equal(sumUniqueIntegers(Object.freeze([3, 5, -2])), 6));
`;

export const checkHash = createHash('sha256')
  .update(originalChecks)
  .digest('hex');

function artifact(files, name, patterns) {
  const path = `.playbill/debug/${name}.md`;
  const content = files[path]?.content;
  assert.equal(typeof content, 'string', `Missing completed artifact: ${path}`);
  for (const pattern of patterns)
    assert.match(
      content,
      pattern,
      `Missing fixture evidence in ${path}: ${pattern}`,
    );
  return content;
}

const commandEvidence = /node --test test\.mjs/u;
const subjectEvidence = /sumUniqueIntegers/u;
const duplicateEvidence = /duplicat|dedup|distinct/iu;
function countEvidence(label, count) {
  const number = `(?:${count}|${['zero', 'one', 'two', 'three', 'four', 'five'][count]}${count === 0 ? '|no' : ''})`;
  const outcome = label === 'pass' ? 'pass(?:ed|es)?' : 'fail(?:ed|ures?)?';
  return new RegExp(
    `(?:\\b${outcome}\\s*[:=]?\\s*${number}\\b|(?<!/\\s*)\\b${number}(?:\\s*/\\s*5)?\\s+(?:(?:original\\s+)?(?:tests?|checks?)\\s+)?${outcome}\\b)`,
    'iu',
  );
}

function checkEvidence(files, name, passed, failed) {
  return artifact(files, name, [
    commandEvidence,
    countEvidence('pass', passed),
    countEvidence('fail', failed),
  ]);
}

function executionEvidence(fixture, events, uses, result) {
  const manifest = JSON.parse(
    readFileSync(join(fixture, 'command.json'), 'utf8'),
  );
  assert.deepEqual(
    manifest.observationProtocol,
    observationProtocol,
    'Missing or incompatible suite observation protocol',
  );
  assert.equal(
    readFileSync(join(fixture, observationProtocol.observer), 'utf8'),
    observerSource,
  );
  const observations = [];
  for (const event of events) {
    if (event.subtype !== 'hook_response') continue;
    const marker =
      /^playbill-suite-observation-v1 ([A-Za-z0-9_-]+\.json) ([a-f0-9]{64})\s*$/u.exec(
        event.stdout ?? '',
      );
    if (!marker) continue;
    assert.equal(event.exit_code, 0, 'Observation hook failed');
    const bytes = readFileSync(
      join(fixture, '.suite-observations', marker[1]),
      'utf8',
    );
    assert.equal(
      sha256(bytes),
      marker[2],
      'Observation differs from native trace receipt',
    );
    const observation = JSON.parse(bytes);
    assert.equal(observation.version, observationVersion);
    assert.equal(observation.event, event.hook_event);
    assert.equal(
      marker[1],
      `${observation.event}-${observation.toolUseId}.json`,
    );
    assert.deepEqual(Object.keys(observation.files), observedPaths);
    for (const file of Object.values(observation.files))
      if (file) assert.equal(file.sha256, sha256(file.content));
    for (const path of ['test.mjs', 'original-test.mjs'])
      assert.equal(
        observation.files[path]?.content,
        originalChecks,
        `Original checks changed at ${observation.toolUseId}`,
      );
    observation.position = observations.length;
    observations.push(observation);
  }
  const blocks = events.flatMap((event) => event.message?.content ?? []);
  const observed = uses.map((use) => {
    const matches = observations.filter((entry) => entry.toolUseId === use.id);
    assert.equal(
      matches.length,
      2,
      `Missing paired tool observations: ${use.id}`,
    );
    const [pre, post] = matches;
    assert.equal(pre.event, 'PreToolUse');
    assert.ok(['PostToolUse', 'PostToolUseFailure'].includes(post.event));
    for (const entry of matches) {
      assert.equal(entry.tool, use.name);
      assert.deepEqual(entry.input, use.input);
    }
    const response = blocks.find(
      (block) => block.type === 'tool_result' && block.tool_use_id === use.id,
    );
    assert.ok(response, `Missing execution result: ${use.id}`);
    return { use, pre, post, response };
  });
  assert.equal(observations.length, uses.length * 2, 'Unmatched observations');
  const stages = observed.filter(({ use }) => use.name === 'Skill');
  const final = observations.at(-1);
  assert.ok(final, 'Missing execution observations');
  assert.deepEqual(
    final.files,
    snapshot(fixture),
    'Final files differ from observed execution',
  );
  assert.equal(
    observations[0].files['solution.mjs']?.content,
    originalSolution,
  );
  for (const name of artifactNames)
    assert.equal(
      observations[0].files[`.playbill/debug/${name}.md`],
      null,
      'Fixture artifacts must start absent',
    );
  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index];
    const next = stages[index + 1]?.pre.position ?? observations.length;
    assert.ok(
      stage.post.position < next,
      'Skill execution overlaps the next activation',
    );
    const work = observed.filter(
      ({ use, pre, post }) =>
        use.name !== 'Skill' &&
        pre.position > stage.post.position &&
        post.position < next,
    );
    assert.ok(
      work.length > 0,
      `No execution between activations: ${stage.use.input.skill}`,
    );
    stage.work = work;
    stage.files = observations[next - 1].files;
    const outputs = [
      ['brief', 'progress'],
      ['diagnosis', 'checks', 'progress'],
      ['work'],
      ['checks', 'progress'],
      ['report'],
    ][index];
    for (const name of outputs) {
      const path = `.playbill/debug/${name}.md`;
      assert.ok(
        stage.files[path]?.content?.trim(),
        `Missing completed artifact: ${path}`,
      );
      assert.notEqual(
        stage.files[path]?.sha256,
        stage.pre.files[path]?.sha256,
        `Step did not produce ${path}`,
      );
      assert.ok(
        work.some(
          ({ pre, post }) =>
            pre.files[path]?.sha256 !== post.files[path]?.sha256 &&
            post.files[path]?.sha256 === stage.files[path].sha256,
        ),
        `Artifact completion has no observed tool execution: ${path}`,
      );
    }
  }
  for (const tool of observed.filter(({ use }) => use.name !== 'Skill'))
    assert.ok(
      stages.some(({ work }) => work.includes(tool)),
      `Tool execution crosses a step boundary: ${tool.use.id}`,
    );
  const [brief, diagnosis, implementation, verification, report] = stages;
  artifact(brief.files, 'brief', [
    subjectEvidence,
    duplicateEvidence,
    /safe integers?/iu,
    /solution\.mjs/u,
    commandEvidence,
  ]);
  artifact(brief.files, 'progress', [subjectEvidence]);
  artifact(diagnosis.files, 'diagnosis', [
    subjectEvidence,
    duplicateEvidence,
    /solution\.mjs/u,
  ]);
  checkEvidence(diagnosis.files, 'checks', 4, 1);
  checkEvidence(diagnosis.files, 'progress', 4, 1);
  artifact(implementation.files, 'work', [/solution\.mjs/u, duplicateEvidence]);
  checkEvidence(verification.files, 'checks', 5, 0);
  checkEvidence(verification.files, 'progress', 4, 1);
  checkEvidence(verification.files, 'progress', 5, 0);
  artifact(verification.files, 'progress', [
    /solution\.mjs/u,
    duplicateEvidence,
  ]);
  artifact(report.files, 'report', [
    subjectEvidence,
    duplicateEvidence,
    /node --test test\.mjs|(?:\.playbill\/debug\/)?(?:checks|progress)\.md/u,
    new RegExp(
      `(?:${countEvidence('pass', 5).source}|\\ball\\s+(?:original\\s+)?(?:tests?|checks?)\\s+passed\\b)`,
      'iu',
    ),
  ]);

  function testRun(stage, failed) {
    const run = stage.work.find(
      ({ use, response }) =>
        use.name === 'Bash' &&
        use.input.command.trim() === observationProtocol.command &&
        (response.is_error === true) === failed,
    );
    assert.ok(
      run,
      `Missing ${failed ? 'failing original reproduction' : 'verification after correction'}: ${observationProtocol.command}`,
    );
    const output =
      typeof run.response.content === 'string'
        ? run.response.content
        : run.response.content.map((part) => part.text ?? '').join('\n');
    for (const [label, count] of Object.entries({
      tests: 5,
      pass: failed ? 4 : 5,
      fail: failed ? 1 : 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    }))
      assert.match(
        output,
        new RegExp(`(?:^|\\n)(?:#|ℹ)?\\s*${label} ${count}\\s*(?:\\n|$)`, 'u'),
        `Missing full ${label} result`,
      );
    assert.equal(
      run.pre.files['solution.mjs'].sha256,
      run.post.files['solution.mjs'].sha256,
      'Solution changed during test command',
    );
    for (const name of ['checks', 'progress']) {
      const path = `.playbill/debug/${name}.md`;
      assert.notEqual(
        stage.files[path].sha256,
        run.post.files[path]?.sha256,
        `Check evidence predates test completion: ${path}`,
      );
    }
    return run;
  }
  const reproduced = testRun(diagnosis, true);
  const verified = testRun(verification, false);
  const initialHash = sha256(originalSolution);
  const correctedHash = implementation.files['solution.mjs'].sha256;
  assert.notEqual(correctedHash, initialHash, 'Missing actual correction');
  for (const entry of observations) {
    if (entry.position <= implementation.post.position)
      assert.equal(
        entry.files['solution.mjs']?.sha256,
        initialHash,
        'Solution edited before original reproduction and correction step',
      );
    if (entry.position >= verification.pre.position)
      assert.equal(
        entry.files['solution.mjs']?.sha256,
        correctedHash,
        'Solution changed after correction step',
      );
  }
  assert.equal(reproduced.pre.files['solution.mjs'].sha256, initialHash);
  assert.equal(verified.pre.files['solution.mjs'].sha256, correctedHash);
  assert.ok(
    implementation.work.some(
      ({ pre, post }) =>
        pre.files['solution.mjs'].sha256 !== post.files['solution.mjs'].sha256,
    ),
    'Correction has no observed tool execution',
  );
  for (const path of observedPaths.filter(
    (path) => path !== '.playbill/debug/report.md',
  ))
    assert.deepEqual(
      report.pre.files[path],
      final.files[path],
      `Report changed earlier step output: ${path}`,
    );
  result.execution = {
    observationVersion,
    observedTools: observed.length,
    reproductionToolUseId: reproduced.use.id,
    verificationToolUseId: verified.use.id,
    initialSolutionSha256: initialHash,
    correctedSolutionSha256: correctedHash,
    completedSteps: stages.map(({ use }) => use.input.skill),
  };
}

export function verifySuite(fixture, output = 'verification.json') {
  const result = { fixture, originalCheckSha256: checkHash, passed: false };
  try {
    const events = readFileSync(join(fixture, 'stdout.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    result.hostResult = events.findLast((event) => event.type === 'result');
    const hook = events.find(
      (event) =>
        event.subtype === 'hook_response' &&
        event.hook_event === 'UserPromptSubmit',
    );
    result.hookExitCode = hook?.exit_code;
    const context = JSON.parse(hook?.stdout ?? '{}').hookSpecificOutput
      ?.additionalContext;
    result.adapterContext = context;
    result.artifacts = {};
    result.missingArtifacts = [];
    for (const name of artifactNames) {
      const path = `.playbill/debug/${name}.md`;
      try {
        result.artifacts[path] = readFileSync(join(fixture, path), 'utf8');
      } catch (error) {
        result.missingArtifacts.push({ path, error: error.message });
      }
    }
    const original = readFileSync(join(fixture, 'original-test.mjs'), 'utf8');
    const current = readFileSync(join(fixture, 'test.mjs'), 'utf8');
    result.originalIntact = original === originalChecks;
    result.checksIntact = current === originalChecks;
    assert.equal(result.originalIntact, true);
    assert.equal(result.checksIntact, true);
    const checkEnv = { ...process.env };
    delete checkEnv.NODE_TEST_CONTEXT;
    const checked = spawnSync(process.execPath, ['--test', 'test.mjs'], {
      cwd: fixture,
      env: checkEnv,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 262144,
    });
    result.independentChecks = {
      exitCode: checked.status,
      stdout: checked.stdout,
      stderr: checked.stderr,
      error: checked.error?.message,
    };
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout, /tests 5/u);
    const blocks = events.flatMap((event) => event.message?.content ?? []);
    const uses = blocks.filter((block) => block.type === 'tool_use');
    const expected = [
      'brief',
      'debug-log',
      'implement',
      'verify',
      'report',
    ].map((name) => `playbill:playbill-${name}`);
    result.nativeInvocations = uses
      .filter((block) => block.name === 'Skill')
      .map((block) => block.input.skill);
    result.activationResults = [];
    let prior = -1;
    for (const skill of expected) {
      const index = uses.findIndex(
        (block, index) =>
          index > prior &&
          block.name === 'Skill' &&
          block.input.skill === skill,
      );
      assert.ok(index > prior, `Missing ordered native activation: ${skill}`);
      prior = index;
      const response = blocks.find(
        (block) =>
          block.type === 'tool_result' && block.tool_use_id === uses[index].id,
      );
      assert.ok(response && response.is_error !== true);
      assert.match(String(response.content), /Launching skill:/u);
      result.activationResults.push({ skill, response: response.content });
    }
    assert.deepEqual(
      result.nativeInvocations,
      expected,
      'Expected the fixture single-correction skill sequence',
    );
    assert.equal(hook?.exit_code, 0);
    assert.match(context, /^Debug a reproducible failure/u);
    for (const name of expected)
      assert.ok(context.includes(`skill=${JSON.stringify(name)}`));
    assert.deepEqual(result.missingArtifacts, []);
    executionEvidence(fixture, events, uses, result);
    assert.equal(result.hostResult?.is_error, false);
    assert.equal(result.hostResult?.subtype, 'success');
    result.passed = true;
  } catch (error) {
    result.error = error.message;
  }
  writeFileSync(join(fixture, output), JSON.stringify(result, null, 2) + '\n');
  return result;
}
