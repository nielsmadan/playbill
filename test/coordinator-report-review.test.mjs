import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { decisionBytes } from '../scripts/coordinator/report-review.mjs';

const temporary = mkdtempSync(join(process.cwd(), '.test-runs-report-review-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const cliPath = fileURLToPath(
  new URL('../scripts/coordinator/cli.mjs', import.meta.url),
);
const hookPath = fileURLToPath(
  new URL('../scripts/coordinator/hook.mjs', import.meta.url),
);
const runtime = '.playbill/coordinator/runtime';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
const files = (root) =>
  Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, sha(readFileSync(path))];
      }),
  );

function fixture(extra = {}) {
  const root = mkdtempSync(join(temporary, 'case-'));
  const configPath = join(root, '.playbill/coordinator/config.json');
  const config = {
    version: 1,
    root,
    runId: 'report-test',
    entry: 'report',
    steps: [
      {
        id: 'report',
        title: 'Report',
        skill: 'playbill:report',
        instruction: 'Report retained execution evidence.',
        consumes: ['evidence.md'],
        produces: ['report.md'],
        allowSourceWrites: false,
        next: null,
      },
    ],
    maxTransitions: 2,
    checks: {
      original: {
        executable: process.execPath,
        args: ['-e', 'console.error("failed assertion");process.exitCode=1'],
        resultFiles: [],
      },
    },
    sourcePaths: ['source.txt'],
    verificationHashes: { 'supplied.txt': sha('immutable') },
    executionHistory: { reportArtifact: 'report.md' },
    reportReview: { publicKey },
    ...extra,
  };
  write(configPath, JSON.stringify(config));
  write(join(root, 'source.txt'), 'baseline');
  write(join(root, 'supplied.txt'), 'immutable');
  write(join(root, 'evidence.md'), 'The supplied check failed.');
  const invoke = (path, args, options = {}) =>
    spawnSync(process.execPath, [path, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      ...options,
    });
  const cli = (command, argument) =>
    invoke(cliPath, [
      configPath,
      command,
      ...(argument === undefined ? [] : [argument]),
    ]);
  const hook = (hook_event_name, event = {}) =>
    invoke(hookPath, [configPath], {
      input: JSON.stringify({
        hook_event_name,
        session_id: 'worker-session',
        cwd: root,
        ...event,
      }),
    });
  const activate = () => {
    const event = {
      tool_name: 'Skill',
      tool_use_id: 'native-report-skill',
      tool_input: { skill: 'playbill:report' },
    };
    success(hook('PreToolUse', event));
    success(
      hook('PostToolUse', { ...event, tool_response: { success: true } }),
    );
  };
  const start = () => {
    success(hook('SessionStart'));
    activate();
    write(
      join(root, 'report.md'),
      'The supplied check failed; broader behavior remains unresolved.\n',
    );
  };
  const state = () => read(join(root, runtime, 'state.json'));
  const request = () => success(cli('review')).review.request;
  const signed = (
    verdict = 'accept',
    changes = {},
    signingKey = keys.privateKey,
  ) => {
    const current = request();
    const decision = {
      version: 1,
      requestId: current.id,
      requestHash: state().reportReview.requests.at(-1).sha256,
      reportHash: current.reportHash,
      evidenceHash: current.evidenceHash,
      verdict,
      findings:
        verdict === 'reject'
          ? [
              {
                claim: 'The supplied check failed',
                evidence: 'evidence.consumed.evidence.md',
                reason: 'The report omits the separate failed native attempt.',
              },
            ]
          : [],
      reviewer: 'independent-reviewer-session',
      reviewedAt: new Date().toISOString(),
      ...changes,
    };
    return {
      decision,
      signature: sign(null, decisionBytes(decision), signingKey).toString(
        'base64',
      ),
    };
  };
  let submissions = 0;
  const submit = (envelope) => {
    const path = join(
      temporary,
      `decision-${root.split('/').at(-1)}-${++submissions}.json`,
    );
    write(
      path,
      typeof envelope === 'string' ? envelope : JSON.stringify(envelope),
    );
    return cli('review-decision', path);
  };
  return {
    root,
    config,
    configPath,
    cli,
    hook,
    start,
    state,
    request,
    signed,
    submit,
  };
}

