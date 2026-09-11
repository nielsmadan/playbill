# Installed native coordinator

The bundled debug workflow enables the existing coordinator on Claude and Codex.
An empty machine/project configuration selects the bundled YAML on matching or
explicit prompts. The first selected `UserPromptSubmit` initializes the run with
its native session identity. Other workflows and Pi/OpenCode retain rendered
instruction delivery.

The compiler consumes the validated pipeline and installed skill inventory. It
lowers steps, `if`, and bounded `while` into the existing graph; it does not use
fixed debug step names. Conditions become decision visits. Before each branch,
including the first loop entry, the agent records the current visit token,
condition ID, boolean and rationale with `decide`. Stale visit tokens and wrong
condition identities are rejected. If a transition fails after recording its
decision, repair the cause and retry `decide` with the same value and rationale,
or use the `complete` command shown in status. The original decision and failure
evidence are retained. A false condition exits immediately; debug's
three-attempt cap remains a hard graph bound. A decision is an agent judgment,
not a native skill activation or a successful test.

Each technique visit requires a successful native receipt. Claude uses the
registered Skill invocation while retaining the canonical technique ID. Codex
requires a paired native Bash receipt for the emitted full-file `cat` command
whose response exactly matches the registered file bytes. Spaces and apostrophes
in paths are supported. Aliases sharing one file resolve to the current visit's
canonical skill ID. Installed skill files may live outside the project; they
must resolve to readable regular files. Project artifacts retain their separate
relative-path and symlink protections.

Completion requires fresh nonempty output artifacts and existing consumed
artifacts. Debug's `report_artifact = "report"` policy appends generated execution
history and preserves the report's original narrative. The history includes
native shell receipts and recorded condition decisions; it does not infer process
outcomes from shell text. The default policy supplies no configured check command,
watched source/input hashes, or external report signer. Actual project checks and
repair correctness remain the agent's work and need independent assessment.

State is isolated by native host, canonical project root, native session ID and a
new run ID. The current pointer lives below
`.playbill/coordinator/sessions/<identity>/current.json`. Each run retains an
immutable config and pointer plus its own runtime state, journal, and evidence
snapshots under that session's `runs/<run-id>/`. The pointer pins the config hash;
changes fail without resetting prior evidence. CLI commands resolve the installed
coordinator module, and both hooks and CLI accept a cwd below the project root.

`artifact_scope = "run"` moves declared scratch artifacts below
`.playbill/runs/<identity>/<run-id>/artifacts/<declared-path>`. Bundled debug requests
this explicitly. Custom workflows default to `project` and retain their declared
paths; cross-session writes to custom project paths remain the author's choice.
Run scope rejects existing input artifacts because relocating them would change
their meaning. Run evidence is retained rather than pruned by the rendered
workflow's temporary selection store.

Existing runs route before inventory discovery or new trigger selection.
Compaction/resume restores their frozen workflow and current visit. Conversation
controls preserve the existing `pause`, `resume`, `exit`, and token-bound `intent`
commands, including epoch checks on delayed receipts. Related questions permit a
read-only turn; redirects pause immediately. Engaged guidance exposes `pause` and
prioritizes a user's requested wait boundary over later branch decisions or visit
completion. The retained visit resumes after the user returns or authorizes work.
`redirect_threshold` (2–20, default 2)
and `ask_on_redirect` (default true) configure the repeated-redirect choice.
After exit or completion, ordinary prompts remain quiet. An explicit
`[playbill:workflow-id]` prompt can start a fresh run with separate evidence.

Unsupported coordinated `switch`, `for_each`, collections, fresh-agent contracts,
and graphs exceeding 100 lowered nodes produce explicit diagnostics. Set
`coordination.enabled = false` for rendered delivery. Run configuration is frozen
at selection, so later configuration changes apply to new entries.

`npm pack` includes coordinator modules and bundled runtime dependencies. Offline
tests exercise package extraction outside the checkout, native receipt boundaries,
conditional routes, the loop cap, stale decisions, isolation, released behavior,
and restore from a subdirectory. The packed native smoke and its acceptance are
recorded in [installation evidence](installed-coordinator-acceptance.md); offline
checks alone do not establish native model adherence.
