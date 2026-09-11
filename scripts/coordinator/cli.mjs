import process from 'node:process';
import { Buffer } from 'node:buffer';
import { configuration } from './config.mjs';
import { execute } from './core.mjs';
import { ensure, withinRoot } from './files.mjs';
import { conversationSummary } from './conversation.mjs';

try {
  const [path, command, argument, ...extra] = process.argv.slice(2);
  ensure(
    path &&
      [
        'status',
        'history',
        'review',
        'review-decision',
        'check',
        'complete',
        'decide',
        'pause',
        'resume',
        'exit',
        'intent',
      ].includes(command) &&
      (command === 'decide'
        ? Boolean(argument) &&
          extra.length === 3 &&
          ['true', 'false'].includes(extra[1])
        : command === 'intent'
          ? Boolean(argument) && extra.length === 1
          : extra.length === 0 &&
            (['complete', 'review-decision'].includes(command)
              ? Boolean(argument)
              : command === 'check' || argument === undefined)),
    'Usage: node cli.mjs CONFIG status|history|review|review-decision FILE|check [NAME]|complete VISIT|decide VISIT CONDITION true|false RATIONALE|pause|resume|exit|intent TURN question|redirect|return|replace',
  );
  const config = configuration(path);
  ensure(withinRoot(config.root, process.cwd()), 'CLI cwd/root mismatch');
  const result = await execute(
    config,
    command,
    command === 'decide'
      ? {
          visit: argument,
          condition: extra[0],
          value: extra[1] === 'true',
          rationale: extra[2],
        }
      : command === 'intent'
        ? { turn: argument, kind: extra[0] }
        : argument,
    process.env.PLAYBILL_COORDINATOR_SESSION_ID,
  );
  const { state, check } = result;
  const output = {
    state: {
      status: state.status,
      visit: {
        id: state.visit.id,
        nodeId: state.visit.nodeId,
        activated: Boolean(state.visit.activation),
        checkInFlight: state.visit.checkLease ?? null,
      },
      completed: state.history.length,
      ...(state.conversation
        ? { conversation: conversationSummary(state) }
        : {}),
      ...(state.reportReview ? { reportReview: state.reportReview } : {}),
    },
    context: result.context,
    ...(result.question ? { question: result.question } : {}),
    ...(result.review ? { review: result.review } : {}),
    ...(result.history
      ? { history: result.history, markdown: result.markdown }
      : {}),
    ...(check
      ? {
          check: {
            outcome: check.outcome,
            exitCode: check.exitCode,
            signal: check.signal,
            error: check.error,
            evidencePath: state.visit.check.path,
            stdout: Buffer.from(check.stdout.base64, 'base64').toString('utf8'),
            stderr: Buffer.from(check.stderr.base64, 'base64').toString('utf8'),
          },
        }
      : {}),
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  if (result.check?.outcome === 'infrastructure-failure') process.exitCode = 2;
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
}
