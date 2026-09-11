import { createHash } from 'node:crypto';
import {
  lstatSync,
  realpathSync,
  statSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const runtime = '.playbill/coordinator/runtime';
export const runtimePath = (config) => config.runtime ?? runtime;

export function skillFile(config, path) {
  if (!isAbsolute(path)) return safePath(config.root, path);
  ensure(
    config.installedSkills === true,
    'Absolute skill file requires installedSkills',
  );
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  ensure(
    stat.isFile() && stat.size <= 4 * 1024 * 1024,
    'Invalid installed skill file',
  );
  readFileSync(canonical);
  return canonical;
}

export function withinRoot(root, cwd) {
  const path = relative(root, realpathSync(cwd));
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith('../'))
  );
}

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const validPath = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  !isAbsolute(name) &&
  !name.includes('\\') &&
  !name.includes('\0') &&
  name.split('/').every((part) => part && part !== '.' && part !== '..');

export function safePath(root, name) {
  ensure(validPath(name), `Unsafe relative path: ${name}`);
  let path = root;
  for (const part of name.split('/')) {
    path = join(path, part);
    try {
      ensure(!lstatSync(path).isSymbolicLink(), `Symlink forbidden: ${name}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return path;
}

export function relativePath(root, path) {
  const name = relative(root, resolve(root, path));
  safePath(root, name);
  return name;
}

export function snapshot(root, name) {
  const path = safePath(root, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  ensure(
    stat.isFile() && stat.size <= 4 * 1024 * 1024,
    `Unsupported file: ${name}`,
  );
  const bytes = readFileSync(path);
  return {
    sha256: hash(bytes),
    size: bytes.length,
    base64: bytes.toString('base64'),
    nonempty: bytes.toString('utf8').trim().length > 0,
  };
}

export const hashes = (root, names) =>
  Object.fromEntries(
    names.map((name) => [name, snapshot(root, name)?.sha256 ?? null]),
  );
export const same = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

export const fileHash = (root, name) =>
  hash(readFileSync(safePath(root, name)));

export function writeJSON(root, name, value, exclusive = false) {
  const path = safePath(root, name);
  mkdirSync(dirname(path), { recursive: true });
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (exclusive) writeFileSync(path, bytes, { flag: 'wx' });
  else {
    const temporary = safePath(root, `${name}.tmp`);
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, path);
  }
}

export function commandWords(command) {
  if (typeof command !== 'string') return null;
  const words = [];
  let value = '';
  let started = false;
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else value += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (['$', '`', '\\'].includes(char)) return null;
      else value += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === '\\') {
      if (++i === command.length || command[i] === '\n') return null;
      value += command[i];
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(value);
      value = '';
      started = false;
    } else {
      if ('|&;<>`$()'.includes(char)) return null;
      value += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(value);
  return words;
}
