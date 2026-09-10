# Coordinator adherence ablation

The contract change preserved the authoritative task and exact constraint quotes in all three trials. Generated history produced accurate execution evidence in all three trials, while each model narrative still contained a factual error. These are useful, separate improvements to the prototype; this batch does not establish reliable end-to-end adherence.

This September 8 batch compares two recommendations separately against the final September 7 coordinator. There are nine protocol-valid observations, three per arm, plus one retained protocol-invalid baseline attempt. The original nine-trial freeze remains unchanged; a separately frozen replacement uses the same normalized baseline and harness.

| Variant  | Difference from baseline                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline | Frozen final September 7 coordinator, including its strict capture instruction                                                                                                   |
| Contract | Allow orientation consistent with the reusable brief skill; make unchanged `TASK.md` an authoritative consumed artifact, protect its hash and quote restated constraints exactly |
| History  | Retain baseline capture wording; generate execution facts from native receipts and configured checks, expose a read-only history command and append facts to the report          |

The interventions were not combined. Reusable technique skills, production adapters and default playbill definitions were not changed by this batch. The coordinator remains an experimental overlay.

## Results

| Observation                                                         | Baseline | Contract | History |
| ------------------------------------------------------------------- | -------- | -------- | ------- |
| Protocol-valid observations                                         | 3/3      | 3/3      | 3/3     |
| Reached completed state                                             | 3/3      | 3/3      | 3/3     |
| All eight persistence comparisons pass                              | 3/3      | 3/3      | 3/3     |
| Common capture sequencing passes                                    | 3/3      | 3/3      | 3/3     |
| Capture preserves exact constraints/authoritative task              | 0/3      | 3/3      | 0/3     |
| Capture preserves constraint meaning, irrespective of exact quoting | 2/3      | 3/3      | 2/3     |
| All worker tests use configured check                               | 2/3      | 3/3      | 3/3     |
| Model retains every actual worker test execution                    | 2/3      | 3/3      | 3/3     |
| Independent original suite passes                                   | 3/3      | 3/3      | 3/3     |
| Independent extra retry probe passes                                | 1/3      | 0/3      | 2/3     |
| Observed forbidden retrieval/action                                 | 0/3      | 0/3      | 0/3     |

| Trial                                                                                               | Protocol          | Tools | Actual worker test executions | Original suite | Extra probe | Native cost |
| --------------------------------------------------------------------------------------------------- | ----------------- | ----- | ----------------------------- | -------------- | ----------- | ----------- |
| [baselinea](../../.test-runs-coordinator-baselinea-xri4xiwc/controller/native/primary-verdict.json) | Valid             | 37    | 3                             | 15/15          | 14/15       | $1.48       |
| [baselineb](../../.test-runs-coordinator-baselineb-v_2nt76l/controller/native/primary-verdict.json) | Valid             | 41    | 4                             | 15/15          | 14/15       | $1.57       |
| [baselinec](../../.test-runs-coordinator-baselinec-jhquyb3s/controller/native/primary-verdict.json) | Invalid; excluded | 39    | 3                             | 15/15          | 14/15       | $1.54       |
| [baselined](../../.test-runs-coordinator-baselined-11u1e424/controller/native/primary-verdict.json) | Valid             | 40    | 4                             | 15/15          | 15/15       | $1.91       |
| [contracta](../../.test-runs-coordinator-contracta-1yfjxhpi/controller/native/primary-verdict.json) | Valid             | 39    | 3                             | 15/15          | 14/15       | $1.56       |
| [contractb](../../.test-runs-coordinator-contractb-3vzyyai7/controller/native/primary-verdict.json) | Valid             | 40    | 3                             | 15/15          | 14/15       | $1.66       |
| [contractc](../../.test-runs-coordinator-contractc-w01gehx0/controller/native/primary-verdict.json) | Valid             | 37    | 3                             | 15/15          | 14/15       | $1.81       |
| [historya](../../.test-runs-coordinator-historya-hpfyzquk/controller/native/primary-verdict.json)   | Valid             | 44    | 4                             | 15/15          | 15/15       | $2.24       |
| [historyb](../../.test-runs-coordinator-historyb-le8d050_/controller/native/primary-verdict.json)   | Valid             | 40    | 3                             | 15/15          | 15/15       | $1.82       |
| [historyc](../../.test-runs-coordinator-historyc-w8soyylz/controller/native/primary-verdict.json)   | Valid             | 44    | 3                             | 15/15          | 14/15       | $1.71       |

