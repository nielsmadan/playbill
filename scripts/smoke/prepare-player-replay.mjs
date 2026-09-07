import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = '/Users/nielsmadan/wrksp/flowlab/dev1';
const firstFix = '8e3bc6570664053ee35617432d1192fb7ee0a74f';
const baselineCommit = '70963f72f6f6282cb3124b79c4c493db3d1d36aa';
const controlCommit = 'cc7aa380a1d878352b2a5ebc0fb59175923da899';
const suppliedTest = 'src/services/player/__tests__/hooks.test.ts';
const hook = 'src/services/player/hooks.ts';
const expectedFailures = [
  'latches a load failure past the Android follow-up status that clears status.error',
  'clears a previous failure when a retry swaps in a new player',
];
const resume = process.argv[2] === '--resume';
assert(
  process.argv.length === (resume ? 4 : 2),
  'Usage: node scripts/smoke/prepare-player-replay.mjs [--resume <experiment>]',
);
const experiment = resume
  ? resolve(process.argv[3])
  : mkdtempSync(join(root, '.test-runs-player-replay-'));
assert.equal(dirname(experiment), resolve(root));
assert(relative(root, experiment).startsWith('.test-runs-player-replay-'));
const evidence = join(experiment, 'preparation');
const previous = resume
  ? JSON.parse(readFileSync(join(evidence, 'manifest.json'), 'utf8'))
  : null;
if (previous) {
  assert.equal(previous.status, 'failed');
  assert.equal(previous.modelTrialsStarted, 0);
  assert.equal(previous.baselineCommit, baselineCommit);
  assert.equal(previous.controlCommit, controlCommit);
}
const workers = ['worker-a', 'worker-b'].map((name) => join(experiment, name));
const control = join(experiment, 'positive-control');
const dependencies = join(experiment, 'dependencies');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const write = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};
const json = (path, value) =>
  write(path, JSON.stringify(value, null, 2) + '\n');
