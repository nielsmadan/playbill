import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tasks, testSource } from './fixtures/tasks.mjs';
import { readJson, readJsonl, callsFrom, skillIds, artifactNames, invocation, writesArtifact } from './inspect.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const harnesses = ['claude', 'codex', 'pi', 'opencode'];
const writeReport = process.argv.includes('--write-report');
const only = process.argv.find(arg => arg.startsWith('--run='))?.slice(6);
const results = [];
const hash = text => createHash('sha256').update(text).digest('hex');
const portable = value => JSON.parse(JSON.stringify(value).replaceAll(root, '<repo>'));
let syntaxFailures = 0;
for (const task of tasks) {
  const check = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: testSource(task), encoding: 'utf8' });
  if (check.status !== 0) {
    syntaxFailures += 1;
    console.error(check.stderr);
  }
}
console.log(`Fixture syntax: ${tasks.length - syntaxFailures}/${tasks.length} valid`);

for (const harness of harnesses) {
  for (const task of tasks) {
    const runId = `${harness}-${task.id}`;
    if (only && only !== runId) continue;
    const dir = join(root, '.spike-runs', runId);
    const metadataPath = join(dir, 'metadata.json');
    if (!existsSync(metadataPath)) {
      results.push({ runId, harness, taskId: task.id, status: 'missing', allSkills: false, sequence: false, reasons: ['No scored run evidence'] });
      continue;
    }
    const metadata = readJson(metadataPath);
    if (metadata.blocked) {
      results.push({ runId, harness, taskId: task.id, status: 'blocked', allSkills: false, sequence: false, reasons: [metadata.blocked], metadata: portable(metadata) });
      continue;
    }
    if (!metadata.finished) {
      results.push({ runId, harness, taskId: task.id, status: 'running', allSkills: false, sequence: false, reasons: ['Harness process still running'] });
      continue;
    }
    const rows = readJsonl(join(dir, 'stdout.jsonl'));
    const calls = callsFrom(harness, rows);
    const activations = calls.flatMap(call => invocation(call, harness, dir).map(skill => ({ skill, line: call.line, endLine: call.endLine })));
    const stages = skillIds.map((skill, index) => {
      const activate = activations.find(item => item.skill === skill);
      const artifact = artifactNames[index];
      const write = calls.find(call => writesArtifact(call, artifact));
      const path = join(dir, artifact);
      const observed = readJsonl(join(dir, 'observed.jsonl')).find(row => row.event.name === artifact && row.event.content.trim());
      const checks = calls.filter(call => call.ok && /\bnode\s+test\.mjs\b/.test(call.input?.command ?? '') && JSON.stringify(call.output).includes(`PASS ${task.id}`));
      const check = checks.find(call => call.line > (activate?.endLine ?? Infinity) && call.endLine < (write?.endLine ?? 0));
      return { skill, activation: activate ?? null, artifact, artifactWrite: write ? { line: write.line, endLine: write.endLine, tool: write.name } : null, observed: observed?.event ?? null, artifactContent: existsSync(path) ? readFileSync(path, 'utf8') : null, check: check ? { line: check.line, endLine: check.endLine, output: check.output } : null };
    });
    const assertions = `import assert from 'node:assert/strict';\nimport * as m from ${JSON.stringify(pathToFileURL(join(dir, 'solution.mjs')).href)};\n${task.assertions}\nconsole.log('PASS ${task.id} canonical');\n`;
    const behavior = spawnSync(process.execPath, ['--input-type=module', '-e', assertions], { cwd: dir, encoding: 'utf8', timeout: 5000 });
    const testIntact = existsSync(join(dir, 'test.mjs')) && readFileSync(join(dir, 'test.mjs'), 'utf8') === testSource(task);
    const allSkills = skillIds.every(skill => activations.some(item => item.skill === skill));
    const injections = readJsonl(join(dir, 'injection.jsonl')).map(row => row.event);
    const injected = injections.some(event => event.text?.startsWith('Playbill M0 coding workflow'));
    const ordered = stages.every((stage, index) => stage.activation && stage.artifactWrite && stage.observed && stage.artifactContent?.trim() && stage.activation.endLine < stage.artifactWrite.line && (!index || stages[index - 1].artifactWrite?.endLine < stage.activation.line));
    const checksInStages = [0, 2, 3].every(index => stages[index].check);
    const processOk = metadata.exitCode === 0 && metadata.timedOut === false;
    const reasons = [];
    if (!injected) reasons.push('Pipeline injection not observed');
    if (!allSkills) reasons.push('Not all four bound skills were successfully activated');
    if (!ordered) reasons.push('Step activation and completed artifact writes were not fully interleaved');
    if (!checksInStages) reasons.push('Successful test commands not observed within implement, fix and final-review steps');
    if (behavior.status !== 0) reasons.push('Canonical task assertions failed');
    if (!testIntact) reasons.push('Task-local test file differs from the canonical fixture');
    if (!processOk) reasons.push(metadata.timedOut ? 'Run exceeded 150 seconds' : 'Harness did not exit successfully');
    const events = rows.map(row => row.event);
    const init = events.find(e => e.type === 'system' && e.subtype === 'init');
    const claudeResult = events.find(e => e.type === 'result');
    const piMessages = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').map(e => e.message);
    const usage = harness === 'claude' ? claudeResult?.usage : harness === 'pi' ? piMessages.reduce((sum, message) => {
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) sum[key] = (sum[key] ?? 0) + (message.usage?.[key] ?? 0);
      sum.costUSD += message.usage?.cost?.total ?? 0;
      return sum;
    }, { costUSD: 0 }) : events.filter(e => e.type === 'turn.completed' || e.type === 'step_finish').map(e => e.usage ?? e.part?.tokens);
    const model = init?.model ?? piMessages[0]?.model ?? metadata.model ?? null;
    const toolEvidence = calls.map(call => ({ ...call, output: undefined, activated: invocation(call, harness, dir), outputText: ['Skill', 'skill'].includes(call.name) || invocation(call, harness, dir).length || /\bnode\s+test\.mjs\b/.test(call.input?.command ?? '') ? call.output : undefined }));
    const sequence = injected && allSkills && ordered && checksInStages && behavior.status === 0 && testIntact && processOk;
    results.push(portable({ runId, harness, taskId: task.id, status: processOk ? 'completed' : 'failed', allSkills, injected, sequence, reasons, model, usage, costUSD: claudeResult?.total_cost_usd, metadata, activations, stages, behavior: { exitCode: behavior.status, stdout: behavior.stdout, stderr: behavior.stderr, error: behavior.error?.message, testIntact }, solution: readFileSync(join(dir, 'solution.mjs'), 'utf8'), originalTest: readFileSync(join(dir, 'test.mjs'), 'utf8'), injections, toolEvidence, registry: init ? { skills: init.skills, plugins: init.plugins, mcpServers: init.mcp_servers } : undefined, rawSha256: hash(readFileSync(join(dir, 'stdout.jsonl'))), stderr: existsSync(join(dir, 'stderr.txt')) ? readFileSync(join(dir, 'stderr.txt'), 'utf8') : '' }));
  }
}

