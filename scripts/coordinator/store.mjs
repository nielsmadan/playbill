import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
} from 'node:fs';
import {
  ensure,
  hash,
  runtimePath,
  safePath,
  same,
  writeJSON,
} from './files.mjs';
import { setTimeout } from 'node:timers/promises';
import { persistHistory, validateHistory } from './history.mjs';
import { validateReportReview } from './report-review.mjs';
import { released, validateConversation } from './conversation.mjs';

export { runtime } from './files.mjs';

function validate(state, config) {
  ensure(
    state &&
      state.version === 1 &&
      state.root === config.root &&
      state.runId === config.runId &&
      state.configHash === config.configHash,
    'State/config/root mismatch',
  );
  validateConversation(state, config);
  ensure(
    typeof state.sessionId === 'string' && state.sessionId.length > 0,
    'Malformed state session',
  );
  ensure(
    ['active', 'paused', 'done'].includes(state.status),
    'Malformed state status',
  );
  ensure(
    Number.isInteger(state.sequence) &&
      state.sequence >= 1 &&
      Number.isInteger(state.transitions) &&
      state.transitions >= 0 &&
      state.transitions <= config.maxTransitions,
    'Malformed state counters',
  );
  ensure(
    Array.isArray(state.history) &&
      state.history.length ===
        state.transitions + (state.status === 'done' ? 1 : 0) &&
      Number.isInteger(state.nextVisit) &&
      state.nextVisit === state.transitions + 2,
    'Malformed state history',
  );
  const visits =
    state.status === 'done' ? state.history : [...state.history, state.visit];
  for (const [index, visit] of visits.entries()) {
    ensure(
      visit &&
        visit.id === `v${index + 1}` &&
        config.steps.some((step) => step.id === visit.nodeId),
      'Malformed state visit',
    );
    ensure(
      visit.baseline &&
        typeof visit.baseline === 'object' &&
        Array.isArray(visit.violations),
      'Malformed visit evidence',
    );
    ensure(
      visit.activation === null ||
        (visit.activation.visitId === visit.id &&
          typeof visit.activation.toolUseId === 'string'),
      'Malformed activation',
    );
    if (visit.decision) {
      const condition = config.steps.find(
        (step) => step.id === visit.nodeId,
      ).condition;
      ensure(
        condition &&
          visit.decision.visitId === visit.id &&
          visit.decision.condition === condition.id &&
          visit.decision.expression === condition.expression &&
          typeof visit.decision.value === 'boolean' &&
          typeof visit.decision.rationale === 'string' &&
          visit.decision.rationale.trim(),
        'Malformed condition decision',
      );
    }
    const lease = visit.checkLease;
    if (lease !== null && lease !== undefined) {
      const inputs = [
        ...new Set([
          ...config.sourcePaths,
          ...Object.keys(config.verificationHashes),
        ]),
      ];
      ensure(
        typeof lease.id === 'string' &&
          /^[a-f0-9-]{36}$/u.test(lease.id) &&
          lease.visitId === visit.id &&
          lease.nodeId === visit.nodeId &&
          visit.activation &&
          lease.activationHash === hash(JSON.stringify(visit.activation)) &&
          lease.root === state.root &&
          lease.runId === state.runId &&
          lease.configHash === state.configHash &&
          lease.sessionId === state.sessionId &&
          Object.hasOwn(config.checks, lease.check) &&
          Number.isFinite(Date.parse(lease.reservedAt)) &&
          lease.rawPath ===
            `${runtimePath(config)}/checks/${lease.id}.raw.json` &&
          lease.path === `${runtimePath(config)}/checks/${lease.id}.json` &&
          lease.inputs &&
          same(Object.keys(lease.inputs), inputs) &&
          Object.values(lease.inputs).every(
            (value) => value === null || /^[a-f0-9]{64}$/u.test(value),
          ) &&
          !visit.completedAt &&
          visit.check === null,
        'Malformed check lease',
      );
    }
    if (index < state.history.length)
      ensure(
        visit.completedAt &&
          (visit.activation || visit.decision) &&
          visit.artifacts,
        'Malformed completed visit',
      );
  }
  ensure(
    state.visit?.id === `v${state.transitions + 1}`,
    'Malformed current visit',
  );
  ensure(
    Number.isInteger(state.stopBlocks) &&
      state.stopBlocks >= 0 &&
      Array.isArray(state.pausedAfter) &&
      state.pending &&
      typeof state.pending === 'object' &&
      state.lastSourceHashes &&
      typeof state.lastSourceHashes === 'object',
    'Malformed state bookkeeping',
  );
  ensure(
    state.status !== 'done' || state.visit.completedAt,
    'Malformed done state',
  );
}

