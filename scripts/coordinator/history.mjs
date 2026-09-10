import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  ensure,
  fileHash,
  hash,
  runtime,
  safePath,
  same,
  snapshot,
  writeJSON,
} from './files.mjs';

export const historyPaths = {
  json: `${runtime}/execution-history.json`,
  markdown: `${runtime}/execution-history.md`,
};
const journalPath = `${runtime}/events.jsonl`;
const digest = (event) => {
  const content = { ...event };
  delete content.stateHash;
  return hash(JSON.stringify(content));
};
export const journalHash = (events) => hash(events.map(digest).join('\n'));
const reference = (config, path) => ({
  path,
  sha256: fileHash(config.root, path),
});
const receipt = (event) => ({
  path: journalPath,
  sequence: event.sequence,
  sha256: digest(event),
});
const nativeField = (event, field) =>
  event[field] === null ? null : { ...receipt(event), field };
const resultReferences = (files, evidence, field) =>
  Object.fromEntries(
    Object.entries(files).map(([name, file]) => [
      name,
      file === null
        ? null
        : {
            ...(file.captureError
              ? { captureError: file.captureError }
              : {
                  sha256: file.sha256,
                  size: file.size,
                  nonempty: file.nonempty,
                }),
            evidence: { ...evidence, field, name },
          },
    ]),
  );

function retained(config, ref) {
  ensure(
    ref &&
      typeof ref.path === 'string' &&
      ref.path.startsWith(`${runtime}/`) &&
      /^[a-f0-9]{64}$/u.test(ref.sha256),
    'Malformed execution history evidence reference',
  );
  const bytes = readFileSync(safePath(config.root, ref.path));
  ensure(
    hash(bytes) === ref.sha256,
    `Execution history evidence changed: ${ref.path}`,
  );
  return bytes;
}

function validBlob(blob, sized = false) {
  ensure(
    blob && typeof blob.base64 === 'string',
    'Malformed retained execution bytes',
  );
  const bytes = Buffer.from(blob.base64, 'base64');
  ensure(
    bytes.toString('base64') === blob.base64 &&
      hash(bytes) === blob.sha256 &&
      (!sized ||
        (blob.size === bytes.length &&
          blob.nonempty === bytes.toString('utf8').trim().length > 0)),
    'Malformed retained execution bytes',
  );
}

function checkEvidence(config, lease, event) {
  ensure(event.evidence === lease.path, 'Malformed configured check reference');
  const evidenceRef = { path: event.evidence, sha256: event.sha256 };
  const evidence = JSON.parse(retained(config, evidenceRef).toString('utf8'));
  const configured = config.checks[lease.check];
  ensure(
    evidence.version === 1 &&
      same(evidence.lease, lease) &&
      evidence.visitId === lease.visitId &&
      evidence.check === lease.check &&
      evidence.executable === configured.executable &&
      same(evidence.args, configured.args) &&
      evidence.timeoutMs === configured.timeoutMs &&
      evidence.maxBufferBytes === configured.maxBufferBytes &&
      ['pass', 'fail', 'infrastructure-failure'].includes(evidence.outcome) &&
      evidence.outcome === event.outcome &&
      evidence.exitCode === event.exitCode &&
      (evidence.exitCode === null || Number.isInteger(evidence.exitCode)) &&
      (evidence.signal === null || typeof evidence.signal === 'string') &&
      evidence.raw?.path === lease.rawPath &&
      Number.isFinite(Date.parse(evidence.startedAt)) &&
      Number.isFinite(Date.parse(evidence.finishedAt)) &&
      Number.isFinite(Date.parse(evidence.finalizedAt)),
    'Malformed configured check evidence',
  );
  const raw = JSON.parse(retained(config, evidence.raw).toString('utf8'));
  const {
    raw: rawRef,
    finalizedAt,
    finalInputs,
    finalizationError,
    ...captured
  } = evidence;
  ensure(
    same({ ...captured, outcome: raw.outcome }, raw) &&
      evidence.outcome ===
        (finalizationError ? 'infrastructure-failure' : raw.outcome) &&
      rawRef &&
      finalizedAt &&
      finalInputs !== undefined,
    'Malformed raw configured check evidence',
  );
  validBlob(evidence.stdout);
  validBlob(evidence.stderr);
  for (const group of [evidence.previousResults, evidence.resultFiles]) {
    ensure(
      group &&
        typeof group === 'object' &&
        !Array.isArray(group) &&
        Object.keys(group).every((name) =>
          configured.resultFiles.includes(name),
        ),
      'Malformed configured check result files',
    );
    for (const blob of Object.values(group))
      if (blob !== null && !blob.captureError) validBlob(blob, true);
  }
  return { evidence, evidenceRef };
}