test('signed acceptance freezes all failed executions and completes the unchanged report through the CLI', () => {
  const f = fixture();
  f.start();
  success(f.cli('check'));
  success(f.cli('check'));
  const wrapper = {
    tool_name: 'Bash',
    tool_use_id: 'complete-report',
    tool_input: { command: `node '${cliPath}' '${f.configPath}' complete v1` },
  };
  success(f.hook('PreToolUse', wrapper));
  const generatedBefore = readFileSync(
    join(f.root, runtime, 'execution-history.json'),
  );
  const pending = success(f.cli('complete', 'v1'));
  assert.equal(pending.state.status, 'paused');
  assert.equal(pending.state.completed, 0);
  assert.equal(f.state().reportReview.status, 'pending');
  assert.deepEqual(
    readFileSync(join(f.root, runtime, 'execution-history.json')),
    generatedBefore,
  );
  const request = f.request();
  assert.deepEqual(
    request.evidence.facts.configuredChecks.map((check) => check.outcome),
    ['fail', 'fail'],
  );
  assert.equal(Object.keys(request.evidence.retained).length, 4);
  assert.equal(
    request.evidence.facts.shellInvocations[0].receiptState,
    'pending',
  );
  const frozen = readFileSync(
    join(f.root, f.state().reportReview.requests[0].path),
  );
  success(
    f.hook('PostToolUse', {
      ...wrapper,
      tool_response: JSON.stringify(pending),
    }),
  );
  const done = success(f.submit(f.signed()));
  assert.equal(done.state.status, 'done');
  assert.equal(done.state.completed, 1);
  assert.equal(done.state.reportReview.status, 'accepted');
  assert.equal(done.state.reportReview.decisions.length, 1);
  const finalHistory = read(join(f.root, runtime, 'execution-history.json'));
  assert.equal(finalHistory.counts.shellInvocations, 1);
  assert.equal(finalHistory.shellInvocations[0].receiptState, 'received');
  assert.equal(
    finalHistory.cutoff.sequence,
    finalHistory.shellInvocations[0].post.sequence,
  );
  assert.deepEqual(
    finalHistory.configuredChecks.map((check) => check.outcome),
    ['fail', 'fail'],
  );
  assert.deepEqual(
    readFileSync(join(f.root, done.state.reportReview.requests[0].path)),
    frozen,
  );
  const narrative = read(
    join(f.root, f.state().visit.executionHistory.narrative.path),
  );
  assert.deepEqual(narrative['report.md'], request.report);
  assert.match(
    readFileSync(join(f.root, 'report.md'), 'utf8'),
    /Generated execution history/u,
  );
  reject(f.submit(f.signed()), /not pending|stale decision/u);
  assert.equal(f.state().reportReview.decisions.length, 1);
  assert.deepEqual(
    read(join(f.root, runtime, 'execution-history.json')),
    finalHistory,
  );
});

test('a rejected draft and its findings survive revision and second-decision acceptance on the same visit', () => {
  const f = fixture();
  f.start();
  success(f.cli('complete', 'v1'));
  const original = f.request();
  const activation = f.state().visit.activation;
  const rejection = f.signed('reject');
  const rejected = success(f.submit(rejection));
  assert.equal(rejected.state.status, 'active');
  assert.equal(rejected.state.visit.id, 'v1');
  assert.match(rejected.context, /Revise this same visit/u);
  assert.deepEqual(success(f.cli('review')).review.latestDecision, rejection);
  write(
    join(f.root, 'report.md'),
    'Both native and supplied checks failed. Broader behavior is unresolved.\n',
  );
  success(f.cli('complete', 'v1'));
  assert.notEqual(f.request().reportHash, original.reportHash);
  assert.deepEqual(f.state().visit.activation, activation);
  reject(f.submit(rejection), /Stale or mismatched/u);
  assert.equal(f.state().reportReview.decisions.length, 1);
  const done = success(f.submit(f.signed()));
  assert.equal(done.state.status, 'done');
  assert.equal(done.state.reportReview.requests.length, 2);
  assert.equal(done.state.reportReview.decisions.length, 2);
  const prior = read(join(f.root, done.state.reportReview.requests[0].path));
  assert.deepEqual(prior.report, original.report);
  const retainedDecision = read(
    join(f.root, done.state.reportReview.decisions[0].path),
  );
  assert.deepEqual(retainedDecision, rejection);
});

