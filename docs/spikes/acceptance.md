# M0 acceptance protocol

Agreed before running the spike, 2026-09-05.

The hypothesis is that a concise, injected workflow can cause a model to select
registered skills and execute an ordered review sequence. The spike evaluates
this with real harnesses and small coding tasks. It does not establish production
reliability or a statistically precise success rate.

## Experiment

Use five distinct tasks on each of Claude Code, Codex, Pi, and OpenCode. Each task
starts from a fresh fixture. Inject the same four-step workflow through the
harness's session or context interface:

1. Implement the requested change using the implementation skill.
2. Review the change using the task-review skill.
3. Address the findings using the fix skill, recording the disposition when no
   change is needed.
4. Review the resulting change using the final-review skill.

The user task describes the desired code behavior. The workflow comes from the
adapter; repeating it in the user task would not test the injection hypothesis.
Use technique descriptions and concise step instructions. Record the exact
injected text and every version of it used for scored runs.

## Evidence and scoring

Each scored run records the harness and model, task, invocation command, process
exit status, elapsed time, injection evidence, actual tool calls, produced
artifacts, and executable task-check results. Preserve raw transcripts locally;
keep a portable, sanitized result summary with the report.

Named-skill invocation requires native skill-tool use on harnesses that expose
that tool. On a harness whose skill mechanism is reading a registered `SKILL.md`,
the transcript must show that read. Mentioning a skill name or creating a claimed
completion marker is insufficient evidence.

A sequence pass requires all four bound skills to be activated in order, their
steps to complete, and the task's executable behavior checks to pass. A final
answer claiming completion is not evidence on its own. Record partial results
separately, including a correct implementation that skipped its reviews.

Count failures and timeouts in the five-run denominator. Harnesses that cannot
start are blocked, not successful. Up to one plumbing probe per harness may be
excluded if it is identified as a probe before it runs. Do not replace failed
scored runs with retries.

Report whether existing global workflows or plugins were present. A contaminated
run cannot prove that Playbill alone caused adherence. If this affects the gate,
describe the limitation rather than converting it into a pass.

## Exit gate

- Named-skill support: all four bound skills are actually activated in at least
  one scored run on at least three of the four harnesses.
- Sequence adherence: at least four of five scored runs pass on Claude Code and
  at least one other harness.

Only a passing gate permits M1. A failure or insufficient evidence is a
load-bearing result: retain the spike findings and revisit the execution or
prose assumptions before building the format.

## Boundaries

Fixtures and explicit configuration stay in this checkout. Use existing
credential mechanisms without reading credentials. Do not change user-level
configuration, disable hook trust, publish, or install into global registries.
Each model run has a 150-second ceiling, and model runs are sequential.
