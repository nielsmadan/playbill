# Conversational workflow control

The experimental coordinator can yield to a change in the user's direction while preserving the unfinished workflow. Enable it in a new coordinator graph:

```json
{
  "conversation": {
    "redirectThreshold": 2,
    "askOnRedirect": true
  }
}
```

`conversation: {}` uses those defaults. The threshold is an integer from 2 through 20. Omitting the option preserves the earlier coordinator behavior. This is experimental JSON configuration; the production YAML pipelines and adapters have not been integrated with this mechanism.

The existing agent interprets the user's intent from the conversation. The coordinator provides a current turn token and accepts `intent TURN KIND`; no separate classifier or model call runs inside a hook. Ordinary continuation needs no intent call.

This adds an intent tool call when the agent recognizes one of the changes below. It uses the existing hook process, CLI and persisted state; no background service or skill-to-skill routing is required. Skills still do not need to know their containing workflow.

| Kind       | Meaning and behavior                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `question` | Answer a question without advancing the workflow. If already diverted, remain paused.                                                  |
| `redirect` | The user is pursuing another objective. Yield immediately; count consecutive redirected user turns.                                    |
| `return`   | The user wants to resume the original work. Restore its position and recheck evidence. Merely mentioning the old task is insufficient. |
| `replace`  | The user clearly abandons or replaces the objective. Exit immediately.                                                                 |

The first redirect releases continuation reminders and workflow-specific tool restrictions. At the threshold, the intent result supplies one question asking whether to keep the workflow paused or close it. The agent presents it conversationally. Later turns, status calls and compaction do not repeat that choice. Unclassified ambiguous turns do not count and break a consecutive streak. Setting `askOnRedirect: false` keeps the workflow paused without asking; it never silently exits.

Intent is bound to the latest user turn. Repeating the same classification is idempotent; stale or conflicting classifications are rejected. Lifecycle restoration and tool calls do not create new user turns. Native prompt delivery with the same turn identity is deduplicated.

Explicit `pause`, `resume` and `exit` remain available to the agent. The user can express those intentions naturally. Exit preserves artifacts and unfinished status, stops workflow injection and guards, and persists through later prompts and compaction. Explicit resume can restore an exited workflow; keyword matches do not re-enter it.

Successful workflow completion also releases conversation control automatically. Suspension stores the current visit and file hashes inline in the existing state; completed artifact snapshots retain their original evidence.

Resuming preserves the current visit and completed snapshots. Intervening source or artifact changes invalidate current activation/check evidence, requiring fresh work. Changed protected verification inputs must be restored before resume, but do not prevent exit or ordinary work outside the flow. In-flight checks and review decisions remain retained and cannot take conversation ownership back or silently complete the workflow after it yields.

Resume remains blocked while a check or report review is pending, or a review is unresolved. Exit remains available. A previously accepted review is checked again against intervening evidence before resume can use it.

## Validation

Final validation passes all 207 repository tests, including 69 coordinator tests, plus formatting, ESLint and TypeScript checks. The deterministic suite drives the CLI and both Claude and Codex hook adapters. It covers duplicate and stale intent, configurable thresholds, ambiguous turns, read-only questions, stale evidence on resume, completed workflows and late check/review results.

Independent review found and verified fixes for three issues: terminal completion skipped generated history refresh; watched files replaced by symlinks could prevent exit; and deleted workflow skills could block unrelated Codex reads after exit. Regression tests now cover terminal receipts and frozen history, signed-review completion, native control-command wrapping, six symlink scenarios and deleted skills. The final narrow review has no remaining actionable findings.

One native Codex conversation exercised eight frozen user prompts through CSD 4.0.0, Codex 0.154.0, `gpt-6-astra` at `xhigh`. It used a contained writing workflow with three native technique skills and no Claude calls:

| Turn | User direction                                    | Observed behavior                                                           |
| ---- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| 1    | Record the workshop goal; wait for its audience   | Capture completed; outline visit retained                                   |
| 2    | Ask a related question                            | Answered; no workflow advance                                               |
| 3    | Consider a separate dinner club                   | First redirect paused conversation ownership                                |
| 4    | Develop the dinner club further                   | Second redirect presented one pause-or-exit choice                          |
| 5    | Keep the workshop on hold; write an invitation    | Wrote `dinner.md`; remained paused; no repeated choice                      |
| 6    | Return to the workshop with its audience          | Resumed the saved visit, cleared the diversion streak and wrote the outline |
| 7    | Forget the workshop; write a release announcement | Exited immediately and wrote `release.md`                                   |
| 8    | After native compaction, revise the announcement  | Remained exited; all hooks were quiet; updated the file                     |

All 19 mechanical audit checks passed. All eight delivered prompts matched their frozen bytes, all 25 native tool requests had paired hook receipts, and all 20 frozen inputs remained unchanged. Inspection of every tool input found no external file access, history/log searches, network use or runtime tampering. The two completed visits and their retained snapshots survived exit and compaction. The worker was stopped; only the original keepalive tmux session remained.

The native run used a frozen copy from before the review fixes. It establishes the observed conversational behavior for that revision; it does not exercise the later filesystem edge fixes, broad semantic recognition or long-term reliability. The writing task deliberately isolates conversation control from bug-solving difficulty.

There is one host interaction rough edge: Codex used its asynchronous question UI, which still showed a pending card after the controller answered through an ordinary prompt. The agent recognized the answer and continued correctly, and never issued a second question. This run therefore proves question delivery and conversational continuation, but not native question-card dismissal. The generic coordinator does not add a host-specific question manager; production presentation must resolve that interaction.

Raw evidence, frozen configuration and runtime, per-turn state, native transcript, tool inputs and `audit.json` are retained under `.test-runs-conversation-native-8ur7q76m/`. The controller reused tmux server PID 79104 and preserved the transcript before stopping the worker.

Two implementation/review agents and one native Codex worker were used. Their internal agent token totals are unavailable. The native worker recorded 558,138 input tokens, including 502,912 cached tokens, and 8,498 output tokens across the conversation and compaction. Those are cumulative worker usage, not the marginal cost of intent delivery or the total cost of this coding session.
