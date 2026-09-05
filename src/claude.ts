import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaudeInventory } from './claude-inventory.js';
import { discoveryFromEnvironment, projectRoot } from './discovery.js';
import { errorMessage, fail, formatDiagnostic } from './diagnostics.js';
import { runtimeFailure } from './runtime.js';
import { record, text } from './schema.js';
import { sessionStore } from './session-state.js';
import { invokeRuntime, readInput } from './subprocess.js';
import type { RuntimeResult } from './runtime.js';

const CLAUDE_OUTPUT_CHARACTERS = 10_000;

export interface ClaudeHookOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
  systemMessage?: string;
}

function boundedOutput(output: string): string {
  if (output.length > CLAUDE_OUTPUT_CHARACTERS)
    fail(
      'LIMIT',
      'Claude context',
      'Complete hook output exceeds 10,000 characters. Shorten the workflow or invocation mapping to fit with warnings and restoration text.',
    );
  return output;
}

export function claudeContext(result: RuntimeResult, restore = false): string {
  if (!result.ok)
    return `Playbill configuration error:\n${result.diagnostics.map(formatDiagnostic).join('\n').slice(0, 8192)}\nNo workflow instructions were composed for this event.`;
  if (!result.commonProse) return '';
  const mapping = result.invocations
    .map(
      ({ id, invocation }) =>
        `- ${JSON.stringify(id)}: Skill tool with skill=${JSON.stringify(invocation)}`,
    )
    .join('\n');
  const appendix = `Claude skill invocation:\n${mapping}\nSkill availability is a discovery snapshot; Claude permissions and live registration still apply.`;
  const context = `${result.commonProse}\n${appendix}${restore ? '\nWorkflow reference restored. Continue from the conversation summary and existing artifacts.' : ''}`;
  return boundedOutput(context);
}

export function handleClaudeEvent(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeHookOutput {
  let event = 'SessionStart';
  let stateStore: ReturnType<typeof sessionStore> | undefined;
  let warned = false;
  try {
    const data = record(input, 'Claude hook');
    event = text(data.hook_event_name, 'hook_event_name');
    if (event !== 'SessionStart' && event !== 'UserPromptSubmit')
      fail(
        'EVENT',
        event,
        'Supported hooks are SessionStart and UserPromptSubmit.',
      );
    const cwd = text(data.cwd, 'cwd');
    const session = text(data.session_id, 'session_id');
    const discovery = discoveryFromEnvironment(env);
    discovery.defaultsDir ??= fileURLToPath(
      new URL('../defaults/', import.meta.url),
    );
    const root = projectRoot(cwd, discovery.projectRoot);
    discovery.projectRoot = root;
    const directory =
      env.PLAYBILL_STATE_DIR ??
      join(
        env.CLAUDE_PLUGIN_DATA ??
          join(tmpdir(), `playbill-${process.getuid?.() ?? 'user'}`),
        'sessions',
      );
    stateStore = sessionStore(directory, `claude\0${root}\0${session}`);
    const previous = stateStore.read();
    warned = previous.warned;
    const restore =
      event === 'SessionStart' &&
      (data.source === 'compact' || data.source === 'resume');
    const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
    const inventory = discoverClaudeInventory(cwd, root, pluginRoot, env);
    if (event === 'UserPromptSubmit' && typeof data.prompt !== 'string')
      fail('PROMPT', 'prompt', 'UserPromptSubmit requires user text.');
    const result = invokeRuntime({
      version: 1,
      cwd,
      event:
        event === 'UserPromptSubmit' ? 'prompt' : restore ? 'restore' : 'start',
      ...(event === 'UserPromptSubmit' ? { prompt: String(data.prompt) } : {}),
      ...(restore && previous.selected
        ? { resumeWorkflow: previous.selected }
        : {}),
      discovery,
      inventory: inventory.skills,
    });
    let warning = '';
    if (inventory.superpowersEvidence && !warned) {
      warning = `Playbill: Superpowers may also supply workflow instructions (${inventory.superpowersEvidence}). Both can coexist; check their workflow choices if they overlap.`;
    }
    const context = claudeContext(result, restore);
    const additionalContext = boundedOutput(
      [context, warning].filter(Boolean).join('\n\n'),
    );
    warned ||= Boolean(warning);
    const selected = result.ok
      ? (result.selected ??
        (event === 'UserPromptSubmit' ? previous.selected : undefined))
      : undefined;
    stateStore.write({ version: 1, warned, ...(selected ? { selected } : {}) });
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext,
      },
      ...(!result.ok || warning
        ? {
            systemMessage: [!result.ok ? context : '', warning]
              .filter(Boolean)
              .join('\n'),
          }
        : {}),
    };
  } catch (error) {
    let failure = error;
    if (stateStore) {
      try {
        stateStore.write({ version: 1, warned });
      } catch (stateError) {
        failure = new Error(
          `${errorMessage(error)}; session state reset failed: ${errorMessage(stateError)}`,
        );
      }
    }
    const context = claudeContext(runtimeFailure(failure));
    return {
      hookSpecificOutput: { hookEventName: event, additionalContext: context },
      systemMessage: context,
    };
  }
}

export async function main(): Promise<void> {
  let output: ClaudeHookOutput;
  try {
    output = handleClaudeEvent(await readInput());
  } catch (error) {
    const context = claudeContext(runtimeFailure(error));
    output = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
      systemMessage: context,
    };
  }
  process.stdout.write(JSON.stringify(output) + '\n');
}
