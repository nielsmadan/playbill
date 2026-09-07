---
name: playbill-brief
description: Capture the current request, acceptance criteria, scope, and existing authorization in a durable task brief.
---

Extract the target from the user's current request and relevant conversation.
Record expected behavior, concrete acceptance checks, writable project boundaries,
reference paths, constraints, and decisions or approvals already supplied. Distinguish
a request for analysis from a request to change code. Record an unknown as unknown.

Include enough context for someone reading the brief without the conversation to
understand the task. A review brief identifies the requested files or comparison
base; a bug brief gives observed versus expected behavior and reproduction steps.
Read repository instructions and inspect the relevant paths to resolve factual gaps.

When asked to initialize progress, include the brief identity, current status, and
an empty evidence section. Existing artifacts for the same task are continuation
evidence: retain decisions and completed work. Preserve evidence of a different
task before replacing its artifacts, using the repository's ordinary file practices.