test('two rejections pause explicitly unresolved and neither resume nor Stop bypasses the gate', () => {
  const f = fixture();
  f.start();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    write(join(f.root, 'report.md'), `Draft ${attempt}`);
    success(f.cli('complete', 'v1'));
    success(f.submit(f.signed('reject')));
  }
  const result = success(f.cli('status'));
  assert.equal(result.state.status, 'paused');
  assert.equal(result.state.reportReview.status, 'unresolved');
  assert.equal(result.state.completed, 0);
  assert.match(
    result.context,
    /limit is exhausted with an unresolved outcome/u,
  );
  reject(f.cli('resume'), /cannot bypass/u);
  reject(f.cli('complete', 'v1'), /Coordinator is paused/u);
  assert.deepEqual(success(f.hook('Stop')), {});
  assert.equal(f.state().reportReview.requests.length, 2);
  assert.equal(existsSync(join(f.root, runtime, 'reports')), false);
});

test('missing, malformed, forged, self-authored and mismatched decisions remain pending with every submission retained', () => {
  const f = fixture();
  f.start();
  success(f.cli('complete', 'v1'));
  const tampered = f.signed();
  tampered.decision.reviewer = 'changed-after-signature';
  const cases = [
    ['{', /JSON/u],
    [{}, /Malformed/u],
    [tampered, /Invalid report review signature/u],
    [
      f.signed('accept', {}, generateKeyPairSync('ed25519').privateKey),
      /Invalid report review signature/u,
    ],
    [f.signed('accept', { reviewer: 'worker-session' }), /non-independent/u],
    [
      f.signed('accept', { requestHash: '0'.repeat(64) }),
      /Stale or mismatched/u,
    ],
    [
      f.signed('accept', { reportHash: '0'.repeat(64) }),
      /Stale or mismatched/u,
    ],
    [
      f.signed('accept', { evidenceHash: '0'.repeat(64) }),
      /Stale or mismatched/u,
    ],
  ];
  for (const [envelope, error] of cases) reject(f.submit(envelope), error);
  reject(f.cli('review-decision'), /Usage/u);
  reject(f.cli('resume'), /cannot bypass/u);
  assert.equal(f.state().reportReview.status, 'pending');
  assert.equal(f.state().reportReview.decisions.length, 0);
  assert.equal(f.state().reportReview.submissions.length, cases.length);
  for (const ref of f.state().reportReview.submissions) {
    const submission = read(join(f.root, ref.path));
    assert.equal(
      sha(Buffer.from(submission.base64, 'base64')),
      submission.sha256,
    );
  }
  assert.equal(success(f.submit(f.signed())).state.status, 'done');
});

test('signed approval becomes stale after report, consumed evidence, source, verification, or execution changes', () => {
  for (const target of [
    'report.md',
    'evidence.md',
    'source.txt',
    'supplied.txt',
    'execution',
  ]) {
    const f = fixture();
    f.start();
    success(f.cli('complete', 'v1'));
    const approval = f.signed();
    if (target === 'execution') {
      const event = {
        tool_name: 'Bash',
        tool_use_id: 'late-execution',
        tool_input: { command: 'node --test' },
      };
      success(f.hook('PreToolUse', event));
      success(
        f.hook('PostToolUse', { ...event, tool_response: 'all tests passed' }),
      );
    } else write(join(f.root, target), 'changed after freezing');
    reject(f.submit(approval), /Stale report review/u);
    assert.equal(f.state().history.length, 0);
    assert.equal(f.state().reportReview.status, 'rejected');
    assert.equal(f.state().reportReview.decisions[0].outcome, 'stale');
    assert.equal(existsSync(join(f.root, runtime, 'reports')), false);
  }
});

