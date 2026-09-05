import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compilePipeline,
  renderPipeline,
  validatePipeline,
} from '../dist/index.js';
import {
  coding,
  config,
  fixture,
  flow,
  hasDiagnostic,
  registry,
  step,
  validate,
} from './helpers.mjs';

test('four-step YAML and bindings reproduce the M0-equivalent prose golden', () => {
  assert.equal(
    compilePipeline(coding(), config(), registry()),
    fixture('coding.golden.md'),
  );
});

for (const [paths, contract] of [
  [['a.md and b.md'], '`a.md and b.md`'],
  [['a.md', 'b.md'], '`a.md` and `b.md`'],
])
  test(`rendered contracts preserve ${paths.length} declared artifact paths`, () => {
    const artifacts = paths.map((path, i) => ({ id: `file${i}`, path }));
    const ids = artifacts.map((artifact) => artifact.id);
    const output = renderPipeline(
      validate(
        flow([step('update', [...ids], [...ids])], {
          introduction: 'Use these artifacts.',
          artifacts,
          inputs: ids,
          outputs: [...ids],
        }),
      ),
    );
    assert.equal(
      output,
      `Flow\n\nUse these artifacts.\n\n1. update — invoke \`pb-implement\`; consume ${contract}; produce ${contract}.\n`,
    );
  });

test('collection paths use code spans in step contracts and loops', () => {
  const output = renderPipeline(
    validate(
      flow(
        [
          step('update', ['tasks'], ['tasks']),
          {
            type: 'for_each',
            collection: 'tasks',
            as: 'task',
            max_items: 8,
            steps: [],
          },
        ],
        {
          introduction: 'Use these artifacts.',
          artifacts: [
            {
              id: 'tasks',
              path: 'tasks and reviews.json',
              kind: 'collection',
            },
          ],
          inputs: ['tasks'],
          outputs: ['tasks'],
        },
      ),
    ),
  );
  assert.equal(
    output,
    'Flow\n\nUse these artifacts.\n\n' +
      '1. update — invoke `pb-implement`; consume `tasks and reviews.json` (a JSON array of task descriptions); produce `tasks and reviews.json` (a JSON array of task descriptions).\n' +
      '2. For each task in `tasks and reviews.json` (a JSON array of task descriptions), in file order, run the following steps. Empty arrays skip this loop; stop and report if more than 8 items are present:\n',
  );
});

test('rendering uses the exact validated snapshot and rejects an unvalidated lookalike', () => {
  const validated = validate(coding());
  validated.pipeline.title = 'Changed after validation';
  assert.equal(renderPipeline(validated), fixture('coding.golden.md'));
  assert.throws(
    () => renderPipeline({ pipeline: coding(), skills: new Map() }),
    hasDiagnostic('VALIDATION_REQUIRED'),
  );
});

test('validation rejects excessive rendered size caused by artifact references', () => {
  const pipeline = flow(
    Array.from({ length: 40 }, (_, i) =>
      step(`step${i}`, ['input'], ['report']),
    ),
  );
  pipeline.artifacts[0].path = 'x'.repeat(1900);
  assert.throws(() => validate(pipeline), hasDiagnostic('LIMIT', 'pipeline'));
});

test('artifacts produced by both if paths are definitely available', () => {
  const pipeline = flow([
    {
      type: 'if',
      condition: 'a draft exists',
      then: [step('yes', ['input'], ['draft'])],
      else: [step('no', ['input'], ['draft'])],
    },
    step('review', ['draft'], ['report']),
  ]);
  assert.equal(validate(pipeline).pipeline.id, 'flow');
});

for (const branch of [undefined, []])
  test(`if with ${branch === undefined ? 'missing' : 'empty'} else retains its unexecuted path`, () => {
    assert.throws(
      () =>
        validate(
          flow([
            {
              type: 'if',
              condition: 'a draft is needed',
              then: [step('yes', [], ['draft'])],
              ...(branch ? { else: branch } : {}),
            },
            step('review', ['draft'], ['report']),
          ]),
        ),
      hasDiagnostic('UNSATISFIED_ARTIFACT', 'pipeline.steps[1].consumes'),
    );
  });

