# Claude Code adapter

The reference adapter loads as a Claude Code plugin and invokes the shared Node
validator in a subprocess. It composes instructions; the model invokes skills
and carries out the workflow. Tested with Claude Code 2.1.261 and Node 24.16.0.

## Load from a checkout

```sh
npm ci
npm run build
claude plugin validate --json /absolute/path/to/playbill
claude --plugin-dir /absolute/path/to/playbill
```

Load the plugin through Claude's normal local-plugin/trust mechanism. A checkout
needs `dist/` and `node_modules/`; the hook reports an actionable build error if
the compiled adapter cannot load. The manifest points directly at
`adapters/claude/hooks.json`. The two commands quote `CLAUDE_PLUGIN_ROOT` and send
hook JSON through stdin; user text and configuration paths never become shell
commands. This milestone does not ship the full default workflow suite.

`SessionStart` validates all configured bindings and workflows. It does not
select a workflow from startup metadata. `UserPromptSubmit` repeats discovery and
validation, then selects from the actual submitted prompt. Invalid declarations
produce model context and a visible `systemMessage` with diagnostics; the event
contains no runnable pipeline. The hook exits 0 to deliver that JSON; it does not
block the user's request. Changes take effect at the next relevant hook.

## Configuration and project roots

The directories below contain `config.toml` and optional `pipelines/*.yaml` or
`pipelines/*.yml`. They apply in increasing precedence:

1. The plugin's `defaults/` directory, reserved for the bundled suite.
2. `$XDG_CONFIG_HOME/playbill`, or `~/.config/playbill` when XDG is unset.
3. `<project-root>/.playbill`.

Config tables merge by key, scalar values override, and arrays replace, including
empty arrays. Every config layer is validated. YAML documents are parsed
individually and replace a lower layer's entire pipeline by its `id`. Two files
with the same ID within one layer are ambiguous. Configured workflow IDs require
a pipeline, including disabled workflows. Every configured slot binding is
validated even when no workflow uses it. Missing optional directories/files are
fine; unreadable, malformed, or oversized files are errors.

Normal project discovery uses Git's toplevel directory, including worktrees and
launches in subdirectories. Outside Git, it uses the nearest ancestor containing
`.playbill`, then the launch directory if none exists. Git status includes
untracked files and runs without optional locks. Git failures other than an
ordinary non-repository result are diagnostics.

All Playbill path overrides must be absolute. They select locations to read, not
paths created or installed by the adapter:

| Variable                    | Meaning                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `PLAYBILL_PROJECT_ROOT`     | Replaces root discovery; must exist and contain hook cwd. Useful for an isolated workspace inside a larger checkout. |
| `PLAYBILL_MACHINE_DIR`      | Replaces the machine layer directory. A missing directory means an empty machine layer.                              |
| `PLAYBILL_DEFAULTS_DIR`     | Replaces the bundled lowest-priority directory. A missing directory supplies no defaults.                            |
| `PLAYBILL_CLAUDE_INVENTORY` | Replaces automatic native-skill discovery with an attested YAML/JSON inventory file, described below.                |
| `PLAYBILL_STATE_DIR`        | Replaces the writable session-state directory.                                                                       |

`CLAUDE_CONFIG_DIR` selects Claude's personal configuration/skills directory,
defaulting to `~/.claude`. Setting discovery overrides does not configure Claude
itself or change what it has installed. Tests put every fixture and state file
inside this checkout and use `PLAYBILL_PROJECT_ROOT`; they do not initialize Git
repositories or modify global configuration.

## Requests and trigger files

The cross-host explicit syntax is a marker at the start of the user request,
with optional leading whitespace:

```text
[playbill:coding] Implement the task in TASK.md.
```

