import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stringify } from 'yaml';
import {
  LIMITS,
  mergeConfig,
  parseConfig,
  parsePipeline,
  validateConfig,
} from '../dist/index.js';
import { coding, flow, hasDiagnostic, step, validate } from './helpers.mjs';

test('project config overrides fields and replaces arrays while retaining other defaults', () => {
  const machine = parseConfig(`version = 1
[slots]
implement = "machine:implement"
review = "machine:review"
[workflows.coding]
entry = "auto"
priority = 5
[workflows.coding.triggers]
keywords = ["build", "implement"]
file_patterns = ["src/**"]
repo_conditions = ["git"]
`);
  const project = parseConfig(`[slots]
implement = "user/custom@v2"
[workflows.coding]
entry = "explicit"
[workflows.coding.triggers]
keywords = ["repair"]
file_patterns = []
`);
  assert.deepEqual(mergeConfig(machine, project), {
    version: 1,
    slots: { implement: 'user/custom@v2', review: 'machine:review' },
    workflows: {
      coding: {
        entry: 'explicit',
        priority: 5,
        triggers: {
          keywords: ['repair'],
          file_patterns: [],
          repo_conditions: ['git'],
        },
      },
    },
  });
  assert.deepEqual(mergeConfig(machine, {}).workflows, machine.workflows);
});

test('empty config has documented defaults and every entry policy is accepted', () => {
  assert.deepEqual(parseConfig(''), { version: 1, slots: {}, workflows: {} });
  for (const entry of ['auto', 'explicit', 'disabled'])
    assert.equal(
      parseConfig(`[workflows.review]\nentry = "${entry}"`).workflows.review
        .entry,
      entry,
    );
});

test('file patterns accept only the portable glob vocabulary', () => {
  const valid = ['src/**', '**/*.ts', 'test?.mjs', '*'];
  assert.deepEqual(
    validateConfig({
      workflows: { coding: { triggers: { file_patterns: valid } } },
    }).workflows.coding.triggers.file_patterns,
    valid,
  );
  for (const pattern of [
    '../src/*',
    '/src/*',
    '[ab].ts',
    'src/**foo',
    '!ignored/**',
    'src/{a,b}.ts',
    '@(foo)',
  ]) {
    assert.throws(
      () =>
        validateConfig({
          workflows: { coding: { triggers: { file_patterns: [pattern] } } },
        }),
      hasDiagnostic('VALUE'),
    );
  }
});

test('plain API inputs reject sparse arrays and symbol keys', () => {
  assert.throws(
    () =>
      validateConfig({
        workflows: { coding: { triggers: { keywords: new Array(2) } } },
      }),
    hasDiagnostic('TYPE'),
  );
  assert.throws(
    () => validateConfig({ [Symbol('hidden')]: true }),
    hasDiagnostic('TYPE'),
  );
});

test('malformed TOML and duplicate declarations fail with parser diagnostics', () => {
  for (const source of ['[slots', 'version = 1\nversion = 1'])
    assert.throws(
      () => parseConfig(source, 'broken.toml'),
      hasDiagnostic('TOML_PARSE', 'broken.toml'),
    );
});

test('config rejects unknown fields, invalid values, nonfinite numbers and dates', () => {
  for (const source of [
    'typo = true',
    'version = 2',
    '[slots]\nreview = true',
    '[workflows.review]\nentry = "always"',
    '[workflows.review]\npriority = nan',
    '[workflows.review]\npriority = 2026-09-05',
    '[workflows.review.triggers]\nrepo_conditions = ["magic"]',
    '[workflows.review.triggers]\nrepo_conditions = ["clean", "dirty"]',
    '[workflows.review.triggers]\nkeywords = ["review", "review"]',
    '[workflows.review]\npriority = 1001',
  ])
    assert.throws(() => parseConfig(source), { name: 'PlaybillError' });
  for (const object of [
    { version: null },
    { slots: null },
    { workflows: null },
  ])
    assert.throws(() => validateConfig(object), { name: 'PlaybillError' });
});

test('a merged config is checked for contradictions across layers', () => {
  assert.throws(
    () =>
      mergeConfig(
        {},
        {
          workflows: {
            review: { triggers: { repo_conditions: ['clean', 'dirty'] } },
          },
        },
      ),
    hasDiagnostic('VALUE'),
  );
});

test('YAML rejects duplicate keys, aliases, cycles, merges, explicit tags, multiple documents and complex keys', () => {
  for (const source of [
    'id: one\nid: two',
    'id: &a [*a]',
    'id: &a x\ntitle: *a',
    'x: &a {id: one}\n<<: *a',
    'id: !!str one',
    'id: !custom one',
    '---\nid: one\n---\nid: two',
    '? [one, two]\n: value',
    'id: .nan',
    'id: .inf',
    '%YAML 1.1\n---\nid: one',
    '__proto__: {polluted: true}',
  ])
    assert.throws(() => parsePipeline(source), { name: 'PlaybillError' });
});

