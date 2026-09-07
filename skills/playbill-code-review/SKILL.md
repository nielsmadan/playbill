---
name: playbill-code-review
description: Review a defined change against its specification and return actionable findings grounded in code and observable behavior.
---

Read the requested scope, specification, repository instructions, changed code, and
relevant callers and tests. Establish the actual diff or file set; report ambiguity
in the comparison base instead of silently widening scope. Assess both acceptance
criteria and code quality: logic, error paths, interfaces, state lifetime, security
boundaries, performance where scale matters, and test effectiveness.

For each actionable finding, provide file and line, a concrete trigger, observed or
deduced wrong behavior, impact, supporting evidence, and a focused correction.
Separate confirmed failures from hypotheses that require execution. Consolidate
duplicates and omit stylistic preferences unsupported by project conventions.

Return findings ordered by impact, checked scope, commands actually run, and
coverage limitations. An empty findings list means the inspected scope yielded
no actionable finding; it is not proof that unexecuted checks pass. Under read-only
access, return report text to the coordinator and use only non-mutating checks;
builds and tests that write files belong with the coordinator.