const within = (parent, path) => {
  const rel = relative(parent, path);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
};
const scopedEnvironment = (directory) => {
  const cache = join(directory, '.replay/cache');
  const temporary = join(directory, '.replay/tmp');
  mkdirSync(cache, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  return {
    PATH: process.env.PATH,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: join(directory, '.replay/config'),
    CI: '1',
    EXPO_NO_TELEMETRY: '1',
    YARN_ENABLE_TELEMETRY: '0',
    YARN_ENABLE_SCRIPTS: 'false',
    YARN_ENABLE_GLOBAL_CACHE: 'false',
    YARN_CACHE_FOLDER: join(experiment, 'dependency-cache'),
    YARN_GLOBAL_FOLDER: join(experiment, 'yarn-global'),
    YARN_ENABLE_COLORS: 'false',
  };
};
const commands = resume
  ? JSON.parse(readFileSync(join(evidence, 'commands.json'), 'utf8'))
  : [];
const run = (
  name,
  executable,
  args,
  cwd,
  environment = scopedEnvironment(experiment),
) => {
  if (commands.some((command) => command.name === name))
    name = `${name}-continued-${commands.length}`;
  const started = new Date().toISOString();
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    timeout: 20 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? new Uint8Array();
  const stderr = result.stderr ?? new Uint8Array();
  const record = {
    executable,
    args,
    cwd,
    environment,
    started,
    finished: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
  write(join(evidence, `${name}.stdout`), stdout);
  write(join(evidence, `${name}.stderr`), stderr);
  json(join(evidence, `${name}.command.json`), record);
  commands.push({ name, ...record });
  json(join(evidence, 'commands.json'), commands);
  return { ...record, stdout, stderr };
};
const successful = (result) => {
  assert.equal(result.exitCode, 0, `Command failed; see ${evidence}`);
  return result.stdout;
};
const git = (name, args) =>
  successful(run(name, 'git', ['-C', source, ...args], root));
const omittedFiles = new Map([
  [
    'android/app/debug.keystore',
    'Tracked signing key; credentials are excluded.',
  ],
  [
    'android/app/google-services.json',
    'Tracked service configuration; excluded from offline replay.',
  ],
  [
    'ios/FlowLab/GoogleService-Info.plist',
    'Tracked service configuration; excluded from offline replay.',
  ],
  [
    'ios/GoogleService-Info.plist',
    'Tracked service configuration; excluded from offline replay.',
  ],
  [
    '.mcp.json',
    'Machine tool launch configuration; excluded from offline replay.',
  ],
  ['mise.toml', 'Machine environment loader; excluded from offline replay.'],
]);
const exports = [];
const exportSnapshot = (name, commit, destination) => {
  const tree = git(`${name}-tree`, ['ls-tree', '-rz', commit]).toString();
  const entries = tree
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [metadata, path] = line.split('\t');
      const [mode, type, object] = metadata.split(' ');
      assert.equal(type, 'blob', `Unexpected tracked object: ${path}`);
      assert(
        within(destination, resolve(destination, path)),
        `Unsafe tracked path: ${path}`,
      );
      return { path, mode, object };
    });
  const included = [];
  const omitted = [];
  for (const entry of entries) {
    const reason = omittedFiles.get(entry.path);
    if (reason) {
      omitted.push({ ...entry, reason });
      continue;
    }
    assert(
      !/(^|\/)(\.git|node_modules|\.env|\.cache|\.npm|\.logs)(\/|$)/.test(
        entry.path,
      ),
    );
    if (entry.mode === '120000') {
      const target = git(`${name}-symlink-${included.length}`, [
        'show',
        `${commit}:${entry.path}`,
      ]).toString();
      if (
        isAbsolute(target) ||
        !within(destination, resolve(destination, dirname(entry.path), target))
      ) {
        omitted.push({
          ...entry,
          target,
          reason: 'Symlink target escapes snapshot; never traversed.',
        });
        continue;
      }
      entry.target = target;
    }
    included.push(entry);
  }
  mkdirSync(destination, { recursive: true });
  const archive = join(evidence, `${name}.tar`);
  git(`${name}-archive`, [
    'archive',
    '--format=tar',
    `--output=${archive}`,
    commit,
    '--',
    ...included.map((entry) => entry.path),
  ]);
  successful(
    run(`${name}-extract`, 'tar', ['-xf', archive, '-C', destination], root),
  );
  for (const entry of included) {
    const path = join(destination, entry.path);
    if (entry.target !== undefined) {
      assert(lstatSync(path).isSymbolicLink());
      assert(
        within(destination, realpathSync(path)),
        `Symlink chain escapes: ${entry.path}`,
      );
      assert.equal(readlinkSync(path), entry.target);
      entry.sha256 = sha256(entry.target);
    } else {
      assert(lstatSync(path).isFile());
      entry.sha256 = sha256(readFileSync(path));
    }
  }
  const record = {
    name,
    commit,
    destination,
    archiveSha256: sha256(readFileSync(archive)),
    included,
    omitted,
  };
  exports.push(record);
  json(join(evidence, `${name}-export.json`), record);
  return record;
};
const auditLinks = (directory) => {
  let files = 0;
  const links = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      assert.notEqual(
        entry.name,
        '.git',
        `Unexpected dependency history: ${child}`,
      );
      if (entry.isSymbolicLink()) {
        assert(
          within(directory, realpathSync(child)),
          `Dependency link escapes: ${child}`,
        );
        links.push({
          path: relative(directory, child),
          target: readlinkSync(child),
        });
      } else if (entry.isDirectory()) visit(child);
      else files += 1;
    }
  };
  visit(directory);
  return { files, links };
};
const testRunner = `const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = join(__dirname, '..');
const temporary = join(__dirname, 'tmp');
const cache = join(__dirname, 'cache');
mkdirSync(temporary, { recursive: true });
mkdirSync(cache, { recursive: true });
const result = spawnSync(process.execPath, [
  'node_modules/jest/bin/jest.js',
  '--runInBand', '--watch=false', '--watchman=false',
  '--runTestsByPath', '${suppliedTest}',
  '--cacheDirectory=.replay/cache/jest',
  '--json', '--outputFile=.replay/result.json',
], {
  cwd: root,
  env: {
    PATH: process.env.PATH, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    XDG_CACHE_HOME: cache, CI: '1', NODE_ENV: 'test', EXPO_NO_TELEMETRY: '1',
  },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;
const task = `Fix the session audio player's failure and retry behavior. After audio fails to load, the visible error can disappear and leave buffering indefinitely. Retrying can also leave the previous failure visible while replacement audio is healthy. Keep a load failure visible through later loading updates, and clear the previous failure when retrying with replacement audio so healthy playback stays clear. Preserve seek clamping, skip-intro behavior, lock-screen controls, one-time autoplay that respects pauses, and suppression of autoplay for a current load failure.

Run the supplied offline hook checks with this exact command from this directory:

node .replay/test.cjs

Preserve the supplied src/services/player/__tests__/hooks.test.ts bytes unchanged. You may add separate tests. Preserve the test runner and its configuration. Audio events are mocked; no device or running app is needed.

