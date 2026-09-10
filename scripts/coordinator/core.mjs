import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateWorkflowPaths } from './config.mjs';
import {
  ensure,
  fileHash,
  hashes,
  relativePath,
  safePath,
  same,
  snapshot,
  writeJSON,
} from './files.mjs';
import {
  captureCheck,
  checkIdle,
  finalizeCheck,
  reserveCheck,
} from './check.mjs';
import { runtime, transaction } from './store.mjs';
import {
  attachHistory,
  executionFacts,
  historyMarkdown,
  historyPaths,
} from './history.mjs';
import {
  applyReviewDecision,
  requireReportReview,
  reviewStatus,
} from './report-review.mjs';
import {
  classifyIntent,
  conversationCommand,
  conversationContext,
  initialConversation,
  promptTurn,
  released,
  resumeConversation,
  yieldConversation,
} from './conversation.mjs';

const now = () => new Date().toISOString();
const stepOf = (tx) =>
  tx.config.steps.find((step) => step.id === tx.state.visit.nodeId);
const sourceAllowed = (tx) =>
  !released(tx.state) &&
  tx.state.status === 'active' &&
  !tx.state.readOnlyTurn &&
  !tx.state.visit.checkLease &&
  Boolean(tx.state.visit.activation) &&
  stepOf(tx).allowSourceWrites;
const commandPrefix = (config) =>
  `node ${quote(join(dirname(config.configPath), 'cli.mjs'))} ${quote(config.configPath)}`;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function context(tx) {
  const { state, config } = tx;
  const prefix = commandPrefix(config);
  if (state.conversation?.mode === 'exited') return '';
  const steering = conversationContext(tx, prefix);
  if (
    state.status !== 'done' &&
    (released(state) || (state.conversation && state.readOnlyTurn))
  )
    return steering;
  return [steering, workflowContext(tx, prefix)].filter(Boolean).join('\n');
}

function workflowContext(tx, prefix) {
  const { state, config } = tx;
  const history = config.executionHistory
    ? `\nGenerated execution facts: ${historyPaths.json}; ${historyPaths.markdown}. Read-only history: ${prefix} history. Use the CLI for current retained receipts; generated snapshots refresh at workflow boundaries. Consult these retained receipts before summarizing executions; shell invocations and configured checks are separate. Completing ${config.executionHistory.reportArtifact} appends a generated snapshot and preserves your narrative for separate accuracy review.`
    : '';
  if (state.status === 'done')
    return `Coordinator ${config.runId}: completed ${state.history.length} visits. Report the retained results and any repair limitations.${history}`;
  const step = stepOf(tx);
  const review = state.reportReview;
  if (review?.status === 'pending' || review?.status === 'unresolved')
    return `Coordinator ${config.runId} is paused at ${state.visit.id} (${step.title}). Report review ${review.status}; ${review.decisions.length}/2 decisions retained. ${review.status === 'pending' ? 'Await the independent controller decision; this visit cannot resume while review is pending.' : 'The review limit is exhausted with an unresolved outcome; preserve all drafts and findings for intervention.'} Read-only review: ${prefix} review.${history}`;
  const reviewFeedback =
    review?.status === 'rejected'
      ? `\nIndependent report review rejected the previous draft. Revise this same visit using the retained findings: ${prefix} review. ${review.reason}. ${review.decisions.length}/2 decisions used.`
      : '';
  const pendingCheck = state.visit.checkLease
    ? `Check ${state.visit.checkLease.check} (${state.visit.checkLease.id}) is in flight; status remains available. Wait for its result before another check, activation or completion. If interrupted, preserve ${state.visit.checkLease.rawPath} and the lease for explicit intervention; no automatic reset occurs.`
    : '';
  if (state.status === 'paused')
    return `Coordinator ${config.runId} is paused at ${state.visit.id} (${step.title}); history is preserved. Read-only status: ${prefix} status. Resume only when requested: ${prefix} resume. ${pendingCheck}${history}`;
  const continuation =
    'Continue the authorized workflow through the returned visits until the coordinator is done or paused.';
  if (pendingCheck)
    return `Coordinator ${config.runId}: current visit ${state.visit.id}, ${step.title}.\n${continuation}\n${pendingCheck}\nStatus: ${prefix} status.${history}`;
  return (
    [
      `Coordinator ${config.runId}: current visit ${state.visit.id}, ${step.title}.`,
      continuation,
      `Technique: ${step.skill}. ${state.visit.activation ? 'Native activation recorded; continue this visit.' : config.nativeSkills ? `Read the complete native skill file with this exact command before completing this visit: cat ${quote(config.nativeSkills[step.skill])}` : 'Invoke this native Skill before completing this visit.'}`,
      step.instruction,
      `Consume: ${step.consumes.join(', ') || '(none)'}. Produce fresh nonempty bytes: ${step.produces.join(', ') || '(none)'}.`,
      `Source edits: ${step.allowSourceWrites ? 'permitted for this visit' : 'defer until a permitted visit'}.`,
      ...(step.check ? [`Capture the configured check: ${prefix} check.`] : []),
      `Complete this exact visit: ${prefix} complete ${state.visit.id}.`,
      `Status: ${prefix} status.`,
    ].join('\n') +
    reviewFeedback +
    history
  );
}