test('switch intersects every case and its default', () => {
  assert.equal(
    validate(
      flow([
        {
          type: 'switch',
          select: 'the task type',
          cases: [
            { when: 'feature', steps: [step('feature', [], ['draft'])] },
            { when: 'repair', steps: [step('repair', [], ['draft'])] },
          ],
          default: [step('other', [], ['draft'])],
        },
        step('review', ['draft'], ['report']),
      ]),
    ).pipeline.id,
    'flow',
  );
});

for (const defaultBranch of [undefined, []])
  test(`switch ${defaultBranch === undefined ? 'missing' : 'empty'} default prevents a promised output`, () => {
    assert.throws(
      () =>
        validate(
          flow([
            {
              type: 'switch',
              select: 'the task type',
              cases: [
                { when: 'feature', steps: [step('feature', [], ['report'])] },
              ],
              ...(defaultBranch ? { default: defaultBranch } : {}),
            },
          ]),
        ),
      hasDiagnostic('UNSATISFIED_ARTIFACT', 'pipeline.outputs'),
    );
  });

test('one switch case cannot consume another case output', () => {
  assert.throws(
    () =>
      validate(
        flow(
          [
            {
              type: 'switch',
              select: 'the mode',
              cases: [
                { when: 'one', steps: [step('one', [], ['draft'])] },
                { when: 'two', steps: [step('two', ['draft'], ['report'])] },
              ],
              default: [],
            },
          ],
          { outputs: [] },
        ),
      ),
    hasDiagnostic(
      'UNSATISFIED_ARTIFACT',
      'pipeline.steps[0].cases[1].steps[0].consumes',
    ),
  );
});

test('nested if inside switch checks every path', () => {
  assert.throws(
    () =>
      validate(
        flow([
          {
            type: 'switch',
            select: 'the mode',
            cases: [
              {
                when: 'one',
                steps: [
                  {
                    type: 'if',
                    condition: 'ready',
                    then: [step('one', [], ['report'])],
                  },
                ],
              },
            ],
            default: [step('other', [], ['report'])],
          },
        ]),
      ),
    hasDiagnostic('UNSATISFIED_ARTIFACT', 'pipeline.outputs'),
  );
});

for (const type of ['while', 'for_each']) {
  const loop = (steps) =>
    type === 'while'
      ? { type, condition: 'findings remain', max_iterations: 3, steps }
      : { type, collection: 'tasks', as: 'task', max_items: 10, steps };
  test(`${type} may execute zero times and cannot establish a later artifact`, () => {
    assert.throws(
      () =>
        validate(
          flow([
            loop([step('draft', [], ['draft'])]),
            step('review', ['draft'], ['report']),
          ]),
        ),
      hasDiagnostic('UNSATISFIED_ARTIFACT', 'pipeline.steps[1].consumes'),
    );
  });
  test(`${type} cannot promise its newly produced output`, () => {
    assert.throws(
      () => validate(flow([loop([step('review', [], ['report'])])])),
      hasDiagnostic('UNSATISFIED_ARTIFACT', 'pipeline.outputs'),
    );
  });
  test(`${type} carries incoming artifacts and validates intra-iteration dependencies`, () => {
    assert.equal(
      validate(
        flow([
          step('initial', ['input'], ['report']),
          loop([
            step('draft', ['report'], ['draft']),
            step('review', ['draft'], ['report']),
          ]),
        ]),
      ).pipeline.id,
      'flow',
    );
  });
  test(`${type} rejects a dependency available only after the first iteration`, () => {
    assert.throws(
      () =>
        validate(
          flow([
            loop([
              step('review', ['draft'], ['report']),
              step('draft', [], ['draft']),
            ]),
          ]),
        ),
      hasDiagnostic(
        'UNSATISFIED_ARTIFACT',
        'pipeline.steps[0].steps[0].consumes',
      ),
    );
  });
}

