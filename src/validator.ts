import { validateConfig } from './config.js';
import { PlaybillError } from './diagnostics.js';
import { pipelineData } from './pipeline.js';
import { validateRegistry } from './registry.js';
import { prepareRendering } from './renderer.js';
import { LIMITS } from './schema.js';
import type {
  AgentRequirements,
  Diagnostic,
  InstalledSkill,
  PipelineNode,
  Step,
  ValidatedPipeline,
} from './types.js';

const tier = { fast: 0, balanced: 1, capable: 2 };

export function validatePipeline(
  pipelineInput: unknown,
  configInput: unknown,
  registryInput: unknown,
): ValidatedPipeline {
  const pipeline = pipelineData(pipelineInput);
  const config = validateConfig(configInput);
  const registry = new Map(
    validateRegistry(registryInput).map((skill) => [skill.id, skill]),
  );
  const diagnostics: Diagnostic[] = [];
  const report = (code: string, path: string, message: string) =>
    diagnostics.push({ code, path, message });
  const artifacts = new Map(
    pipeline.artifacts.map((artifact) => [artifact.id, artifact]),
  );
  const resolved = new Map<string, InstalledSkill>();
  for (const [slot, id] of Object.entries(config.slots).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const skill = registry.get(id);
    if (!skill)
      report(
        'UNINSTALLED_SKILL',
        `config.slots.${slot}`,
        `Skill '${id}' is not installed; provide its registry entry or skill root.`,
      );
    else if (!skill.model_invocable)
      report(
        'SKILL_INVOCATION',
        `config.slots.${slot}`,
        `Skill '${id}' is marked unavailable for model invocation.`,
      );
    else resolved.set(slot, skill);
  }
  function reference(id: string, path: string): boolean {
    if (artifacts.has(id)) return true;
    report(
      'UNKNOWN_ARTIFACT',
      path,
      `Artifact '${id}' is undeclared; add it to artifacts.`,
    );
    return false;
  }
  function available(ids: string[], state: Set<string>, path: string): void {
    for (const id of ids)
      if (reference(id, path) && !state.has(id))
        report(
          'UNSATISFIED_ARTIFACT',
          path,
          `Artifact '${id}' is not available on every path; declare it as an input or produce it on every preceding branch.`,
        );
  }
  function contract(
    step: Step,
    required: AgentRequirements,
    path: string,
  ): void {
    for (const property of ['fresh', 'read_only'] as const) {
      if (
        required[property] !== undefined &&
        required[property] !== step.agent[property]
      )
        report(
          'AGENT_CONTRACT',
          `${path}.${property}`,
          `Step '${step.id}' requires ${property}=${required[property]}, but its agent provides ${step.agent[property]}.`,
        );
    }
    if (
      required.model !== undefined &&
      tier[step.agent.model] < tier[required.model]
    )
      report(
        'AGENT_CONTRACT',
        `${path}.model`,
        `Step '${step.id}' requires at least '${required.model}', but its agent provides '${step.agent.model}'.`,
      );
  }
  function intersection(states: Set<string>[]): Set<string> {
    return new Set(
      [...states[0]!].filter((id) => states.every((state) => state.has(id))),
    );
  }
  function flow(
    nodes: PipelineNode[],
    incoming: Set<string>,
    path: string,
  ): { state: Set<string>; cost: number } {
    let state = new Set(incoming);
    let cost = 0;
    for (const [i, node] of nodes.entries()) {
      const at = `${path}[${i}]`;
      switch (node.type) {
        case 'step': {
          const slot = node.skill.slice(2, -2);
          if (!Object.hasOwn(config.slots, slot))
            report(
              'UNKNOWN_SLOT',
              `${at}.skill`,
              `Slot '${slot}' is unbound; add [slots] ${slot} = "installed-skill-id" to config.`,
            );
          available(node.consumes, state, `${at}.consumes`);
          contract(node, node.requires, `${at}.requires`);
          const skill = resolved.get(slot);
          if (skill) contract(node, skill.requires, `${at}.skill.requires`);
          for (const id of node.produces)
            if (reference(id, `${at}.produces`)) state.add(id);
          cost += 1;
          break;
        }
        case 'if': {
          const yes = flow(node.then, state, `${at}.then`);
          const no = flow(node.else ?? [], state, `${at}.else`);
          state = intersection([yes.state, no.state]);
          cost += Math.max(yes.cost, no.cost);
          break;
        }
        case 'switch': {
          const branches = node.cases.map((branch, j) =>
            flow(branch.steps, state, `${at}.cases[${j}].steps`),
          );
          branches.push(flow(node.default ?? [], state, `${at}.default`));
          state = intersection(branches.map((branch) => branch.state));
          cost += Math.max(...branches.map((branch) => branch.cost));
          break;
        }
        case 'while': {
          const body = flow(node.steps, state, `${at}.steps`);
          cost += node.max_iterations * Math.max(1, body.cost);
          break;
        }
        case 'for_each': {
          available([node.collection], state, `${at}.collection`);
          if (
            artifacts.has(node.collection) &&
            artifacts.get(node.collection)!.kind !== 'collection'
          )
            report(
              'COLLECTION_CONTRACT',
              `${at}.collection`,
              `Artifact '${node.collection}' must have kind: collection (a JSON array of task descriptions).`,
            );
          const body = flow(node.steps, state, `${at}.steps`);
          cost += node.max_items * Math.max(1, body.cost);
          break;
        }
      }
    }
    return { state, cost };
  }
  for (const id of pipeline.inputs) reference(id, 'pipeline.inputs');
  const result = flow(
    pipeline.steps,
    new Set(pipeline.inputs),
    'pipeline.steps',
  );
  available(pipeline.outputs, result.state, 'pipeline.outputs');
  if (result.cost > LIMITS.expandedSteps)
    report(
      'LIMIT',
      'pipeline.steps',
      `Worst-case execution exceeds ${LIMITS.expandedSteps} step/loop visits; reduce loop caps or nesting.`,
    );
  if (diagnostics.length) throw new PlaybillError(diagnostics);
  const validated = { pipeline, skills: resolved };
  prepareRendering(validated);
  return validated;
}
