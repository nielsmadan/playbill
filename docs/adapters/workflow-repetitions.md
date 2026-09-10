# Unchanged workflow repetitions

Date: 2026-09-07. Three repetitions completed; M4 acceptance remains open.

The earlier successful main sequence did not repeat consistently. One run repaired
the bug before completing the required handoffs, another skipped four skills, and
the third substantially followed the workflow with an early-baseline deviation.
All supplied checks passed; only the second run passed the additional retry probe.

## Results

| Run | Skills / artifacts        | Workflow execution                                                                     | Verification evidence                                                                    | Supplied tests | Extra retry probe |
| --- | ------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------- | ----------------- |
| 1   | 5/5 skills, 6/6 artifacts | Repair preceded investigation and implementation handoffs; artifacts written afterward | Baseline recorded after scratch overwrite; final test and TypeScript successes supported | 15/15 pass     | 14 pass, 1 fail   |
| 2   | 1/5 skills, 5/6 artifacts | Only brief invoked; four skills skipped and work artifact absent                       | Baseline recorded late; final rerun omitted from artifacts                               | 15/15 pass     | 15/15 pass        |
| 3   | 5/5 skills, 6/6 artifacts | Main handoffs followed; baseline ran before brief/progress initialization              | Substantive evidence preserved; exact pipelines and exit statuses omitted                | 15/15 pass     | 14 pass, 1 fail   |

Skill calls and final files alone would overstate run 1's adherence. It ran the
baseline at tool 6, edited at 7, and passed its checks at 9; brief/progress appeared
at 13–14, investigation at 15, and implementation at 18. Those later stages
described an already-applied fix. Its final TypeScript check did run unfiltered and
passed. The test output also contained the complete supplied-suite result, despite
the shell pipelines being omitted from the written commands.

Run 2 performed a real investigation and repair but invoked only the brief skill.
Five artifacts appeared after the repair, and `work.md` never appeared. Both
measured correctness checks pass. Review identified an untested concern: a fresh
retry failure carrying the same error string may not relatch because its effect
depends only on the error string. No new experiment was added for that concern;
the frozen measured-check result remains passing.

Run 3 is materially better adherence. Diagnosis and progress preceded the edit;
implementation evidence preceded formal verification; reporting followed it.
Baseline evidence was preserved before scratch reuse. Its ordering deviation is
limited to running the baseline before initializing brief/progress and loading
the investigation skill. Its artifacts disclose unrun type/lint checks, though
claiming those checks were prohibited by task scope is unsupported. Its report
also calls summarized output exact and overstates exhaustive coverage.

The extra probe fails runs 1 and 3 for the same observed behavior: after a player
swap clears the error, a second render with the old status restores
`"Failed to load"`. Formal supplied-test verification passed, so the later
controller probe does not retroactively require a hard-fix skill invocation.

## Controls and integrity

All three used the frozen production plugin from
`.test-runs-delivery-productionhigh-6jyjt1ww`: 104 byte-identical files, ordinary
hook delivery and ten techniques. Claude Code 2.1.263, CSD 4.0.0, Sonnet 5, high
effort, default tools, task text and scoring remained fixed. Helpers differed only
in fixture paths and worker names. No coaching or additional task turn was sent.

Every fixture started from the same neutral 323-path historical Git tree, with one
commit, no remotes or alternates, and no historical fix objects. Each baseline
independently failed the same two cases: 13 passed, 2 failed. Test bytes and their
diagnostic comments remained unchanged.

Native prompt receipts matched exactly. Delivered workflow text matched the
reference after normalizing fixture paths. All 148 observation receipts matched
74 native tool calls. Supplied tests/configuration and plugin hashes remained
intact; independent original checks and the separate retry probe were run after
each worker finished. The additional rerender assertion was independently confirmed
present in all three probe copies.

No observed tool call accessed machine logs, sibling checkouts, historical source
objects or external solutions. These are audited-scope checks, not OS isolation;
dependency contents were not rehashed afterward. Supplied diagnostic comments make
this repair from a provided reproduction rather than blind bug discovery.

Independent read-only review covered preparation and every outcome. Three Claude
runs reported **$2.6648278 combined**; one reviewer was reused, with its usage not
exposed. CSD stop succeeded for all workers, and only the original keepalive tmux
session remained. A supplemental process-list check failed with `EPERM`; `/bin/ps`
has a read grant, so no missing filesystem grant was established. Session cleanup
was verified through CSD and tmux; OS process enumeration was unavailable.

## Evidence and interpretation

| Run | Session                                | Local experiment                           | Reported model cost |
| --- | -------------------------------------- | ------------------------------------------ | ------------------: |
| 1   | `4ce7ba60-aa46-4fc2-ae41-4b60389f4a0f` | `.test-runs-delivery-repeatone-ijuml68z`   |          $1.0803948 |
| 2   | `50ac5409-d922-4ccb-93c6-c9b2341adc35` | `.test-runs-delivery-repeattwo-q16ytxjl`   |          $0.6471044 |
| 3   | `1be1c5f4-1f1a-4250-8a76-2f4aa96a54b8` | `.test-runs-delivery-repeatthree-t1kwbzdc` |          $0.9373286 |

Each experiment retains `controller/native/primary-audit.json`, the native
transcript, paired observations, independent test results and
`controller/native/workflow-audit.json`. Retry evidence is under
`controller/repeated-status-probe/worker-native/`. Batch preparation, manifest,
prelaunch review and postflight integrity checks are in
`.test-runs-repetitions-20260907/`.

These three observations establish inconsistent execution in this fixed setup.
They do not establish a reliability rate or isolate the cause to instructions,
delivery, effort or remaining harness restrictions. No run combines complete
workflow compliance, complete verification evidence and passing both measured
repair checks. The existing hook delivery can execute the workflow, but higher
effort/default tools alone did not establish repeatable compliance. No delivery
redesign or skill-to-skill successor instructions were introduced.
