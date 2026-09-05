import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { stringify } from 'yaml';
import { coding, fixture, fixtureDir } from './helpers.mjs';

const dir = mkdtempSync(join(process.cwd(), '.test-runs-cli-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const cli = (...args) =>
  spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
const args = [
  '--config',
  join(fixtureDir, 'config.toml'),
  '--skill-root',
  join(fixtureDir, 'skills'),
];

test('real CLI validates and renders deterministic four-step instructions', () => {
  const validation = cli('validate', join(fixtureDir, 'coding.yaml'), ...args);
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal(validation.stdout, 'Valid: coding\n');
  const rendering = cli('render', join(fixtureDir, 'coding.yaml'), ...args);
  assert.equal(rendering.status, 0, rendering.stderr);
  assert.equal(rendering.stdout, fixture('coding.golden.md'));
  assert.equal(
    cli('render', join(fixtureDir, 'coding.yaml'), ...args).stdout,
    rendering.stdout,
  );
});

test('package command exposes the CLI help and examples', () => {
  const result = spawnSync(
    'npm',
    ['run', '--silent', 'playbill', '--', '--help'],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: playbill <validate\|render>/u);
  assert.match(result.stdout, /playbill render flow.yaml/u);
});

for (const [name, modify, code] of [
  [
    'unknown-slot',
    (pipeline) => {
      pipeline.steps[0].skill = '{{missing}}';
    },
    'UNKNOWN_SLOT',
  ],
  [
    'uncapped-loop',
    (pipeline) => {
      pipeline.steps = [
        { type: 'while', condition: 'work remains', steps: pipeline.steps },
      ];
    },
    'LOOP_CAP',
  ],
  [
    'unsatisfied-contract',
    (pipeline) => {
      pipeline.steps[0].consumes.push('task_review');
    },
    'UNSATISFIED_ARTIFACT',
  ],
  [
    'agent-mismatch',
    (pipeline) => {
      pipeline.steps[0].requires = { fresh: true };
    },
    'AGENT_CONTRACT',
  ],
])
  test(`real CLI rejects ${name} and emits no runnable prose`, () => {
    const pipeline = coding();
    modify(pipeline);
    const path = join(dir, `${name}.yaml`);
    writeFileSync(path, stringify(pipeline));
    for (const command of ['validate', 'render']) {
      const result = cli(command, path, ...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(code, 'u'));
      assert.equal(result.stdout, '');
    }
  });

test('real CLI rejects an uninstalled skill even if it is bound in config', () => {
  const path = join(dir, 'uninstalled.toml');
  writeFileSync(
    path,
    fixture('config.toml').replace('pb-implement', 'custom:uninstalled'),
  );
  const result = cli(
    'validate',
    join(fixtureDir, 'coding.yaml'),
    '--config',
    path,
    '--skill-root',
    join(fixtureDir, 'skills'),
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /config.slots.implement: UNINSTALLED_SKILL: Skill 'custom:uninstalled'/u,
  );
});

test('real CLI requires registry evidence and rejects ambiguous roots', () => {
  const missing = cli(
    'validate',
    join(fixtureDir, 'coding.yaml'),
    '--config',
    join(fixtureDir, 'config.toml'),
  );
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /UNINSTALLED_SKILL/u);
  const ambiguous = cli(
    'validate',
    join(fixtureDir, 'coding.yaml'),
    ...args,
    '--skill-root',
    join(fixtureDir, 'skills'),
  );
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /AMBIGUOUS_SKILL/u);
});

test('CLI merges machine and project config and resolves relative registry paths', () => {
  const machine = join(dir, 'machine.toml');
  writeFileSync(
    machine,
    fixture('config.toml').replace('pb-implement', 'absent'),
  );
  const project = join(dir, 'project.toml');
  writeFileSync(project, '[slots]\nimplement = "pb-implement"');
  const registry = join(dir, 'registry.json');
  writeFileSync(
    registry,
    JSON.stringify({
      version: 1,
      skills: [
        ['pb-implement', 'implement'],
        ['pb-task-review', 'review'],
        ['pb-fix', 'fix'],
        ['pb-final-review', 'final'],
      ].map(([id, folder]) => ({
        id,
        path: `../test/fixtures/skills/${folder}/SKILL.md`,
      })),
    }),
  );
  const result = cli(
    'render',
    join(fixtureDir, 'coding.yaml'),
    '--machine-config',
    machine,
    '--config',
    project,
    '--registry',
    registry,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, fixture('coding.golden.md'));
});

test('CLI reports malformed config, malformed YAML, missing files and invalid UTF-8', () => {
  const config = join(dir, 'bad.toml');
  writeFileSync(config, '[slots');
  const yaml = join(dir, 'bad.yaml');
  writeFileSync(yaml, 'steps: &a [*a]');
  const invalidUtf8 = join(dir, 'utf8.yaml');
  writeFileSync(invalidUtf8, new Uint8Array([0xff]));
  for (const [invocation, code] of [
    [
      ['validate', join(fixtureDir, 'coding.yaml'), '--config', config],
      'TOML_PARSE',
    ],
    [['render', yaml], 'ALIAS'],
    [['validate', join(dir, 'missing.yaml')], 'READ'],
    [['validate', invalidUtf8], 'READ'],
  ]) {
    const result = cli(...invocation);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(code, 'u'));
    assert.equal(result.stdout, '');
  }
});

test('invalid CLI usage returns 2 and help returns 0', () => {
  for (const invocation of [
    [],
    ['execute', 'flow.yaml'],
    ['validate'],
    ['validate', 'a', 'b'],
    ['--unknown'],
  ]) {
    const result = cli(...invocation);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage|Usage/u);
  }
  assert.equal(cli('--help').status, 0);
});
