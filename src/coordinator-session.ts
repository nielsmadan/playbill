import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, readFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { configuration } from '../scripts/coordinator/config.mjs';
import { execute, handleHook } from '../scripts/coordinator/core.mjs';
import { handleCodexHook } from '../scripts/coordinator/codex.mjs';
import { hash, safePath, writeJSON } from '../scripts/coordinator/files.mjs';
import { discoveryFromEnvironment, projectRoot } from './discovery.js';
import { fail } from './diagnostics.js';
import { record, text } from './schema.js';
import type { CoordinatorPlan } from './coordinator-compiler.js';
import type { HookOutput } from '../scripts/coordinator/core.mjs';

export const nativeEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SessionEnd',
];

export function hookFailure(event: string, context: string): HookOutput {
  if (event === 'Stop') return { decision: 'block', reason: context };
  if (event === 'SessionEnd') return {};
  if (event === 'PreToolUse')
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: context,
      },
    };
  return {
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  };
}

export class CoordinatorSession {
  private readonly root: string;
  private readonly identity: string;
  private readonly pointer: string;

  constructor(
    private readonly host: 'claude' | 'codex',
    private readonly event: Record<string, unknown>,
    env: NodeJS.ProcessEnv,
  ) {
    const cwd = text(event.cwd, 'cwd');
    const session = text(event.session_id, 'session_id');
    this.root = projectRoot(cwd, discoveryFromEnvironment(env).projectRoot);
    this.identity = hash(`${host}\0${this.root}\0${session}`);
    this.pointer = `.playbill/coordinator/sessions/${this.identity}/current.json`;
  }

  async route(): Promise<HookOutput | undefined> {
    const path = safePath(this.root, this.pointer);
    if (!existsSync(path)) return undefined;
    const pointer = record(
      JSON.parse(readFileSync(path, 'utf8')) as unknown,
      path,
      [
        'version',
        'mode',
        'runId',
        'configPath',
        'configHash',
        'host',
        'root',
        'sessionId',
      ],
    );
    if (
      pointer.version !== 1 ||
      pointer.host !== this.host ||
      pointer.root !== this.root ||
      pointer.sessionId !== this.event.session_id
    )
      fail(
        'STATE',
        path,
        'Coordinator pointer identity mismatch. Preserve this run for inspection.',
      );
    if (pointer.mode === 'rendered') return undefined;
    if (pointer.mode !== undefined)
      fail('STATE', path, 'Invalid routing disposition.');
    const runId = text(pointer.runId, 'coordinator.runId');
    if (!/^[a-f0-9-]{36}$/u.test(runId))
      fail('STATE', path, 'Invalid run identity.');
    const expected = `.playbill/coordinator/sessions/${this.identity}/runs/${runId}/config.json`;
    if (pointer.configPath !== expected)
      fail('STATE', path, 'Coordinator pointer config path mismatch.');
    const config = configuration(safePath(this.root, expected));
    if (
      config.configHash !== pointer.configHash ||
      config.root !== this.root ||
      config.runId !== runId
    )
      fail(
        'STATE',
        path,
        'Coordinator configuration changed. Preserve this run for inspection.',
      );
    if (
      this.event.hook_event_name === 'UserPromptSubmit' &&
      typeof this.event.prompt === 'string' &&
      /^\s*\[playbill:/u.test(this.event.prompt)
    ) {
      const { state } = await execute(
        config,
        'status',
        undefined,
        String(this.event.session_id),
      );
      if (state.status === 'done' || state.conversation?.mode === 'exited')
        return undefined;
    }
    return this.dispatch(config);
  }

  rendered(): void {
    if (!existsSync(safePath(this.root, this.pointer))) return;
    writeJSON(this.root, this.pointer, {
      version: 1,
      mode: 'rendered',
      host: this.host,
      root: this.root,
      sessionId: this.event.session_id,
    });
  }

  async start(plan: CoordinatorPlan): Promise<HookOutput> {
    if (
      plan.root !== this.root ||
      this.event.hook_event_name !== 'UserPromptSubmit'
    )
      fail(
        'STATE',
        'coordinator',
        'A new run requires the selected prompt and canonical project root.',
      );
    const lock = safePath(this.root, `${dirname(this.pointer)}/selection-lock`);
    mkdirSync(dirname(lock), { recursive: true });
    mkdirSync(lock);
    try {
      const routed = await this.route();
      if (routed !== undefined) return routed;
      return await this.initialize(plan);
    } finally {
      rmdirSync(lock);
    }
  }

  private async initialize(plan: CoordinatorPlan): Promise<HookOutput> {
    const runId = randomUUID();
    const base = `.playbill/coordinator/sessions/${this.identity}/runs/${runId}`;
    const artifact = (path: string) =>
      plan.artifactScope === 'run'
        ? `.playbill/runs/${this.identity}/${runId}/artifacts/${path}`
        : path;
    const steps = plan.steps.map((step) => ({
      ...step,
      consumes: step.consumes.map(artifact),
      produces: step.produces.map(artifact),
    }));
    const configPath = `${base}/config.json`;
    const raw = {
      version: 1,
      root: this.root,
      runId,
      runtime: `${base}/runtime`,
      workflow: plan.workflow,
      introduction: plan.introduction,
      entry: plan.entry,
      steps,
      maxTransitions: Math.max(1, steps.length),
      maxStopBlocks: 3,
      sourcePaths: [],
      verificationHashes: {},
      checks: {},
      pauseAfter: [],
      conversation: plan.conversation,
      ...(plan.reportArtifact
        ? {
            executionHistory: { reportArtifact: artifact(plan.reportArtifact) },
          }
        : {}),
      nativeSkills: plan.nativeSkills,
      installedSkills: true,
      ...(this.host === 'claude'
        ? { nativeInvocations: plan.nativeInvocations }
        : {}),
    };
    writeJSON(this.root, configPath, raw, true);
    const config = configuration(safePath(this.root, configPath));
    const output = await this.dispatch(config);
    const pointer = {
      version: 1,
      runId,
      configPath,
      configHash: config.configHash,
      host: this.host,
      root: this.root,
      sessionId: this.event.session_id,
    };
    writeJSON(this.root, `${base}/pointer.json`, pointer, true);
    writeJSON(this.root, this.pointer, pointer);
    return output;
  }

  private async dispatch(
    config: ReturnType<typeof configuration>,
  ): Promise<HookOutput> {
    if (this.event.hook_event_name === 'SessionEnd') return Promise.resolve({});
    const output = await (this.host === 'codex'
      ? handleCodexHook(config, this.event)
      : handleHook(config, this.event));
    const context =
      output.hookSpecificOutput?.additionalContext ?? output.reason ?? '';
    if (
      this.host === 'claude'
        ? context.length > 10000
        : Buffer.byteLength(context) > 16384
    )
      fail(
        'LIMIT',
        'coordinator context',
        'Complete coordinator output exceeds the native host context limit. Shorten the workflow introduction or step instruction.',
      );
    return output;
  }
}
