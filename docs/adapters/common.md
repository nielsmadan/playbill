# Shared adapter contract

All four adapters invoke the same Node 24 validator executable,
`dist/runtime-cli.js`. A version-1 JSON request carries the host cwd, normalized
native inventory, event (`start`, `prompt`, `restore`), optional prompt text and
configuration discovery roots. A response separates common workflow prose from
canonical-to-native invocation mappings. Native Claude/Codex requests may also
receive a graph lowered from the same validated AST when the selected workflow
enables coordination. This graph runs through the existing coordinator. See [the format reference](../formats.md).

Configuration layers load bundled `defaults/`, machine settings at
`~/.config/playbill`, then project `.playbill`, with project values winning.
Pipelines replace whole files. `PLAYBILL_DEFAULTS_DIR`, `PLAYBILL_MACHINE_DIR`
and `PLAYBILL_PROJECT_ROOT` override discovery for isolated integrations. The
project override must contain the session cwd. Otherwise discovery uses the Git
toplevel, nearest `.playbill` ancestor, or cwd. Every native appendix names the
resolved root so artifact paths stay correct when tools start below it.

Explicit entry is literal prompt text beginning with `[playbill:workflow-id]`,
optionally preceded by whitespace. Automatic matching uses declared keywords,
file patterns and repository guards. Adapter candidate files are workspace-relative
forward-slash paths enclosed in single backticks in the user prompt; attached
files and repository file lists do not implicitly become candidates. The shared
runtime also accepts an explicit `candidateFiles` array. Selection and entry-only
policy follow the same format rules on every host.

The core distinguishes canonical skill identity from native invocation. Native
discovery maps this package's own `skills/` files to
`playbill:<frontmatter-name>` on every host. Explicit snapshots preserve the
author's canonical aliases, including aliases for bundled files. Host SDK
inventory, supported filesystem corroboration, and documented attested snapshots
establish registration evidence. None grants tool permission or proves actual
agent capabilities. Unavailable bindings and ambiguous identities fail loudly.

The renderer's common prose is byte-identical for the same validated configuration
and canonical inventory. Native appendices intentionally contain different tool
instructions, paths, roots and capability notes. The conformance tests compare
only the complete common prose, through all four production entrypoints and the
shared executable, and independently compare the result to the shared runtime.

Runtime input is bounded to 256 KiB, prompts to 64 KiB, validator output to
512 KiB, and validator execution to five seconds. Claude's complete delivery
bound is 10,000 JavaScript characters. Codex, Pi and OpenCode each bound complete
context to 16 KiB, including the native appendix and restoration suffix.
Diagnostics are separately bounded. Overflow or invalid configuration clears
saved selection and returns a complete diagnostic rather than partial prose.

Codex, Pi and OpenCode retain only the last selected workflow in a shared bounded
session store. It defaults to `PLUGIN_DATA/playbill-sessions` when available,
otherwise the OS temporary directory's `playbill-sessions`; `PLAYBILL_STATE_DIR`
can override it. Host, project root and session ID are hashed into each filename.
Files are bounded to 4 KiB, limited to 128 records and pruned after seven days.
Claude retains its existing equivalent store and coexistence-warning flag.
New sessions reset selection; resume and compaction revalidate it. Entry-only
policy allows an existing selection to survive a later entry-policy change.
Invalid configuration clears it. These selection stores apply to rendered workflows. Coordinated native workflows
retain their own immutable run configuration, visit state, journal, and snapshots;
see the [installed coordinator contract](installed-coordinator.md).

`npm test` is deterministic and offline. It uses real Pi resource/extension
loaders and an actual OpenCode SDK client with offline native event/HTTP fixtures.
Tests cover same-config prose identity, aliases, matching/nonmatching/disabled
entry, startup errors, native unavailability and ambiguity, restored context,
idempotence, validator errors, complete-output bounds and helper termination.

Paid integration scripts live under `scripts/smoke/`, outside test discovery.
The M3 runner preserves original task checks and hashes, raw traces, exact argv
and environment overrides, native activation/results and independent test output
in a unique `.test-runs-<host>-smoke-<timestamp>` directory. Each model process has
a 120-second deadline, a 2 MiB stdout bound and a 256 KiB stderr bound. Pi also
stops at 12 turns; Codex and OpenCode have no equivalent turn/budget cap exposed
by this runner. Failed trials remain distinct and require separate authorization
to retry. [Retained evidence](m3-smoke.json) distinguishes native API probes,
real model runs and the blocked OpenCode run.
