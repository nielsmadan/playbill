# Contained historical bug replay

Date: 2026-09-06. Playbill M4 acceptance remains open.

Unchanged production Playbill executed all five main debug steps and created all
six artifacts using default tools and high effort. Its supplied checks passed
15/15, but the additional retry case failed and its type-check evidence was
deficient. Earlier low-effort runs skipped steps in both Playbill and Superpowers.
These results weaken a delivery-specific diagnosis; setup effects are not ruled
out. Authentication, prompt integrity and trust-dialog readiness are now verified
for the scored runs. Full M4 acceptance remains open.

## Fixture and preparation

The check-agent-logs skill recovered a FlowLab session-player bug from Claude
session `d48a78d8-8184-4f30-b574-ae9a683d2083`, titled
“distributed-humming-wilkes,” with relevant work on August 4–8. The earlier
Ringleader candidate was abandoned because it depended on machine session storage.

Two matching source snapshots started at
`70963f72f6f6282cb3124b79c4c493db3d1d36aa`. The positive control used
`cc7aa380a1d878352b2a5ebc0fb59175923da899`. Both workers received the same
historical hook test, a symptom report, installed locked dependencies, and an empty
Playbill configuration. The tests mock audio events. Their diagnostic comments
remain intact: this measures repair from a supplied reproduction, not unaided
diagnosis.

The original check is `node .replay/test.cjs`. Preparation and independent primary
checks established:

| Source                   | Passed | Failed | Exit |
| ------------------------ | -----: | -----: | ---: |
| Historical baseline      |     13 |      2 |    1 |
| Historical fixed control |     15 |      0 |    0 |

The failures concern retaining a load error through later status updates and
clearing the previous player's error during retry. Supplied-test SHA-256:
`b17efb624d38617bcdd8c15fb30a6a96e1478b0f27c58d882b9c6916edf277fd`.

The workers had 94,886 matching file/directory/link entries before Git seeding.
Each received 323 explicitly selected paths in a fresh one-commit repository,
with no remotes, alternates, or original commit objects. The original project
checkout was read-only. Signing/service files and machine launch configuration
were excluded. Worker scope was instructed and audited, not enforced by a new
operating-system sandbox.

## Direct Claude result

Claude Code 2.1.263, `claude-sonnet-5`, low effort, loaded the actual Playbill
plugin and defaults. Session: `17f6e8bb-2442-4cb5-b5c4-6b2c0da6c61d`.
The host exited successfully after nine turns, about 71 seconds, reporting
$0.290233. No time, tool, or budget limit was reached.

The native trace shows seven tools:

1. Activate `playbill:playbill-brief` with task arguments.
2. Create the workflow directory and list player files.
3. Read the hook.
4. Read the supplied tests.
5. Edit the hook.
6. Run the supplied tests.
7. Inspect Git diff/status without mutation.

Both native Playbill hooks succeeded. The complete debug instructions were
delivered, including the named skill sequence and artifact paths. Fourteen paired
pre/post observations matched their native receipt hashes, tool IDs, and inputs.
The original test bytes were unchanged at every observed boundary.

**Workflow adherence failed.** Only the brief skill activated. The worker never
ran the failing baseline, and all six workflow artifacts were absent at every
observed boundary and at completion. It did not inspect machine or agent logs.
Passing task checks did not satisfy workflow acceptance.

The independent supplied-test rerun passed all 15 tests. A separate post-run probe
then added one render while a replacement player still exposed the old status
object. The worker's patch restored the old error on that render: 14 passed,
1 failed. The same probe passed all 15 checks against the historical control.
This probe changed no worker source or supplied-test bytes. It demonstrates that
the direct patch is incomplete despite its original green test result.

## Session-driver attempts

The installed claude-session-driver is version 4.0.0. It controls an interactive
Claude process in tmux; it does not enforce Playbill steps or send step coaching.

The first launch, session `96227a20-ecf2-4430-8eba-882a95817198`, failed before
receiving a task. This Claude version defaults the workspace-trust dialog to
“No, exit.” The driver's startup code detects the dialog and presses Enter, which
closes Claude. An unprompted diagnostic session confirmed the dialog and startup
after explicitly selecting trust for the verified worker checkout. Both diagnostic
sessions were stopped.

The subsequent session, `cc09f989-cde5-40d5-912a-28b235aa88f4`, started and accepted
the task, then returned `authentication_failed`: “Not logged in.” The native
assistant message was synthetic, with zero input/output tokens and zero tools.
The worker was stopped and its source stayed unchanged. This is **not an
adherence result**. The controller's `trialValid` field describes successful
capture/verification mechanics; it does not override the native authentication
failure or establish that a model trial occurred.

