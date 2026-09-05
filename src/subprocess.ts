import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail } from './diagnostics.js';
import { runtimeFailure } from './runtime.js';
import type { RuntimeRequest, RuntimeResult } from './runtime.js';

export const RUNTIME_LIMITS = Object.freeze({
  inputBytes: 262_144,
  outputBytes: 524_288,
  timeoutMs: 5000,
});

export async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(
    () =>
      process.stdin.destroy(
        new Error('Input exceeded the 2 second read deadline.'),
      ),
    2000,
  );
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > RUNTIME_LIMITS.inputBytes)
        fail('LIMIT', 'stdin', 'Input exceeds 256 KiB.');
      chunks.push(buffer);
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export function invokeRuntime(
  request: RuntimeRequest,
  nodeExecutable = process.execPath,
): RuntimeResult {
  try {
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > RUNTIME_LIMITS.inputBytes)
      fail('LIMIT', 'runtime', 'Request exceeds 256 KiB.');
    const child = spawnSync(
      nodeExecutable,
      [fileURLToPath(new URL('./runtime-cli.js', import.meta.url))],
      {
        input,
        encoding: 'utf8',
        timeout: RUNTIME_LIMITS.timeoutMs,
        maxBuffer: RUNTIME_LIMITS.outputBytes,
      },
    );
    if (child.error) throw child.error;
    if (child.status !== 0 && child.status !== 1)
      fail(
        'SUBPROCESS',
        'runtime',
        `Validator exited ${child.status}: ${child.stderr.slice(0, 2000)}`,
      );
    const result = JSON.parse(child.stdout) as RuntimeResult;
    if (
      result.version !== 1 ||
      typeof result.ok !== 'boolean' ||
      typeof result.commonProse !== 'string' ||
      !Array.isArray(result.diagnostics) ||
      !Array.isArray(result.invocations) ||
      (child.status === 1 && result.ok)
    )
      fail('PROTOCOL', 'runtime', 'Invalid validator response.');
    return result;
  } catch (error) {
    return runtimeFailure(error);
  }
}
