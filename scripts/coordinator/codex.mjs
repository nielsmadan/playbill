import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { activateNativeSkillRead, handleHook } from './core.mjs';
import { commandWords, skillFile } from './files.mjs';

export function nativeSkillRead(config, event, currentSkill) {
  if (event.tool_name !== 'Bash') return null;
  const command = event.tool_input?.command;
  if (typeof command !== 'string') return null;
  const words = commandWords(command);
  if (words?.[0] !== 'cat') return null;
  if (words[1] === '--') words.splice(1, 1);
  if (words.length !== 2 || words[1].startsWith('-')) return null;
  let target;
  try {
    target = realpathSync(resolve(config.root, words[1]));
  } catch {
    return null;
  }
  let match = null;
  for (const [skill, path] of Object.entries(config.nativeSkills ?? {})) {
    if (target === realpathSync(skillFile(config, path))) {
      const candidate = { skill, path };
      if (skill === currentSkill) return candidate;
      match ??= candidate;
    }
  }
  return match;
}

export async function handleCodexHook(config, event) {
  if (event.hook_event_name === 'SessionEnd') return {};
  let skillRead = null;
  const output = await handleHook(config, event, {
    nativeSkillRead: (currentSkill) => {
      skillRead = nativeSkillRead(config, event, currentSkill);
      return skillRead;
    },
  });
  if (
    skillRead &&
    event.hook_event_name === 'PostToolUse' &&
    typeof event.tool_response === 'string' &&
    event.tool_response ===
      readFileSync(skillFile(config, skillRead.path), 'utf8')
  )
    return activateNativeSkillRead(
      config,
      event,
      skillRead.path,
      skillRead.skill,
    );
  return output;
}
