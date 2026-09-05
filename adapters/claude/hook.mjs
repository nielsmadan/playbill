import { stdout } from 'node:process';

try {
  const { main } = await import('../../dist/claude.js');
  await main();
} catch (error) {
  const message = `Playbill adapter could not start. Run npm ci && npm run build in the plugin directory. ${error.message}`;
  stdout.write(
    JSON.stringify({
      systemMessage: message,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: message,
      },
    }) + '\n',
  );
}
