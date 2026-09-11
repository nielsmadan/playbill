import { fail } from './diagnostics.js';
import type { NativeSkill } from './runtime.js';
import type {
  CoordinationPolicy,
  PipelineNode,
  ValidatedPipeline,
} from './types.js';

export interface CoordinatorStep {
  id: string;
  title: string;
  skill?: string;
  instruction: string;
  consumes: string[];
  produces: string[];
  allowSourceWrites: boolean;
  condition?: { id: string; expression: string };
  next: string | null | { true: string | null; false: string | null };
}

export interface CoordinatorPlan {
  workflow: string;
  reportArtifact?: string;
  root: string;
  artifactScope: 'project' | 'run';
  introduction: string;
  conversation: { redirectThreshold: number; askOnRedirect: boolean };
  entry: string;
  steps: CoordinatorStep[];
  nativeSkills: Record<string, string>;
  nativeInvocations: Record<string, string>;
}

export function compileCoordinator(
  validated: ValidatedPipeline,
  root: string,
  inventory: NativeSkill[],
  policy: CoordinationPolicy,
): CoordinatorPlan {
  const { pipeline, skills } = validated;
  const unsupported = (path: string, detail: string): never =>
    fail(
      'COORDINATION_UNSUPPORTED',
      path,
      `${detail} Disable workflow coordination to use the rendered workflow.`,
    );
  if (pipeline.artifacts.some((artifact) => artifact.kind === 'collection'))
    unsupported(
      pipeline.id,
      'Coordinated collection artifacts are not supported.',
    );
  if (policy.artifact_scope === 'run' && pipeline.inputs.length)
    unsupported(
      pipeline.id,
      'Run-scoped coordination cannot relocate existing input artifacts.',
    );
  const artifacts = new Map(
    pipeline.artifacts.map((item) => [item.id, item.path]),
  );
  const steps: CoordinatorStep[] = [];
  const nativeSkills: Record<string, string> = {};
  const nativeInvocations: Record<string, string> = {};
  let serial = 0;
  function sequence(
    nodes: PipelineNode[],
    next: string | null,
    path: string,
  ): string | null {
    let entry = next;
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index]!;
      const at = `${path}_${index}`;
      if (node.type === 'step') {
        if (node.agent.fresh)
          unsupported(
            at,
            'A fresh agent contract cannot be enforced by the native in-session coordinator.',
          );
        const skill = skills.get(node.skill.slice(2, -2))!;
        const native = inventory.find((item) => item.id === skill.id)!;
        nativeSkills[skill.id] = skill.path;
        nativeInvocations[skill.id] = native.invocation;
        const id = `s${++serial}_${node.id}`;
        steps.push({
          id,
          title: node.title,
          skill: skill.id,
          instruction: [
            node.instruction ?? node.title,
            `Agent contract: fresh=${node.agent.fresh}, read_only=${node.agent.read_only}, model=${node.agent.model}. Use the current user request as the task; apply this technique within its authorization. Report unavailable agent capabilities before acting.`,
          ].join('\n'),
          consumes: node.consumes.map((item) => artifacts.get(item)!),
          produces: node.produces.map((item) => artifacts.get(item)!),
          allowSourceWrites: !node.agent.read_only,
          next: entry,
        });
        entry = id;
      } else if (node.type === 'if') {
        const yes = sequence(node.then, entry, `${at}_then`);
        const no = sequence(node.else ?? [], entry, `${at}_else`);
        const id = `d${++serial}`;
        steps.push({
          id,
          title: 'Evaluate condition',
          condition: { id: at, expression: node.condition },
          instruction:
            'Choose the branch from the current task and retained evidence.',
          consumes: [],
          produces: [],
          allowSourceWrites: false,
          next: { true: yes, false: no },
        });
        entry = id;
      } else if (node.type === 'while') {
        const after = entry;
        for (let iteration = node.max_iterations; iteration >= 1; iteration--) {
          const body = sequence(node.steps, entry, `${at}_body`);
          const id = `d${++serial}`;
          steps.push({
            id,
            title: 'Evaluate loop condition',
            condition: { id: at, expression: node.condition },
            instruction: `Before iteration ${iteration} of at most ${node.max_iterations}, evaluate the condition. False exits immediately; the final allowed body exits at the cap.`,
            consumes: [],
            produces: [],
            allowSourceWrites: false,
            next: { true: body, false: after },
          });
          entry = id;
        }
      } else
        unsupported(
          at,
          `Coordinated ${node.type} control flow is not supported.`,
        );
      if (steps.length > 100)
        unsupported(pipeline.id, 'The lowered graph exceeds 100 nodes.');
    }
    return entry;
  }
  const entry = sequence(pipeline.steps, null, 'condition');
  if (!entry)
    return unsupported(pipeline.id, 'The coordinated workflow has no visits.');
  const reportArtifact = policy.report_artifact
    ? artifacts.get(policy.report_artifact)
    : undefined;
  if (policy.report_artifact) {
    const owners = steps.filter((step) =>
      step.produces.includes(reportArtifact ?? ''),
    );
    if (
      !reportArtifact ||
      owners.length !== 1 ||
      owners[0]!.next !== null ||
      steps.some((step) => step.consumes.includes(reportArtifact))
    )
      unsupported(
        pipeline.id,
        'coordination.report_artifact must name a declared artifact with exactly one terminal producer and no consumers.',
      );
  }
  return {
    ...(reportArtifact ? { reportArtifact } : {}),
    conversation: {
      redirectThreshold: policy.redirect_threshold ?? 2,
      askOnRedirect: policy.ask_on_redirect ?? true,
    },
    workflow: pipeline.id,
    root,
    artifactScope: policy.artifact_scope ?? 'project',
    introduction: pipeline.introduction ?? '',
    entry,
    steps,
    nativeSkills,
    nativeInvocations,
  };
}
