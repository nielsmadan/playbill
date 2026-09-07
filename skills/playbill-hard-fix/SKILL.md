---
name: playbill-hard-fix
description: Reassess a persistent bug by explaining failed hypotheses and choosing a discriminating experiment grounded in evidence.
---

Read the reproduction, current source, and accumulated attempt evidence. Explain
why each attempted fix failed and which assumptions those outcomes weaken. Trace
the causal mechanism through state, timing, contracts, dependency source, or
relevant read-only history as needed. Treat symptoms and root causes separately.

Rank plausible causes with supporting and opposing observations. Select the next
experiment by its ability to distinguish alternatives, and specify its expected
result under each hypothesis. Identify a proposed correction only when the
evidence supports it. Record a missing environmental prerequisite or architectural
conflict as a concrete blocker instead of another speculative patch.

Return the diagnosis, evidence paths, proposed single-variable experiment or fix,
and its original-reproduction check. Keep unsuccessful attempts in the record.