function visit(config, nodeId, number) {
  const step = config.steps.find((candidate) => candidate.id === nodeId);
  return {
    id: `v${number}`,
    nodeId,
    enteredAt: now(),
    baseline: hashes(config.root, step.produces),
    activation: null,
    check: null,
    checkLease: null,
    violations: [],
  };
}

function initialize(tx, sessionId) {
  const { config } = tx;
  validateWorkflowPaths(config);
  tx.state = {
    version: 1,
    root: config.root,
    runId: config.runId,
    configHash: config.configHash,
    sessionId,
    status: 'active',
    visit: visit(config, config.entry, 1),
    nextVisit: 2,
    transitions: 0,
    history: [],
    pausedAfter: [],
    stopBlocks: 0,
    lastSourceHashes: hashes(config.root, config.sourcePaths),
    pending: {},
    readOnlyTurn: false,
    ...(config.conversation ? { conversation: initialConversation() } : {}),
    sequence: 0,
  };
  tx.event('initialized');
}

function observe(tx, origin = null) {
  const { config, state } = tx;
  if (released(state)) return null;
  validateWorkflowPaths(config);
  const source = hashes(config.root, config.sourcePaths);
  const changed = config.sourcePaths.filter(
    (name) => source[name] !== state.lastSourceHashes[name],
  );
  let violation = null;
  if (changed.length) {
    const allowed = origin?.allowSourceWrites ?? sourceAllowed(tx);
    const visitId = origin?.visitId ?? state.visit.id;
    tx.event('source-change', {
      originVisitId: visitId,
      allowed,
      before: state.lastSourceHashes,
      after: source,
      paths: changed,
    });
    if (!allowed) {
      violation = {
        kind: 'early-source-write',
        visitId,
        paths: changed,
        timestamp: now(),
      };
      state.visit.violations.push(violation);
      tx.event('violation', {
        violation: violation.kind,
        originVisitId: visitId,
        paths: changed,
      });
    }
    state.lastSourceHashes = source;
  }
  const verification = hashes(
    config.root,
    Object.keys(config.verificationHashes),
  );
  if (!same(verification, config.verificationHashes)) {
    tx.event('violation', {
      violation: 'verification-input-changed',
      expected: config.verificationHashes,
      actual: verification,
    });
    throw new Error('Immutable verification input changed');
  }
  return violation;
}

function active(tx) {
  ensure(!released(tx.state), `Conversation is ${tx.state.conversation?.mode}`);
  ensure(tx.state.status === 'active', `Coordinator is ${tx.state.status}`);
  ensure(
    !tx.state.readOnlyTurn,
    'Read-only status turn; wait for a continuation request',
  );
  validateWorkflowPaths(tx.config);
}

