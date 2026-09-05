import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const root = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(resolve(root, 'pipeline.md'), 'utf8');

export default function playbill(pi: ExtensionAPI) {
  pi.on('resources_discover', async () => ({ skillPaths: [resolve(root, 'skills')] }));
  pi.on('context', async (event, ctx) => {
    if (event.messages.some(message => JSON.stringify(message.content).includes('Playbill M0 coding workflow'))) return;
    appendFileSync(resolve(ctx.cwd, 'injection.jsonl'), JSON.stringify({ seam: 'context', harness: 'pi', text, timestamp: Date.now() }) + '\n');
    return { messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }, ...event.messages] };
  });
}
