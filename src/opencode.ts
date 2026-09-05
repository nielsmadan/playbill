import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from '@opencode-ai/plugin';
import { AdapterSession, nativeContext } from './adapter-session.js';
import { fail } from './diagnostics.js';
import {
  bundledSkills,
  canonicalId,
  nativeSnapshot,
  normalizeNative,
  skillMetadata,
} from './native-inventory.js';
import { readText } from './parsing.js';
import { runtimeFailure } from './runtime.js';
import { record, text } from './schema.js';
import type { NativeSkill } from './runtime.js';

export function opencodeInventory(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): NativeSkill[] {
  if (!Array.isArray(input) || input.length > 1000)
    fail(
      'INVENTORY',
      'OpenCode commands',
      'Expected at most 1000 native commands.',
    );
  if (Buffer.byteLength(JSON.stringify(input)) > 2_097_152)
    fail(
      'LIMIT',
      'OpenCode commands',
      'Native command inventory exceeds 2 MiB.',
    );
  const commands = input.map((value: unknown) =>
    record(value, 'OpenCode command'),
  );
  const live = normalizeNative(
    commands
      .filter((command) => command.source === 'skill')
      .flatMap((command) => {
        const invocation = text(command.name, 'command.name');
        if (typeof command.template !== 'string')
          fail('INVENTORY', invocation, 'Expected native skill template text.');
        const template = command.template;
        const match =
          /\n\nBase directory for this skill: ([^\n]+)\nRelative paths in this skill \(e\.g\., scripts\/, references\/\) are relative to this base directory\.$/u.exec(
            template,
          );
        if (!match) return [];
        const path = realpathSync(join(match[1]!, 'SKILL.md'));
        const contents = readText(path)
          .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '')
          .trim();
        const metadata = skillMetadata(path);
        if (
          metadata.name !== invocation ||
          contents !== template.slice(0, match.index).trim()
        )
          fail(
            'INVENTORY',
            invocation,
            'Native command metadata disagrees with the installed skill file. Reload OpenCode or supply an attested inventory.',
          );
        return [
          {
            id: canonicalId(invocation, path),
            path,
            invocation,
            model_invocable: metadata.invocable,
            requires: {},
          },
        ];
      }),
  );
  if (!env.PLAYBILL_OPENCODE_INVENTORY) return live;
  return normalizeNative(
    nativeSnapshot(env.PLAYBILL_OPENCODE_INVENTORY, 'opencode').map((skill) => {
      const native = live.find(
        (entry) => entry.invocation === skill.invocation,
      );
      if (native && native.path !== skill.path)
        fail(
          'AMBIGUOUS_SKILL',
          skill.invocation,
          'Attested inventory conflicts with native skill location.',
        );
      return {
        ...skill,
        model_invocable:
          skill.model_invocable && (native?.model_invocable ?? true),
      };
    }),
  );
}

