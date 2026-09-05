import { discoverConfiguration, gitOutput } from './discovery.js';
import { errorMessage, fail, PlaybillError } from './diagnostics.js';
import { validateRegistry } from './registry.js';
import { renderPipeline } from './renderer.js';
import { identifier, record, text, version } from './schema.js';
import { candidateFiles, selectWorkflow, validCandidate } from './triggers.js';
import { validatePipeline } from './validator.js';
import type { DiscoveryOptions } from './discovery.js';
import type { Diagnostic, InstalledSkill } from './types.js';

export interface NativeSkill extends InstalledSkill {
  invocation: string;
  unavailableReason?: string;
}

export interface RuntimeRequest {
  version: 1;
  cwd: string;
  event: 'start' | 'prompt' | 'restore';
  prompt?: string;
  candidateFiles?: string[];
  resumeWorkflow?: string;
  discovery?: DiscoveryOptions;
  inventory: NativeSkill[];
}

export interface RuntimeResult {
  version: 1;
  ok: boolean;
  commonProse: string;
  diagnostics: Diagnostic[];
  selected?: string;
  invocations: { id: string; invocation: string; path: string }[];
}

export function runtimeFailure(error: unknown): RuntimeResult {
  return {
    version: 1,
    ok: false,
    commonProse: '',
    invocations: [],
    diagnostics:
      error instanceof PlaybillError
        ? [...error.diagnostics]
        : [{ code: 'RUNTIME', path: 'adapter', message: errorMessage(error) }],
  };
}

export function runRuntime(input: unknown): RuntimeResult {
  try {
    const data = record(input, 'request', [
      'version',
      'cwd',
      'event',
      'prompt',
      'candidateFiles',
      'resumeWorkflow',
      'discovery',
      'inventory',
    ]);
    version(data.version, 'request.version');
    const cwd = text(data.cwd, 'request.cwd');
    if (!['start', 'prompt', 'restore'].includes(String(data.event)))
      fail('EVENT', 'request.event', 'Expected start, prompt, or restore.');
    const discovery = record(data.discovery ?? {}, 'request.discovery', [
      'projectRoot',
      'machineDir',
      'defaultsDir',
    ]);
    const options: DiscoveryOptions = {};
    for (const key of ['projectRoot', 'machineDir', 'defaultsDir'] as const)
      if (discovery[key] !== undefined)
        options[key] = text(discovery[key], `request.discovery.${key}`);
    if (
      typeof (data.prompt ?? '') !== 'string' ||
      Buffer.byteLength(String(data.prompt ?? '')) > 65_536
    )
      fail('LIMIT', 'request.prompt', 'Expected a string of at most 64 KiB.');
    const prompt = String(data.prompt ?? '');
    if (!Array.isArray(data.inventory) || data.inventory.length > 1000)
      fail(
        'INVENTORY',
        'request.inventory',
        'Expected at most 1000 normalized native skills.',
      );
    const invocations = new Map<string, string>();
    const unavailable = new Map<string, string>();
    const registry = validateRegistry(
      data.inventory.map((item: unknown) => {
        const native = record(item, 'request.inventory[]', [
          'id',
          'path',
          'model_invocable',
          'requires',
          'invocation',
          'unavailableReason',
        ]);
        const invocation = text(
          native.invocation,
          'request.inventory[].invocation',
        );
        invocations.set(String(native.id), invocation);
        if (native.unavailableReason !== undefined)
          unavailable.set(
            String(native.id),
            text(
              native.unavailableReason,
              'request.inventory[].unavailableReason',
            ),
          );
        const {
          invocation: _invocation,
          unavailableReason: _reason,
          ...skill
        } = native;
        void _invocation;
        void _reason;
        return skill;
      }),
    );
    const { root, config, pipelines } = discoverConfiguration(cwd, options);
    const installed = new Map(registry.map((skill) => [skill.id, skill]));
    for (const [slot, id] of Object.entries(config.slots)) {
      const skill = installed.get(id);
      if (!skill)
        fail(
          'UNINSTALLED_SKILL',
          `config.slots.${slot}`,
          `Skill '${id}' is absent from the host inventory. Install it through the host or supply its documented normalized inventory; bindings do not install skills.`,
        );
      if (!skill.model_invocable)
        fail(
          'SKILL_INVOCATION',
          `config.slots.${slot}`,
          `Skill '${id}' is unavailable for model invocation.${unavailable.has(id) ? ` ${unavailable.get(id)}` : ''}`,
        );
    }
    const validated = new Map<string, string>();
    for (const id of Object.keys(config.workflows)) {
      const pipeline = pipelines.get(id);
      if (!pipeline)
        fail(
          'MISSING_PIPELINE',
          `config.workflows.${id}`,
          `Add pipelines/${id}.yaml to a Playbill configuration layer.`,
        );
      validated.set(
        id,
        renderPipeline(validatePipeline(pipeline, config, registry)),
      );
    }
    let selected: string | undefined;
    if (data.event === 'prompt') {
      const files: unknown = data.candidateFiles ?? candidateFiles(prompt);
      if (
        !Array.isArray(files) ||
        files.length > 1000 ||
        !files.every(
          (file: unknown) => typeof file === 'string' && validCandidate(file),
        )
      )
        fail(
          'CANDIDATE_FILES',
          'request.candidateFiles',
          'Expected at most 1000 workspace-relative forward-slash file paths.',
        );
      const status = gitOutput(root, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=normal',
      ]);
      selected = selectWorkflow(config, prompt, files as string[], {
        git: status !== undefined,
        dirty: Boolean(status),
      }).workflow;
    } else if (data.event === 'restore' && data.resumeWorkflow !== undefined) {
      const id = identifier(data.resumeWorkflow, 'request.resumeWorkflow');
      if (config.workflows[id]) selected = id;
    }
    return {
      version: 1,
      ok: true,
      diagnostics: [],
      commonProse: selected ? validated.get(selected)! : '',
      ...(selected ? { selected } : {}),
      invocations: selected
        ? [...new Set(Object.values(config.slots))].sort().map((id) => ({
            id,
            invocation: invocations.get(id)!,
            path: installed.get(id)!.path,
          }))
        : [],
    };
  } catch (error) {
    return runtimeFailure(error);
  }
}