const totals = harnesses.map(harness => {
  const runs = results.filter(run => run.harness === harness);
  return { harness, recorded: runs.filter(run => run.status !== 'missing').length, namedSkillRuns: runs.filter(run => run.allSkills && run.injected).length, sequencePasses: runs.filter(run => run.sequence).length, denominator: 5, behaviorPasses: runs.filter(run => run.behavior?.exitCode === 0).length, blocked: runs.filter(run => run.status === 'blocked').length };
});
const namedHarnesses = totals.filter(item => item.namedSkillRuns >= 1).length;
const claudePasses = totals.find(item => item.harness === 'claude').sequencePasses;
const otherPasses = totals.some(item => item.harness !== 'claude' && item.sequencePasses >= 4);
const complete = results.length === 20 && results.every(run => !['missing', 'running'].includes(run.status));
const gate = complete && syntaxFailures === 0 && namedHarnesses >= 3 && claudePasses >= 4 && otherPasses;
for (const run of results) console.log(`${run.runId}: ${run.sequence ? 'PASS' : run.status.toUpperCase()} skills=${run.activations?.map(item => item.skill).join(',') || 'none'} tests=${run.behavior?.exitCode === 0 ? 'PASS' : 'UNPASSED'}${run.reasons.length ? ' — ' + run.reasons.join('; ') : ''}`);
for (const item of totals) console.log(`${item.harness}: named=${item.namedSkillRuns}/5 sequence=${item.sequencePasses}/5 behavior=${item.behaviorPasses}/5 blocked=${item.blocked}/5`);
console.log(`M0 GATE: ${gate ? 'PASS' : complete ? 'FAIL' : 'INCOMPLETE'} (named harnesses ${namedHarnesses}/4; Claude ${claudePasses}/5; another harness >=4/5: ${otherPasses})`);
if (writeReport) {
  mkdirSync(join(root, 'docs/spikes/evidence'), { recursive: true });
  for (const run of results) writeFileSync(join(root, 'docs/spikes/evidence', run.runId + '.json'), JSON.stringify(run, null, 2) + '\n');
  writeFileSync(join(root, 'docs/spikes/evidence/summary.json'), JSON.stringify({ totals, gate, namedHarnesses }, null, 2) + '\n');
}
process.exitCode = only ? results.every(run => run.sequence) ? 0 : 1 : gate ? 0 : 1;
