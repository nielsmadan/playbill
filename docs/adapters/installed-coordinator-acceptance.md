# Installed coordinator acceptance

The local M4 installation gate passed on 2026-09-11 after independent review.
This record evaluates a
packed default debug workflow with empty Playbill configuration. It does not
estimate adherence across projects, models, or repeated runs.

## Setup

Both attempts use Codex 0.154.0, `gpt-6-astra` at `xhigh`, driven through
claude-session-driver 4.0.0. No Claude model calls are made. The existing tmux
server is checked before every operation; a wrapper prevents starting another
server. Each worker has a fresh temporary Codex home and a separate task folder
inside an already trusted repository.

The controller runs `npm pack`, extracts the archive into a local marketplace,
and installs it through Codex's native plugin CLI. The installed plugin uses its
own hooks, coordinator modules, and bundled YAML/TOML dependencies. File hashes
identify the candidate and check the native cache before and after execution.
There are no project Playbill settings, machine settings, workflow replacements,
or supplied skill inventory. A project-root override scopes the nested fixture.
Codex can also expose account-level plugins in a fresh local home; Superpowers
was visible, and the second worker read its guidance.

The task is a contained historical audio-player bug. The source, supplied tests,
runner, configuration, and dependencies are copied into the worker directory.
The supplied reproduction contains diagnostic comments. The worker is asked to
repair from that reproduction; it is not a blind bug-discovery task. Baseline
checks produce 13 passes and two failures before each run. The three prompts ask
for diagnosis followed by a pause, a related question while paused, and authorized
correction after a real `/compact`.

Worker restrictions prohibit other checkouts, machine/session logs, history,
external services, dependency installation, subagents, and Git commands. These are
audited instructions, not a filesystem security boundary. The controller retains
native tool inputs and outputs, exact prompt receipts, workflow state, generated
history, artifact snapshots, and independent post-run checks. An additional
retry-render assertion is kept outside the worker until it stops.

## First attempt

Candidate SHA-256:
`a48a4125719d8e2d77c3554dc27288e77fd999ccbabc42b59de8bee505c375e1`.
Evidence: `.test-runs-installed-debug-a3fp8tqu/controller/`.
Native session: `01a08d89-76ce-7901-916a-5de67c551b37`.

Installation and delivery passed. All 398 installed files matched the archive,
the first prompt matched exactly, all 22 tools had post receipts, and all frozen
worker inputs remained unchanged. The tool audit found no solution lookup or
tampering. Capture and reproduction completed with the correct failing baseline
and a grounded diagnosis.

Pause handling failed. The worker interpreted missing correction authorization
as a false loop condition, reported, and completed the run while describing its
work as paused. No player code changed, but the resumable visit was lost. The
controller stopped after this first turn and preserved the failure.

The engaged conversation guidance omitted the existing `pause` command. The fix
adds that command and gives an explicit user-requested wait precedence over
further branch decisions or completion. YAML, skills, task prompts, source, and
supplied checks remain identical. Independent review accepted the change.

## Repetition

Candidate SHA-256:
`d806524b9c870e3729f93d70666ffaa25f4dbfa485105f55413c42b1478ecc2a`.
Evidence: `.test-runs-installed-debug-repeat-81yp4m6g/controller/`.
Native session: `01a08d9a-b5b9-76b1-ae94-9f1c8585162b`.

Only `scripts/coordinator/conversation.mjs` differs between the two packed
candidates. Root ran `npm run check-all && npm test` before packing: 225 tests
passed, with zero failures, cancellations, skips, or todos. Installed-adapter
tests cover both native hosts, two-session isolation, branching and loop limits,
and preserving an undecided visit through pause, question, compact, and return.
The new pause regressions failed before the guidance change and passed after it.

The native repetition completed all three turns. The controller then stopped the
worker, retained its evidence, and confirmed the original tmux server remained.

| Boundary                          | Observed result                                                              |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Diagnosis and requested wait      | Paused at reproduction visit `v2`; all 11 frozen input files unchanged       |
| Related question                  | Answered read-only; identical visit and completed history                    |
| Real compaction and authorization | One compaction; same native session, run, and visit resumed                  |
| Correction                        | One source correction, after the implementation skill receipt                |
| Verification                      | Supplied suite: 15/15; separate regressions: 5/5                             |
| Handoff                           | Report skill activated; report and generated history retained; run completed |

