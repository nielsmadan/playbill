import { runRuntime, runtimeFailure } from './runtime.js';
import { readInput, RUNTIME_LIMITS } from './subprocess.js';

let result;
try {
  result = runRuntime(await readInput());
} catch (error) {
  result = runtimeFailure(error);
}
let output = JSON.stringify(result);
if (Buffer.byteLength(output) > RUNTIME_LIMITS.outputBytes) {
  result = runtimeFailure(new Error('Validator response exceeds 512 KiB.'));
  output = JSON.stringify(result);
}
process.stdout.write(output + '\n');
process.exitCode = result.ok ? 0 : 1;