Generated-history fidelity passed **3/3** independent audits. Explicit model history-file/CLI consultation was **0/3**.

The common capture score requires brief/progress before test execution or source correction, with reproduction pending and no established diagnostic conclusion during capture. Source orientation is recorded separately: allowing it in the contract arm cannot count as improved obedience to the baseline's stricter rule. Contract trials still formed detailed candidate explanations during capture, so the boundary between orientation and diagnosis remains ambiguous even when a hypothesis is labelled unconfirmed.

Exact constraint preservation is stricter than preserving approximately the same meaning. All contract briefs explicitly point to authoritative `TASK.md` and retain its full quote, allowing Markdown reflow. They also contain redundant explanatory paraphrases. Baseline/history briefs generally paraphrase constraints; `baselineb` weakens the source-history prohibition with “beyond what's normally available,” and `historyc` adds “beyond what's needed.” No actual prohibited history retrieval was observed.

Two baseline final reports accounted for their executions correctly. The replacement `baselined` ran an unmanaged baseline test, then repeated it through the coordinator. Its original checks artifact records both executions, but its final report lists only the three configured checks, omitting the separate direct failure. The cumulative evidence therefore survives while the final inventory is incomplete. All contract/history workers used the configured check for every test; no native history trial exercised this unmanaged-run case, so the comparison does not establish that generated history fixes that reporting failure. The implementation's tests cover it separately.

A shell wrapper around a configured check and the check process count as one test execution. Reads, diffs and other mentions of `.replay/test.cjs` do not count as test runs.

## What still failed

Passing the supplied 15 tests frequently concealed the same incomplete repair: the implementation clears the old error on the first replacement-player render, then re-latches it on a second render before fresh status arrives. The unchanged independent probe adds precisely that rerender/assertion before the existing healthy-status update. It runs outside the workflow after worker termination. Its actual diff and full output were checked; probe failures are not failures of a configured verification branch that the model subsequently ignored.

`baselined` passes that probe using component state that tracks player identity, the last-seen status error and the latched error. The extra-probe totals are baseline **1/3**, contract **0/3**, history **2/3**. These small counts do not establish a repair benefit from history generation, particularly when no history worker explicitly consulted the generated record.

The three history trials make the evidence/prose distinction concrete:

| Trial      | Generated evidence                                                 | Remaining model error                                                                                                                             | Extra probe |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `historya` | All four checks, including a failed correction, retained correctly | Describes the failed correction as re-latching in the same effect invocation despite an early return; it happens in a subsequent effect execution | 15/15       |
| `historyb` | All three checks and actual shell inspections retained correctly   | Claims protected-file diff checks at visits where those targeted commands did not run                                                             | 15/15       |
| `historyc` | All three checks and actual shell inspections retained correctly   | Weakens a task constraint and invents targeted test-file diff commands at correction/verification; also overstates repair                         | 14/15       |

No history trial explicitly read the generated history files or invoked the history CLI. They did receive the coordinator context pointing to it and directly saw their configured-check results. The generated appendix is independently useful evidence, but its presence is not evidence that the model consulted it or reasoned from it.

The contract change also leaves report accuracy unresolved. `contracta` calls an already-failing retry test merely latent and invents a prohibition on relevant local library-source inspection. `contractb` attributes a status command to the wrong visit. `contractc` claims a fresh targeted test-file diff at reporting, where the actual command was global diffstat. All three claim the repair is complete despite the failing extra retry probe. Global diffstat can support the narrower claim that tracked files are unchanged; it does not make a fabricated command history accurate.

## Generated history implementation

The optional coordinator configuration is:

```json
{
  "executionHistory": {
    "reportArtifact": ".playbill/debug/report.md"
  }
}
```

`scripts/coordinator/history.mjs` projects retained native Bash receipts and configured-check records into `.playbill/coordinator/runtime/execution-history.json` and `.md`. Shell records retain stable tool IDs, visit, exact input/command, receipt state and verified journal references to native responses/errors. Configured checks retain stable IDs, executable/argv, actual exit/outcome and raw evidence references, including superseded failures. Arbitrary shell text is not parsed into authoritative process results.

The read-only command is `node .playbill/coordinator/cli.mjs .playbill/coordinator/config.json history`. It projects current receipts without rewriting generated snapshots. Snapshots refresh on initialization, activation, check reservation/finalization and visit completion. Ordinary tool receipts, paused/status reads and completed turns do not rewrite them.