The completed route has eight visits: capture, reproduce, loop-entry decision,
correct, recheck, reassessment decision, next loop-entry decision, and report.
The decisions are true, false, and false, respectively. All five technique visits
have exact native skill-read receipts. No visit has a recorded violation. There
are 50 pre/post tool pairs and three exact user prompts. No Stop block was needed;
native blocking behavior is therefore not established by this run.

Root read every tool input and the full test outputs. No source-history,
controller/solution, machine-log, or other-checkout lookup was observed, nor any
test or harness tampering. Ten protected files remained unchanged after correction;
the player hook is the intended changed input. All 398 installed files still match
the frozen archive, and the frozen controller files are unchanged. The shipped
history command independently validated retained state, journal, report and
history evidence with exit 0, preserving every runtime file byte.

After shutdown, root independently reran `node .replay/test.cjs`: 15/15, exit 0.
The withheld probe adds a second render while retry still carries the old status
object, in a controller-owned copy of the supplied test. It also passed 15/15,
exit 0. The actual added assertion was checked in the generated test, and the
supplied worker test was preserved. This covers the known extra retry failure
missed by several earlier repairs. It does not establish native audio correctness
outside the mocked event model.

The report preserves all four worker test executions: supplied baseline 13/2,
added regression baseline 0/5, supplied correction 15/0, and added correction 5/0.
Native shell receipts are separate from configured coordinator checks, of which
there are zero under empty configuration. Generated history preserves raw receipt
references; it does not certify the agent's narrative by itself.

Key retained files beneath the second controller directory:

- `package-metadata.json`, `packed-files.json`, `installed-before.json`, and
  `installed-final.json`: exact candidate and installation integrity.
- `root-preflight.json`: full local checks, review, and single-file candidate diff.
- `manifest.json`, `rubric.json`, `frozen-controller.json`, and `frozen-worker.json`:
  task, acceptance criteria, and protected bytes.
- `native-final.jsonl`, `native-hooks.jsonl`, and `states-turn-*.json`: native
  execution, prompt receipts, pause/question snapshots, and completion.
- `paused-integrity.json`, `integrity-audit.json`, and
  `independent-history-command.json`: independent structure and evidence checks.
- `independent-supplied-command.json`, `independent-supplied-result.json`, and
  `repeated-status-probe/command.json`: post-shutdown verification.

## Interpretation and remaining coverage

Independent review accepted the scoped local installed-debug result with no
blocking findings; `independent-review.json` records the verdict. M4/T4.5 is
complete. M5 documentation, distribution, and whole-branch review remain separate.
The successful repetition is one installed Codex observation, with substantive
Superpowers guidance also read.
It cannot isolate the pause sentence as the cause of success, establish a
reliability rate, or stand in for a fresh native Claude trial. Both attempts remain
in the record. The controller normalizes CSD's unrelated Stop acknowledgement to
an empty object; it does not change or simulate Playbill's installed hooks.

Session isolation, explicit exit, repeated-redirect choices, stale commands,
branch alternatives, loop caps, and compatibility restores have offline adapter
coverage. This native run covers automatic entry, pause, question, compaction,
return, correction, and completion. The default policy validates skill receipts,
artifact freshness, and decisions; it supplies neither an external report signer
nor project-specific source guards or executable check policy.

## Recorded work and usage

Five collaboration agents handled reconnaissance, implementation, independent
review, and two focused fixes; the reviewer was reused for each fix and native
acceptance. Two native Codex workers ran sequentially. No Claude model calls were
made. Collaboration-agent and root usage were not available for this report.

| Native attempt       | Responses | Input tokens | Cached input (included) | Output tokens | Total tokens |
| -------------------- | --------: | -----------: | ----------------------: | ------------: | -----------: |
| Failed pause attempt |        12 |      525,496 |                 454,400 |         7,682 |      533,178 |
| Completed repetition |        36 |    1,807,441 |               1,648,896 |        23,082 |    1,830,523 |

Each `native-usage.json` sums unique response records and matches the final native
thread total. Cached input is a subset of input, and reasoning output is a subset
of output. These are whole-worker totals, including repeated context; they are
not the marginal cost of hook injection and exclude root/reviewer work.
