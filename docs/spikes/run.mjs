import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, watch, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks, testSource } from './fixtures/tasks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = join(root, 'docs/spikes/fixtures');
const [harness, taskId, flag] = process.argv.slice(2);
const task = tasks.find(item => item.id === taskId);
if (!['claude', 'codex', 'pi', 'opencode'].includes(harness) || !task || (flag && flag !== '--probe')) {
  console.error('Usage: node docs/spikes/run.mjs <claude|codex|pi|opencode> <01-clamp|02-unique|03-chunks|04-median|05-totals> [--probe]');
  process.exit(2);
}
const runId = flag ? `${harness}-probe` : `${harness}-${task.id}`;
const dir = join(root, '.spike-runs', runId);
if (existsSync(dir)) throw new Error(`Run already exists: ${dir}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'TASK.md'), task.spec + '\n');
writeFileSync(join(dir, 'solution.mjs'), task.starter);
writeFileSync(join(dir, 'test.mjs'), testSource(task));
const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: testSource(task), encoding: 'utf8' });
if (syntax.status !== 0) throw new Error(syntax.stderr);

const prompt = 'Implement the task in TASK.md. Work only in this task directory. Use Node builtins; do not dispatch agents, install dependencies, or use git.';
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const args = [];
if (harness === 'claude') {
  const plugin = join(dir, 'plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'hooks'));
  cpSync(join(fixtures, 'skills'), join(plugin, 'skills'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'playbill-spike', version: '0.0.0', description: 'Throwaway Playbill M0 fixture' }));
  writeFileSync(join(plugin, 'hooks/hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node ${shellQuote(join(fixtures, 'session-start.mjs'))} claude`, timeout: 5 }] }] } }));
  args.push('-p', '--plugin-dir', plugin, '--setting-sources', 'project,local', '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--no-session-persistence', '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Write,Edit,Bash,Skill,Glob,Grep', '--effort', 'low', prompt);
}
if (harness === 'pi') {
  args.push('-p', '--mode', 'json', '--no-session', '--no-extensions', '-e', join(fixtures, 'pi-extension.ts'), '--no-skills', '--skill', join(fixtures, 'skills'), '--no-context-files', '--no-prompt-templates', '--no-themes', '--approve', '--model', 'openai-codex/gpt-5.6-sol', '--thinking', 'low', prompt);
}
if (harness === 'opencode') {
  mkdirSync(join(dir, '.opencode/plugins'), { recursive: true });
  writeFileSync(join(dir, '.opencode/plugins/playbill.js'), `export { PlaybillPlugin } from ${JSON.stringify(join(fixtures, 'opencode-plugin.js'))};\n`);
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: { read: 'allow', edit: 'allow', bash: 'allow', skill: 'allow', task: 'deny', external_directory: { '*': 'deny', [fixtures + '/*']: 'allow' } }, share: 'disabled' }, null, 2));
  args.push('run', '--dir', dir, '--format', 'json', prompt);
}
if (harness === 'codex') {
  mkdirSync(join(dir, '.codex'), { recursive: true });
  cpSync(join(fixtures, 'skills'), join(dir, '.agents/skills'), { recursive: true });
  writeFileSync(join(dir, '.codex/config.toml'), '[features]\nhooks = true\n');
  const command = `node ${shellQuote(join(fixtures, 'session-start.mjs'))} codex`;
  const hookPath = join(dir, '.codex/hooks.json');
  writeFileSync(hookPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }] } }));
  const identity = JSON.stringify({ event_name: 'session_start', hooks: [{ async: false, command, timeout: 5, type: 'command' }] });
  const hash = 'sha256:' + createHash('sha256').update(identity).digest('hex');
  args.push('exec', '--json', '--ephemeral', '-C', dir, '--skip-git-repo-check', '-s', 'danger-full-access', '-c', 'approval_policy="never"', '-c', 'features.hooks=true', '-c', 'features.multi_agent=false', '-c', 'model_reasoning_effort="low"', '-c', `projects={${JSON.stringify(dir)}={trust_level="trusted"}}`, '-c', `hooks.state={${JSON.stringify(hookPath + ':session_start:0:0')}={trusted_hash=${JSON.stringify(hash)}}}`, prompt);
  writeFileSync(join(dir, 'hook-trust.json'), JSON.stringify({ hookPath, identity: JSON.parse(identity), hash }, null, 2));
}

const artifacts = ['solution.mjs', 'implementation.md', 'reviews/task.md', 'fixes.md', 'reviews/final.md'];
const observed = [];
const seen = new Map();
function observe() {
  for (const name of artifacts) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (seen.get(name) === sha256) continue;
    seen.set(name, sha256);
    observed.push({ timestamp: Date.now(), name, sha256, content, mtimeMs: statSync(path).mtimeMs });
  }
}
observe();
const watcher = watch(dir, { recursive: true }, observe);
const started = Date.now();
const metadata = { runId, harness, taskId: task.id, scored: !flag, cwd: dir, command: harness, args, prompt, timeoutMs: 150000, started, fixtureSha256: createHash('sha256').update(readFileSync(join(fixtures, 'pipeline.md'))).digest('hex'), testSha256: createHash('sha256').update(testSource(task)).digest('hex'), harnessVersion: spawnSync(harness, ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout.trim() };
writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
console.log(`START ${runId} (150s limit)`);
const child = spawn(harness, args, { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
let timedOut = false;
let killTimer;
const timer = setTimeout(() => {
  timedOut = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
}, 150000);
const result = await new Promise(done => {
  child.on('error', error => done({ exitCode: null, signal: null, error: error.message }));
  child.on('close', (exitCode, signal) => done({ exitCode, signal }));
});
clearTimeout(timer);
clearTimeout(killTimer);
watcher.close();
observe();
const redact = text => text.replace(/\b(sk-(?:proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})/g, '[REDACTED]');
writeFileSync(join(dir, 'stdout.jsonl'), redact(stdout));
writeFileSync(join(dir, 'stderr.txt'), redact(stderr));
writeFileSync(join(dir, 'observed.jsonl'), observed.map(item => JSON.stringify(item)).join('\n') + '\n');
Object.assign(metadata, result, { timedOut, durationMs: Date.now() - started, finished: Date.now() });
writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify({ runId, ...result, timedOut, durationMs: metadata.durationMs, stdoutBytes: stdout.length, stderrBytes: stderr.length, artifacts: [...seen.keys()] }));
process.exitCode = timedOut ? 124 : result.exitCode ?? 1;