test('API rejects cyclic/aliased objects, custom objects, accessors and nonfinite values', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const shared = {};
  for (const value of [
    cyclic,
    { a: shared, b: shared },
    new Date(),
    { a: Infinity },
    {
      get slots() {
        throw new Error('must never run');
      },
    },
  ]) {
    assert.throws(() => validateConfig(value), { name: 'PlaybillError' });
  }
});

test('step, artifact and switch case declarations must be unique', () => {
  const duplicateArtifact = flow([step('one', [], ['report'])]);
  duplicateArtifact.artifacts.push({ id: 'report', path: 'other.md' });
  assert.throws(
    () => validate(duplicateArtifact),
    hasDiagnostic('DUPLICATE_ARTIFACT'),
  );
  const duplicatePath = flow([step('one', [], ['report'])]);
  duplicatePath.artifacts.push({ id: 'another', path: 'review.md' });
  assert.throws(
    () => validate(duplicatePath),
    hasDiagnostic('DUPLICATE_ARTIFACT'),
  );
  assert.throws(
    () => validate(flow([step('same'), step('same')])),
    hasDiagnostic('DUPLICATE_STEP'),
  );
  assert.throws(
    () =>
      validate(
        flow([
          {
            type: 'switch',
            select: 'mode',
            cases: [
              { when: 'one', steps: [step('a')] },
              { when: 'one', steps: [step('b')] },
            ],
          },
        ]),
      ),
    hasDiagnostic('DUPLICATE'),
  );
});

test('raw skill paths and malformed slot interpolation fail', () => {
  for (const skill of [
    'pb-implement',
    './skill/SKILL.md',
    '{{missing',
    'prefix {{implement}}',
    '{{ implement }}',
  ]) {
    const pipeline = coding();
    pipeline.steps[0].skill = skill;
    assert.throws(() => validate(pipeline), hasDiagnostic('SLOT_REFERENCE'));
  }
});

test('closed schemas reject unsupported nodes, fields, invalid agent properties and nonrelative artifact paths', () => {
  for (const node of [
    { ...step('one'), script: 'throw Error()' },
    { type: 'parallel', steps: [step('one')] },
    { ...step('one'), requires: { sandbox: true } },
    { ...step('one'), agent: { fresh: 'yes' } },
    { ...step('one'), requires: { model: 'expensive' } },
    { type: 'switch', select: 'mode', cases: [] },
  ])
    assert.throws(() => validate(flow([node])), { name: 'PlaybillError' });
  for (const path of [
    '/tmp/task.md',
    '../task.md',
    'a/../task.md',
    './task.md',
    'a\\task.md',
    'a//task.md',
    '{{item}}.md',
  ]) {
    const pipeline = coding();
    pipeline.artifacts[0].path = path;
    assert.throws(() => validate(pipeline), hasDiagnostic('VALUE'));
  }
});

test('loops require a finite positive integer cap within the supported bound', () => {
  for (const cap of [undefined, 0, -1, 1.5, Infinity, 101, '3']) {
    for (const node of [
      {
        type: 'while',
        condition: 'work remains',
        ...(cap === undefined ? {} : { max_iterations: cap }),
        steps: [step('one')],
      },
      {
        type: 'for_each',
        collection: 'tasks',
        as: 'task',
        ...(cap === undefined ? {} : { max_items: cap }),
        steps: [step('one')],
      },
    ])
      assert.throws(() => validate(flow([node])), { name: 'PlaybillError' });
  }
});

test('limits bound source size, data depth, node count and expanded work', () => {
  assert.throws(
    () => parseConfig('#'.repeat(LIMITS.sourceBytes + 1)),
    hasDiagnostic('LIMIT'),
  );
  assert.throws(
    () => parsePipeline('x: ' + '['.repeat(300) + '0' + ']'.repeat(300)),
    { name: 'PlaybillError' },
  );
  assert.throws(
    () =>
      validate(
        flow(
          Array.from({ length: LIMITS.flowNodes + 1 }, (_, i) => step(`s${i}`)),
        ),
      ),
    hasDiagnostic('LIMIT'),
  );
  let nested = step('one');
  for (let i = 0; i < LIMITS.flowDepth + 1; i++)
    nested = { type: 'if', condition: 'ready', then: [nested] };
  assert.throws(() => validate(flow([nested])), hasDiagnostic('LIMIT'));
  assert.throws(
    () =>
      validate(
        flow([
          {
            type: 'while',
            condition: 'work remains',
            max_iterations: 100,
            steps: [
              {
                type: 'while',
                condition: 'work remains',
                max_iterations: 100,
                steps: [step('one'), step('two')],
              },
            ],
          },
        ]),
      ),
    hasDiagnostic('LIMIT'),
  );
});

test('conditions remain declarative text and are never evaluated', () => {
  const condition = 'globalThis.__playbillConditionWasRun = true';
  const parsed = parsePipeline(
    stringify(
      flow([{ type: 'if', condition, then: [step('one')] }], { outputs: [] }),
    ),
  );
  assert.equal(parsed.steps[0].condition, condition);
  assert.equal(validate(parsed).pipeline.steps[0].condition, condition);
});
