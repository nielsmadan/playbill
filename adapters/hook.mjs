import { Buffer } from 'node:buffer';
import { stdin, stdout } from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { TextDecoder } from 'node:util';

export async function hook(host) {
  let event = 'SessionStart';
  const timer = setTimeout(
    () =>
      stdin.destroy(new Error('Hook input exceeded its 2 second deadline.')),
    2000,
  );
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stdin) {
      bytes += chunk.length;
      if (bytes > 262144) throw new Error('Hook input exceeds 256 KiB.');
      chunks.push(chunk);
    }
    clearTimeout(timer);
    const input = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (input?.hook_event_name === 'UserPromptSubmit')
      event = 'UserPromptSubmit';
    const adapter = await import(`../dist/${host}.js`);
    const output = await (host === 'claude'
      ? adapter.handleClaudeEvent(input)
      : adapter.handleCodexEvent(input));
    stdout.write(JSON.stringify(output) + '\n');
  } catch (error) {
    const context = `Playbill adapter could not start. Check hook input and run npm ci && npm run build in the plugin directory. ${String(error.message).slice(0, 2000)}`;
    stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: context,
        },
        ...(host === 'claude' ? { systemMessage: context } : {}),
      }) + '\n',
    );
  } finally {
    clearTimeout(timer);
  }
}
