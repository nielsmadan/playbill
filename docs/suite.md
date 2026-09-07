# Bundled workflows

The package ships four workflows and ten technique skills. With an adapter loaded,
an empty project `.playbill/config.toml` inherits the bundled configuration. The
current user request supplies the brief; no `TASK.md` or generated project scaffold
is required. For example, `Fix the duplicate handling in the parser` selects debug.

| Workflow | Automatic keywords or phrases            | Priority | Behavior                                                                                                                          |
| -------- | ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| longshot | `longshot`, `work on this independently` | 40       | Settle material decisions, plan up to 20 tasks, implement and independently review each, verify, then review the complete change. |
| review   | `review`, `code review`                  | 30       | Capture scope, read project guidance, obtain one fresh read-only review, and report findings.                                     |
| plan     | `plan`, `implementation plan`            | 20       | Obtain a fresh read-only plan, resolve material decisions, and implement up to 12 tasks when authorized.                          |
| debug    | `debug`, `fix`, `investigate bug`        | 10       | Reproduce in the current context, apply and check up to three supported corrections, reassess failures, and report evidence.      |

Matching is literal and case-insensitive, with word boundaries. When several
workflows match, the highest priority wins. Explicit entry, such as
`[playbill:debug] Investigate the parser`, takes precedence. The
[format reference](formats.md#configuration) defines selection precisely.

Entry selects instructions. It grants no permission for Git mutations, global
settings, publication, or external messages. The actual request and repository
instructions determine authorized work. A review request yields findings rather
than permission to apply fixes. Planning honors previous approvals and collects
only unresolved material decisions; when implementation approval is missing, the
concrete plan is presented once before implementation. A request for a plan only
remains a planning task.

## Replace bindings and entry policy

All default steps use named slots. A project can replace the final reviewer while
keeping every pipeline unchanged:

```toml
[slots]
final_review = "company/custom@v1"

[workflows.debug]
entry = "explicit"

[workflows.longshot]
entry = "disabled"
```

Install the replacement through the host's registry or supply its documented
attested inventory; a binding does not install anything. Its contracts must match
the consuming steps. Both task and final review default to the same technique,
but `task_review` and `final_review` can be replaced independently.

To change order, delegation, caps, or artifacts, copy the corresponding YAML file
from `defaults/pipelines/` into `.playbill/pipelines/` and edit the whole file.
Keep its workflow `id`. The project file replaces that pipeline completely;
neither nodes nor artifact lists merge. Configuration layers remain bundled,
machine, then project, with the project winning.

Playbill's `disabled` and `explicit` settings govern entry through Playbill only.
A host can independently advertise or invoke a native skill outside Playbill.
Use the host's own skill visibility settings to control that separate behavior.

## Technique inventory

The directory and frontmatter names match. All native names begin with `playbill-`
to avoid common personal skills such as `plan` and `code-review` shadowing the
bundle in hosts with first-name precedence. Canonical IDs follow the same rule
on all four hosts: `playbill:<frontmatter-name>`, for example
`playbill:playbill-plan`. Native invocation identities remain host-specific.

| Slot                      | Bundled technique name | Purpose                                                                      |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| brief                     | playbill-brief         | Capture the request, acceptance criteria, boundaries, and prior approvals.   |
| read_docs                 | playbill-read-docs     | Find applicable project guidance and verification commands.                  |
| decisions                 | playbill-blind-spots   | Identify material design choices in dependency order.                        |
| plan                      | playbill-plan          | Ground ordered tasks and acceptance checks in actual files.                  |
| implement                 | playbill-implement     | Make scoped changes or corrections and record evidence.                      |
| task_review, final_review | playbill-code-review   | Return actionable specification and quality findings.                        |
| investigate               | playbill-debug-log     | Reproduce and distinguish hypotheses with targeted observations.             |
| diagnose                  | playbill-hard-fix      | Explain failed attempts and choose a discriminating experiment.              |
| verify                    | playbill-verify        | Run original reproductions and relevant checks, retaining complete outcomes. |
| report                    | playbill-report        | Preserve cumulative evidence and produce an honest handoff.                  |

These techniques were distilled from the author's 49-skill loadout collection,
especially longshot, plan, blind-spots, code-review, read-docs, debug-log, and
hard-fix. The suite includes only the four workflows' dependencies. Ordering,
conditional approval, iteration limits, and delegation live in YAML. Skill files
contain no nested skill calls, workflow fan-out, provider model names, or inherited
commit consent.

The native appendix tells the coordinator to supply the current step's title and
instruction, task string (the current collection item or initiating request),
input/output artifact paths, and declared agent scope when applying a technique.
Claude receives these through the Skill tool's `args`; its documented argument
expansion appends arguments to a skill body when no placeholder consumes them.
See [Claude's skill arguments](https://code.claude.com/docs/en/skills#pass-arguments-to-skills).
Codex and Pi apply that context after reading the registered skill. OpenCode applies
it after its native `skill` tool loads the skill; that tool receives its supported
`name` field. The guidance has fixed size and does not duplicate pipeline steps.
It instructs the model's handoff; the adapter does not execute or supervise steps.

## Artifacts and execution limits

Artifacts live under `.playbill/<workflow>/`, relative to the project root named
in the native context. Each brief captures the initiating request. Plans use a
`tasks.json` collection containing a JSON array of task-description strings, with
detail in `plan.md`. Paths are fixed; there is no task-path interpolation.

Longshot, plan, and debug initialize `progress.md` before loops. Each iteration
appends the item's identity, changes, findings, and executable evidence before
reusing scratch files such as `work.md`, `checks.md`, or `findings.md`. Evidence
is copied into progress, since a link to a scratch report would later refer to a
different task. On continuation, existing decisions and completed tasks are
preserved. Different-task evidence is preserved before artifacts are replaced.

The model evaluates conditions and performs the steps. The validator checks
declared dependencies and capabilities; there is no runtime runner, enforced
loop counter, or automatic artifact persistence. Capped correction loops report
unresolved work honestly. Longshot stops implementation on failed acceptance
checks or unresolved material task findings after its correction cap. Final
reports retain remaining findings rather than declaring an incomplete task done.

Fresh contexts in longshot, plan, and review require actual permitted native
delegation or a separately launched fresh host session. Read-only planners and
reviewers return report text; the coordinator writes their declared output files.
They may inspect files and run non-mutating checks. Builds or tests that create
caches belong to the coordinator. A `capable` tier is a declared portable category,
not a provider model name or guarantee of quality.

Pi has no standard fresh-subagent tool. Debug uses the current context throughout
and works with ordinary reading, editing, and check execution capabilities. When
another workflow requires unavailable delegation, report the missing capability
before that step; substituting the coordinator would violate its contract.

Default complete contexts are tested with canonical/native mappings, artifact
root, restoration text, and Claude's coexistence warning. They fit Claude's
10,000 JavaScript-character limit and the other hosts' 16 KiB limits in the test
installation. Long custom paths, additional slot mappings, or expanded pipelines
can exceed those limits and receive the adapter's bounded diagnostic.

## Validate the actual installation files

After `npm ci && npm run build`, run from the package directory:

```sh
node dist/cli.js validate defaults/pipelines/longshot.yaml --config defaults/config.toml --registry defaults/registry.yaml
node dist/cli.js render defaults/pipelines/debug.yaml --config defaults/config.toml --registry defaults/registry.yaml
```

The bundled explicit `defaults/registry.yaml` resolves its relative paths against
that file and supplies the namespaced canonical IDs. This is filesystem evidence
for the core CLI, not proof that a running host registered those skills. Generic
`--skill-root skills` discovers bare frontmatter names and therefore does not
satisfy these default namespaced bindings. Native adapters supply their own
registry normalization and activation instructions.

`npm test` exercises the actual default files through configuration discovery and
all four normalization seams, including Pi's real loader beside personal skills,
arbitrary replacement IDs, disabled entry, whole-file replacement, and complete
context limits. These are deterministic file/SDK checks. They do not establish
model compliance or live OpenCode registration.

`node scripts/smoke/suite.mjs` is a separate paid Claude trial with the actual
plugin, native bundled discovery, empty project config, and original executable
regression checks. It creates a unique `.test-runs-suite-smoke-*` directory and
retains command, baseline, raw trace, usage, context, artifacts, and independent
verification. Each invocation starts a new paid trial, capped at 120 seconds,
24 turns, $2, and 2 MiB stdout. Results and limitations are recorded in
[the first trial](adapters/suite-smoke.json) and
[the invocation-context follow-up](adapters/suite-smoke-followup.json).

The first M4 trial failed workflow adherence. Claude received the
complete default debug context and activated `playbill:playbill-brief`, then fixed
the function directly, skipping the remaining required skill activations and all
six workflow artifacts. The original failing regression was preserved and all
five original checks passed independently afterward. The trial took 15.751 seconds,
six turns, and $0.1350988; none of its caps was reached. This
establishes task correction and one native activation, while leaving completion
of the default workflow unproven. The trace showed no context truncation or native
name mismatch and does not establish why the model skipped the steps.

The separately identified follow-up used the invocation-context guidance and
observer protocol described below. Claude correctly supplied the brief step's
arguments, including its output paths, and the native skill expansion included
them. It nevertheless activated only the brief skill, then directly corrected the
function and ran the passing checks. All six artifacts were absent at every
observed tool boundary; the model did not run the original failing reproduction.
The primary audit verified all eight native observation receipts, unchanged
original tests, and a separate five-test passing rerun. This trial took 21.025
seconds, six turns, and $0.1410998, with no cap reached.

Both default-workflow trials failed adherence. The follow-up confirms argument
delivery, but does not establish the cause of skipped steps. The install-and-go
workflow acceptance criterion remains unmet; passing task checks do not satisfy it.

The follow-up smoke protocol is version 1. It measures this fixture's five-step,
single-correction path: brief, reproduce, correct, verify, report. Each new trial
copies a fixture-only observer and supplies native `PreToolUse`, `PostToolUse`, and
`PostToolUseFailure` hooks through a local CLI settings file. The observer records
the solution, both original test files, and the six artifact files at tool
boundaries. Each snapshot is limited to 32 KiB per file; its receipt in the native
trace contains the snapshot hash and tool-use ID. `command.json` retains the
protocol version and observer source hash. All observer files remain in the
trial directory. Hooks collect observations without changing tool inputs,
results, permissions, or workflow instructions.

The verifier requires successful native activations, completed outputs before
the next activation, and actual tool execution between them. The original
standalone `node --test test.mjs` command must fail with four passes and one failure
during reproduction while the original solution remains intact. A solution change
must be observed during correction, followed by the same command passing all five
checks during verification. Every snapshot is checked against independently
retained original test bytes; the final solution must also pass an independent rerun. Artifacts must describe
this function and duplicate handling. Checks and progress record the check command
and observed outcomes, accepting equivalent summaries such as `5/5 passed; no
failures`. Progress preserves baseline and correction evidence. The final report
summarizes verified behavior and may link to checks or progress for executable
evidence. Reporting comes last and preserves the earlier outputs.

This protocol observes filesystem state, so Bash writes do not require a shell
parser. Only the exact standalone test command is recognized as execution of the
fixture checks. Missing receipts, changed test bytes, overlapping step work,
unsupported paths, placeholder reports, and artifacts created after their step
boundary fail verification. Offline regressions include a complete observed
trace with real checks and rejecting traces. Snapshot receipts are audit evidence,
not protection against a model deliberately falsifying local evidence. Text
anchors and counts establish fixture-specific content, not semantic diagnosis or
review quality; those still require reading the trace and artifacts. This narrow
verifier does not score correction retries or arbitrary workflows.

The original trial predates the observer protocol and retains its recorded failure.
Both trials' evidence files remain unchanged. Each future invocation creates a
separate paid experiment; it must retain these failures in the recorded outcomes.
