import { renderPipeline } from './renderer.js';
import { validatePipeline } from './validator.js';

export function compilePipeline(
  pipeline: unknown,
  config: unknown,
  registry: unknown,
): string {
  return renderPipeline(validatePipeline(pipeline, config, registry));
}
