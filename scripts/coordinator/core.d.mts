import type { CoordinatorConfig } from './config.mjs';
export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
  decision?: string;
  reason?: string;
  systemMessage?: string;
}
export function handleHook(
  config: CoordinatorConfig,
  event: Record<string, unknown>,
): Promise<HookOutput>;
export function execute(
  config: CoordinatorConfig,
  command: string,
  argument?: unknown,
  sessionId?: string,
): Promise<{
  state: { status: string; conversation?: { mode: string } };
  context: string;
}>;