This is literal request text. Workflow IDs are case-sensitive. A malformed,
missing, or disabled explicit target produces a diagnostic and cannot fall
through to an automatic workflow. Explicit selection bypasses automatic trigger
guards. All other selection rules follow [the shared format](../formats.md#configuration):
bounded case-insensitive literal phrases; portable case-sensitive globs; all
repository guards; highest priority followed by ascending code-point ID.

Claude candidate files are workspace-relative forward-slash paths enclosed in
single backticks in the submitted prompt, for example `src/widget.ts`. They can
refer to files that do not exist yet. Plain words, attached file internals, shell
output, Git's full file list, and files elsewhere in the workspace are not
candidate inputs. Absolute and traversal paths are excluded. A shared runtime
caller can instead provide an explicit `candidateFiles` array; that array
replaces prompt extraction, including when empty. Paths are relative to the
project root, even when Claude starts below it.

## Native skills and the inventory contract

Automatic discovery supports ordinary `SKILL.md` directories under
`.claude/skills` from the launch directory through the project root, personal
skills under `CLAUDE_CONFIG_DIR/skills`, and this plugin's own `skills/` directory.
Personal skills override project identities. Duplicate project identities across
ancestry are rejected with explicit-inventory guidance. Subdirectories below
the launch cwd may load lazily in Claude and are not assumed available.

The scanner uses YAML frontmatter identity, requires supported lowercase
letter/digit/hyphen names, and preserves `disable-model-invocation: true`.
Ordinary automatic installations require the skill directory name to equal the
frontmatter name. A mismatched entry is unavailable for bindings and includes
repair guidance; an unbound mismatch does not disable other workflows. The
conservative equality rule follows the concrete naming discrepancy in the smoke
evidence below. Boolean metadata must use YAML `true`/`false` in this supported
subset.

Project and personal `settings.json`, plus project `settings.local.json`, provide
known `skillOverrides`: `off` and `user-invocable-only` make ordinary skills
unavailable for model invocation; `on` and `name-only` preserve frontmatter
eligibility. Claude does not apply this setting to plugin skills. The scanner
does not implement Claude's complete settings resolver. Enterprise, synced,
session flags, `--settings`, `--setting-sources`, `--add-dir`, skill-directory
plugins, legacy command files, and foreign plugins require an explicit inventory
when they affect bindings. Reserved `synced` directories and skill-directory
plugin roots are excluded from ordinary scanning. Arbitrary matching files do
not establish native installation.

Claude hooks supply no authoritative native inventory. `claude plugin list
--json` includes other projects, and its enabled flags did not reflect
`--setting-sources` in local reconnaissance. Playbill therefore does not use
that command as proof of live registration. For unsupported native sources,
provide a normalized inventory representing the actual intended session:

```yaml
version: 1
skills:
  - id: company:review
    path: /installed/company-plugin/skills/review/SKILL.md
    invocation: company:review
    model_invocable: true
    requires: { fresh: true, read_only: true, model: capable }
```

Paths resolve relative to the inventory file and must be readable, nonempty,
regular `SKILL.md` files. Frontmatter is still required. The invocation's last
component must match either the frontmatter name or the installed directory
name; an optional namespace identifies the plugin or nested directory.
For symlink installations, this directory name comes from the resolved inventory
path before following symlinks. Registry paths and ambiguity checks use the
canonical target file.
The inventory author attests the actual native invocation. Canonical IDs may be
explicit aliases and remain independent from native invocation text. Duplicate
IDs or one native invocation targeting different files fail as ambiguous. The
snapshot cannot enable a frontmatter-disabled skill.

The inventory is a discovery assertion, not evidence of tool permission or a
query of live host registration. Claude can still deny a Skill call. Configure
the host's installation and permission settings normally and keep the snapshot
current. A filesystem snapshot cannot reproduce managed or session-only state.

Common pipeline prose contains only canonical skill IDs. A separate Claude
appendix maps each ID to `Skill`'s `skill` argument, including namespace-qualified
plugin names such as `company:review`. Other adapters can return byte-identical
`commonProse` while supplying a different invocation appendix. Declarative
agent contracts do not create host capabilities or fresh agents.

## Sessions and coexistence

Session state contains only a schema version, the last selected workflow ID, and
a Superpowers-warning flag. On `SessionStart` with `source: compact` or `resume`,
the adapter revalidates and restores the selected workflow reference and asks the
model to continue from its conversation summary and artifacts. It stores no
step number, artifact content, prompt, or rendered prose. Repeated restoration
events may repeat the reference but do not reset execution progress.

Changing entry policy after selection affects future entry only: compaction can
restore an already-entered workflow even after its policy becomes disabled.
An invalid configuration or failed explicit request clears the saved selection;
repairing configuration does not revive an old successful rendering. Startup,
clear, and fork start without a selected workflow. Unmatched continuation prompts
retain the selection for later restoration. This is context memory, not a runner.

Default state lives under `CLAUDE_PLUGIN_DATA/sessions` when supplied, otherwise
under the OS temporary directory in `playbill-<uid>/sessions`. Session/root IDs
are hashed into filenames. Each file is bounded to 4 KiB; the store retains at
most 128 session records and prunes records older than seven days when writing.
Atomic replacement avoids partial JSON writes. Hook events for a given session
are expected in host event order; this is not a multiprocess coordination service.

A `superpowers@...` plugin enabled in observed settings is evidence of a likely
bootstrap, with an explicit caveat that launch and managed settings may differ.
Installation or a `using-superpowers` skill file alone does not produce a warning.
An explicit inventory can supply stronger evidence:

```yaml
superpowers_bootstrap:
  status: active
  evidence: Session integration observed the Superpowers startup hook.
```

`status` accepts `active` or `likely`. The warning appears once per saved session
and never refuses coexistence. Configure or remove overlapping instructions using
the host's normal configuration when needed.

## Runtime boundary and limits

Every adapter calls the same `dist/runtime-cli.js` through `invokeRuntime`.
Its version-1 JSON request carries `cwd`, `event` (`start`, `prompt`, `restore`),
normalized `inventory`, optional discovery directories, and optional prompt,
candidate files, or workflow ID to restore. `NativeSkill` extends the shared
installed-skill entry with `invocation` and an optional `unavailableReason`.
`invokeRuntime(request, nodeExecutable?)` lets non-Node hosts select an actual
Node executable. The default is the current Node executable.

The response separates `ok`, `diagnostics`, `commonProse`, `selected`, and
`invocations`. Runtime process exit is 0 for valid input and 1 for diagnostics.
No pipeline is returned on failure. Public types and discovery/trigger helpers
are exported from `src/index.ts` for adapter integration and public tests.

Input is limited to 256 KiB with a two-second stdin deadline, prompt text to
64 KiB, subprocess response to 512 KiB, and validator runtime to five seconds.
Each Git read has a two-second/256 KiB limit. Each config layer has at most 128
pipeline files; native inventories have at most 1,000 skills. Existing source,
AST, and rendering bounds still apply. Claude's complete pipeline and mapping
appendix, including any warning and restoration text, must fit **10,000
characters** in `additionalContext`. The adapter counts UTF-16 code units
conservatively with JavaScript string length, separately from the shared 64 KiB
rendering bound. Claude replaces larger hook strings with a preview and file
reference ([native JSON output limit](https://code.claude.com/docs/en/hooks#json-output));
Playbill instead reports a bounded diagnostic and clears the saved workflow
selection. It never delivers a partial workflow. Diagnostic text is capped
separately to 8,192 characters, and both final `additionalContext` and
`systemMessage` strings stay within the native limit. An undelivered coexistence
warning remains pending for the next event. Hook
commands have a ten-second host timeout. A host timeout can prevent any context
from being delivered and appears as a host hook error.

## Verification and sources

`npm test` exercises public trigger/root APIs, the actual shared subprocess, and
production hook commands. Coverage includes config precedence/replacement,
live edits, startup binding errors, file/repo triggers, explicit/auto/disabled
entry, namespace mappings, permissions, JSON escaping, repeated events,
compaction, warning scope, and bounds. The manifest validates with installed
`claude plugin validate --json`; its only advisory is missing author metadata.

The paid smoke command is `node scripts/smoke/claude.mjs` after building. It creates
an isolated fixture, loads this production plugin with `--plugin-dir`, records
its exact argv and environment overrides in `command.json`, and bounds the call
to 120 seconds, 12 turns, $2, and 2 MiB stdout. It correlates a Skill tool use to a
successful tool result, checks the injected mapping, verifies the skill-only
receipt, compares task checks to their original bytes/hash, and independently
runs those checks after Claude exits. This command is deliberately excluded from
the test directories so neither `npm test` nor Node's default test discovery can
start a paid run. See the retained
[sanitized smoke evidence](claude-smoke.json).

The first trial found that Claude 2.1.261 advertised and invoked `implementation`
for a directory with that name whose frontmatter said
`playbill-smoke-implement`. The injected mapping used the frontmatter name and
therefore failed the seam assertion, despite successful native activation and
independent 4/4 task checks. This observed discrepancy with documentation led to
the conservative automatic-discovery contract above. A separately approved
retry uses matching directory/frontmatter/native names. It passed: the injected
`playbill-smoke-implement` mapping matched a successful native Skill result,
the original task checks were intact, and independent verification passed 4/4.
Both trials remain in the evidence; no M0 experiments were changed or rerun.

Primary references checked 2026-09-05: [Claude hooks](https://code.claude.com/docs/en/hooks)
for event payloads, additional context and compaction sources;
[Claude skills](https://code.claude.com/docs/en/skills) for discovery, frontmatter,
namespaces, precedence, visibility, and invocation permission;
[plugin reference](https://code.claude.com/docs/en/plugins-reference) for manifest
hook paths, plugin loading, and validation. These describe a broader host feature
set than this adapter's supported discovery subset. The real smoke result takes
precedence where its observed naming differs.
