import { Buffer } from 'node:buffer';
import { randomUUID, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import {
  ensure,
  fileHash,
  hash,
  hashes,
  runtimePath,
  safePath,
  same,
  snapshot,
  writeJSON,
} from './files.mjs';
import { executionFacts, journalHash } from './history.mjs';
import { conversationCommand, released } from './conversation.mjs';

const directory = (config) => `${runtimePath(config)}/report-reviews`;
const digest = (value) => hash(JSON.stringify(value));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const nonempty = (value) =>
  typeof value === 'string' && value.trim().length > 0;
export const decisionBytes = (decision) =>
  Buffer.from(JSON.stringify(decision));
export const reviewPolicy =
  'Inventory every actual test/check execution once, including failures and superseded attempts. Preserve exact command and visit provenance. Distinguish supplied-suite results from broader behavior claims. Do not call unperformed inspections performed. Keep unsupported claims unresolved. Quote each offending claim and cite specific frozen evidence. Do not supply a source fix, hidden probe, hidden solution, or advice from another experimental arm. Pending receipts at the frozen cutoff establish neither process completion nor process success.';

const reference = (config, path) => ({
  path,
  sha256: fileHash(config.root, path),
});
const retained = (config, ref) => {
  ensure(
    ref?.path?.startsWith(`${directory(config)}/`) &&
      /^[a-f0-9]{64}$/u.test(ref.sha256),
    'Malformed report review reference',
  );
  const bytes = readFileSync(safePath(config.root, ref.path));
  ensure(hash(bytes) === ref.sha256, 'Report review evidence changed');
  return JSON.parse(bytes.toString('utf8'));
};

function requestFor(config, gate) {
  return retained(config, gate.requests.at(-1));
}

export function validateReportReview(config, state, events) {
  const gate = state.reportReview;
  if (!gate) return;
  ensure(
    config.reportReview &&
      gate.visitId === state.visit.id &&
      ['pending', 'rejected', 'accepted', 'unresolved'].includes(gate.status) &&
      Array.isArray(gate.requests) &&
      gate.requests.length > 0 &&
      gate.requests.length <= 2 &&
      Array.isArray(gate.decisions) &&
      gate.decisions.length <= 2 &&
      Array.isArray(gate.submissions) &&
      (gate.status !== 'pending' || state.status === 'paused') &&
      (gate.status !== 'unresolved' || state.status === 'paused') &&
      (state.status !== 'done' || gate.status === 'accepted'),
    'Malformed report review state',
  );
  for (const ref of gate.requests) {
    const request = retained(config, ref);
    ensure(
      request.version === 1 &&
        request.id === ref.id &&
        request.runId === config.runId &&
        request.root === config.root &&
        request.configHash === config.configHash &&
        request.sessionId === state.sessionId &&
        request.visitId === gate.visitId &&
        request.reportHash === request.report.sha256 &&
        hash(Buffer.from(request.report.base64, 'base64')) ===
          request.reportHash &&
        digest(request.evidence) === request.evidenceHash &&
        journalHash(events.slice(0, request.cutoff)) ===
          request.evidence.journalHash,
      'Report review request integrity mismatch',
    );
    for (const [path, file] of Object.entries(request.evidence.retained))
      ensure(
        fileHash(config.root, path) === file.sha256,
        'Report review retained evidence changed',
      );
  }
  for (const ref of gate.submissions) retained(config, ref);
  for (const decision of gate.decisions) {
    const envelope = retained(config, decision);
    const request = gate.requests.find(
      (entry) => entry.id === decision.requestId,
    );
    ensure(request, 'Report review decision has no request');
    verifyDecision(config, state, envelope, retained(config, request), request);
  }
}

export function reviewStatus(config, state) {
  ensure(config.reportReview, 'Report review is not configured');
  return {
    gate: state.reportReview ?? null,
    request: state.reportReview ? requestFor(config, state.reportReview) : null,
    latestDecision: state.reportReview?.decisions.length
      ? retained(config, state.reportReview.decisions.at(-1))
      : null,
  };
}

export function requireReportReview(tx, artifacts) {
  const { config, state } = tx;
  const reportPath = config.executionHistory?.reportArtifact;
  if (!config.reportReview || !Object.hasOwn(artifacts, reportPath))
    return true;
  let gate = state.reportReview;
  if (gate?.status === 'accepted') {
    validateCurrent(tx, requestFor(config, gate));
    return true;
  }
  ensure(
    !gate || gate.status === 'rejected',
    'Report review is pending or unresolved',
  );
  ensure(
    !gate || gate.decisions.length < 2,
    'Report review decision limit reached',
  );
  const events = tx.events().map((event) => {
    const copy = { ...event };
    delete copy.stateHash;
    return copy;
  });
  const facts = executionFacts(config, events);
  const step = config.steps.find(
    (candidate) => candidate.id === state.visit.nodeId,
  );
  const watched = [
    ...new Set([
      ...config.sourcePaths,
      ...Object.keys(config.verificationHashes),
      ...Object.values(config.nativeSkills ?? {}),
    ]),
  ];
  const retainedPaths = [
    ...new Set([
      ...state.history.map((visit) => visit.artifacts.path),
      ...facts.configuredChecks.flatMap((check) =>
        check.evidence ? [check.evidence.path, check.raw.path] : [],
      ),
    ]),
  ];
  const evidence = {
    consumed: Object.fromEntries(
      step.consumes.map((path) => [path, snapshot(config.root, path)]),
    ),
    produced: artifacts,
    inputs: hashes(config.root, watched),
    activation: state.visit.activation,
    facts,
    events,
    journalHash: journalHash(events),
    retained: Object.fromEntries(
      retainedPaths.map((path) => [path, snapshot(config.root, path)]),
    ),
    priorDecisions: gate
      ? gate.decisions.map((ref) => retained(config, ref))
      : [],
  };
  const id = randomUUID();
  const request = {
    version: 1,
    id,
    root: config.root,
    runId: config.runId,
    configHash: config.configHash,
    sessionId: state.sessionId,
    visitId: state.visit.id,
    nodeId: state.visit.nodeId,
    createdAt: new Date().toISOString(),
    cutoff: events.length,
    policy: reviewPolicy,
    reportPath,
    report: artifacts[reportPath],
    reportHash: artifacts[reportPath].sha256,
    evidence,
    evidenceHash: digest(evidence),
  };
  const path = `${directory(config)}/${id}.request.json`;
  writeJSON(config.root, path, request, true);
  gate ??= {
    visitId: state.visit.id,
    requests: [],
    decisions: [],
    submissions: [],
  };
  gate.requests.push({ id, ...reference(config, path) });
  gate.status = 'pending';
  gate.reason = null;
  state.reportReview = gate;
  state.status = 'paused';
  state.stopBlocks = 0;
  tx.event('report-review-requested', {
    request: gate.requests.at(-1),
    reportHash: request.reportHash,
    evidenceHash: request.evidenceHash,
  });
  tx.event('paused', { reason: 'report-review-pending' });
  return false;
}

function lifecycleCommand(config, command, visitId) {
  if (typeof command !== 'string') return false;
  if (conversationCommand(config, command)) return true;
  const absoluteCliPaths = [
    join(dirname(config.configPath), 'cli.mjs'),
    fileURLToPath(new URL('./cli.mjs', import.meta.url)),
  ];
  const cliPaths = [
    ...new Set(
      absoluteCliPaths.flatMap((path) => [path, relative(config.root, path)]),
    ),
  ];
  const configPaths = [
    config.configPath,
    relative(config.root, config.configPath),
  ];
  for (const executable of [
    'node',
    quote('node'),
    process.execPath,
    quote(process.execPath),
  ])
    for (const cli of cliPaths)
      for (const cliArg of [cli, quote(cli)])
        for (const configArg of configPaths.flatMap((path) => [
          path,
          quote(path),
        ]))
          for (const suffix of [
            'status',
            'history',
            'review',
            `complete ${visitId}`,
          ])
            if (command === `${executable} ${cliArg} ${configArg} ${suffix}`)
              return true;
  return false;
}

function validateCurrent(tx, request) {
  const { config, state } = tx;
  ensure(
    state.visit.id === request.visitId &&
      digest(state.visit.activation) === digest(request.evidence.activation) &&
      same(
        hashes(config.root, Object.keys(request.evidence.inputs)),
        request.evidence.inputs,
      ),
    'Stale report review: visit, activation or source/input changed',
  );
  for (const [path, file] of Object.entries({
    ...request.evidence.consumed,
    ...request.evidence.produced,
  }))
    ensure(
      snapshot(config.root, path)?.sha256 === file.sha256,
      `Stale report review: artifact changed: ${path}`,
    );
  for (const event of tx.events().slice(request.cutoff)) {
    ensure(
      !['check-reserved', 'check', 'activated'].includes(event.kind),
      'Stale report review: execution evidence changed',
    );
    if (['tool-pre', 'tool-post'].includes(event.kind))
      ensure(
        event.tool === 'Bash' &&
          lifecycleCommand(config, event.input?.command, request.visitId),
        'Stale report review: native execution evidence changed',
      );
  }
}

export function refreshAcceptedReview(tx) {
  const gate = tx.state.reportReview;
  if (gate?.status !== 'accepted') return;
  try {
    validateCurrent(tx, requestFor(tx.config, gate));
  } catch (error) {
    gate.status = gate.decisions.length < 2 ? 'rejected' : 'unresolved';
    gate.reason = error.message;
    tx.state.status = 'paused';
    tx.event('report-review-invalidated', { reason: gate.reason });
  }
}

function verifyDecision(config, state, envelope, request, ref) {
  const decision = envelope?.decision;
  ensure(
    decision &&
      decision.version === 1 &&
      ['accept', 'reject'].includes(decision.verdict) &&
      nonempty(decision.reviewer) &&
      decision.reviewer !== state.sessionId &&
      Number.isFinite(Date.parse(decision.reviewedAt)) &&
      Array.isArray(decision.findings) &&
      decision.findings.every(
        (finding) =>
          nonempty(finding?.claim) &&
          nonempty(finding?.evidence) &&
          nonempty(finding?.reason),
      ) &&
      (decision.verdict !== 'reject' || decision.findings.length > 0) &&
      typeof envelope.signature === 'string',
    'Malformed report review decision or non-independent reviewer',
  );
  const signature = Buffer.from(envelope.signature, 'base64');
  ensure(
    signature.toString('base64') === envelope.signature &&
      verify(
        null,
        decisionBytes(decision),
        config.reportReview.publicKey,
        signature,
      ),
    'Invalid report review signature',
  );
  ensure(
    decision.requestId === request.id &&
      decision.requestHash === ref.sha256 &&
      decision.reportHash === request.reportHash &&
      decision.evidenceHash === request.evidenceHash,
    'Stale or mismatched report review decision',
  );
  return decision;
}

export function applyReviewDecision(tx, path) {
  const { config, state } = tx;
  ensure(config.reportReview, 'Report review is not configured');
  const gate = state.reportReview;
  ensure(gate, 'No report review request');
  const bytes = readFileSync(path);
  const submissionPath = `${directory(config)}/${randomUUID()}.submission.json`;
  writeJSON(
    config.root,
    submissionPath,
    { base64: bytes.toString('base64'), sha256: hash(bytes) },
    true,
  );
  gate.submissions.push(reference(config, submissionPath));
  tx.event('report-review-submitted', { submission: gate.submissions.at(-1) });
  ensure(
    gate.status === 'pending' && state.status === 'paused',
    'Report review is not pending; stale decision cannot be reused',
  );
  ensure(gate.decisions.length < 2, 'Report review decision limit reached');
  const envelope = JSON.parse(bytes.toString('utf8'));
  const ref = gate.requests.at(-1);
  const request = requestFor(config, gate);
  const decision = verifyDecision(config, state, envelope, request, ref);
  let stale = null;
  try {
    validateCurrent(tx, request);
  } catch (error) {
    stale = error.message;
  }
  const decisionPath = `${directory(config)}/${request.id}.decision.json`;
  writeJSON(config.root, decisionPath, envelope, true);
  const accepted = decision.verdict === 'accept' && !stale;
  gate.decisions.push({
    requestId: request.id,
    verdict: decision.verdict,
    outcome: stale ? 'stale' : decision.verdict,
    ...reference(config, decisionPath),
  });
  gate.status = accepted
    ? 'accepted'
    : gate.decisions.length === 2
      ? 'unresolved'
      : 'rejected';
  gate.reason = stale ?? (accepted ? null : 'Report review rejected the draft');
  const canContinue =
    !released(state) && !(config.conversation && state.readOnlyTurn);
  state.status =
    gate.status === 'unresolved' || !canContinue ? 'paused' : 'active';
  if (canContinue) {
    state.readOnlyTurn = false;
    state.stopBlocks = 0;
  }
  tx.event('report-review-decided', {
    decision: gate.decisions.at(-1),
    status: gate.status,
    reason: gate.reason,
    findings: decision.findings,
  });
  if (gate.status === 'unresolved')
    tx.event('paused', { reason: 'report-review-unresolved', decisions: 2 });
  if (stale) throw new Error(stale);
  return accepted && canContinue;
}
