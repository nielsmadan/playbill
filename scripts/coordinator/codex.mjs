import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { activateNativeSkillRead, handleHook } from './core.mjs';
import { safePath } from './files.mjs';

export function nativeSkillRead(config, event) {
  if (event.tool_name !== 'Bash') return null;
  const command = event.tool_input?.command;
  if (typeof command !== 'string') return null;
  const match =
    /^cat\s+(?:--\s+)?(?:'([^']+)'|"([^"$`\\]+)"|([^\s'"|&;<>`$\\()]+))\s*$/u.exec(
      command,
    );
  if (!match) return null;
  let target;
  try {
    target = realpathSync(
      resolve(config.root, match[1] ?? match[2] ?? match[3]),
    );
  } catch {
    return null;
  }
  for (const [skill, path] of Object.entries(config.nativeSkills ?? {})) {
    if (target === realpathSync(safePath(config.root, path)))
      return { skill, path };
  }
  return null;
}

export async function handleCodexHook(config, event) {
  if (event.hook_event_name === 'SessionEnd') return {};
  let skillRead = null;
  const output = await handleHook(config, event, {
    nativeSkillRead: () => {
      skillRead = nativeSkillRead(config, event);
      return skillRead;
    },
  });
  if (
    skillRead &&
    event.hook_event_name === 'PostToolUse' &&
    typeof event.tool_response === 'string' &&
    event.tool_response ===
      readFileSync(safePath(config.root, skillRead.path), 'utf8')
  )
    return activateNativeSkillRead(
      config,
      event,
      skillRead.path,
      skillRead.skill,
    );
  return output;
}