test('collection loops require an available declared collection artifact', () => {
  const loop = {
    type: 'for_each',
    collection: 'draft',
    as: 'task',
    max_items: 5,
    steps: [step('review', [], ['report'])],
  };
  assert.throws(
    () => validate(flow([loop])),
    hasDiagnostic('UNSATISFIED_ARTIFACT', 'pipeline.steps[0].collection'),
  );
  assert.throws(
    () => validate(flow([loop], { inputs: ['draft'], outputs: [] })),
    hasDiagnostic('COLLECTION_CONTRACT'),
  );
});

test('unknown inputs, output declarations and consumed/produced references fail', () => {
  for (const pipeline of [
    flow([step('one', [], ['report'])], { inputs: ['typo'] }),
    flow([step('one', [], ['report'])], { outputs: ['typo'] }),
    flow([step('one', ['typo'], ['report'])]),
    flow([step('one', [], ['typo'])], { outputs: [] }),
  ])
    assert.throws(() => validate(pipeline), hasDiagnostic('UNKNOWN_ARTIFACT'));
});

test('required agent properties must be provided by the declared agent', () => {
  for (const requires of [
    { fresh: true },
    { read_only: true },
    { model: 'capable' },
  ]) {
    assert.throws(
      () => validate(flow([{ ...step('review', [], ['report']), requires }])),
      hasDiagnostic('AGENT_CONTRACT'),
    );
  }
  assert.equal(
    validate(
      flow([
        {
          ...step('review', [], ['report']),
          requires: { fresh: true, read_only: true, model: 'balanced' },
          agent: { fresh: true, read_only: true, model: 'capable' },
        },
      ]),
    ).pipeline.id,
    'flow',
  );
});

test('required false is an exact requirement and model tier is a minimum', () => {
  assert.throws(
    () =>
      validate(
        flow([
          {
            ...step('review', [], ['report']),
            requires: { fresh: false },
            agent: { fresh: true },
          },
        ]),
      ),
    hasDiagnostic('AGENT_CONTRACT'),
  );
  assert.equal(
    validate(
      flow([
        {
          ...step('review', [], ['report']),
          requires: { model: 'fast' },
          agent: { model: 'capable' },
        },
      ]),
    ).pipeline.id,
    'flow',
  );
});

test('installed skill contracts independently constrain step execution', () => {
  const skills = registry();
  skills.find((skill) => skill.id === 'pb-implement').requires = {
    read_only: true,
  };
  assert.throws(
    () =>
      validatePipeline(
        flow([step('review', [], ['report'])]),
        config(),
        skills,
      ),
    hasDiagnostic(
      'AGENT_CONTRACT',
      'pipeline.steps[0].skill.requires.read_only',
    ),
  );
});

test('structured prose renders branches, caps, item binding and reviewer execution', () => {
  const validated = validate(
    flow([
      step('initial', [], ['report']),
      {
        type: 'if',
        condition: 'changes are needed',
        then: [step('change')],
        else: [],
      },
      {
        type: 'switch',
        select: 'the review mode',
        cases: [{ when: 'deep', steps: [step('deep')] }],
        default: [step('quick')],
      },
      {
        type: 'while',
        condition: 'findings remain',
        max_iterations: 2,
        steps: [step('repair', ['report'], ['report'])],
      },
      {
        type: 'for_each',
        collection: 'tasks',
        as: 'task',
        max_items: 8,
        steps: [
          {
            ...step('task_review'),
            requires: { fresh: true, read_only: true, model: 'capable' },
            agent: { fresh: true, read_only: true, model: 'capable' },
          },
        ],
      },
    ]),
  );
  const output = renderPipeline(validated);
  assert.match(output, /2\. If changes are needed:\n {2}2\.1\. change/u);
  assert.match(
    output,
    /3\. Decide the review mode; use the first matching case:/u,
  );
  assert.match(output, /4\. While findings remain, repeat at most 2 times/u);
  assert.match(output, /5\. For each task in `tasks\.json`/u);
  assert.match(output, /stop and report if more than 8 items/u);
  assert.match(
    output,
    /fresh agent, read-only access \(read files and run non-mutating checks; return artifacts for the coordinator to persist\), capable model tier/u,
  );
});