The user supplied the working authentication shim from Mouthfeel's host-smoke
harness. It sources the normal zshrc and invokes wrapped Claude. A new,
separately recorded attempt set `CSD_CLAUDE_BIN` through a fixture launcher that
chains that shim. No credentials were searched, printed, copied, or decrypted.
The launcher used the already-trusted worker checkout and the existing unsandboxed
tmux server, PID 79104. A fixture-local wrapper adds `tmux -N` to prevent starting
a replacement server. A missing-socket check confirmed failure without creating
a socket. Its first version used an overlong socket path and was inconclusive;
the corrected relative-path check is retained separately.

## Authenticated CSD result

Session `13fd440f-d84e-4eb3-b699-6bb0e075bcee` ran Claude Code 2.1.263,
`claude-sonnet-5`, low effort, through CSD 4.0.0. The worker started from the
unchanged second historical snapshot with the same Playbill build and defaults.
It completed a model turn in about 85 seconds, reporting $0.328042, then was
stopped. No time or tool cap was reached, and no coaching was sent.

The native trace contains eleven tools: brief activation; directory inspection;
reads of the hook, tests and runner; creation of the workflow directory; a failing
baseline; one edit; passing tests; and read-only Git inspection. Unlike the direct
run, it reproduced both original failures before editing. The worker piped test
output through `tail` without `pipefail`, so its successful Bash result is not a
test exit status. The retained output contains both failure details and the full
13-passed/2-failed summary; primary verification ran the test command directly.

**Workflow adherence still failed.** Only `playbill:playbill-brief` activated.
None of `brief.md`, `diagnosis.md`, `work.md`, `checks.md`, `progress.md` or
`report.md` existed at any observed boundary or completion. The injected workflow
contained all 4,030 characters and 26 newlines, matching the direct run after
normalizing the project path. All 22 pre/post observations matched native receipt
hashes, tool identities and inputs. The supplied test and empty config remained
unchanged at every boundary; verification-input hashes matched before and after.
Final files matched the last observation. The tools did not inspect machine or
agent logs.

An independent rerun passed all 15 supplied tests with their original bytes. The
same separate retry probe used for the direct patch failed again: 14 passed,
1 failed. Another render while the new player still carries the old status
restores the old failure. The historical fixed control passes this probe. Thus
neither worker's green supplied-test result establishes a complete repair.

## Prompt-delivery diagnostic

The failed-login transcript alone did not establish newline loss during a working
model session. The authenticated run and a subsequent blocked-hook diagnostic now
provide stronger evidence:

- The controller passed the original task as one argv element through
  `spawnSync`, without shell interpolation. The saved send argument has nine
  actual newline characters, not literal backslash-n escapes.
- The authenticated native user prompt contains zero newlines and equals the
  original task with only those nine characters removed. This joins the test
  command to the following sentence.
- A separate CSD-driven Claude session captured the native `UserPromptSubmit`
  hook input, then blocked submission before any model request. Its captured
  prompt also has zero newlines and exactly the same removal. Native cost state
  reports zero API duration and $0. This rules out transcript formatting alone.
- A raw terminal receiver preserved a multiline payload byte for byte through
  the driver's literal `tmux send-keys` operation. This establishes that this
  operation can preserve newlines; it does not locate the loss in Claude's
  interactive input path.

The installed CSD implementation uses bracketed paste and argv-based subprocesses;
its worker shim forwards `"$@"`. No shell interpolation was found in the inspected
send path. The exact loss point remains unresolved. Follow-up zero-model probes established
a working transport: send CR characters through bracketed paste, and the native
hook receives the original LF task byte for byte, including all nine newlines.
A logging tmux wrapper verified the LF and CR arguments arriving at tmux. New
scored trials enforce exact prompt, session and cwd equality before any model
response. This resolves input comparability for the new trials, while the earlier
direct/authenticated pair remains unmatched.

## Interpretation and retained evidence

A real contained task reproduced the earlier skipped-step behavior, but those
results did not establish its cause. New trials distinguish delivery packaging,
explicit completion instructions, and test-setup limitations.

| Trial                                                | Main sequence           | Artifacts | Original checks | Extra retry check |
| ---------------------------------------------------- | ----------------------- | --------: | --------------: | ----------------: |
| Hook delivery, exact prompt                          | Brief only              |       0/6 |            15/0 |              14/1 |
| Native workflow skill, exact prompt                  | Workflow and brief only |       0/6 |            15/0 |              15/0 |
| Native workflow plus completion/handoff instructions | All main steps in order |       6/6 |            15/0 |              15/0 |
| Production hook, default tools and high effort       | All main steps in order |       6/6 |            15/0 |              14/1 |

The first two trials exposed the same eleven Playbill skill names and varied hook
versus native-skill delivery. Both skipped the workflow. The third added a fixed
92-word execution contract; technique files, task, model, effort, tools and checks
stayed fixed. It ran the 13/2 baseline before editing and created substantive
artifacts at the declared step boundaries. All 44 native observation receipts
matched, and the full workflow body loaded. Session:
`24ba559c-fb47-47a9-a7f8-41f2b157c8fc`; reported model cost $0.627512.

