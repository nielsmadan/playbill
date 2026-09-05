import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks } from './fixtures/tasks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const harnesses = process.argv.slice(2);
if (!harnesses.length || harnesses.some(harness => !['claude', 'codex', 'pi', 'opencode'].includes(harness))) throw new Error('Pass harness names');
let failed = 0;
for (const harness of harnesses) {
  for (const task of tasks) {
    if (existsSync(join(root, '.spike-runs', `${harness}-${task.id}`, 'metadata.json'))) continue;
    const child = spawn(process.execPath, [join(root, 'docs/spikes/run.mjs'), harness, task.id], { cwd: root, stdio: 'inherit' });
    const code = await new Promise(done => child.on('close', done));
    if (code !== 0) failed += 1;
  }
}
console.log(`Batch finished: ${failed} harness process failures`);
process.exitCode = failed ? 1 : 0;
