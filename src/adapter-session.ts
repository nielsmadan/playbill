import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoveryFromEnvironment, projectRoot } from './discovery.js';
import { fail, formatDiagnostic } from './diagnostics.js';
import { pluginRoot } from './native-inventory.js';
import { runtimeFailure } from './runtime.js';
import { sessionStore } from './session-state.js';
import { invokeRuntime } from './subprocess.js';
import type { NativeSkill, RuntimeRequest, RuntimeResult } from './runtime.js';

export type Host = 'codex' | 'pi' | 'opencode';
export const CONTEXT_BYTES = 16_384;

export function nativeContext(
  host: Host,
  result: RuntimeResult,
  restore = false,
  root?: string,
): string {
  if (!result.ok)
    return `Playbill configuration error:\n${result.diagnostics.map(formatDiagnostic).join('\n').slice(0, 2048)}\nNo workflow instructions were composed for this event.`;
  if (!result.commonProse) return '';
  const mapping = result.invocations
    .map(({ id, invocation, path }) =>
      host === 'opencode'
        ? `- ${JSON.stringify(id)}: skill tool with name=${JSON.stringify(invocation)}`
        : `- ${JSON.stringify(id)}: read the registered SKILL.md at ${JSON.stringify(path)} (native name ${JSON.stringify(invocation)})`,
    )
    .join('\n');
  const capability =
    host === 'pi'
      ? '\nPi has no standard fresh-subagent tool. If a step requires a capability unavailable in this session, report the missing capability and stop that step; preserve its declared contract.'
      : '\nAgent contracts require actual host capabilities; report any unavailable capability before that step.';
  const context = `${result.commonProse}\n${host} skill invocation:\n${mapping}\nAfter loading each skill, apply its technique to the current step's title and instruction, task string (current collection item or user request), input/output artifact paths, and declared agent scope.${root ? `\nResolve workflow artifact paths relative to project root ${JSON.stringify(root)}.` : ''}\nSkill availability is a discovery snapshot; native permissions and live registration still apply.${capability}${restore ? '\nWorkflow reference restored. Continue from the conversation summary and existing artifacts.' : ''}`;
  if (Buffer.byteLength(context) > CONTEXT_BYTES)
    fail(
      'LIMIT',
      `${host} context`,
      'Complete instructions exceed 16 KiB. Shorten the workflow or invocation mapping.',
    );
  return context;
}

export class AdapterSession {
  private readonly discovery;
  private readonly store;
  private selected: string | undefined;

  constructor(
    private readonly host: Host,
    private readonly cwd: string,
    session: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.discovery = discoveryFromEnvironment(env);
    this.discovery.defaultsDir ??= join(pluginRoot, 'defaults');
    this.discovery.projectRoot = projectRoot(cwd, this.discovery.projectRoot);
    this.store = sessionStore(
      env.PLAYBILL_STATE_DIR ??
        join(env.PLUGIN_DATA ?? tmpdir(), 'playbill-sessions'),
      `${host}\0${this.discovery.projectRoot}\0${session}`,
    );
    this.selected = this.store.read().selected;
  }

  evaluate(
    event: RuntimeRequest['event'],
    inventory: NativeSkill[],
    prompt?: string,
  ): RuntimeResult {
    return invokeRuntime(
      {
        version: 1,
        cwd: this.cwd,
        event,
        inventory,
        discovery: this.discovery,
        ...(this.host === 'codex' ? { coordinationHost: 'codex' } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(event === 'restore' && this.selected
          ? { resumeWorkflow: this.selected }
          : {}),
      },
      this.env.PLAYBILL_NODE ??
        (this.host === 'opencode' ? 'node' : process.execPath),
    );
  }

  run(
    event: RuntimeRequest['event'],
    inventory: NativeSkill[],
    prompt?: string,
    evaluated?: RuntimeResult,
  ): string {
    try {
      const result = evaluated ?? this.evaluate(event, inventory, prompt);
      if (
        this.host !== 'codex' &&
        event === 'prompt' &&
        result.ok &&
        !result.selected &&
        this.selected
      )
        return this.run('restore', inventory);
      const context = nativeContext(
        this.host,
        result,
        event === 'restore',
        this.discovery.projectRoot,
      );
      this.selected = result.ok
        ? (result.selected ?? (event === 'prompt' ? this.selected : undefined))
        : undefined;
      this.store.write({
        version: 1,
        warned: false,
        ...(this.selected ? { selected: this.selected } : {}),
      });
      return context;
    } catch (error) {
      return this.failure(error);
    }
  }

  failure(error: unknown): string {
    this.selected = undefined;
    try {
      this.store.write({ version: 1, warned: false });
    } catch (stateError) {
      return nativeContext(this.host, runtimeFailure(stateError));
    }
    return nativeContext(this.host, runtimeFailure(error));
  }
}