export function executionFacts(config, events) {
  const shells = new Map();
  const checks = new Map();
  let cutoff = { sequence: 0, timestamp: null };
  for (const event of events) {
    if (
      (['tool-pre', 'tool-post'].includes(event.kind) &&
        event.tool === 'Bash') ||
      ['check-reserved', 'check'].includes(event.kind)
    )
      cutoff = { sequence: event.sequence, timestamp: event.timestamp };
    if (
      ['tool-pre', 'tool-post'].includes(event.kind) &&
      event.tool === 'Bash'
    ) {
      ensure(
        typeof event.toolUseId === 'string' &&
          typeof event.input?.command === 'string',
        'Malformed native Bash evidence',
      );
      let shell = shells.get(event.toolUseId);
      if (event.kind === 'tool-pre') {
        ensure(!shell, 'Duplicate native Bash receipt');
        shell = {
          id: `bash:${event.toolUseId}`,
          toolUseId: event.toolUseId,
          visitId: event.visitId,
          command: event.input.command,
          input: event.input,
          receiptState: event.denied ? 'denied' : 'pending',
          denied: event.denied,
          pre: receipt(event),
          post: null,
          nativeEvent: null,
          response: null,
          error: null,
        };
        shells.set(event.toolUseId, shell);
      } else {
        ensure(
          !shell?.post && (!shell || same(shell.input, event.input)),
          'Mismatched native Bash receipt',
        );
        ensure(
          ['PostToolUse', 'PostToolUseFailure'].includes(event.nativeEvent),
          'Malformed native Bash result',
        );
        if (!shell) {
          shell = {
            id: `bash:${event.toolUseId}`,
            toolUseId: event.toolUseId,
            visitId: event.originVisitId,
            command: event.input.command,
            input: event.input,
            denied: null,
            pre: null,
          };
          shells.set(event.toolUseId, shell);
        }
        shell.receiptState = !shell.pre
          ? 'missing-pre'
          : event.response === null && event.error === null
            ? 'missing-result'
            : 'received';
        shell.post = receipt(event);
        shell.nativeEvent = event.nativeEvent;
        shell.response = nativeField(event, 'response');
        shell.error = nativeField(event, 'error');
      }
    }
    if (event.kind === 'check-reserved') {
      const lease = event.lease;
      ensure(
        lease &&
          typeof lease.id === 'string' &&
          !checks.has(lease.id) &&
          lease.visitId === event.visitId &&
          lease.runId === config.runId &&
          lease.root === config.root &&
          lease.configHash === config.configHash &&
          Object.hasOwn(config.checks, lease.check) &&
          lease.path === `${runtime}/checks/${lease.id}.json` &&
          lease.rawPath === `${runtime}/checks/${lease.id}.raw.json`,
        'Malformed configured check reservation',
      );
      const check = config.checks[lease.check];
      checks.set(lease.id, {
        id: lease.id,
        visitId: lease.visitId,
        nodeId: lease.nodeId,
        check: lease.check,
        executable: check.executable,
        args: check.args,
        receiptState: 'pending',
        outcome: null,
        exitCode: null,
        reservation: receipt(event),
        lease,
        evidence: null,
      });
    }
    if (event.kind === 'check') {
      const check = checks.get(event.leaseId);
      ensure(
        check && !check.evidence,
        'Missing or duplicate configured check reservation',
      );
      const { evidence, evidenceRef } = checkEvidence(
        config,
        check.lease,
        event,
      );
      Object.assign(check, {
        receiptState: 'finalized',
        outcome: evidence.outcome,
        exitCode: evidence.exitCode,
        signal: evidence.signal,
        error: evidence.error,
        captureError: evidence.captureError,
        finalizationError: evidence.finalizationError,
        startedAt: evidence.startedAt,
        finishedAt: evidence.finishedAt,
        evidence: evidenceRef,
        raw: evidence.raw,
        stdout: { ...evidenceRef, field: 'stdout' },
        stderr: { ...evidenceRef, field: 'stderr' },
        resultFiles: resultReferences(
          evidence.resultFiles,
          evidenceRef,
          'resultFiles',
        ),
        previousResults: resultReferences(
          evidence.previousResults,
          evidenceRef,
          'previousResults',
        ),
        finalized: receipt(event),
      });
    }
  }
  return {
    version: 1,
    runId: config.runId,
    source: journalPath,
    cutoff,
    interpretation:
      'Shell invocations are native tool receipts, not additional configured checks. No underlying process status is inferred from shell command text or response text. Pending receipts and reservations do not establish completion.',
    counts: {
      shellInvocations: shells.size,
      configuredChecks: checks.size,
      finalizedChecks: [...checks.values()].filter((check) => check.evidence)
        .length,
      pendingChecks: [...checks.values()].filter((check) => !check.evidence)
        .length,
    },
    shellInvocations: [...shells.values()],
    configuredChecks: [...checks.values()],
  };
}

