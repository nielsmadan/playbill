import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, unlinkSync } from 'node:fs';
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

export function checkIdle(state) {
  ensure(
    !state.visit.checkLease,
    'Check is in flight; wait for its result. If interrupted, preserve evidence and inspect the lease for explicit intervention; it is never reset automatically',
  );
}

export function reserveCheck(tx, checkName) {
  const { config, state } = tx;
  checkIdle(state);
  const inputs = [
    ...new Set([
      ...config.sourcePaths,
      ...Object.keys(config.verificationHashes),
    ]),
  ];
  const id = randomUUID();
  const lease = {
    id,
    visitId: state.visit.id,
    nodeId: state.visit.nodeId,
    activationHash: hash(JSON.stringify(state.visit.activation)),
    root: config.root,
    runId: config.runId,
    configHash: config.configHash,
    sessionId: state.sessionId,
    check: checkName,
    inputs: hashes(config.root, inputs),
    reservedAt: new Date().toISOString(),
    rawPath: `${runtimePath(config)}/checks/${id}.raw.json`,
    path: `${runtimePath(config)}/checks/${id}.json`,
  };
  state.visit.checkLease = lease;
  state.visit.check = null;
  tx.event('check-reserved', { lease });
  return lease;
}

export function captureCheck(config, lease) {
  const check = config.checks[lease.check];
  const before = lease.inputs;
  const inputs = Object.keys(before);
  const previousResults = {};
  const startedAt = new Date().toISOString();
  let result = { status: null, signal: null };
  let captureError = null;
  try {
    ensure(
      same(before, hashes(config.root, inputs)),
      'Check inputs changed after reservation',
    );
    ensure(
      hash(readFileSync(config.configPath)) === lease.configHash,
      'Check configuration changed after reservation',
    );
    for (const name of check.resultFiles)
      previousResults[name] = snapshot(config.root, name);
    for (const name of check.resultFiles)
      if (previousResults[name]) unlinkSync(safePath(config.root, name));
    result = spawnSync(check.executable, check.args, {
      cwd: config.root,
      shell: false,
      timeout: check.timeoutMs,
      maxBuffer: check.maxBufferBytes,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    captureError = error.message;
  }
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  let after = null;
  let resultFiles = {};
  try {
    after = hashes(config.root, inputs);
  } catch (error) {
    captureError = error.message;
  }
  resultFiles = Object.fromEntries(
    check.resultFiles.map((name) => {
      try {
        return [name, snapshot(config.root, name)];
      } catch (error) {
        captureError = error.message;
        return [name, { captureError: error.message }];
      }
    }),
  );
  const infrastructureFailure = Boolean(
    result.error ||
    result.signal ||
    result.status === null ||
    captureError ||
    !same(before, after) ||
    check.resultFiles.some((name) => !resultFiles[name]?.nonempty),
  );
  const evidence = {
    version: 1,
    lease,
    visitId: lease.visitId,
    check: lease.check,
    executable: check.executable,
    args: check.args,
    startedAt,
    finishedAt: new Date().toISOString(),
    timeoutMs: check.timeoutMs,
    maxBufferBytes: check.maxBufferBytes,
    exitCode: result.status,
    signal: result.signal,
    error: result.error
      ? { code: result.error.code, message: result.error.message }
      : null,
    captureError,
    outcome: infrastructureFailure
      ? 'infrastructure-failure'
      : result.status === 0
        ? 'pass'
        : 'fail',
    before,
    after,
    stdout: { sha256: hash(stdout), base64: stdout.toString('base64') },
    stderr: { sha256: hash(stderr), base64: stderr.toString('base64') },
    previousResults,
    resultFiles,
  };
  writeJSON(config.root, lease.rawPath, evidence, true);
  return { evidence, sha256: fileHash(config.root, lease.rawPath) };
}

export function finalizeCheck(tx, lease, captured) {
  const { config, state } = tx;
  ensure(
    same(state.visit.checkLease, lease) &&
      state.visit.id === lease.visitId &&
      state.visit.nodeId === lease.nodeId &&
      hash(JSON.stringify(state.visit.activation)) === lease.activationHash,
    'Check lease/visit/activation mismatch; preserve raw evidence for intervention',
  );
  ensure(
    realpathSync(config.root) === lease.root &&
      state.root === lease.root &&
      state.runId === lease.runId &&
      state.sessionId === lease.sessionId &&
      state.configHash === lease.configHash &&
      hash(readFileSync(config.configPath)) === lease.configHash,
    'Check configuration/root/native session changed; preserve raw evidence for intervention',
  );
  ensure(
    fileHash(config.root, lease.rawPath) === captured.sha256,
    'Raw check evidence changed; preserve lease for intervention',
  );
  let finalInputs = null;
  let finalizationError = null;
  try {
    finalInputs = hashes(config.root, Object.keys(lease.inputs));
    ensure(
      same(lease.inputs, finalInputs),
      'Check inputs changed before finalization',
    );
  } catch (error) {
    finalizationError = error.message;
  }
  const evidence = {
    ...captured.evidence,
    raw: { path: lease.rawPath, sha256: captured.sha256 },
    finalizedAt: new Date().toISOString(),
    finalInputs,
    finalizationError,
    outcome: finalizationError
      ? 'infrastructure-failure'
      : captured.evidence.outcome,
  };
  writeJSON(config.root, lease.path, evidence, true);
  state.visit.check = {
    path: lease.path,
    sha256: fileHash(config.root, lease.path),
    outcome: evidence.outcome,
    inputs: lease.inputs,
  };
  state.visit.checkLease = null;
  tx.event('check', {
    leaseId: lease.id,
    evidence: lease.path,
    ...(config.executionHistory ? { sha256: state.visit.check.sha256 } : {}),
    outcome: evidence.outcome,
    exitCode: evidence.exitCode,
    finalizationError,
  });
  return evidence;
}