function complete(tx, token) {
  const { state, config } = tx;
  active(tx);
  checkIdle(state);
  ensure(
    token === state.visit.id,
    `Stale visit token: expected ${state.visit.id}`,
  );
  ensure(!state.visit.completedAt, 'Visit already completed');
  const step = stepOf(tx);
  ensure(state.visit.activation, 'Missing successful native Skill activation');
  ensure(
    state.visit.violations.length === 0,
    'Visit has recorded source-write violations; preserve this run for intervention',
  );
  for (const name of step.consumes)
    ensure(
      snapshot(config.root, name)?.nonempty,
      `Missing consumed artifact: ${name}`,
    );
  const artifacts = Object.fromEntries(
    step.produces.map((name) => [name, snapshot(config.root, name)]),
  );
  for (const [name, file] of Object.entries(artifacts))
    ensure(
      file?.nonempty && file.sha256 !== state.visit.baseline[name],
      `Missing or stale produced artifact: ${name}`,
    );
  let outcome = null;
  if (step.check) {
    const check = state.visit.check;
    ensure(check, 'Missing configured check');
    ensure(
      fileHash(config.root, check.path) === check.sha256,
      'Check evidence changed',
    );
    const raw = JSON.parse(readFileSync(join(config.root, check.path), 'utf8'));
    ensure(
      raw.visitId === state.visit.id && raw.check === step.check,
      'Check visit mismatch',
    );
    ensure(
      same(check.inputs, hashes(config.root, Object.keys(check.inputs))),
      'Stale check: watched source/input changed',
    );
    ensure(
      check.outcome !== 'infrastructure-failure',
      'Check infrastructure failure; rerun after repair',
    );
    outcome = check.outcome;
  }
  const successor =
    typeof step.next === 'object' && step.next !== null
      ? step.next[outcome]
      : step.next;
  ensure(
    !successor || state.transitions < config.maxTransitions,
    'Transition limit reached; pause for intervention',
  );
  if (!requireReportReview(tx, artifacts)) return;
  const artifactPath = `${runtime}/artifacts/${state.visit.id}.json`;
  const nextVisit = successor
    ? visit(config, successor, state.nextVisit)
    : null;
  if (config.executionHistory)
    ensure(
      !existsSync(safePath(config.root, artifactPath)),
      `Unowned artifact snapshot path: ${artifactPath}`,
    );
  attachHistory(tx, artifacts);
  writeJSON(config.root, artifactPath, artifacts, true);
  state.visit.artifacts = {
    path: artifactPath,
    sha256: fileHash(config.root, artifactPath),
  };
  state.visit.completedAt = now();
  state.visit.outcome = outcome;
  state.history.push(JSON.parse(JSON.stringify(state.visit)));
  tx.event('completed', {
    nodeId: step.id,
    outcome,
    artifacts: artifactPath,
    successor: successor ?? null,
  });
  state.stopBlocks = 0;
  if (!successor) state.status = 'done';
  else {
    state.visit = nextVisit;
    state.nextVisit += 1;
    state.transitions += 1;
    tx.event('entered', { nodeId: successor });
    if (
      config.pauseAfter.includes(step.id) &&
      !state.pausedAfter.includes(step.id)
    ) {
      state.pausedAfter.push(step.id);
      state.status = 'paused';
      tx.event('paused', { reason: 'pauseAfter', afterNodeId: step.id });
    }
  }
}