export const PlaybillPlugin: Plugin = async ({ client, directory }) => {
  const sessions = new Map<
    string,
    {
      session?: AdapterSession;
      prompt?: string;
      context: string;
      restore: boolean;
      generation: number;
      error?: string;
    }
  >();
  const get = (id: string) => {
    let state = sessions.get(id);
    if (!state) {
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
      state = {
        context: '',
        restore: true,
        generation: 0,
      };
      sessions.set(id, state);
    }
    return state;
  };
  const initialize = (id: string, state: ReturnType<typeof get>) =>
    (state.session ??= new AdapterSession('opencode', directory, id));
  const failure = (state: ReturnType<typeof get>, error: unknown) =>
    (state.context = state.session
      ? state.session.failure(error)
      : nativeContext('opencode', runtimeFailure(error)));
  const inventory = async () => {
    const result = await client.command.list({
      query: { directory },
      signal: AbortSignal.timeout(5000),
    });
    if (result.error)
      fail(
        'INVENTORY',
        'OpenCode command.list',
        'Native command discovery failed; verify the supplied client connection.',
      );
    return opencodeInventory(result.data);
  };
  return {
    async config(config) {
      const data = record(config, 'OpenCode config');
      const skills = record(data.skills ?? {}, 'OpenCode config.skills');
      const paths = skills.paths ?? [];
      if (
        !Array.isArray(paths) ||
        !paths.every((path: unknown) => typeof path === 'string')
      )
        fail(
          'INVENTORY',
          'OpenCode config.skills.paths',
          'Expected skill directory paths.',
        );
      Object.assign(config, {
        skills: { ...skills, paths: [...new Set([...paths, bundledSkills])] },
      });
    },
    async event({ event }) {
      if (event.type === 'session.created') {
        const id = event.properties.info.id;
        const state = get(id);
        const generation = ++state.generation;
        const current = () =>
          sessions.get(id) === state && state.generation === generation;
        delete state.prompt;
        state.restore = false;
        try {
          const session = initialize(id, state);
          const skills = await inventory();
          if (!current()) return;
          state.context = session.run('start', skills);
        } catch (error) {
          if (current()) state.error = failure(state, error);
        }
      } else if (event.type === 'session.compacted') {
        const state = get(event.properties.sessionID);
        state.generation++;
        state.restore = true;
      } else if (event.type === 'session.deleted') {
        sessions.delete(event.properties.info.id);
      }
    },
    async 'chat.message'(input) {
      const state = get(input.sessionID);
      state.generation++;
      delete state.prompt;
      state.restore = false;
    },
    async 'experimental.chat.messages.transform'(_input, output) {
      for (const message of output.messages)
        message.parts = message.parts.filter(
          (part) =>
            part.type !== 'text' || part.metadata?.playbill !== 'workflow-v1',
        );
      const user = output.messages.findLast(
        (message) =>
          message.info.role === 'user' &&
          message.parts.some(
            (part) => part.type === 'text' && !part.synthetic && !part.ignored,
          ),
      );
      const anchor =
        user ??
        output.messages.findLast((message) => message.info.role === 'user');
      if (!anchor) return;
      let context: string;
      const id = anchor.info.sessionID;
      const state = get(id);
      const generation = ++state.generation;
      const current = () =>
        sessions.get(id) === state && state.generation === generation;
      try {
        if (state.error) {
          context = state.error;
          delete state.error;
        } else {
          const session = initialize(id, state);
          if (user && state.prompt !== user.info.id && !state.restore) {
            const prompt = user.parts
              .filter(
                (part) =>
                  part.type === 'text' && !part.synthetic && !part.ignored,
              )
              .map((part) => (part.type === 'text' ? part.text : ''))
              .join('\n');
            const skills = await inventory();
            if (!current()) return;
            state.context = session.run('prompt', skills, prompt);
            state.prompt = user.info.id;
          } else if (state.restore) {
            const skills = await inventory();
            if (!current()) return;
            state.context = session.run('restore', skills);
            state.restore = false;
            if (user && state.prompt === undefined) {
              const prompt = user.parts
                .filter(
                  (part) =>
                    part.type === 'text' && !part.synthetic && !part.ignored,
                )
                .map((part) => (part.type === 'text' ? part.text : ''))
                .join('\n');
              if (!state.context) {
                const skills = await inventory();
                if (!current()) return;
                state.context = session.run('prompt', skills, prompt);
              }
              state.prompt = user.info.id;
            }
          }
          context = state.context;
        }
      } catch (error) {
        if (!current()) return;
        context = failure(state, error);
      }
      if (context)
        anchor.parts.push({
          id: `playbill-${anchor.info.id}`,
          sessionID: anchor.info.sessionID,
          messageID: anchor.info.id,
          type: 'text',
          synthetic: true,
          text: context,
          metadata: { playbill: 'workflow-v1' },
        });
    },
  };
};