Work only inside this directory, including ordinary workflow artifacts. Keep changes limited to the session player behavior and relevant additional tests. Do not inspect machine or agent logs, the original checkout, other directories, or source history. Do not use external services, install dependencies, start native builds or development servers, edit global settings, dispatch subagents, or mutate Git state.
`;
const manifest = {
  schemaVersion: 1,
  status: 'preparing',
  experiment,
  source,
  baselineCommit,
  firstFix,
  controlCommit,
  workers,
  control,
  modelTrialsStarted: 0,
  recoveryReference: {
    harness: 'Claude',
    session: 'd48a78d8-8184-4f30-b574-ae9a683d2083',
    slug: 'distributed-humming-wilkes',
    events: 'August 4–8',
    method: 'check-agent-logs; reference only, no transcript copied',
  },
  limitations: [
    'Only the mocked public player-hook checks run; no native audio, simulator, backend, full suite, lint or source-project type checking.',
    'Historical source is retained except explicitly recorded credential/machine-configuration omissions and the supplied test overlay.',
    'Dependencies are installed from the immutable historical lock with lifecycle/build scripts disabled; native package builds are not exercised.',
    'Positive control and provenance are siblings outside worker directories; task scope forbids reading outside the assigned worker, but this is not a filesystem sandbox.',
  ],
};
if (previous)
  json(join(evidence, `failed-preparation-${commands.length}.json`), previous);
const preparationCode = readFileSync(fileURLToPath(import.meta.url));
manifest.preparationCodeSha256 = sha256(preparationCode);
write(
  join(evidence, `preparation-code-${commands.length}.mjs`),
  preparationCode,
);
json(join(evidence, 'manifest.json'), manifest);
process.stdout.write(`Preparing ${experiment}\n`);

try {
  assert.equal(
    git('resolve-baseline', ['rev-parse', `${firstFix}^`])
      .toString()
      .trim(),
    baselineCommit,
  );
  assert.equal(
    git('resolve-first-fix', ['rev-parse', firstFix]).toString().trim(),
    firstFix,
  );
  assert.equal(
    git('resolve-control', ['rev-parse', controlCommit]).toString().trim(),
    controlCommit,
  );
  const testBytes = git('supplied-test', [
    'show',
    `${controlCommit}:${suppliedTest}`,
  ]);
  manifest.suppliedTest = {
    path: suppliedTest,
    sourceCommit: controlCommit,
    sha256: sha256(testBytes),
  };
  if (resume) {
    for (const name of ['worker-1', 'worker-2', 'control']) {
      const record = JSON.parse(
        readFileSync(join(evidence, `${name}-export.json`), 'utf8'),
      );
      assert(!existsSync(join(record.destination, '.git')));
      for (const entry of record.included) {
        const expected =
          entry.path === suppliedTest ? sha256(testBytes) : entry.sha256;
        const actual =
          entry.target !== undefined
            ? sha256(readlinkSync(join(record.destination, entry.path)))
            : sha256(readFileSync(join(record.destination, entry.path)));
        assert.equal(
          actual,
          expected,
          `Refusing to overwrite changed source: ${entry.path}`,
        );
      }
      exports.push(record);
    }
  } else {
    for (const [index, worker] of workers.entries())
      exportSnapshot(`worker-${index + 1}`, baselineCommit, worker);
    exportSnapshot('control', controlCommit, control);
  }
  assert.deepEqual(exports[0].included, exports[1].included);
  for (const destination of [...workers, control]) {
    write(join(destination, suppliedTest), testBytes);
    write(join(destination, '.playbill/config.toml'), '');
    write(join(destination, '.replay/test.cjs'), testRunner);
    write(join(destination, 'TASK.md'), task);
  }
  manifest.preparationDelta = {
    overlay: manifest.suppliedTest,
    added: {
      '.playbill/config.toml': sha256(''),
      '.replay/test.cjs': sha256(testRunner),
      'TASK.md': sha256(task),
    },
    jestConfiguration:
      'Historical Babel, Jest configuration and setup retained; runner only scopes caches and selects the hook test with watchman disabled.',
  };
  assert(!/\b(plan|review|longshot)\b/i.test(task));
  for (const path of [
    'package.json',
    'yarn.lock',
    '.yarnrc.yml',
    '.yarn/releases/yarn-3.6.4.cjs',
  ]) {
    const bytes = readFileSync(join(workers[0], path));
    assert.deepEqual(bytes, readFileSync(join(control, path)));
    write(join(dependencies, path), bytes);
  }
  process.stdout.write(
    'Installing the pinned historical dependency lock with scripts disabled.\n',
  );
  successful(
    run(
      'dependency-install',
      process.execPath,
      [
        '.yarn/releases/yarn-3.6.4.cjs',
        'install',
        '--immutable',
        '--mode=skip-build',
      ],
      dependencies,
      scopedEnvironment(dependencies),
    ),
  );
  assert.deepEqual(
    readFileSync(join(dependencies, 'yarn.lock')),
    readFileSync(join(workers[0], 'yarn.lock')),
  );
  const lock = parse(readFileSync(join(dependencies, 'yarn.lock'), 'utf8'));
  const versions = {};
  for (const name of [
    'jest',
    'jest-expo',
    'react',
    'react-native',
    'expo-audio',
    '@testing-library/react-native',
    'test-renderer',
    'babel-preset-expo',
  ]) {
    const installed = JSON.parse(
      readFileSync(
        join(dependencies, 'node_modules', name, 'package.json'),
        'utf8',
      ),
    ).version;
    const expected = Object.entries(lock)
      .filter(([key]) =>
        key
          .split(', ')
          .some((descriptor) => descriptor.startsWith(`${name}@npm:`)),
      )
      .map(([, entry]) => entry.version);
    assert(
      expected.includes(installed),
      `Installed ${name}@${installed} is outside the historical lock`,
    );
    versions[name] = installed;
  }
  manifest.dependencies = {
    method:
      'Fresh immutable Yarn install, public registry, experiment-owned cache, scripts disabled; independent copy-on-write copies into each snapshot.',
    versions,
    yarnLockSha256: sha256(readFileSync(join(dependencies, 'yarn.lock'))),
    audit: auditLinks(join(dependencies, 'node_modules')),
  };
  manifest.results = [];
  for (const [index, destination] of [...workers, control].entries()) {
    cpSync(
      join(dependencies, 'node_modules'),
      join(destination, 'node_modules'),
      {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      },
    );
    const dependencyAudit = auditLinks(join(destination, 'node_modules'));
    assert.deepEqual(dependencyAudit, manifest.dependencies.audit);
    const name = index < 2 ? `worker-${index + 1}` : 'control';
    process.stdout.write(`Running ${name} hook checks.\n`);
    const result = run(
      `${name}-test`,
      process.execPath,
      ['.replay/test.cjs'],
      destination,
      scopedEnvironment(destination),
    );
    assert(
      existsSync(join(destination, '.replay/result.json')),
      `Missing Jest results for ${name}`,
    );
    const reportBytes = readFileSync(join(destination, '.replay/result.json'));
    write(join(evidence, `${name}-jest.json`), reportBytes);
    const report = JSON.parse(reportBytes);
    const failures = report.testResults.flatMap((suite) =>
      suite.assertionResults
        .filter((test) => test.status === 'failed')
        .map((test) => test.fullName),
    );
    assert.equal(report.numTotalTests, 15);
    assert.equal(result.exitCode, index < 2 ? 1 : 0);
    assert.deepEqual(
      failures.sort(),
      index < 2 ? [...expectedFailures].sort() : [],
    );
    assert.equal(report.numPassedTests, index < 2 ? 13 : 15);
    assert.equal(report.numFailedTestSuites, index < 2 ? 1 : 0);
    assert.equal(report.testResults.length, 1);
    assert.equal(report.testResults[0].name, join(destination, suppliedTest));
    for (const entry of exports[index].included) {
      const expected =
        entry.path === suppliedTest ? sha256(testBytes) : entry.sha256;
      const actual =
        entry.target !== undefined
          ? sha256(readlinkSync(join(destination, entry.path)))
          : sha256(readFileSync(join(destination, entry.path)));
      assert.equal(
        actual,
        expected,
        `Historical source changed: ${entry.path}`,
      );
    }
    assert.equal(
      sha256(readFileSync(join(destination, hook))),
      exports[index].included.find((entry) => entry.path === hook).sha256,
    );
    assert(!existsSync(join(destination, '.git')));
    manifest.results.push({
      name,
      destination,
      exitCode: result.exitCode,
      tests: report.numTotalTests,
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      failures,
      hookSha256: sha256(readFileSync(join(destination, hook))),
      suppliedTestSha256: sha256(readFileSync(join(destination, suppliedTest))),
    });
    for (const artifact of ['result.json', 'cache', 'tmp'])
      rmSync(join(destination, '.replay', artifact), {
        recursive: true,
        force: true,
      });
    json(join(evidence, 'manifest.json'), manifest);
  }
  manifest.status = 'verified';
  manifest.finished = new Date().toISOString();
  json(join(evidence, 'manifest.json'), manifest);
  process.stdout.write(
    JSON.stringify(
      {
        experiment,
        workers,
        control,
        suppliedTest: manifest.suppliedTest,
        results: manifest.results,
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  manifest.status = 'failed';
  manifest.error = error.stack;
  json(join(evidence, 'manifest.json'), manifest);
  throw error;
}