export async function execute(config, command, argument, sessionId) {
  const result = await transaction(
    config,
    (tx) => {
      ensure(tx.state, 'Coordinator requires native SessionStart');
      ensure(
        !sessionId || sessionId === tx.state.sessionId,
        'Native session mismatch',
      );
      if (command === 'status')
        return { state: tx.state, context: context(tx) };
      if (command === 'review')
        return {
          state: tx.state,
          context: context(tx),
          review: reviewStatus(config, tx.state),
        };
      if (command === 'history') {
        ensure(config.executionHistory, 'Execution history is not configured');
        const history = executionFacts(config, tx.events());
        return {
          state: tx.state,
          context: context(tx),
          history,
          markdown: historyMarkdown(history),
        };
      }
      if (command === 'review-decision') {
        if (applyReviewDecision(tx, argument)) complete(tx, tx.state.visit.id);
        return {
          state: tx.state,
          context: context(tx),
          review: reviewStatus(config, tx.state),
        };
      }
      if (command === 'intent') {
        const result = classifyIntent(tx, argument);
        return { state: tx.state, context: context(tx), ...result };
      }
      if (
        command === 'exit' ||
        (tx.state.conversation && command === 'pause')
      ) {
        yieldConversation(
          tx,
          command === 'exit' ? 'exited' : 'paused',
          'explicit',
        );
        return { state: tx.state, context: context(tx) };
      }
      if (tx.state.conversation && command === 'resume') {
        resumeConversation(tx);
        return { state: tx.state, context: context(tx) };
      }
      ensure(
        !tx.state.readOnlyTurn,
        'Read-only status turn; wait for a continuation request',
      );
      observe(tx);
      if (command === 'complete') complete(tx, argument);
      else if (command === 'check') {
        active(tx);
        ensure(
          tx.state.visit.activation,
          'Missing successful native Skill activation',
        );
        const checkName =
          argument ??
          stepOf(tx).check ??
          (Object.keys(config.checks).length === 1
            ? Object.keys(config.checks)[0]
            : undefined);
        ensure(
          checkName && Object.hasOwn(config.checks, checkName),
          'Choose a configured check name',
        );
        return { lease: reserveCheck(tx, checkName) };
      } else if (command === 'pause') {
        ensure(tx.state.status !== 'done', 'Coordinator is done');
        tx.state.status = 'paused';
        tx.event('paused', { reason: 'explicit' });
      } else if (command === 'resume') {
        ensure(
          !['pending', 'unresolved'].includes(tx.state.reportReview?.status),
          'Report review is pending or unresolved; resume cannot bypass the gate',
        );
        ensure(
          tx.state.status === 'paused',
          `Coordinator is ${tx.state.status}`,
        );
        tx.state.status = 'active';
        tx.state.readOnlyTurn = false;
        tx.state.stopBlocks = 0;
        tx.event('resumed');
      } else throw new Error(`Unknown command: ${command}`);
      return {
        state: tx.state,
        context: context(tx),
      };
    },
    {
      readOnly: ['history', 'review', 'status'].includes(command),
    },
  );
  if (!result.lease) return result;
  const captured = captureCheck(config, result.lease);
  return transaction(config, (tx) => {
    ensure(tx.state, 'Coordinator requires native SessionStart');
    const check = finalizeCheck(tx, result.lease, captured);
    observe(tx);
    return { state: tx.state, context: context(tx), check };
  });
}

function guard(tx, event) {
  const { state, config } = tx;
  if (released(state)) return null;
  const input = event.tool_input ?? {};
  if (event.tool_name === 'Skill') {
    if (state.visit.checkLease)
      return 'Check is in flight; wait before another technique activation.';
    if (state.status !== 'active' || state.readOnlyTurn)
      return `Coordinator is ${state.status}; no technique activation now.`;
    if (input.skill !== stepOf(tx).skill)
      return `Expected Skill ${stepOf(tx).skill} for visit ${state.visit.id}.`;
    for (const name of stepOf(tx).consumes)
      if (!snapshot(config.root, name)?.nonempty)
        return `Missing consumed artifact: ${name}`;
  }
  if (
    ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(event.tool_name)
  ) {
    if (state.status !== 'active' || state.readOnlyTurn)
      return 'Coordinator permits only read-only status while paused or on a status turn.';
    const target = input.file_path ?? input.notebook_path;
    if (typeof target !== 'string') return 'Missing explicit write path.';
    let name;
    try {
      name = relativePath(config.root, target);
    } catch (error) {
      return error.message;
    }
    if (Object.hasOwn(config.verificationHashes, name))
      return `Immutable verification input: ${name}`;
    if (name.startsWith('.playbill/coordinator/'))
      return 'Coordinator runtime/config is not an output artifact.';
    if (config.sourcePaths.includes(name) && !sourceAllowed(tx))
      return `Source writes require an activated permitted visit; deferred during ${state.visit.id}.`;
  }
  return null;
}

const injection = (event, additionalContext) => ({
  hookSpecificOutput: { hookEventName: event, additionalContext },
});

