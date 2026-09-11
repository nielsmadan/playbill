import {
  CoordinatorSession,
  hookFailure,
  nativeEvents,
} from './coordinator-session.js';
import { AdapterSession, nativeContext } from './adapter-session.js';
import { discoverCodexInventory } from './codex-inventory.js';
import { fail } from './diagnostics.js';
import { runtimeFailure } from './runtime.js';
import { record, text } from './schema.js';
import { readInput } from './subprocess.js';

export async function handleCodexEvent(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
) {
  let event = 'SessionStart';
  let session: AdapterSession | undefined;
  let context: string;
  try {
    const data = record(input, 'Codex hook');
    event = text(data.hook_event_name, 'hook_event_name');
    if (!nativeEvents.includes(event) || event === 'PostToolUseFailure')
      fail('EVENT', event, 'Unsupported native Codex hook.');
    const cwd = text(data.cwd, 'cwd');
    const coordinator = new CoordinatorSession('codex', data, env);
    const routed = await coordinator.route();
    if (routed !== undefined) return routed;
    if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return {};
    session = new AdapterSession(
      'codex',
      cwd,
      text(data.session_id, 'session_id'),
      env,
    );
    const inventory = await discoverCodexInventory(cwd, env);
    const restore =
      event === 'SessionStart' &&
      (data.source === 'resume' || data.source === 'compact');
    if (event === 'UserPromptSubmit' && typeof data.prompt !== 'string')
      fail('PROMPT', event, 'Expected prompt text.');
    const kind =
      event === 'UserPromptSubmit' ? 'prompt' : restore ? 'restore' : 'start';
    const prompt =
      event === 'UserPromptSubmit' ? String(data.prompt) : undefined;
    const result = session.evaluate(kind, inventory, prompt);
    if (result.coordination)
      return await coordinator.start(result.coordination);
    if (event === 'UserPromptSubmit' && result.ok && result.selected)
      coordinator.rendered();
    context = session.run(kind, inventory, prompt, result);
  } catch (error) {
    context = session
      ? session.failure(error)
      : nativeContext('codex', runtimeFailure(error));
    return hookFailure(event, context);
  }
  return {
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  };
}

export async function main(): Promise<void> {
  try {
    process.stdout.write(
      JSON.stringify(await handleCodexEvent(await readInput())) + '\n',
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: nativeContext('codex', runtimeFailure(error)),
        },
      }) + '\n',
    );
  }
}
