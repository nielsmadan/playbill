# Playbill M0 spike

These are throwaway fixtures for the [accepted M0 experiment](acceptance.md).
They inject a hand-written, four-step workflow and observe whole harness sessions.
The scripts do not execute workflow steps, inject reminders after mistakes, or
repair model output.

`fixtures/pipeline.md` is the rendered prose. The four `fixtures/skills/*/SKILL.md`
files contain short task techniques. `fixtures/tasks.mjs` defines five JavaScript
tasks and their positive executable assertions: clamp, distinct words, array
chunks, median, and category totals.

## Run and inspect

From the repository root, replay the archived evidence without model access:

```sh
node docs/spikes/replay.mjs
```

This checks the fixture syntax, executes canonical assertions against each saved
solution, and recomputes native skill activation and artifact/test ordering from
the portable tool evidence. Exit 0 means the accepted gate passes, 1 means it
fails, and 2 means the evidence replay disagrees or fixture syntax is invalid.
This verifies the recorded observation; it is not another live harness trial.

With the original ignored runtime directories present, regenerate the portable
evidence directly from raw harness JSONL and filesystem observations:

```sh
node docs/spikes/verify.mjs --write-report
```

To launch a fresh paid trial, use a task ID from `fixtures/tasks.mjs`:

```sh
node docs/spikes/run.mjs claude 01-clamp
```

Supported harness arguments are `claude`, `codex`, `pi`, and `opencode`. The runner
refuses to overwrite an existing run. `--probe` marks the single unscored plumbing
probe before launch. `batch.mjs claude pi` runs remaining fresh task slots
sequentially, preserving completed or blocked slots. Each model process has a
150-second limit.

## Evidence

`evidence/<harness>-<task>.json` includes the exact command, injected text,
successful tool calls and their raw line numbers, step artifacts and filesystem
snapshots, archived solution and original test, independent behavior-check
results, and available usage. Absolute repository paths are written as `<repo>`.
Raw JSONL and runtime-owned files remain under ignored `.spike-runs/` directories;
known credential patterns are redacted from captured stdout/stderr.

The grader requires successful skill activation, a completed artifact write
before the next skill activation, an observed nonempty artifact, and successful
`node test.mjs` calls inside implement, fix, and final-review steps. It also runs
the original task assertions independently and checks task-local test integrity.
An end-of-run completion claim supplies none of those checks.

## Harness seams

| Harness | Injection | Registry activation |
| --- | --- | --- |
| Claude Code | Inline plugin `SessionStart` additional context | Native `Skill` calls using the plugin namespace |
| Codex | Project `.codex/hooks.json` `SessionStart`, scoped CLI trust hash | Reads of registered `.agents/skills/*/SKILL.md` |
| Pi | Explicit extension `context` callback | Reads from the explicitly registered fixture skill directory |
| OpenCode | Project plugin message transform, config callback registers skills | Native `skill` tool; startup was blocked in this environment |

Claude uses `playbill-spike:pb-*` IDs; other fixtures use `pb-*`. This tests native
registry invocation with host-specific IDs. It does not establish the later
same-config, byte-identical rendering contract.

The adapter patterns follow
[superpowers](https://github.com/obra/superpowers): `hooks/session-start`,
`.pi/extensions/superpowers.ts`, and `.opencode/plugins/superpowers.js`. The
original MIT notice is preserved in `fixtures/LICENSE.superpowers`; its workflow
prose is not used.
