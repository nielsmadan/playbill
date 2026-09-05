import type { PipelineNode, ValidatedPipeline } from './types.js';
import { fail } from './diagnostics.js';
import { LIMITS } from './schema.js';

const rendered = new WeakMap<ValidatedPipeline, string>();

function joinWords(items: string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function sentence(value: string): string {
  return /[.!?]$/u.test(value) ? value : `${value}.`;
}

export function prepareRendering(validated: ValidatedPipeline): void {
  const { pipeline, skills } = validated;
  const paths = new Map(
    pipeline.artifacts.map((artifact) => [artifact.id, artifact.path]),
  );
  const descriptions = new Map(
    pipeline.artifacts.map((artifact) => [
      artifact.id,
      artifact.kind === 'collection'
        ? `\`${artifact.path}\` (a JSON array of task descriptions)`
        : `\`${artifact.path}\``,
    ]),
  );
  const lines: string[] = [];
  let bytes = 0;
  function append(...values: string[]): void {
    for (const value of values) {
      bytes += Buffer.byteLength(value, 'utf8') + 1;
      if (bytes > LIMITS.renderedBytes)
        fail(
          'LIMIT',
          'pipeline',
          `Rendered instructions exceed ${LIMITS.renderedBytes} bytes; shorten text or artifact references.`,
        );
      lines.push(value);
    }
  }
  append(
    pipeline.title,
    '',
    pipeline.introduction ??
      'Use the following steps in order. Each step invokes its named skill through the harness skill registry.',
    '',
  );
  function render(nodes: PipelineNode[], prefix = '', depth = 0): void {
    for (const [i, node] of nodes.entries()) {
      const number = `${prefix}${i + 1}`;
      const indent = '  '.repeat(depth);
      const start = `${indent}${number}. `;
      switch (node.type) {
        case 'step': {
          const clauses = [
            `${node.title} — invoke \`${skills.get(node.skill.slice(2, -2))!.id}\``,
          ];
          if (
            node.agent.fresh ||
            node.agent.read_only ||
            node.agent.model !== 'balanced' ||
            Object.keys(node.requires).length
          ) {
            clauses.push(
              `use ${node.agent.fresh ? 'a fresh agent' : 'the current context'}, ${node.agent.read_only ? 'read-only access (read files and run non-mutating checks; return artifacts for the coordinator to persist)' : 'read/write access'}, ${node.agent.model} model tier`,
            );
          }
          if (node.consumes.length)
            clauses.push(
              `consume ${joinWords(node.consumes.map((id) => descriptions.get(id)!))}`,
            );
          if (node.produces.length)
            clauses.push(
              `produce ${joinWords(node.produces.map((id) => descriptions.get(id)!))}`,
            );
          if (node.instruction) clauses.push(node.instruction);
          append(start + sentence(clauses.join('; ')));
          break;
        }
        case 'if':
          append(`${start}If ${node.condition}:`);
          render(node.then, `${number}.`, depth + 1);
          if (node.else) {
            append(`${indent}  Otherwise:`);
            render(node.else, `${number}.else.`, depth + 1);
          }
          break;
        case 'switch':
          append(`${start}Decide ${node.select}; use the first matching case:`);
          for (const [j, branch] of node.cases.entries()) {
            append(`${indent}  Case ${j + 1}: ${branch.when}:`);
            render(branch.steps, `${number}.${j + 1}.`, depth + 2);
          }
          if (node.default) {
            append(`${indent}  Otherwise:`);
            render(node.default, `${number}.default.`, depth + 2);
          } else
            append(
              `${indent}  If no case matches, continue after this switch.`,
            );
          break;
        case 'while':
          append(
            `${start}While ${node.condition}, repeat at most ${node.max_iterations} times (check before each iteration; continue afterward):`,
          );
          render(node.steps, `${number}.`, depth + 1);
          break;
        case 'for_each':
          append(
            `${start}For each ${node.as} in \`${paths.get(node.collection)}\` (a JSON array of task descriptions), in file order, run the following steps. Empty arrays skip this loop; stop and report if more than ${node.max_items} items are present:`,
          );
          render(node.steps, `${number}.`, depth + 1);
          break;
      }
    }
  }
  render(pipeline.steps);
  rendered.set(validated, `${lines.join('\n')}\n`);
}

export function renderPipeline(validated: ValidatedPipeline): string {
  const output = rendered.get(validated);
  if (output === undefined)
    fail(
      'VALIDATION_REQUIRED',
      'pipeline',
      'Pass the result of validatePipeline to renderPipeline.',
    );
  return output;
}
