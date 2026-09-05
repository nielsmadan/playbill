import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(resolve(root, 'pipeline.md'), 'utf8');

export const PlaybillPlugin = async ({ directory }) => ({
  config: async config => {
    config.skills ??= {};
    config.skills.paths ??= [];
    config.skills.paths.push(resolve(root, 'skills'));
    appendFileSync(resolve(directory, 'injection.jsonl'), JSON.stringify({ seam: 'config', harness: 'opencode', skills: config.skills.paths, timestamp: Date.now() }) + '\n');
  },
  'experimental.chat.messages.transform': async (_input, output) => {
    const first = output.messages.find(message => message.info.role === 'user');
    if (!first?.parts.length || first.parts.some(part => part.type === 'text' && part.text.includes('Playbill M0 coding workflow'))) return;
    first.parts.unshift({ ...first.parts[0], type: 'text', text });
    appendFileSync(resolve(directory, 'injection.jsonl'), JSON.stringify({ seam: 'experimental.chat.messages.transform', harness: 'opencode', text, timestamp: Date.now() }) + '\n');
  }
});
