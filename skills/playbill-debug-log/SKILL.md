---
name: playbill-debug-log
description: Isolate a failure using a minimal reproduction, a falsifiable hypothesis, and targeted observations that preserve program behavior.
---

Establish expected versus observed behavior using the original reproduction.
Trace relevant inputs, branches, state transitions, and asynchronous boundaries.
Choose the smallest observation that distinguishes likely causes; existing test
output or a source trace may be enough without adding logs.

When instrumentation is useful, record exactly where it was added and what it
measures. Use pure reads in log arguments, preserve return values and control flow,
and omit credentials and personal data. Correlate events by a safe request or task
identifier when timing matters. Change one experimental variable and compare its
result with the baseline; record both confirming and contradicting evidence.

Return reproduction commands and outcomes, a ranked hypothesis, evidence that
would falsify it, and temporary instrumentation locations. Preserve original test
expectations; a changed expectation does not establish that a failure was fixed.
