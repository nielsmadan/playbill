import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import {
  discoverSkills,
  parseRegistry,
  validatePipeline,
  validateRegistry,
} from '../dist/index.js';
import {
  coding,
  config,
  fixtureDir,
  hasDiagnostic,
  registry,
} from './helpers.mjs';

const dir = mkdtempSync(join(process.cwd(), '.test-runs-registry-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('filesystem discovery uses frontmatter names even when directory names differ', () => {
  assert.deepEqual(
    discoverSkills(join(fixtureDir, 'skills'))
      .map((skill) => skill.id)
      .sort(),
    ['pb-final-review', 'pb-fix', 'pb-implement', 'pb-task-review'],
  );
});

test('explicit registry accepts a custom canonical ID and relative installation path', () => {
  const skills = parseRegistry(
    JSON.stringify({
      version: 1,
      skills: [{ id: 'my-company:review@v2', path: 'skills/review/SKILL.md' }],
    }),
    fixtureDir,
  );
  assert.equal(skills[0].id, 'my-company:review@v2');
  assert.equal(skills[0].path, join(fixtureDir, 'skills/review/SKILL.md'));
  assert.equal(skills[0].model_invocable, true);
});

test('missing installations, arbitrary files and empty skill files are rejected', () => {
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  writeFileSync(join(empty, 'SKILL.md'), '');
  for (const path of [
    join(dir, 'missing/SKILL.md'),
    join(fixtureDir, 'config.toml'),
    join(empty, 'SKILL.md'),
  ]) {
    assert.throws(
      () => validateRegistry([{ id: 'custom', path }]),
      hasDiagnostic('SKILL_INSTALLATION'),
    );
  }
});

test('duplicate canonical IDs are ambiguous even with the same file', () => {
  const skills = registry();
  assert.throws(
    () => validateRegistry([...skills, { ...skills[0], requires: {} }]),
    hasDiagnostic('AMBIGUOUS_SKILL'),
  );
});

test('config bindings alone cannot satisfy installed-skill validation', () => {
  assert.throws(
    () => validatePipeline(coding(), config(), []),
    hasDiagnostic('UNINSTALLED_SKILL', 'config.slots.implement'),
  );
  const configured = config();
  configured.slots.implement = 'custom:missing';
  assert.throws(
    () => validatePipeline(coding(), configured, registry()),
    hasDiagnostic('UNINSTALLED_SKILL', 'config.slots.implement'),
  );
});

test('a registered skill disabled for model invocation cannot fill a slot', () => {
  const skills = registry();
  skills.find((skill) => skill.id === 'pb-implement').model_invocable = false;
  assert.throws(
    () => validatePipeline(coding(), config(), skills),
    hasDiagnostic('SKILL_INVOCATION', 'config.slots.implement'),
  );
});

test('root discovery preserves the native disable-model-invocation flag', () => {
  const root = join(dir, 'disabled');
  mkdirSync(join(root, 'physical-name'), { recursive: true });
  writeFileSync(
    join(root, 'physical-name/SKILL.md'),
    '---\nname: native-name\ndisable-model-invocation: true\n---\nTechnique.\n',
  );
  assert.deepEqual(
    discoverSkills(root).map(({ id, model_invocable }) => ({
      id,
      model_invocable,
    })),
    [{ id: 'native-name', model_invocable: false }],
  );
});

test('root discovery diagnoses missing name metadata and duplicate frontmatter names', () => {
  const root = join(dir, 'names');
  mkdirSync(join(root, 'one'), { recursive: true });
  writeFileSync(join(root, 'one/SKILL.md'), 'Technique without metadata.');
  assert.throws(() => discoverSkills(root), hasDiagnostic('SKILL_METADATA'));
  writeFileSync(
    join(root, 'one/SKILL.md'),
    '---\nname: repeated\n---\nTechnique.\n',
  );
  mkdirSync(join(root, 'two'));
  writeFileSync(
    join(root, 'two/SKILL.md'),
    '---\nname: repeated\n---\nTechnique.\n',
  );
  assert.throws(() => discoverSkills(root), hasDiagnostic('AMBIGUOUS_SKILL'));
});

test('registry schemas reject unknown fields, invalid flags and duplicate YAML keys', () => {
  for (const source of [
    'version: 1\nskills: []\nextra: true',
    'version: 2\nskills: []',
    'version: 1\nversion: 1\nskills: []',
    JSON.stringify({
      version: 1,
      skills: [
        { id: 'one', path: 'skills/review/SKILL.md', model_invocable: 'yes' },
      ],
    }),
  ])
    assert.throws(() => parseRegistry(source, fixtureDir), {
      name: 'PlaybillError',
    });
});
