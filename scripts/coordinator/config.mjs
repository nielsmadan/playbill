import { readFileSync, realpathSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { ensure, hash, safePath, skillFile, validPath } from './files.mjs';

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const identifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value);
const paths = (value) =>
  Array.isArray(value) &&
  value.every(validPath) &&
  new Set(value).size === value.length;
const bounded = (value, maximum) =>
  Number.isInteger(value) && value > 0 && value <= maximum;

export function configuration(path) {
  const bytes = readFileSync(path);
  const config = JSON.parse(bytes.toString('utf8'));
  ensure(
    object(config) && config.version === 1,
    'Unsupported coordinator config',
  );
  ensure(
    text(config.root) && isAbsolute(config.root),
    'Config root must be absolute',
  );
  config.root = realpathSync(config.root);
  ensure(identifier(config.runId), 'Invalid runId');
  if (config.runtime !== undefined)
    ensure(
      validPath(config.runtime) &&
        config.runtime.startsWith('.playbill/coordinator/') &&
        !config.runtime.endsWith('/'),
      'Invalid runtime path',
    );
  ensure(
    config.installedSkills === undefined ||
      typeof config.installedSkills === 'boolean',
    'Invalid installedSkills',
  );
  ensure(bounded(config.maxTransitions, 1000), 'Invalid maxTransitions');
  config.maxStopBlocks ??= 3;
  ensure(bounded(config.maxStopBlocks, 20), 'Invalid maxStopBlocks');
  if (config.conversation !== undefined) {
    ensure(
      object(config.conversation) &&
        Object.keys(config.conversation).every((key) =>
          ['redirectThreshold', 'askOnRedirect'].includes(key),
        ),
      'Invalid conversation; expected { redirectThreshold, askOnRedirect }',
    );
    if (config.conversation.redirectThreshold === undefined)
      config.conversation.redirectThreshold = 2;
    if (config.conversation.askOnRedirect === undefined)
      config.conversation.askOnRedirect = true;
    ensure(
      bounded(config.conversation.redirectThreshold, 20) &&
        config.conversation.redirectThreshold >= 2 &&
        typeof config.conversation.askOnRedirect === 'boolean',
      'Invalid conversation; redirectThreshold must be 2..20 and askOnRedirect must be boolean',
    );
  }
  ensure(paths(config.sourcePaths), 'Invalid sourcePaths');
  ensure(object(config.verificationHashes), 'Invalid verificationHashes');
  for (const [name, digest] of Object.entries(config.verificationHashes)) {
    ensure(
      validPath(name) &&
        typeof digest === 'string' &&
        /^[a-f0-9]{64}$/u.test(digest),
      'Invalid verification hash',
    );
  }
  ensure(object(config.checks), 'Invalid checks');
  for (const [name, check] of Object.entries(config.checks)) {
    ensure(
      identifier(name) && object(check) && text(check.executable),
      'Invalid check executable',
    );
    ensure(
      Array.isArray(check.args) &&
        check.args.every((arg) => typeof arg === 'string'),
      'Invalid check args',
    );
    ensure(paths(check.resultFiles), 'Invalid check resultFiles');
    check.timeoutMs ??= 60000;
    check.maxBufferBytes ??= 1048576;
    ensure(
      bounded(check.timeoutMs, 300000) &&
        bounded(check.maxBufferBytes, 16777216),
      'Invalid check limits',
    );
  }
  ensure(
    Array.isArray(config.steps) &&
      config.steps.length > 0 &&
      config.steps.length <= 100,
    'Invalid steps',
  );
  const ids = new Set(config.steps.map((step) => step?.id));
  ensure(
    ids.size === config.steps.length && ids.has(config.entry),
    'Duplicate steps or missing entry',
  );
  for (const step of config.steps) {
    ensure(
      object(step) &&
        identifier(step.id) &&
        text(step.title) &&
        (step.condition !== undefined || text(step.skill)) &&
        text(step.instruction),
      'Invalid step',
    );
    ensure(
      paths(step.consumes) &&
        paths(step.produces) &&
        typeof step.allowSourceWrites === 'boolean',
      'Invalid step contract',
    );
    ensure(
      step.check === undefined || Object.hasOwn(config.checks, step.check),
      'Unknown step check',
    );
    if (step.condition !== undefined) {
      ensure(
        object(step.condition) &&
          identifier(step.condition.id) &&
          text(step.condition.expression) &&
          step.consumes.length === 0 &&
          step.produces.length === 0 &&
          !step.skill &&
          !step.check,
        'Invalid condition step',
      );
      ensure(
        object(step.next) &&
          Object.keys(step.next).length === 2 &&
          ['true', 'false'].every(
            (key) =>
              Object.hasOwn(step.next, key) &&
              (step.next[key] === null || ids.has(step.next[key])),
          ),
        'Invalid condition successors',
      );
    } else if (step.next !== undefined && step.next !== null) {
      if (typeof step.next === 'string')
        ensure(ids.has(step.next), 'Unknown successor');
      else
        ensure(
          object(step.next) &&
            step.check &&
            ids.has(step.next.pass) &&
            ids.has(step.next.fail) &&
            Object.keys(step.next).length === 2,
          'Invalid check successors',
        );
    }
  }
  config.pauseAfter ??= [];
  ensure(
    Array.isArray(config.pauseAfter) &&
      config.pauseAfter.every((id) => ids.has(id)),
    'Invalid pauseAfter',
  );
  const artifacts = config.steps.flatMap((step) => [
    ...step.consumes,
    ...step.produces,
  ]);
  const results = Object.values(config.checks).flatMap(
    (check) => check.resultFiles,
  );
  if (config.nativeSkills !== undefined) {
    const skills = [
      ...new Set(
        config.steps
          .filter((step) => !step.condition)
          .map((step) => step.skill),
      ),
    ];
    ensure(
      object(config.nativeSkills) &&
        Object.keys(config.nativeSkills).length === skills.length &&
        skills.every(
          (skill) =>
            validPath(config.nativeSkills[skill]) ||
            (config.installedSkills &&
              text(config.nativeSkills[skill]) &&
              isAbsolute(config.nativeSkills[skill])),
        ),
      'Invalid nativeSkills; map every step skill to a validated skill file',
    );
  }
  if (config.nativeInvocations !== undefined) {
    ensure(
      object(config.nativeInvocations) &&
        config.steps
          .filter((step) => !step.condition)
          .every((step) => text(config.nativeInvocations[step.skill])),
      'Invalid nativeInvocations',
    );
  }
  if (config.executionHistory !== undefined) {
    ensure(
      object(config.executionHistory) &&
        Object.keys(config.executionHistory).length === 1 &&
        validPath(config.executionHistory.reportArtifact),
      'Invalid executionHistory; expected { reportArtifact: relativePath }',
    );
    const report = config.executionHistory.reportArtifact;
    const owners = config.steps.filter((step) =>
      step.produces.includes(report),
    );
    ensure(
      owners.length === 1 &&
        !owners[0].next &&
        !results.includes(report) &&
        !config.steps.some((step) => step.consumes.includes(report)),
      'Execution history report must belong to one terminal step and not overlap check results or consumed artifacts',
    );
  }
  if (config.reportReview !== undefined) {
    ensure(
      config.executionHistory &&
        object(config.reportReview) &&
        Object.keys(config.reportReview).length === 1 &&
        typeof config.reportReview.publicKey === 'string' &&
        config.reportReview.publicKey.startsWith(
          '-----BEGIN PUBLIC KEY-----',
        ) &&
        !config.reportReview.publicKey.includes('PRIVATE KEY'),
      'Invalid reportReview; requires executionHistory and { publicKey: Ed25519 public PEM }',
    );
    ensure(
      createPublicKey(config.reportReview.publicKey).asymmetricKeyType ===
        'ed25519',
      'Report review requires an Ed25519 public key',
    );
  }
  for (const name of [
    ...config.sourcePaths,
    ...Object.keys(config.verificationHashes),
    ...artifacts,
    ...results,
  ]) {
    ensure(
      !name.startsWith('.playbill/coordinator/'),
      'Evidence/input path overlaps coordinator',
    );
  }
  for (const name of [
    ...config.steps.flatMap((step) => step.produces),
    ...results,
  ]) {
    ensure(
      !config.sourcePaths.includes(name) &&
        !Object.hasOwn(config.verificationHashes, name),
      'Output overlaps watched input',
    );
  }
  if (!config.conversation) validateWorkflowPaths(config);
  return { ...config, configHash: hash(bytes), configPath: resolve(path) };
}

export function validateWorkflowPaths(config) {
  for (const path of Object.values(config.nativeSkills ?? {}))
    skillFile(config, path);
  for (const path of [
    ...config.sourcePaths,
    ...Object.keys(config.verificationHashes),
    ...config.steps.flatMap((step) => [...step.consumes, ...step.produces]),
    ...Object.values(config.checks).flatMap((check) => check.resultFiles),
  ])
    safePath(config.root, path);
}