Completing the report appends a delimited generated section and retains the original model narrative byte-for-byte in `runtime/reports/vN.narrative.json`. Each snapshot states its evidence cutoff. An enclosing completion Bash call is honestly pending at that cutoff; subsequent status calls remain in the journal. Shell invocations and configured checks are separate inventories, avoiding double counting. Evidence hashes, superseded check blobs, generated facts and preserved narrative are validated against the retained journal.

The history snapshots survived the pause/status/native-compaction/resume/completed-status sequence unchanged where required. Independent audits recomputed records from native inputs and journal receipts and matched the report's original narrative prefix. An early review found that native wrappers around active history/status reads still refreshed snapshots; that was fixed before the final freeze, with a regression test that failed on the old behavior.

## Native protocol and validity

Every worker used CSD 4.0.0 to drive native Claude Code, Sonnet 5/high effort/default tools. Claude CLI was 2.1.263 and Node was 24.16.0. Authentication used the previously approved wrapper and the existing unsandboxed keepalive tmux server, PID 79104. No new tmux server was started.

Each fresh fixture contained the same 323 tracked source paths, one neutral baseline commit, no remotes/alternates and none of the known solution commits. Baseline verification was 13 passed/2 failed before any model work. The exact task hash was `d2ff1371f4048a44c647baaeb9741c55ef5d630431e6fe0d0aa07ab44c76c4c5`; native delivery matched all bytes and nine newlines. Original tests/runner/config, coordinator files and 104 plugin files were checked against frozen hashes, including the ten unchanged technique skills.

Trials ran interleaved, at most two workers concurrently. Each paused after reproduction, received a read-only status request, underwent actual native `/compact`, resumed from a generic request and received completed status. The eight persistence comparisons include generated-history hashes. Audits distinguish protocol validity, graph progression, model prose, repair correctness and observed forbidden activity.

`baselinec` is excluded from the clean comparison. Its startup trust guard logged the exact expected cwd and affirmative selection, sent Enter once, then blocked a later observation with `Unexpected trust dialog` at `2026-09-08T00:44:08.662Z`. The trace is consistent with a dialog-transition race, but the rejected pane was not saved, so its exact render cannot be reconstructed. No second key action was recorded. The worker subsequently received the exact task, completed five visits, passed all eight persistence comparisons and had matching native receipts; its controller nevertheless exited 1 with `trialValid: false`. We preserved that verdict and error, including its model cost, instead of waiving the frozen validity rule. `baselined` is the separately frozen replacement, with identical normalized harness/coordinator configuration.

This is a real testing-setup failure. It does not explain the repeated semantic errors in clean trials, whose task delivery, receipts, source integrity and compaction all verified. Complete independence from machine state is not proven: worker constraints were audited through native inputs, not enforced by an OS isolation boundary. Existing dependency copies were not comprehensively rehashed. Supplied tests include explanatory comments and are legitimate model inputs; this measures adherence on a contained real bug, not unaided discovery.

## Validation, evidence and decision

Repository validation passed **177/177 tests**, including 39 coordinator tests, plus formatting, lint and types. The final implementation was independently reviewed, corrected and re-reviewed before trials. Three implementation/review agents were used; their token totals are unavailable here and are not included in native-worker costs.

Native transcript-reported model cost was **$17.29** across all ten attempts (**$15.74** for the nine clean observations; **$1.54** for excluded `baselinec`). This is worker model cost, not total project/session cost. Clean-arm totals: baseline $4.96, contract $5.02, history $5.76.

The complete local evidence is in `.test-runs-adherence-20260908/`: `frozen-batch.json`, `frozen-replacement.json`, `scoring.md`, `results.json`, semantic review reports and validation logs. Each listed trial root retains its frozen controller, full native transcript, pre/post receipts, saved v1–v5 artifacts, configured-check evidence, independent original-suite/probe results and `controller/native/primary-verdict.json`. Generated-history trials additionally retain independent `generated-audit.json` results. These local experiment directories are not a portable published dataset.

Keep the authoritative-task contract in the experimental configuration and retain generated history as audit infrastructure. Neither result justifies production adoption or an adherence claim across long workflows. Three observations per arm, one fixture/model and one compaction per session measure minutes of persistence, not hours, transfer or statistical reliability. Failed-verification reassessment branches and Stop recovery were not exercised.

The next useful experiment is a report acceptance check that compares claims with specific retained evidence and keeps unsupported claims unresolved. That would test whether facts influence the model's final decisions, rather than merely making an inaccurate report auditable. It was not added to this batch.
