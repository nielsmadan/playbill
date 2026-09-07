---
name: playbill-plan
description: Produce an implementation plan grounded in actual files, with ordered task descriptions and executable acceptance checks.
---

Read the brief, repository notes, relevant code, tests, and any existing plan. Assess
existing work against the requested behavior before proposing changes. Explain the
chosen approach and any alternative whose tradeoff materially affects the design.

Return actual files to change and what each change accomplishes, ordered tasks with
dependencies, executable checks, edge cases, risks, and unresolved decisions.
Each task should leave a coherent piece of behavior that can be reviewed and checked.
Include enough detail in each task description for a fresh implementer to locate
the relevant plan section and understand acceptance. Avoid placeholders for work
whose implementation can already be determined from the repository.

When a collection is requested, return a JSON array of task-description strings in
execution order. Put supporting detail in the plan document. Reconcile completed
tasks with existing progress instead of planning them again.
