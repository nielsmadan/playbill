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
    if (event !== 'SessionStart' && event !== 'UserPromptSubmit')
      fail('EVENT', event, 'Expected SessionStart or UserPromptSubmit.');
    const cwd = text(data.cwd, 'cwd');
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
    context = session.run(
      event === 'UserPromptSubmit' ? 'prompt' : restore ? 'restore' : 'start',
      inventory,
      event === 'UserPromptSubmit' ? String(data.prompt) : undefined,
    );
  } catch (error) {
    context = session
      ? session.failure(error)
      : nativeContext('codex', runtimeFailure(error));
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