export async function transaction(
  config,
  operation,
  { readOnly = false } = {},
) {
  const directory = safePath(config.root, runtimePath(config));
  mkdirSync(directory, { recursive: true });
  const lock = safePath(config.root, `${runtimePath(config)}/lock`);
  const deadline = Date.now() + 65000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      ensure(
        Date.now() < deadline,
        'Coordinator busy or interrupted transaction; preserve evidence and inspect lock',
      );
      await setTimeout(20);
    }
  }
  try {
    const statePath = safePath(
      config.root,
      `${runtimePath(config)}/state.json`,
    );
    const journalPath = safePath(
      config.root,
      `${runtimePath(config)}/events.jsonl`,
    );
    let state = null;
    let lines = [];
    if (existsSync(statePath)) {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
      validate(state, config);
      lines = readFileSync(journalPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      ensure(
        lines.length === state.sequence &&
          lines.every(
            (event, index) =>
              event.sequence === index + 1 && event.runId === config.runId,
          ),
        'State/journal mismatch; refusing silent recovery',
      );
      ensure(
        lines.at(-1).stateHash === hash(JSON.stringify(state)),
        'State/journal integrity mismatch',
      );
      if (config.executionHistory) validateHistory(config, state, lines);
      if (config.reportReview) validateReportReview(config, state, lines);
    } else
      ensure(
        !existsSync(journalPath),
        'Journal exists without state; refusing reset',
      );
    const events = [];
    const wasWritable =
      !state ||
      (state.status === 'active' && !released(state) && !state.readOnlyTurn);
    const tx = {
      config,
      state,
      events: () => [...lines, ...events],
      event(kind, detail = {}) {
        events.push({
          version: 1,
          sequence: (tx.state?.sequence ?? 0) + events.length + 1,
          runId: config.runId,
          sessionId: tx.state?.sessionId ?? null,
          timestamp: new Date().toISOString(),
          visitId: tx.state?.visit.id ?? null,
          status: tx.state?.status ?? null,
          ...(tx.state?.conversation
            ? {
                conversationMode: tx.state.conversation.mode,
                conversationEpoch: tx.state.conversation.epoch,
              }
            : {}),
          kind,
          ...detail,
        });
      },
    };
    let result;
    let failure;
    try {
      result = operation(tx);
    } catch (error) {
      failure = error;
      if (tx.state && !readOnly) tx.event('rejected', { error: error.message });
    }
    if (events.length > 0 && tx.state) {
      ensure(!readOnly, 'Read-only transaction attempted to mutate state');
      const terminalCompletion =
        tx.state.status === 'done' &&
        events.some((event) => event.kind === 'completed');
      if (config.executionHistory)
        persistHistory(
          config,
          tx.state,
          [...lines, ...events],
          (terminalCompletion || (wasWritable && !released(tx.state))) &&
            !tx.state.readOnlyTurn &&
            events.some((event) =>
              [
                'initialized',
                'activated',
                'check-reserved',
                'check',
                'completed',
              ].includes(event.kind),
            ),
        );
      tx.state.sequence += events.length;
      events.at(-1).stateHash = hash(JSON.stringify(tx.state));
      appendFileSync(
        journalPath,
        events.map((event) => JSON.stringify(event) + '\n').join(''),
      );
      writeJSON(config.root, `${runtimePath(config)}/state.json`, tx.state);
    }
    if (failure) throw failure;
    return result;
  } finally {
    rmdirSync(lock);
  }
}
