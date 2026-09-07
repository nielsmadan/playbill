---
name: playbill-read-docs
description: Ground a task in repository documentation, actual source paths, and supported verification commands.
---

Search instruction files, README files, and relevant docs by filename and content
with the task's terms. Rank exact topic matches ahead of incidental mentions.
Read the matching sections and nearby source; follow references needed to understand
the change. Record which promising documents remain unread if scope limits coverage.

Return concise notes with paths, applicable conventions, affected interfaces,
known failure modes, and the project's check commands. Identify commands that write
build outputs or caches so a read-only agent can distinguish them from inspection.
Resolve documentation conflicts against actual code and call out the discrepancy.
If documentation is absent, report that and ground the notes in existing examples.