const cell = (value) =>
  JSON.stringify(String(value))
    .slice(1, -1)
    .replaceAll('|', '&#124;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('`', '&#96;');
const preview = (value) =>
  cell(
    value.length > 200
      ? `${value.slice(0, 200)}… [exact command in JSON]`
      : value,
  );

export function historyMarkdown(facts, paths = historyPaths) {
  return [
    '## Generated execution history',
    '',
    facts.interpretation,
    'This snapshot includes only receipts retained when it was generated. The JSON retains exact shell commands and verified references to native responses/errors and check evidence. Full native bodies remain in the journal; generated facts never embed prior history responses. Model narrative above is preserved and requires separate accuracy review.',
    `Evidence cutoff: journal event ${facts.cutoff.sequence} (${facts.cutoff.timestamp ?? 'no execution receipts yet'}). Pending Bash receipts, including any enclosing completion/check wrapper, have not returned at this cutoff; they do not establish a missing or completed test. Generated files refresh only at initialization, activation, configured-check reservation/finalization or visit completion, and remain frozen during paused, read-only and completed turns. Native receipts alone do not rewrite them; the history CLI projects current retained receipts without rewriting files.`,
    '',
    `Facts: ${paths.json}. Markdown: ${paths.markdown}.`,
    '',
    `Shell invocations: ${facts.counts.shellInvocations}. Configured checks: ${facts.counts.configuredChecks} (${facts.counts.finalizedChecks} finalized, ${facts.counts.pendingChecks} pending). These counts must not be added as a test total.`,
    '',
    '### Native Bash invocations',
    '',
    '| ID / visit | Receipt | Command preview | Native evidence |',
    '| --- | --- | --- | --- |',
    ...facts.shellInvocations.map(
      (shell) =>
        `| ${cell(shell.id)} / ${cell(shell.visitId ?? 'unknown')} | ${cell(shell.receiptState)}${shell.nativeEvent ? ` (${cell(shell.nativeEvent)})` : ''} | ${preview(shell.command)} | journal events ${shell.pre?.sequence ?? 'missing'} / ${shell.post?.sequence ?? 'pending'} |`,
    ),
    '',
    '### Configured process executions',
    '',
    '| ID / visit | Check | Retained outcome | Process exit / signal | Evidence |',
    '| --- | --- | --- | --- | --- |',
    ...facts.configuredChecks.map(
      (check) =>
        `| ${cell(check.id)} / ${cell(check.visitId)} | ${cell(check.check)} | ${check.outcome ?? 'pending (not finalized)'} | ${check.exitCode ?? 'unknown'} / ${cell(check.signal ?? 'none recorded')} | ${cell(check.evidence?.path ?? check.lease.rawPath)}${check.evidence ? '' : ' (expected raw path; no finalized evidence)'} |`,
    ),
    '',
  ].join('\n');
}

export function validateHistory(config, state, events) {
  ensure(
    state.executionHistory &&
      state.executionHistory.journalHash === journalHash(events),
    'Execution history journal integrity mismatch',
  );
  for (const [key, path] of Object.entries(historyPaths)) {
    ensure(
      state.executionHistory[key]?.path === path,
      'Malformed generated history path',
    );
    retained(config, state.executionHistory[key]);
  }
  executionFacts(config, events);
  const saved = JSON.parse(
    retained(config, state.executionHistory.json).toString('utf8'),
  );
  ensure(
    Number.isInteger(saved.cutoff?.sequence) &&
      saved.cutoff.sequence >= 0 &&
      saved.cutoff.sequence <= events.length,
    'Malformed execution history cutoff',
  );
  const facts = executionFacts(config, events.slice(0, saved.cutoff.sequence));
  ensure(
    same(
      JSON.parse(
        retained(config, state.executionHistory.json).toString('utf8'),
      ),
      facts,
    ) &&
      retained(config, state.executionHistory.markdown).toString('utf8') ===
        historyMarkdown(facts),
    'Generated execution history does not match retained evidence',
  );
  for (const visit of state.history) {
    if (!visit.executionHistory) continue;
    for (const [key, extension] of [
      ['json', 'json'],
      ['markdown', 'md'],
      ['narrative', 'narrative.json'],
    ]) {
      ensure(
        visit.executionHistory[key]?.path ===
          `${runtime}/reports/${visit.id}.${extension}`,
        'Malformed report history path',
      );
      retained(config, visit.executionHistory[key]);
    }
    retained(config, visit.artifacts);
  }
}

export function persistHistory(config, state, events, materialize) {
  const facts = executionFacts(config, events);
  if (!materialize && state.executionHistory) {
    state.executionHistory.journalHash = journalHash(events);
    return;
  }
  const markdown = historyMarkdown(facts);
  const values = { json: JSON.stringify(facts, null, 2) + '\n', markdown };
  for (const [key, path] of Object.entries(historyPaths)) {
    if (!state.executionHistory?.[key])
      ensure(
        !existsSync(safePath(config.root, path)),
        `Unowned generated history path: ${path}`,
      );
  }
  for (const [key, path] of Object.entries(historyPaths)) {
    const previous = state.executionHistory?.[key];
    if (previous?.sha256 === hash(values[key])) continue;
    if (key === 'json') writeJSON(config.root, path, facts, !previous);
    else
      writeFileSync(safePath(config.root, path), markdown, {
        flag: previous ? 'w' : 'wx',
      });
  }
  state.executionHistory = {
    journalHash: journalHash(events),
    json: reference(config, historyPaths.json),
    markdown: reference(config, historyPaths.markdown),
  };
}

export function attachHistory(tx, artifacts) {
  const { config, state } = tx;
  const report = config.executionHistory?.reportArtifact;
  if (!report || !Object.hasOwn(artifacts, report)) return;
  const facts = executionFacts(config, tx.events());
  facts.cutoff = {
    sequence: tx.events().at(-1)?.sequence ?? 0,
    timestamp: new Date().toISOString(),
  };
  const paths = {
    json: `${runtime}/reports/${state.visit.id}.json`,
    markdown: `${runtime}/reports/${state.visit.id}.md`,
    narrative: `${runtime}/reports/${state.visit.id}.narrative.json`,
  };
  const markdown = historyMarkdown(facts, paths);
  const narrative = Buffer.from(artifacts[report].base64, 'base64');
  const appendix = `\n\n<!-- playbill:generated-execution-history:start -->\n${markdown}<!-- playbill:generated-execution-history:end -->\n`;
  const reportBytes = Buffer.concat([narrative, Buffer.from(appendix)]);
  ensure(
    reportBytes.length <= 4 * 1024 * 1024,
    'Report with generated history exceeds artifact size limit',
  );
  for (const path of Object.values(paths))
    ensure(
      !existsSync(safePath(config.root, path)),
      `Unowned generated report history path: ${path}`,
    );
  writeJSON(config.root, paths.json, facts, true);
  writeFileSync(safePath(config.root, paths.markdown), markdown, {
    flag: 'wx',
  });
  writeJSON(
    config.root,
    paths.narrative,
    { [report]: artifacts[report] },
    true,
  );
  writeFileSync(safePath(config.root, report), reportBytes);
  artifacts[report] = snapshot(config.root, report);
  state.visit.executionHistory = Object.fromEntries(
    Object.entries(paths).map(([key, path]) => [key, reference(config, path)]),
  );
}