export function activateNativeSkillRead(config, event, skillPath, skillId) {
  return transaction(config, (tx) => {
    ensure(tx.state, 'Coordinator requires native SessionStart');
    const { state } = tx;
    ensure(event.session_id === state.sessionId, 'Native session mismatch');
    if (released(state)) return {};
    const receipts = tx
      .events()
      .filter(
        (receipt) =>
          ['tool-pre', 'tool-post'].includes(receipt.kind) &&
          receipt.toolUseId === event.tool_use_id,
      );
    const [pre, post] = receipts;
    if (
      state.conversation &&
      pre &&
      (pre.conversationMode !== 'engaged' ||
        pre.conversationEpoch !== state.conversation.epoch)
    )
      return {};
    active(tx);
    checkIdle(state);
    const step = stepOf(tx);
    ensure(
      config.nativeSkills?.[skillId] === skillPath && step.skill === skillId,
      'Native skill file does not match the current visit',
    );
    ensure(
      receipts.length === 2 &&
        pre.kind === 'tool-pre' &&
        post.kind === 'tool-post' &&
        !pre.denied &&
        pre.visitId === state.visit.id &&
        post.originVisitId === state.visit.id &&
        pre.tool === 'Bash' &&
        post.tool === 'Bash' &&
        post.nativeEvent === 'PostToolUse' &&
        event.hook_event_name === 'PostToolUse' &&
        !post.error &&
        !event.error &&
        same(pre.input, event.tool_input) &&
        same(post.input, event.tool_input) &&
        same(post.response, event.tool_response) &&
        !tx
          .events()
          .some(
            (receipt) =>
              ['activated', 'native-skill-refreshed'].includes(receipt.kind) &&
              receipt.toolUseId === event.tool_use_id,
          ),
      'Missing or mismatched native skill file receipt',
    );
    for (const path of step.consumes)
      ensure(
        snapshot(config.root, path)?.nonempty,
        `Missing consumed artifact: ${path}`,
      );
    if (
      state.visit.activation?.kind === 'native-skill-file-read' &&
      state.visit.activation.skill === skillId
    ) {
      tx.event('native-skill-refreshed', {
        skill: skillId,
        skillPath,
        toolUseId: event.tool_use_id,
      });
      return injection('PostToolUse', context(tx));
    }
    state.visit.baseline = hashes(config.root, step.produces);
    state.visit.check = null;
    state.visit.activation = {
      kind: 'native-skill-file-read',
      visitId: state.visit.id,
      skill: skillId,
      skillPath,
      toolUseId: event.tool_use_id,
      timestamp: now(),
    };
    tx.event('activated', {
      activationKind: 'native-skill-file-read',
      skill: skillId,
      skillPath,
      toolUseId: event.tool_use_id,
    });
    return injection('PostToolUse', context(tx));
  });
}

