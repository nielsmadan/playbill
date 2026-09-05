import { fail } from './diagnostics.js';
import { parseYamlData } from './parsing.js';
import {
  agentProperties,
  choice,
  identifier,
  integer,
  LIMITS,
  list,
  record,
  relativePath,
  requirements,
  safeData,
  strings,
  text,
  version,
} from './schema.js';
import type { Artifact, Pipeline, PipelineNode, Step } from './types.js';

export function parsePipeline(
  source: string,
  path = 'pipeline.yaml',
): Pipeline {
  return pipelineData(parseYamlData(source, path), path);
}

export function pipelineData(value: unknown, path = 'pipeline'): Pipeline {
  safeData(value, path);
  const data = record(value, path, [
    'version',
    'id',
    'title',
    'introduction',
    'artifacts',
    'inputs',
    'outputs',
    'steps',
  ]);
  const artifactIds = new Set<string>();
  const artifactPaths = new Set<string>();
  const artifacts = list(data.artifacts, `${path}.artifacts`).map(
    (value, i): Artifact => {
      const at = `${path}.artifacts[${i}]`;
      const artifact = record(value, at, ['id', 'path', 'kind']);
      const id = identifier(artifact.id, `${at}.id`);
      if (artifactIds.has(id))
        fail(
          'DUPLICATE_ARTIFACT',
          `${at}.id`,
          `Artifact '${id}' is already declared.`,
        );
      artifactIds.add(id);
      const artifactPath = relativePath(artifact.path, `${at}.path`);
      if (artifactPaths.has(artifactPath))
        fail(
          'DUPLICATE_ARTIFACT',
          `${at}.path`,
          `Path '${artifactPath}' already belongs to another artifact.`,
        );
      artifactPaths.add(artifactPath);
      return {
        id,
        path: artifactPath,
        kind:
          artifact.kind === undefined
            ? 'file'
            : choice(artifact.kind, `${at}.kind`, ['file', 'collection']),
      };
    },
  );
  let count = 0;
  const stepIds = new Set<string>();
  function nodes(value: unknown, at: string, depth: number): PipelineNode[] {
    if (depth > LIMITS.flowDepth)
      fail('LIMIT', at, `Control flow exceeds ${LIMITS.flowDepth} levels.`);
    return list(value, at).map((value, i): PipelineNode => {
      const here = `${at}[${i}]`;
      if (++count > LIMITS.flowNodes)
        fail(
          'LIMIT',
          here,
          `Pipeline exceeds ${LIMITS.flowNodes} control-flow nodes.`,
        );
      const node = record(value, here);
      const type = choice(node.type, `${here}.type`, [
        'step',
        'if',
        'switch',
        'while',
        'for_each',
      ]);
      switch (type) {
        case 'step': {
          record(node, here, [
            'type',
            'id',
            'title',
            'skill',
            'consumes',
            'produces',
            'requires',
            'agent',
            'instruction',
          ]);
          const id = identifier(node.id, `${here}.id`);
          if (stepIds.has(id))
            fail(
              'DUPLICATE_STEP',
              `${here}.id`,
              `Step '${id}' is already declared; use a distinct ID in every branch.`,
            );
          stepIds.add(id);
          const skill = text(node.skill, `${here}.skill`);
          if (!/^\{\{[a-zA-Z][a-zA-Z0-9_-]{0,79}\}\}$/u.test(skill))
            fail(
              'SLOT_REFERENCE',
              `${here}.skill`,
              'Expected exactly {{slot_name}}; skill IDs and paths belong in config bindings.',
            );
          const result: Step = {
            type,
            id,
            title: text(node.title, `${here}.title`),
            skill,
            consumes: strings(
              node.consumes === undefined ? [] : node.consumes,
              `${here}.consumes`,
            ),
            produces: strings(
              node.produces === undefined ? [] : node.produces,
              `${here}.produces`,
            ),
            requires: requirements(
              node.requires === undefined ? {} : node.requires,
              `${here}.requires`,
            ),
            agent: agentProperties(
              node.agent === undefined ? {} : node.agent,
              `${here}.agent`,
            ),
          };
          if (node.instruction !== undefined)
            result.instruction = text(node.instruction, `${here}.instruction`);
          return result;
        }
        case 'if': {
          record(node, here, ['type', 'condition', 'then', 'else']);
          return {
            type,
            condition: text(node.condition, `${here}.condition`),
            then: nodes(node.then, `${here}.then`, depth + 1),
            ...(node.else === undefined
              ? {}
              : { else: nodes(node.else, `${here}.else`, depth + 1) }),
          };
        }
        case 'switch': {
          record(node, here, ['type', 'select', 'cases', 'default']);
          const cases = list(node.cases, `${here}.cases`).map((value, j) => {
            const atCase = `${here}.cases[${j}]`;
            const branch = record(value, atCase, ['when', 'steps']);
            return {
              when: text(branch.when, `${atCase}.when`),
              steps: nodes(branch.steps, `${atCase}.steps`, depth + 1),
            };
          });
          if (!cases.length)
            fail(
              'VALUE',
              `${here}.cases`,
              'Switch must declare at least one case.',
            );
          if (new Set(cases.map((branch) => branch.when)).size !== cases.length)
            fail('DUPLICATE', `${here}.cases`, 'Switch labels must be unique.');
          return {
            type,
            select: text(node.select, `${here}.select`),
            cases,
            ...(node.default === undefined
              ? {}
              : { default: nodes(node.default, `${here}.default`, depth + 1) }),
          };
        }
        case 'while': {
          record(node, here, ['type', 'condition', 'max_iterations', 'steps']);
          if (node.max_iterations === undefined)
            fail(
              'LOOP_CAP',
              `${here}.max_iterations`,
              'While loops require max_iterations.',
            );
          return {
            type,
            condition: text(node.condition, `${here}.condition`),
            max_iterations: integer(
              node.max_iterations,
              `${here}.max_iterations`,
              1,
              LIMITS.loopIterations,
            ),
            steps: nodes(node.steps, `${here}.steps`, depth + 1),
          };
        }
        case 'for_each': {
          record(node, here, [
            'type',
            'collection',
            'as',
            'max_items',
            'steps',
          ]);
          if (node.max_items === undefined)
            fail(
              'LOOP_CAP',
              `${here}.max_items`,
              'Collection loops require max_items.',
            );
          return {
            type,
            collection: identifier(node.collection, `${here}.collection`),
            as: identifier(node.as, `${here}.as`),
            max_items: integer(
              node.max_items,
              `${here}.max_items`,
              1,
              LIMITS.loopIterations,
            ),
            steps: nodes(node.steps, `${here}.steps`, depth + 1),
          };
        }
      }
    });
  }
  const steps = nodes(data.steps, `${path}.steps`, 1);
  if (!steps.length || !stepIds.size)
    fail(
      'VALUE',
      `${path}.steps`,
      'A pipeline must contain at least one step.',
    );
  return {
    version: version(data.version, `${path}.version`),
    id: identifier(data.id, `${path}.id`),
    title: text(data.title, `${path}.title`),
    ...(data.introduction === undefined
      ? {}
      : { introduction: text(data.introduction, `${path}.introduction`) }),
    artifacts,
    inputs: strings(
      data.inputs === undefined ? [] : data.inputs,
      `${path}.inputs`,
    ),
    outputs: strings(
      data.outputs === undefined ? [] : data.outputs,
      `${path}.outputs`,
    ),
    steps,
  };
}
