import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fail } from './diagnostics.js';
import { optionalPath } from './discovery.js';
import { readText } from './parsing.js';
import { identifier, record } from './schema.js';

export interface SessionState {
  version: 1;
  warned: boolean;
  selected?: string;
}

export function sessionStore(
  directory: string,
  key: string,
): {
  read: () => SessionState;
  write: (state: SessionState) => void;
} {
  if (!isAbsolute(directory))
    fail('PATH', directory, 'State directory must be absolute.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `pb-${createHash('sha256').update(key).digest('hex')}.json`,
  );
  return {
    read() {
      if (!optionalPath(path)) return { version: 1, warned: false };
      if (statSync(path).size > 4096)
        fail(
          'STATE',
          path,
          'Session state exceeds 4 KiB; remove this file to reset it.',
        );
      const data = record(JSON.parse(readText(path)) as unknown, path, [
        'version',
        'warned',
        'selected',
      ]);
      if (data.version !== 1 || typeof data.warned !== 'boolean')
        fail(
          'STATE',
          path,
          'Invalid session state; remove this file to reset it.',
        );
      return {
        version: 1,
        warned: data.warned,
        ...(data.selected === undefined
          ? {}
          : { selected: identifier(data.selected, path) }),
      };
    },
    write(state) {
      const files = readdirSync(directory)
        .filter((file) => /^pb-[a-f0-9]{64}\.json$/u.test(file))
        .map((file) => ({
          path: join(directory, file),
          time: statSync(join(directory, file)).mtimeMs,
        }))
        .sort((a, b) => b.time - a.time);
      for (const [index, file] of files.entries())
        if (
          file.path !== path &&
          (index >= 127 || file.time < Date.now() - 7 * 86400_000)
        )
          unlinkSync(file.path);
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        renameSync(temp, path);
      } finally {
        if (optionalPath(temp)) unlinkSync(temp);
      }
    },
  };
}
