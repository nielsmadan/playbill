import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pipeline = readFileSync(fileURLToPath(new URL('./pipeline.md', import.meta.url)), 'utf8');
const harness = process.argv[2];
const prefix = harness === 'claude' ? 'playbill-spike:' : '';
const text = pipeline.replace(/`(pb-[^`]+)`/g, (_, id) => `\`${prefix}${id}\``);
appendFileSync('injection.jsonl', JSON.stringify({ seam: 'SessionStart', harness, text, timestamp: Date.now() }) + '\n');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
