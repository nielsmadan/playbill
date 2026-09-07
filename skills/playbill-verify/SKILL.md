---
name: playbill-verify
description: Verify changed behavior with the original reproduction and appropriate project checks, recording complete executable evidence.
---

Derive checks from acceptance criteria and the changed behavior. Preserve the
original regression tests and rerun the original reproduction. Run relevant
project checks using the supported commands and record the command, exit status,
summary, and complete failure list. Read the whole result before judging success.

Differentiate passed, failed, and unavailable checks. An unavailable check includes
the exact command, observed blocker, and what remains unverified. Compare actual
output with expected behavior, including important error and boundary cases.
Claims based only on another agent's report are unverified until independently
checked. Return a concise evidence record and the remaining acceptance gaps.