Independent review narrowed its defect to evidence retention: an implementation
check returned 12 passed / 3 failed, followed by a local correction and passing
rerun, but the work/checks/progress files omit that intermediate failure and
correction. Local testing within implementation is permitted, so a missing
hard-fix activation and the wording “first attempt” do not independently prove a
sequence violation. This is successful ordered execution with incomplete evidence,
not another ignored workflow.

These individual runs do not establish reliability or rule out setup effects.
The common rig uses Sonnet 5 at low effort, seven available tools, no user settings
or MCP configuration, an instrumented single turn, and supplied diagnostic tests.
Those controls can interact with workflow behavior. A separately frozen reference run of the installed Superpowers 6.3.0 package
also skipped executable requirements: it loaded systematic-debugging but edited
before reproducing the failure and never invoked its required verification skill.
The native trace confirms full skill delivery and availability of that handoff.
Original checks passed 15/0; the extra retry probe failed 14/1. Session:
`a8b9ed2c-bcfd-4118-a6cb-3c954626e8da`; model cost $0.271049. An earlier reference
launch failed at the trust UI before task submission and is excluded. The helper
now confirms visible Yes before Enter and supports already-trusted folders; 12
offline checks and scoped independent review passed.

This weakens a Playbill-specific delivery diagnosis. It does not establish that
the testing setup caused the omissions: Bash and Skill were available for the
skipped actions. Restoring default built-in tools was insufficient in a second reference run:
Superpowers still edited before baseline and skipped its verification skill.
Changing only effort from low to high then improved substantive execution: the
baseline preceded edits, and the final original and extra checks passed 15/0.
The high-effort run performed verification but still omitted the required named
verification skill handoff. These are separate dimensions of adherence.

The unchanged production Playbill control completed at default tools/high effort:
brief, debug-log, implement, verify and report all ran in order, with six substantive
artifacts present at their required handoffs. The original 13/2 baseline preceded
the edit; independent supplied checks passed 15/0. All 68 native observation
receipts matched across 34 tools. The 104-file plugin copy matches the production
M4 source, with its ordinary hook and ten techniques. Session:
`4de6909f-e33d-4795-a50e-635ebbbcfd4a`; model cost $1.1566264.

Independent review confirmed two separate limits. The extra retry probe failed
14/1: a second render with replacement audio but the old status relatches the old
error. Verification evidence also failed: an unavailable `timeout` command was
hidden by a filtered type-check pipeline, yet the work artifact claimed success.
A later type-check still filtered output and hid the compiler exit status. ESLint
passed its rerun, but the first unavailable-command outcome was omitted. Primary
subsequently ran the full unfiltered compiler check directly: exit 0, no output.
Actual type checking therefore passes; the model's evidence remains deficient.
The formal supplied-test verification passed, so missing hard-fix is not an
additional sequence violation.

This demonstrates that the original delivery can execute the main workflow.
Compared with older production runs, both tools and effort changed, so it does
not isolate either cause or estimate reliability. Further instruction changes
remain paused. CSD still disables AskUserQuestion. The successful Mouthfeel
protocol the user cited also includes explicit activation/status turns and
host-default models; our automatic-entry single-turn trials differ. M4 remains
open; M5 and the final whole-run review remain unfinished. The production audit is
`.test-runs-delivery-productionhigh-6jyjt1ww/controller/native/workflow-audit.json`.

All earlier arithmetic evidence remains unchanged. Local raw evidence lives in
`.test-runs-player-replay-W0umKP/`, including preparation, isolated workers,
frozen protocols, native transcripts, observation receipts, independent tests,
the additional probe, and the original `controller/primary-audit.json`. New
authenticated evidence is in `controller/interactive-authenticated/`, including
its own `primary-audit.json`. The blocked native hook and raw transport probes are
in `controller/transport-ui/` and `controller/transport-probe/`. The failed install
option, startup attempts and preflights remain separate records. All experiment
workers and diagnostics were stopped; the original keepalive server was retained.

The preparation helper is `scripts/smoke/prepare-player-replay.mjs`; the observer
is `scripts/smoke/player-observer.mjs`. Model runs are outside the default test
suite. The controller received an independent review, a scoped fix pass, and a
clean re-review. Primary format, lint, TypeScript, diff, controller syntax, and
fixture checks passed. Installed dependency contents were not rehashed after the
worker ran; tool inspection and the immutable verification-input checks provide
the stated scope of integrity evidence.

New delivery pair evidence is in `.test-runs-delivery-w9y5vvhw/controller/`,
including `pair-audit.json` and zero-model transport probes. The completion-contract
trial is in `.test-runs-delivery-contract-hnfbwg22/controller/native/`, including
`primary-audit.json` and `workflow-audit.json`. Earlier evidence was preserved.

Reference control evidence is in
`.test-runs-delivery-reference-47i0p8ry/controller-retry/native/`, including
`workflow-audit.json`. The excluded startup and both readiness-helper revisions
are retained separately in that experiment.
