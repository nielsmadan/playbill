import { Buffer } from 'node:buffer';
import process from 'node:process';
import { configuration } from './config.mjs';
import { handleHook } from './core.mjs';
import { ensure } from './files.mjs';

try {
  ensure(process.argv.length === 3, 'Usage: node hook.mjs CONFIG');
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    ensure(Buffer.byteLength(input) <= 1048576, 'Hook input exceeds 1 MiB');
  }
  const result = await handleHook(
    configuration(process.argv[2]),
    JSON.parse(input),
  );
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(`Coordinator hook rejected event: ${error.message}\n`);
  process.exitCode = 2;
}
