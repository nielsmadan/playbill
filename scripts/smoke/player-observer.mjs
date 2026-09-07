import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

const configuration = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const root = realpathSync(configuration.root);
const output = realpathSync(configuration.observations);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const names = [
  'src/services/player/hooks.ts',
  'src/services/player/__tests__/hooks.test.ts',
  '.playbill/config.toml',
  ...['brief', 'diagnosis', 'work', 'checks', 'progress', 'report'].map(
    (name) => `.playbill/debug/${name}.md`,
  ),
];

function snapshot(name) {
  const path = join(root, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const resolved = relative(root, realpathSync(path));
  if (
    !stat.isFile() ||
    stat.size > 131072 ||
    resolved === '..' ||
    resolved.startsWith(`..${sep}`)
  )
    throw new Error(`Unsupported observed file: ${name}`);
  const bytes = readFileSync(path);
  return { content: bytes.toString('utf8'), sha256: hash(bytes) };
}

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 1048576)
    throw new Error('Observation input exceeds 1 MiB');
}
const event = JSON.parse(input);
if (realpathSync(event.cwd) !== root)
  throw new Error('Observation cwd differs from replay root');
if (
  !['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(
    event.hook_event_name,
  ) ||
  typeof event.tool_use_id !== 'string' ||
  !/^[A-Za-z0-9_-]+$/u.test(event.tool_use_id)
)
  throw new Error('Unsupported observation event');
const record = {
  version: 1,
  timestamp: new Date().toISOString(),
  event: event.hook_event_name,
  session: event.session_id,
  toolUseId: event.tool_use_id,
  tool: event.tool_name,
  input: event.tool_input,
  files: Object.fromEntries(names.map((name) => [name, snapshot(name)])),
};
const bytes = JSON.stringify(record) + '\n';
const file = `${record.event}-${record.toolUseId}.json`;
writeFileSync(join(output, file), bytes, { flag: 'wx' });
process.stdout.write(`playbill-player-observation-v1 ${file} ${hash(bytes)}\n`);
