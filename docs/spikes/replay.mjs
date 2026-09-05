import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks, testSource } from './fixtures/tasks.mjs';
import { skillIds, artifactNames, invocation, writesArtifact } from './inspect.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const harnesses = ['claude', 'codex', 'pi', 'opencode'];
const results = [];
let mismatches = 0;
let syntaxFailures = 0;
for (const task of tasks) {
  const check = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: testSource(task), encoding: 'utf8' });
  if (check.status !== 0) syntaxFailures += 1;
}
console.log(`Fixture syntax: ${tasks.length - syntaxFailures}/${tasks.length} valid`);

for (const harness of harnesses) {
  for (const task of tasks) {
    const runId = `${harness}-${task.id}`;
    const run = JSON.parse(readFileSync(join(root, 'docs/spikes/evidence', runId + '.json'), 'utf8').replaceAll('<repo>', root));
    if (run.status === 'blocked') {
      results.push({ harness, named: false, sequence: false, behavior: false, blocked: true });
      console.log(`${runId}: BLOCKED`);
      continue;
    }
    const source = `data:text/javascript;base64,${Buffer.from(run.solution ?? '').toString('base64')}`;
    const assertions = `import assert from 'node:assert/strict';\nimport * as m from ${JSON.stringify(source)};\n${task.assertions}\nconsole.log('PASS ${task.id}');\n`;
    const check = spawnSync(process.execPath, ['--input-type=module', '-e', assertions], { encoding: 'utf8', timeout: 5000 });
    const calls = (run.toolEvidence ?? []).map(call => ({ ...call, output: call.outputText }));
    const stages = skillIds.map((id, index) => ({
      activation: calls.find(call => invocation(call, harness, run.metadata.cwd).includes(id)),
      write: calls.find(call => writesArtifact(call, artifactNames[index])),
      artifact: run.stages?.[index]
    }));
    const injected = run.injections?.some(event => event.text?.startsWith('Playbill M0 coding workflow'));
    const named = !!injected && stages.every(stage => stage.activation);
    const ordered = stages.every((stage, index) => stage.activation && stage.write && stage.artifact?.observed?.content.trim() && stage.artifact.artifactContent?.trim() && stage.activation.endLine < stage.write.line && (!index || stages[index - 1].write?.endLine < stage.activation.line));
    const checked = [0, 2, 3].every(index => calls.some(call => call.ok && /\bnode\s+test\.mjs\b/.test(call.input?.command ?? '') && JSON.stringify(call.output).includes(`PASS ${task.id}`) && call.line > (stages[index].activation?.endLine ?? Infinity) && call.endLine < (stages[index].write?.endLine ?? 0)));
    const sequence = named && ordered && checked && check.status === 0 && run.originalTest === testSource(task) && run.metadata.exitCode === 0 && run.metadata.timedOut === false;
    if (sequence !== run.sequence || check.status !== run.behavior?.exitCode) mismatches += 1;
    results.push({ harness, named, sequence, behavior: check.status === 0, blocked: false });
    console.log(`${runId}: sequence=${sequence ? 'PASS' : 'UNPASSED'} canonical=${check.status === 0 ? 'PASS' : 'FAIL'}`);
    if (check.status !== 0) console.error(check.stderr);
  }
}

const totals = harnesses.map(harness => {
  const runs = results.filter(run => run.harness === harness);
  const total = { harness, named: runs.filter(run => run.named).length, sequence: runs.filter(run => run.sequence).length, behavior: runs.filter(run => run.behavior).length, blocked: runs.filter(run => run.blocked).length };
  console.log(`${harness}: named=${total.named}/5 sequence=${total.sequence}/5 canonical=${total.behavior}/5 blocked=${total.blocked}/5`);
  return total;
});
const namedHarnesses = totals.filter(total => total.named > 0).length;
const gate = namedHarnesses >= 3 && totals[0].sequence >= 4 && totals.slice(1).some(total => total.sequence >= 4);
console.log(`Evidence consistency: ${mismatches} mismatches`);
console.log(`M0 GATE: ${gate ? 'PASS' : 'FAIL'} (named harnesses ${namedHarnesses}/4)`);
process.exitCode = mismatches || syntaxFailures ? 2 : gate ? 0 : 1;
