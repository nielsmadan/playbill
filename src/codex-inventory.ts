import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { errorMessage, fail } from './diagnostics.js';
import {
  canonicalId,
  codexInvocable,
  nativeSnapshot,
  normalizeNative,
} from './native-inventory.js';
import { record, text } from './schema.js';
import type { NativeSkill } from './runtime.js';

export function codexSkills(input: unknown, cwd: string): NativeSkill[] {
  const data = record(input, 'skills/list');
  if (!Array.isArray(data.data))
    fail('INVENTORY', 'skills/list', 'Expected cwd entries.');
  const entries = data.data.map((value: unknown) =>
    record(value, 'skills/list.data'),
  );
  const entry = entries.find((value) => value.cwd === cwd);
  if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors))
    fail('INVENTORY', 'skills/list', 'Missing native cwd inventory.');
  if (entry.errors.length)
    fail(
      'INVENTORY',
      'skills/list',
      JSON.stringify(entry.errors).slice(0, 2000),
    );
  if (entry.skills.length > 1000)
    fail('LIMIT', 'skills/list', 'At most 1000 skills.');
  return normalizeNative(
    entry.skills.map((value: unknown) => {
      const skill = record(value, 'skills/list.skills');
      const path = realpathSync(text(skill.path, 'skill.path'));
      const invocation = text(skill.name, 'skill.name');
      if (typeof skill.enabled !== 'boolean')
        fail('INVENTORY', path, 'Expected native enabled flag.');
      let invocable = false;
      let unavailableReason: string | undefined;
      try {
        invocable = codexInvocable(path);
      } catch (error) {
        const reason = Array.from(errorMessage(error), (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
            ? ' '
            : character,
        )
          .join('')
          .replace(/\s+/gu, ' ')
          .slice(0, 1800);
        unavailableReason = `Native skill metadata could not be validated: ${reason}`;
      }
      return {
        id: canonicalId(invocation, path),
        path,
        invocation,
        model_invocable: skill.enabled && invocable,
        requires: {},
        ...(unavailableReason ? { unavailableReason } : {}),
      };
    }),
  );
}

export async function discoverCodexInventory(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<NativeSkill[]> {
  if (env.PLAYBILL_CODEX_INVENTORY)
    return nativeSnapshot(env.PLAYBILL_CODEX_INVENTORY, 'codex');
  const result = await new Promise<unknown>((resolve, reject) => {
    const child = spawn(
      env.PLAYBILL_CODEX_EXECUTABLE ?? 'codex',
      ['-C', cwd, 'app-server'],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let buffer = '';
    let bytes = 0;
    let done = false;
    const finish = (error?: Error, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            'Codex inventory exceeded its 5 second deadline. Supply PLAYBILL_CODEX_INVENTORY for the intended session.',
          ),
        ),
      5000,
    );
    const send = (value: unknown) =>
      child.stdin.write(JSON.stringify(value) + '\n');
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => finish(error));
    child.on('exit', (code) =>
      finish(
        new Error(
          `Codex inventory exited ${code} before skills/list completed.`,
        ),
      ),
    );
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_097_152)
        finish(new Error('Codex inventory exceeded 2 MiB.'));
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2_097_152) {
        finish(new Error('Codex inventory exceeded 2 MiB.'));
        return;
      }
      buffer += chunk;
      let end;
      while (!done && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = record(
            JSON.parse(line) as unknown,
            'Codex app-server',
          );
          if (message.error)
            throw new Error(JSON.stringify(message.error).slice(0, 2000));
          if (message.id === 1) {
            send({ method: 'initialized', params: {} });
            send({
              id: 2,
              method: 'skills/list',
              params: { cwds: [cwd], forceReload: true },
            });
          } else if (message.id === 2) finish(undefined, message.result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'playbill-inventory', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });
  return codexSkills(result, cwd);
}
