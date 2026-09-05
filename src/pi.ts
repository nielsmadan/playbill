import type {
  ExtensionAPI,
  ExtensionContext,
  Skill,
} from '@earendil-works/pi-coding-agent';
import { AdapterSession, nativeContext } from './adapter-session.js';
import { optionalPath } from './discovery.js';
import {
  bundledSkills,
  canonicalId,
  corroborateSnapshot,
  nativeSnapshot,
  normalizeNative,
} from './native-inventory.js';
import { runtimeFailure } from './runtime.js';
import type { NativeSkill } from './runtime.js';

export function piInventory(
  skills: Skill[],
  env: NodeJS.ProcessEnv = process.env,
): NativeSkill[] {
  const live = normalizeNative(
    skills.map((skill) => ({
      id: canonicalId(skill.name, skill.filePath),
      path: skill.filePath,
      invocation: skill.name,
      model_invocable: !skill.disableModelInvocation,
      requires: {},
    })),
  );
  return env.PLAYBILL_PI_INVENTORY
    ? corroborateSnapshot(nativeSnapshot(env.PLAYBILL_PI_INVENTORY, 'pi'), live)
    : live;
}

export default function playbill(pi: ExtensionAPI): void {
  let session: AdapterSession | undefined;
  let pending: 'start' | 'restore' | undefined = 'start';
  let context = '';
  let skills: Skill[] = [];
  const failure = (error: unknown) => {
    context = session
      ? session.failure(error)
      : nativeContext('pi', runtimeFailure(error));
  };
  const ready = (ctx: ExtensionContext, skills: Skill[]) => {
    session ??= new AdapterSession(
      'pi',
      ctx.cwd,
      ctx.sessionManager.getSessionId(),
    );
    const inventory = piInventory(skills);
    if (pending) {
      context = session.run(pending, inventory);
      pending = undefined;
      if (context.startsWith('Playbill configuration error:') && ctx.hasUI)
        ctx.ui.notify(context, 'error');
    }
    return inventory;
  };
  pi.on('resources_discover', () => ({
    skillPaths: optionalPath(bundledSkills) ? [bundledSkills] : [],
  }));
  pi.on('session_start', (event) => {
    session = undefined;
    context = '';
    skills = [];
    pending =
      event.reason === 'resume' || event.reason === 'reload'
        ? 'restore'
        : 'start';
  });
  pi.on('session_compact', () => {
    pending = 'restore';
  });
  pi.on('session_tree', () => {
    context = '';
    pending = 'start';
  });
  pi.on('before_agent_start', (event, ctx) => {
    try {
      skills = event.systemPromptOptions.skills ?? [];
      const inventory = ready(ctx, skills);
      context = session!.run('prompt', inventory, event.prompt);
    } catch (error) {
      failure(error);
    }
  });
  pi.on('context', (event, ctx) => {
    try {
      ready(ctx, skills);
    } catch (error) {
      failure(error);
    }
    const messages = event.messages.filter(
      (message) =>
        message.role !== 'custom' || message.customType !== 'playbill:workflow',
    );
    if (context)
      messages.push({
        role: 'custom',
        customType: 'playbill:workflow',
        content: context,
        display: false,
        timestamp: 0,
      });
    return { messages };
  });
}
