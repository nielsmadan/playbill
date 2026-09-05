import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const readJsonl = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').flatMap((line, index) => {
  try { return [{ line: index + 1, event: JSON.parse(line) }]; } catch { return []; }
}) : [];

export function callsFrom(harness, rows) {
  const calls = [];
  const pending = new Map();
  for (const { line, event: e } of rows) {
    if (harness === 'claude') {
      for (const part of e.message?.content ?? []) {
        if (part.type === 'tool_use') {
          const call = { line, id: part.id, name: part.name, input: part.input };
          calls.push(call);
          pending.set(part.id, call);
        }
        if (part.type === 'tool_result' && pending.has(part.tool_use_id)) {
          Object.assign(pending.get(part.tool_use_id), { endLine: line, ok: !part.is_error, output: part.content, timestamp: e.timestamp });
        }
      }
    }
    if (harness === 'pi') {
      if (e.type === 'tool_execution_start') {
        const call = { line, id: e.toolCallId, name: e.toolName, input: e.args };
        calls.push(call);
        pending.set(e.toolCallId, call);
      }
      if (e.type === 'tool_execution_end' && pending.has(e.toolCallId)) {
        Object.assign(pending.get(e.toolCallId), { endLine: line, ok: !e.isError, output: e.result });
      }
    }
    if (harness === 'opencode' && e.type === 'tool_use') {
      const part = e.part;
      calls.push({ line, endLine: line, id: part.callID, name: part.tool, input: part.state?.input, ok: part.state?.status === 'completed', output: part.state?.output, timestamp: e.timestamp });
    }
    if (harness === 'codex' && ['item.started', 'item.completed'].includes(e.type)) {
      const item = e.item;
      if (item.type === 'command_execution') {
        let call = pending.get(item.id);
        if (!call) {
          call = { line, id: item.id, name: 'command_execution', input: { command: item.command } };
          calls.push(call);
          pending.set(item.id, call);
        }
        if (e.type === 'item.completed') Object.assign(call, { endLine: line, ok: item.exit_code === 0, output: item.aggregated_output, exitCode: item.exit_code });
      }
      if (e.type === 'item.completed' && item.type === 'file_change') {
        calls.push({ line, endLine: line, id: item.id, name: 'file_change', input: { changes: item.changes }, ok: item.status === 'completed', output: item });
      }
    }
  }
  return calls;
}

export const skillIds = ['pb-implement', 'pb-task-review', 'pb-fix', 'pb-final-review'];
export const artifactNames = ['implementation.md', 'reviews/task.md', 'fixes.md', 'reviews/final.md'];

export function invocation(call, harness, dir) {
  if (!call.ok) return [];
  if (harness === 'claude') {
    return call.name === 'Skill' ? skillIds.filter(id => call.input.skill === `playbill-spike:${id}`) : [];
  }
  if (harness === 'opencode') {
    return call.name === 'skill' ? skillIds.filter(id => call.input.name === id) : [];
  }
  if (harness === 'pi' && call.name === 'read') {
    return skillIds.filter(id => resolve(dir, call.input.path) === resolve(dir, `../../docs/spikes/fixtures/skills/${id}/SKILL.md`) && JSON.stringify(call.output).includes(`name: ${id}`));
  }
  if (harness === 'codex' && call.name === 'command_execution') {
    return skillIds.filter(id => {
      const command = call.input.command;
      const path = `.agents/skills/${id}/SKILL.md`;
      return command.includes(path) && /\b(cat|sed|readFileSync)\b/.test(command) && JSON.stringify(call.output).includes(`name: ${id}`);
    });
  }
  return [];
}

export function writesArtifact(call, artifact) {
  if (!call.ok) return false;
  const input = call.input ?? {};
  if (['Write', 'write', 'Edit', 'edit'].includes(call.name)) {
    const path = input.file_path ?? input.path ?? input.filePath;
    return path === artifact || path?.endsWith('/' + artifact);
  }
  if (call.name === 'file_change') return input.changes?.some(change => change.path === artifact || change.path.endsWith('/' + artifact));
  if (call.name === 'apply_patch') return String(input.patchText ?? input.patch ?? '').includes(artifact);
  if (['Bash', 'bash', 'command_execution'].includes(call.name)) {
    const command = input.command ?? '';
    return command.includes(artifact) && /(>|writeFile|write_text|writeFileSync|apply_patch|tee\b)/.test(command);
  }
  return false;
}