export function handleHook(config, event, { nativeSkillRead } = {}) {
  ensure(
    event &&
      typeof event.session_id === 'string' &&
      event.session_id.length > 0,
    'Missing native session identity',
  );
  ensure(
    typeof event.cwd === 'string' && realpathSync(event.cwd) === config.root,
    'Native cwd/root mismatch',
  );
  const supported = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'Stop',
  ];
  ensure(
    supported.includes(event.hook_event_name),
    'Unsupported native hook event',
  );
  return transaction(config, (tx) => {
    const name = event.hook_event_name;
    if (!tx.state) {
      ensure(
        name === 'SessionStart',
        'Coordinator requires native SessionStart',
      );
      initialize(tx, event.session_id);
    }
    ensure(tx.state.sessionId === event.session_id, 'Native session mismatch');
    const { state } = tx;
    const skillRead = released(state)
      ? null
      : typeof nativeSkillRead === 'function'
        ? nativeSkillRead()
        : nativeSkillRead;
    if (name === 'SessionStart') {
      observe(tx);
      tx.event('session-start', { source: event.source ?? 'startup' });
      if (
        state.conversation &&
        (state.conversation.mode === 'exited' || state.status === 'done')
      )
        return {};
      return ['compact', 'resume'].includes(event.source)
        ? injection(name, context(tx))
        : {};
    }
    if (name === 'UserPromptSubmit') {
      if (state.conversation) {
        promptTurn(tx, event);
        return state.conversation.mode === 'exited' || state.status === 'done'
          ? {}
          : injection(name, context(tx));
      }
      observe(tx);
      state.readOnlyTurn =
        typeof event.prompt === 'string' &&
        /\b(read[- ]only|status only|only.*status)\b/iu.test(event.prompt);
      tx.event('prompt', {
        readOnly: state.readOnlyTurn,
        prompt: event.prompt ?? '',
      });
      return injection(
        name,
        `${context(tx)}${state.readOnlyTurn ? '\nThis is a read-only status turn. Report status and preserve the current visit.' : ''}`,
      );
    }
    if (name === 'Stop') {
      observe(tx);
      const blocked =
        !released(state) &&
        state.status === 'active' &&
        !state.readOnlyTurn &&
        state.stopBlocks < config.maxStopBlocks;
      if (blocked) state.stopBlocks += 1;
      else if (
        !released(state) &&
        state.status === 'active' &&
        !state.readOnlyTurn
      ) {
        state.status = 'paused';
        tx.event('paused', { reason: 'stop-limit' });
      }
      tx.event('stop', {
        blocked,
        stopHookActive: event.stop_hook_active ?? false,
        stopBlocks: state.stopBlocks,
      });
      return blocked
        ? {
            decision: 'block',
            reason: `Continue the authorized current visit.\n${context(tx)}`,
          }
        : {};
    }
    ensure(
      typeof event.tool_use_id === 'string' &&
        /^[A-Za-z0-9_-]+$/u.test(event.tool_use_id) &&
        typeof event.tool_name === 'string',
      'Malformed native tool event',
    );
    if (name === 'PreToolUse') {
      const control =
        event.tool_name === 'Bash' &&
        conversationCommand(config, event.tool_input?.command);
      const violation = control ? null : observe(tx);
      let denied = guard(tx, event);
      if (!denied && skillRead && !released(state)) {
        if (
          state.status !== 'active' ||
          state.readOnlyTurn ||
          state.visit.checkLease
        )
          denied =
            'Native skill reads require an active visit with no check in flight.';
        else if (
          skillRead.skill !== stepOf(tx).skill ||
          config.nativeSkills?.[skillRead.skill] !== skillRead.path
        )
          denied = `Expected native skill file for ${stepOf(tx).skill}.`;
        else {
          const missing = stepOf(tx).consumes.find(
            (path) => !snapshot(config.root, path)?.nonempty,
          );
          if (missing) denied = `Missing consumed artifact: ${missing}`;
        }
      }
      tx.event('tool-pre', {
        toolUseId: event.tool_use_id,
        tool: event.tool_name,
        input: event.tool_input,
        denied,
      });
      if (denied)
        return {
          hookSpecificOutput: {
            hookEventName: name,
            permissionDecision: 'deny',
            permissionDecisionReason: denied,
          },
        };
      state.pending[event.tool_use_id] = {
        visitId: state.visit.id,
        nodeId: state.visit.nodeId,
        allowSourceWrites: sourceAllowed(tx),
        tool: event.tool_name,
        input: event.tool_input,
        ...(state.conversation
          ? {
              conversationEpoch: state.conversation.epoch,
              conversationMode: state.conversation.mode,
            }
          : {}),
        ...(control ? { conversationControl: true } : {}),
      };
      return violation
        ? injection(
            name,
            `Observed an out-of-stage source edit. ${context(tx)}`,
          )
        : {};
    }
    const pending = state.pending[event.tool_use_id];
    const detachedReceipt =
      state.conversation &&
      pending &&
      (pending.conversationEpoch !== state.conversation.epoch ||
        pending.conversationMode !== 'engaged');
    const violation =
      pending?.conversationControl || detachedReceipt
        ? null
        : observe(tx, pending);
    delete state.pending[event.tool_use_id];
    tx.event('tool-post', {
      toolUseId: event.tool_use_id,
      tool: event.tool_name,
      nativeEvent: name,
      originVisitId: pending?.visitId ?? null,
      input: event.tool_input,
      response: event.tool_response ?? null,
      error: event.error ?? null,
    });
    if (released(state) || detachedReceipt) return {};
    if (event.tool_name === 'Skill') {
      const successful =
        name === 'PostToolUse' &&
        !event.error &&
        event.tool_response?.success !== false &&
        !event.tool_response?.is_error;
      ensure(
        pending?.tool === 'Skill' &&
          pending.visitId === state.visit.id &&
          pending.input?.skill === stepOf(tx).skill &&
          event.tool_input?.skill === pending.input.skill,
        'Missing or mismatched native Skill receipt',
      );
      if (successful) {
        active(tx);
        checkIdle(state);
        state.visit.baseline = hashes(config.root, stepOf(tx).produces);
        state.visit.check = null;
        state.visit.activation = {
          visitId: state.visit.id,
          skill: event.tool_input.skill,
          toolUseId: event.tool_use_id,
          timestamp: now(),
        };
        tx.event('activated', {
          skill: event.tool_input.skill,
          toolUseId: event.tool_use_id,
        });
        return injection(name, context(tx));
      }
      tx.event('activation-failed', { toolUseId: event.tool_use_id });
    }
    return violation
      ? injection(name, `Observed an out-of-stage source edit. ${context(tx)}`)
      : {};
  });
}
