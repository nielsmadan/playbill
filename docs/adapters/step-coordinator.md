# In-session coordinator experiment

This page records the historical prototype trials. The current installed behavior
is documented in [Installed native coordinator](installed-coordinator.md).

The final tested revision completed all five stages across a real pause, read-only status request, native compaction and generic resume. Its saved visit, history and artifact bytes survived. Full adherence remains incomplete: the model omitted a test execution from its final report, and an independent retry probe still failed.

This is an opt-in prototype in `scripts/coordinator/`, approved for iteration on 2026-09-07. The shipped adapters, default workflows and ten bundled technique skills are unchanged.

| Model trial                      | Progression and persistence                                                                                             | Original tests | Extra retry probe |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------- |
| 1: initial coordinator           | 5/5 stages; premature investigation and prohibited history reads                                                        | 15/15          | 14/15             |
| 2: narrower capture contract     | Correct capture before diagnosis; unintended early pause; saved position survived compaction; stopped before correction | 13/15          | 13/15             |
| 3: explicit continuation wording | 5/5 stages; all eight specified persistence checks pass; final report still omits direct baseline execution             | 15/15          | 14/15             |

Each row is a separate revision, not an unchanged repetition. The final revision has one live observation. These runs do not estimate long-term reliability.

## Mechanism

A frozen JSON graph owns the active visit, native technique name, artifact contract, check command and successor. Skills do not know which workflow contains them or which skill follows. Claude receives the current visit on prompt submission, after successful native Skill activation, after a CLI transition, and after native compact/resume restoration.

The generic CLI supports `status`, `check`, `complete <visit>`, `pause` and `resume`. Completion requires the exact visit token, a successful paired native Skill receipt, fresh nonempty artifact bytes and any required current check. It saves artifact snapshots before advancing. Failed checks select correction branches; process errors and stale evidence cannot count as successful verification.

Checks reserve a durable lease, execute outside the state lock, then revalidate and finalize. Raw stdout, stderr, process status, result files and source/input hashes survive scratch-file reuse. Status and read hooks remain responsive during checks. Inconsistent state, interrupted leases and changed configuration fail closed without resetting history.

Explicit premature source writes and out-of-order Skill calls are rejected at native tool boundaries. Source hashes detect changed watched files after shell operations. A bounded Stop hook asks for continuation while active; explicit pause, completed work and read-only status turns may end normally.

## What the mechanism proves

Mechanical progression and semantic work are scored separately. Native activation does not establish that a technique was followed; nonempty files do not establish accurate evidence. Each model trial therefore retains native tool inputs/results and observer receipts, snapshots artifacts at completion, independently reruns the original tests, and applies the existing extra retry-status probe outside the worker.

The coordinator runs with the worker's permissions. It is not an OS isolation boundary: arbitrary shell commands, newly added source paths, dependencies and malicious rewriting are outside its complete coverage. Native hooks bind the session; the standalone CLI's optional session environment check is not caller authentication. Read-only prompt recognition currently covers explicit phrases, not every natural-language request.

This graph is a bounded debug experiment, not an implementation of every YAML condition or all four native hosts.

## Validation and trial protocol

The frozen prototype passes 166 repository tests, including 28 coordinator tests, plus formatting, lint and type checks. Independent review found and resolved a long-check lock timeout. One earlier development-time full-suite run reported a state/journal integrity failure without retained fixture evidence; its cause remains unexplained. The final frozen full run passes.

Trials use CSD to drive Claude Sonnet 5, high effort, default tools, the existing authentication shim and the already-running tmux server. Each fresh worker contains a neutral single-commit historical repository with no remote, alternates or fix commits. Task bytes, supplied verification inputs and all ten technique files match the previous production control. Baseline: 13 passed, 2 failed, 15 assertions.

The experimental plugin changes two adapter files to install the coordinator. The graph and delivery are a mechanism package, so comparisons cannot attribute an effect to one sentence or hook. The previous three production repetitions are observational controls, not a randomized reliability estimate.

The persistence protocol automatically pauses after reproduction. It then sends a read-only status prompt, enters a real native `/compact`, waits for native restoration, sends a generic resume request, and finally requests read-only completed status. Position snapshots include actual artifact hashes, visit, history and session identity. Each prompt and turn is retained separately.

## Run ledger

