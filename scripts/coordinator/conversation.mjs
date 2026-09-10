import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { ensure, hash, hashes, same, snapshot, validPath } from './files.mjs';
import { checkIdle } from './check.mjs';
import { refreshAcceptedReview } from './report-review.mjs';
import { validateWorkflowPaths } from './config.mjs';

const kinds = ['question', 'redirect', 'return', 'replace'];
export const released = (state) =>
  Boolean(
    state.conversation &&
    (state.conversation.mode !== 'engaged' || state.status === 'done'),
  );
export const conversationSummary = (state) => {
  if (!state.conversation) return undefined;
  const { mode, turn, redirects, offered } = state.conversation;
  return { mode, turn, redirects, offered };
};

export function conversationCommand(config, command) {
  if (!config.conversation || typeof command !== 'string') return false;
  const match =
    /^('[^']+'|"[^"$`\\]+"|[^\s'"|&;<>`$\\()]+)\s+('[^']+'|"[^"$`\\]+"|[^\s'"|&;<>`$\\()]+)\s+('[^']+'|"[^"$`\\]+"|[^\s'"|&;<>`$\\()]+)\s+(?:pause|resume|exit|intent\s+[1-9][0-9]*\s+(?:question|redirect|return|replace))\s*$/u.exec(
      command,
    );
  if (!match) return false;
  const unquote = (value) =>
    /^["']/u.test(value) ? value.slice(1, -1) : value;
  const executable = unquote(match[1]);
  const cli = resolve(config.root, unquote(match[2]));
  return (
    (executable === 'node' || executable === process.execPath) &&
    [
      resolve(dirname(config.configPath), 'cli.mjs'),
      fileURLToPath(new URL('./cli.mjs', import.meta.url)),
    ].includes(cli) &&
    resolve(config.root, unquote(match[3])) === config.configPath
  );
}

export function initialConversation() {
  return {
    mode: 'engaged',
    turn: 0,
    redirects: 0,
    offered: false,
    lastRedirectTurn: null,
    intent: null,
    nativeTurns: {},
    epoch: 0,
    suspension: null,
  };
}

export function validateConversation(state, config) {
  const value = state.conversation;
  if (!config.conversation) {
    ensure(value === undefined, 'Unexpected conversation state');
    return;
  }
  ensure(
    value &&
      ['engaged', 'paused', 'exited'].includes(value.mode) &&
      Number.isSafeInteger(value.turn) &&
      value.turn >= 0 &&
      Number.isSafeInteger(value.epoch) &&
      value.epoch >= 0 &&
      Number.isInteger(value.redirects) &&
      value.redirects >= 0 &&
      value.redirects <= config.conversation.redirectThreshold &&
      typeof value.offered === 'boolean' &&
      (value.lastRedirectTurn === null ||
        (Number.isSafeInteger(value.lastRedirectTurn) &&
          value.lastRedirectTurn > 0 &&
          value.lastRedirectTurn <= value.turn)) &&
      (value.intent === null ||
        (value.intent.turn === value.turn &&
          value.turn > 0 &&
          kinds.includes(value.intent.kind))) &&
      value.nativeTurns &&
      typeof value.nativeTurns === 'object' &&
      !Array.isArray(value.nativeTurns) &&
      Object.entries(value.nativeTurns).every(
        ([key, turn]) =>
          /^[a-f0-9]{64}$/u.test(key) &&
          Number.isSafeInteger(turn) &&
          turn > 0 &&
          turn <= value.turn,
      ) &&
      (value.mode === 'engaged'
        ? value.suspension === null
        : value.suspension?.visitId === state.visit?.id &&
          value.suspension.files &&
          typeof value.suspension.files === 'object' &&
          !Array.isArray(value.suspension.files) &&
          Object.entries(value.suspension.files).every(
            ([path, file]) =>
              validPath(path) &&
              (file === null ||
                /^[a-f0-9]{64}$/u.test(file) ||
                typeof file?.error === 'string'),
          )),
    'Malformed conversation state',
  );
}

export function promptTurn(tx, event) {
  const conversation = tx.state.conversation;
  if (typeof event.prompt !== 'string' || !event.prompt.trim()) return false;
  const native = event.turn_id;
  ensure(
    native === undefined || (typeof native === 'string' && native.length > 0),
    'Malformed native turn identity',
  );
  const key = native === undefined ? null : hash(native);
  if (key && Object.hasOwn(conversation.nativeTurns, key)) return false;
  conversation.turn += 1;
  conversation.intent = null;
  if (key) conversation.nativeTurns[key] = conversation.turn;
  tx.state.readOnlyTurn = false;
  tx.event('prompt', {
    turn: conversation.turn,
    nativeTurnId: native ?? null,
    readOnly: false,
    prompt: event.prompt,
  });
  return true;
}

export function conversationContext(tx, prefix) {
  const { state } = tx;
  const value = state.conversation;
  if (!value || value.mode === 'exited' || state.status === 'done') return '';
  const protocol = `Conversation turn ${value.turn}. Before workflow work, interpret the latest user request. Ordinary continuation needs no signal. Otherwise report once: ${prefix} intent ${value.turn} KIND (question = related explanation/status, read-only this turn; redirect = likely diversion, pause immediately; return = user wants the original task resumed; replace = clear replacement, exit immediately). Ambiguity needs no signal. Mentioning the original task alone is not a return.`;
  if (value.mode === 'paused')
    return `${protocol}\nOriginal workflow paused; follow the current user request. Resume only on user return. Present a newly returned CLI question once; when no question is returned, do not repeat an earlier choice. Explicit fallback: ${prefix} resume or ${prefix} exit.`;
  if (state.readOnlyTurn)
    return `${protocol}\nAnswer the related question read-only; preserve the current visit and allow this turn to stop.`;
  return protocol;
}

function frozenFiles(config, state) {
  const step = config.steps.find((item) => item.id === state.visit.nodeId);
  const paths = [
    ...new Set([
      ...config.sourcePaths,
      ...Object.keys(config.verificationHashes),
      ...Object.values(config.nativeSkills ?? {}),
      ...step.consumes,
      ...step.produces,
      ...(state.visit.check ? [state.visit.check.path] : []),
    ]),
  ];
  return Object.fromEntries(
    paths.map((path) => {
      try {
        return [path, snapshot(config.root, path)?.sha256 ?? null];
      } catch (error) {
        return [path, { error: error.message }];
      }
    }),
  );
}

export function yieldConversation(tx, mode, reason) {
  const { state, config } = tx;
  const value = state.conversation;
  ensure(value, 'Conversation control is not configured');
  if (value.mode === 'exited' && mode === 'paused') return;
  if (value.mode === mode) return;
  value.suspension ??= {
    visitId: state.visit.id,
    files: frozenFiles(config, state),
  };
  value.mode = mode;
  value.epoch += 1;
  if (state.status === 'active') state.status = 'paused';
  state.stopBlocks = 0;
  tx.event('conversation-yielded', {
    mode,
    reason,
    suspension: value.suspension,
  });
}

export function resumeConversation(tx) {
  const { state, config } = tx;
  const value = state.conversation;
  ensure(value, 'Conversation control is not configured');
  ensure(state.status !== 'done', 'Coordinator is done');
  ensure(
    !['pending', 'unresolved'].includes(state.reportReview?.status),
    'Report review is pending or unresolved; resume cannot bypass the gate',
  );
  checkIdle(state);
  validateWorkflowPaths(config);
  ensure(
    same(
      hashes(config.root, Object.keys(config.verificationHashes)),
      config.verificationHashes,
    ),
    'Immutable verification input changed; restore it before resuming',
  );
  if (value.suspension) {
    const frozen = value.suspension;
    ensure(
      frozen.visitId === state.visit.id,
      'Conversation suspension visit changed',
    );
    const changed = Object.entries(frozen.files)
      .filter(
        ([path, file]) =>
          file?.error || (snapshot(config.root, path)?.sha256 ?? null) !== file,
      )
      .map(([path]) => path);
    if (changed.length) {
      state.visit.invalidated ??= [];
      state.visit.invalidated.push({
        activation: state.visit.activation,
        check: state.visit.check,
        suspension: frozen,
        paths: changed,
      });
      state.visit.activation = null;
      state.visit.check = null;
      const step = config.steps.find((item) => item.id === state.visit.nodeId);
      state.visit.baseline = hashes(config.root, step.produces);
      tx.event('conversation-invalidated', { paths: changed });
    }
  }
  refreshAcceptedReview(tx);
  ensure(
    state.reportReview?.status !== 'unresolved',
    'Report review limit exhausted; preserve retained decisions for intervention',
  );
  state.lastSourceHashes = hashes(config.root, config.sourcePaths);
  value.mode = 'engaged';
  value.epoch += 1;
  value.redirects = 0;
  value.lastRedirectTurn = null;
  value.offered = false;
  value.suspension = null;
  state.status = 'active';
  state.readOnlyTurn = false;
  state.stopBlocks = 0;
  tx.event('conversation-resumed');
}

export function classifyIntent(tx, argument) {
  const { state, config } = tx;
  const value = state.conversation;
  ensure(value, 'Conversation control is not configured');
  const { kind } = argument ?? {};
  const turn =
    typeof argument?.turn === 'string' && /^[1-9][0-9]*$/u.test(argument.turn)
      ? Number(argument.turn)
      : argument?.turn;
  ensure(
    Number.isSafeInteger(turn) && turn > 0 && turn === value.turn,
    `Stale or invalid turn token: expected ${value.turn}`,
  );
  ensure(kinds.includes(kind), 'Invalid intent kind');
  if (value.intent) {
    ensure(
      value.intent.kind === kind,
      'Conflicting intent for the current user turn',
    );
    return {};
  }
  let question;
  if (kind === 'return') resumeConversation(tx);
  else if (kind === 'question') state.readOnlyTurn = true;
  else if (kind === 'replace') yieldConversation(tx, 'exited', 'replacement');
  else if (value.mode !== 'exited') {
    value.redirects =
      value.lastRedirectTurn === turn - 1
        ? Math.min(value.redirects + 1, config.conversation.redirectThreshold)
        : 1;
    value.lastRedirectTurn = turn;
    yieldConversation(tx, 'paused', 'redirect');
    if (
      value.redirects >= config.conversation.redirectThreshold &&
      !value.offered &&
      config.conversation.askOnRedirect
    ) {
      value.offered = true;
      question =
        'Keep the original workflow paused, or exit it and continue with the current task?';
    }
  }
  value.intent = { turn, kind };
  tx.event('conversation-intent', {
    turn,
    intent: kind,
    ...(question ? { question } : {}),
  });
  return question ? { question } : {};
}
