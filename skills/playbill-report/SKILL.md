---
name: playbill-report
description: Preserve cumulative task evidence and produce a handoff that separates completed work, decisions, failures, and unresolved work.
---

Synthesize the supplied artifacts into the requested report. Tie each completed
claim to changed paths and observed checks. Record routine rulings as decision,
reason, and cost if wrong. Retain unresolved findings, failed attempts, unavailable
checks with exact commands, and material decisions needing the user.

For a cumulative record, append the current task or attempt identity and its
evidence without replacing earlier entries. Copy the evidence itself when the
source is a reusable scratch file; a link alone will point at a later iteration.
Record pending work before reporting completion status. For a final handoff, lead
with resulting behavior and give the user the paths and limitations needed to
assess it. Report Git state only from a fresh read-only inspection when relevant.