test('pending status, review and history reads preserve every runtime byte across Stop and compaction', () => {
  const f = fixture();
  f.start();
  success(f.cli('complete', 'v1'));
  const requestBefore = readFileSync(
    join(f.root, f.state().reportReview.requests[0].path),
  );
  assert.deepEqual(success(f.hook('Stop')), {});
  success(f.hook('SessionStart', { source: 'compact' }));
  success(f.hook('UserPromptSubmit', { prompt: 'Read-only status only.' }));
  const before = files(join(f.root, runtime));
  for (const command of ['status', 'history', 'review'])
    success(f.cli(command));
  assert.deepEqual(files(join(f.root, runtime)), before);
  assert.deepEqual(
    readFileSync(join(f.root, f.state().reportReview.requests[0].path)),
    requestBefore,
  );
  assert.equal(success(f.submit(f.signed())).state.status, 'done');
});

test('changed frozen requests fail read-only integrity checks without replacing snapshots', () => {
  const f = fixture();
  f.start();
  success(f.cli('complete', 'v1'));
  write(join(f.root, f.state().reportReview.requests[0].path), '{}');
  const before = files(join(f.root, runtime));
  for (const command of ['status', 'history', 'review'])
    reject(f.cli(command), /review evidence changed/u);
  assert.deepEqual(files(join(f.root, runtime)), before);
});

test('disabled report review preserves immediate history completion and rejects private worker configuration', () => {
  const f = fixture({ reportReview: undefined });
  f.start();
  const done = success(f.cli('complete', 'v1'));
  assert.equal(done.state.status, 'done');
  assert.equal(done.state.completed, 1);
  assert.equal(existsSync(join(f.root, runtime, 'report-reviews')), false);
  for (const config of [
    { reportReview: { publicKey, maxDecisions: 3 } },
    {
      reportReview: {
        publicKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      },
    },
    { executionHistory: undefined },
  ]) {
    const bad = fixture(config);
    reject(bad.hook('SessionStart'), /Invalid reportReview/u);
  }
});

test('exiting a pending report review preserves the decision without completing or reactivating the workflow', () => {
  const f = fixture({ conversation: {} });
  f.start();
  success(f.cli('complete', 'v1'));
  const approval = f.signed();
  const request = f.request();
  success(f.cli('exit'));
  success(f.submit(approval));
  assert.equal(f.state().conversation.mode, 'exited');
  assert.equal(f.state().status, 'paused');
  assert.equal(f.state().history.length, 0);
  assert.equal(f.state().reportReview.decisions.length, 1);
  assert.deepEqual(f.request().report, request.report);
  assert.equal(existsSync(join(f.root, runtime, 'reports')), false);
  assert.deepEqual(success(f.hook('Stop')), {});
  assert.deepEqual(
    success(
      f.hook('UserPromptSubmit', { prompt: 'Work on the new objective.' }),
    ),
    {},
  );
});

test('resuming after new outside executions invalidates an accepted review and allows a fresh review', () => {
  const f = fixture({ conversation: {} });
  f.start();
  success(f.cli('complete', 'v1'));
  const approval = f.signed();
  success(f.cli('exit'));
  success(f.submit(approval));
  const event = {
    tool_name: 'Bash',
    tool_use_id: 'outside-command',
    tool_input: { command: 'pwd' },
  };
  success(f.hook('PreToolUse', event));
  success(f.hook('PostToolUse', { ...event, tool_response: f.root }));
  const resumed = success(f.cli('resume'));
  assert.equal(resumed.state.conversation.mode, 'engaged');
  assert.equal(resumed.state.reportReview.status, 'rejected');
  assert.equal(resumed.state.reportReview.decisions.length, 1);
  write(
    join(f.root, 'report.md'),
    'The supplied check failed; later work included a directory inspection.',
  );
  const pending = success(f.cli('complete', 'v1'));
  assert.equal(pending.state.reportReview.status, 'pending');
  assert.equal(pending.state.reportReview.requests.length, 2);
});
