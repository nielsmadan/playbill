import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import {
  discoverSkills,
  parseConfig,
  parsePipeline,
  validatePipeline,
} from '../dist/index.js';

export const fixtureDir = fileURLToPath(
  new URL('./fixtures/', import.meta.url),
);
export const fixture = (name) => readFileSync(join(fixtureDir, name), 'utf8');
export const registry = () => discoverSkills(join(fixtureDir, 'skills'));
export const config = () => parseConfig(fixture('config.toml'));
export const coding = () => parsePipeline(fixture('coding.yaml'));
export const step = (id, consumes = [], produces = []) => ({
  type: 'step',
  id,
  title: id,
  skill: '{{implement}}',
  consumes,
  produces,
});
export const flow = (steps, options = {}) => ({
  version: 1,
  id: 'flow',
  title: 'Flow',
  artifacts: [
    { id: 'input', path: 'TASK.md' },
    { id: 'draft', path: 'draft.md' },
    { id: 'report', path: 'review.md' },
    { id: 'tasks', path: 'tasks.json', kind: 'collection' },
  ],
  inputs: ['input', 'tasks'],
  outputs: ['report'],
  steps,
  ...options,
});
export const validate = (pipeline) =>
  validatePipeline(pipeline, config(), registry());
export const hasDiagnostic = (code, path) => (error) => {
  return (
    error.name === 'PlaybillError' &&
    error.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === code &&
        (path === undefined || diagnostic.path === path),
    )
  );
};
