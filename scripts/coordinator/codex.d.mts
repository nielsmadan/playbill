import type { CoordinatorConfig } from './config.mjs';
import type { HookOutput } from './core.mjs';
export function handleCodexHook(
  config: CoordinatorConfig,
  event: Record<string, unknown>,
): Promise<HookOutput>;
