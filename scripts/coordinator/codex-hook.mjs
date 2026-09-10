import { Buffer } from 'node:buffer';
import process from 'node:process';
import { configuration } from './config.mjs';
import { handleCodexHook } from './codex.mjs';
import { ensure } from './files.mjs';

try {
  ensure(process.argv.length === 3, 'Usage: node codex-hook.mjs CONFIG');
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    ensure(Buffer.byteLength(input) <= 1048576, 'Hook input exceeds 1 MiB');
  }
  const output = await handleCodexHook(
    configuration(process.argv[2]),
    JSON.parse(input),
  );
  process.stdout.write(JSON.stringify(output) + '\n');
} catch (error) {
  process.stderr.write(
    `Codex coordinator hook rejected event: ${error.message}\n`,
  );
  process.exitCode = 2;
}