- Initial launch, `.test-runs-coordinator-pilot-aos17xx2`: invalid before task delivery, zero tool calls, no coordinator runtime. The observed trust-dialog timeout is consistent with the wrapper displaying the dialog after CSD's five-second polling window; its later startup wait does not inspect the dialog again. The worker was stopped and the failed launch evidence preserved. Missing transcript/runtime capture errors are consequences of startup failure, not model adherence results.
- Harness correction: poll for the exact worker's visible trust dialog throughout launch, use a file lock and recheck the pane, verify the worker directory and affirmative selection before Enter. No task, technique or coordinator change. Four offline polling cases pass.
- First model trial, `.test-runs-coordinator-pilotb-64bcigdv`: five ordered activated visits, three recorded checks, 39 native tools/78 receipts, no coordinator interventions. The worker investigated and ran a direct test before writing the brief/progress, then inspected Git history twice despite the task restriction. Both history results contained only the neutral seed. It reported four worker test executions as three/all through the coordinator. Independent original suite: 15/15. Extra retry probe: 14/15, re-latching the old error on an additional rerender. Native reported cost: $1.4647324.
- Capture-contract iteration: retain the reusable brief skill, but narrow this graph visit to the supplied request, constraints and unknowns; require an empty evidence section and pending reproduction before source/test inspection or diagnostic execution.
- Second model trial, `.test-runs-coordinator-persistencec-yk1083gu`: brief/progress preceded source reads and checks, though a directory listing exceeded the literal top-level-only instruction. The worker mistook the advertised `Explicit pause` command for an instruction and paused after capture. Actual native compaction preserved that position/history/artifact bytes. A generic resume correctly continued reproduction, which then reached the configured automatic pause before correction. Two visits completed; implementation/verification/report were not reached. Both status turns preserved state, and the final answer correctly challenged the controller's premature completion premise. Original and extra suites remain 13/15 because source was unchanged. Native reported cost: $0.9806145.
- Continuation-wording iteration: ordinary active/in-flight context now says to continue the authorized workflow through returned visits until done or paused. It exposes status, while the pause API remains available without being advertised as an action in every visit. Paused context still permits resume only when requested. The revised code again passes all 166 repository tests and checks.
- Third and final model trial, `.test-runs-coordinator-persistencee-sxa2f_q6`: five ordered activated visits, 40 native tools/80 receipts, three recorded checks and no guard/Stop-block interventions. Capture artifacts preceded source reads and diagnosis; a source-path listing still exceeded the literal capture instruction. All eight persistence checks passed: intended pause point, paused status preservation, actual native compaction preservation, completion after generic resume, completed-status preservation, preserved history prefix and unchanged session identity. Native compaction occurred at 18:11:08 UTC, paused at v3/correct1 with capture and reproduction completed. Source changes followed resume and implementation activation. Original suite: 15/15. Extra probe: 14/15. Native reported cost: $1.5514425.
- Reporting failure in trial 3: reproduction artifacts initially acknowledged both the direct filtered baseline and the coordinator baseline. Verification rewrote that distinction away after compaction; the final report falsely claimed exclusive coordinator execution. Runtime visit snapshots preserve the earlier accurate artifact bytes, and the initial JSON result survives in the structured baseline's `previousResults`. The storage mechanism retained evidence that the model's cumulative summary omitted. This establishes the loss across later artifact rewrites, without proving compaction caused it.

Raw evidence and preparation helpers live under `.test-runs-coordinator-20260907/` and the per-run directories; they are ignored local artifacts. The implementation plan is `docs/plans/2026-09-07-step-coordinator-iterations.md`.

## Audit details

Independent review inspected all 40 final-trial tool inputs and retained artifact snapshots, recomputed persistence comparisons, and confirmed no observed solution retrieval or tampering. It also found that the initial brief qualified the history prohibition, although no history command followed. The direct test's acknowledgment disappeared in the v4 verification rewrite; the compaction boundary preserved the earlier evidence.

The second trial contains 27 native tool requests and 52 hook receipts: 26 tools passed through hook boundaries, while one unmatched-string Edit was rejected by native validation before either hook. The original pair-per-request audit failed. The revised audit retains that explicit native error, requires the Edit target to be observed, checks identical observed files immediately before/after it, and verifies no coordinator events exist for that request; every other request still requires paired receipts. This is a classified pre-validation rejection, not evidence silently discarded to make the trial pass.

Per-run `primary-verdict.json` records separate judgments. Controller `completion.json: trialValid` concerns capture/infrastructure validity; it does not grant workflow adherence or repair correctness. In the second trial, `pauseAtExpectedNode` and `resumedCompleted` are false despite the other persistence booleans passing.

Frozen preparations that never launched (`persistence`, `persistenceb`, `persistenced`) are not model trials. The failed trust launch also precedes any task/model turn.

## Decision

Keep the coordinator experimental. It merits continued development as the owner of workflow position, transitions and retained execution evidence. Skills can remain reusable: the graph owns successors and the coordinator returns the current step.

The next focused improvement should make execution summaries derive from retained evidence and independently check final report claims. Semantic completion and repair acceptance need stronger verification than native skill receipts, nonempty artifacts and a fixed supplied suite. The extra probe demonstrates that an orderly workflow can still produce an incomplete repair.

Before production integration, repeat the final revision unchanged on more contained fixtures and exercise correction retries, live Stop recovery, active read-only turns and longer sessions. No live guard denial, Stop-block recovery or failed-correction branch occurred in this batch; those paths currently have offline coverage. Native restoration was exercised once per persistence trial, not across hours or days. The active-context continuation sentence is qualified by authorization; read-only prompt output adds an explicit override and runtime mutation guards enforce it, but active read-only presentation was not part of these two paused-status trials.

Three implementation/review agents were used; their token totals are not exposed here. The three Claude worker transcripts report $3.9967894 in total, including their compaction work. This is reported worker usage, not an invoice or the total cost of this coding session.

The batch overview is `.test-runs-coordinator-20260907/results.json`. Each launched fixture retains its frozen protocol, native transcript, receipt audit, coordinator journal and artifact/check snapshots, independent test result, extra probe result and `primary-verdict.json`. The extra probe's actual diff was checked: it adds one rerender and error assertion before the replacement player receives fresh status, without changing the supplied worker tests.
