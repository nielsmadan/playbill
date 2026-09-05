# OpenCode adapter

The adapter targets OpenCode and `@opencode-ai/plugin` 1.18.29. Run
`npm ci && npm run build`. Register one project plugin at
`.opencode/plugins/playbill.js`:

```js
export { PlaybillPlugin } from '/absolute/path/to/playbill/adapters/opencode/playbill.js';
```

The package subpath `@playbill/core/opencode` also exports `PlaybillPlugin`.
The SDK is an optional peer and a pinned development dependency; the adapter
imports only its types. OpenCode's supplied client provides all network access.
Its `config` hook appends the bundled `skills/` directory once, preserving other
skill paths, URLs and configuration fields. This is native resource registration,
not a new Playbill configuration format.

OpenCode runs under Bun, so its validator subprocess explicitly invokes `node`
from PATH. Set `PLAYBILL_NODE=/absolute/path/to/node` when needed. It must point
to Node 24, not Bun. The shared executable is `dist/runtime-cli.js` in either
case. Validator failure produces a bounded configuration error in model context.

## Native discovery and its limits

The 1.18.29 plugin's supplied client is the **v1** SDK, which lacks
`client.app.skills()`. Creating a separate v2 client from `serverUrl` would lose
native authentication or an embedded server's custom fetch. Playbill uses the
supplied client's public `command.list()` endpoint, preserving its transport.
The request has a five-second deadline and the resulting command inventory is
bounded to 1,000 entries and 2 MiB before normalization.

Native skill commands include `source: "skill"`, a name and a template. The
v1 generated types omit the newer `source` and config `skills` fields, so the
adapter validates these runtime fields explicitly. It never assumes a method
or property exists merely because another SDK version defines it.

The supported fallback recognizes OpenCode's exact skill-template footer,
resolves the referenced directory's `SKILL.md`, and corroborates both the
frontmatter name and body against the native response. A footer by itself is
not sufficient. Missing footers and built-ins without installed skill files do
not establish a supported installation. A changed file/body mismatch produces
an actionable error. This is a documented compatibility subset of the native
registry, not a structured location API.

Command names can shadow skill names, and OpenCode omits those skills from its
command list. For such skills, built-in/alternative templates, or explicit
canonical aliases, set `PLAYBILL_OPENCODE_INVENTORY` to the version-1 snapshot
in [the Codex inventory contract](codex.md#native-inventory). It attests actual
native registration when the public API cannot corroborate it. An exposed
native skill at a conflicting file fails as ambiguous. Frontmatter-disabled
model invocation cannot be enabled. Canonical snapshot IDs are preserved;
automatically discovered bundled files default to
`playbill:<frontmatter-name>`. The native appendix maps IDs to `skill` tool
`name` arguments and states the artifact project root.

Host tool and agent permissions still apply. Inventory is not permission to
invoke a skill or create a fresh/read-only agent. The adapter does not inspect
credentials, protected client fields, or reconstruct host authentication.

## Messages and sessions

The native `session.created` event validates startup configuration once command
resources are available. Attaching to an existing session validates on the first
message transform, before the model request. A config callback cannot query
native skills while the host is still constructing that registry.
OpenCode dispatches event promises without awaiting them. Each session tracks
lifecycle changes so delayed inventory results from startup or an earlier
transform cannot overwrite a newer request, restoration, or deleted session.

`chat.message` marks a new submitted request. On
`experimental.chat.messages.transform`, the adapter finds the current real user
text, excluding synthetic or ignored parts, selects entry through the shared
validator and caches that response for repeated agent steps. Native messages
arrive fresh from the database on every call, so every transform replaces only
parts tagged as this adapter's workflow and inserts at most one current
reference. Existing user text, tool results and compaction summaries retain
order and contents. Empty/non-user context is preserved.

`session.compacted` restores and revalidates the last selected workflow on the
next transform. An attached session can restore persisted selection, and a new
`chat.message` still performs normal entry selection. Failed configuration or
selection clears the saved workflow. The adapter retains at most 128 in-memory
session records and uses the bounded shared selection store. It persists no
workflow execution state. Complete workflow context is capped at 16 KiB;
oversized context becomes a diagnostic, never a preview.
Session construction happens inside guarded startup or transform callbacks.
Initialization failures from unawaited events retain a bounded diagnostic for
the next transform; later transforms retry construction after configuration or
state is repaired. Pending diagnostics share the same 128-record limit.

## Verification and blocked live run

Offline conformance imports the production JavaScript entrypoint and uses the
actual 1.18.29 SDK client with an offline fetch transport. It mocks native host
events, verifies API paths, registry/body corroboration, config idempotence,
context preservation, repeated transforms, compaction, failure clearing and
bounds. Deferred native inventory fixtures also cover unawaited startup ordering,
and constructor failures exercise diagnostic delivery and recovery. The
implementation type-checks against the installed plugin SDK.

A real OpenCode startup is **blocked** on this machine: reading
`/Users/nielsmadan/.opencode/opencode.json` failed with EPERM, and
`nono why --self` confirmed `DENIED / path_not_granted`. This previously verified
blocker was not retried or bypassed. No alternate HOME, relocated configuration,
new grant, weaker test or global settings change was used. No paid OpenCode run
was attempted in this milestone.

The complete future product smoke is prepared by:

```sh
node scripts/smoke/hosts.mjs opencode --prepare-only
```

After the user resolves the session's access externally and starts a suitable
session, the exact fresh-run command is:

```sh
node scripts/smoke/hosts.mjs opencode
```

The runner uses the production plugin, captures its transformed context and
native successful `skill` activation, preserves original test bytes, and runs
independent task checks. It has a 120-second deadline and 2 MiB stdout / 256 KiB
stderr limits. OpenCode's live installation, event order and adherence remain
unverified until that run succeeds.

Primary source checked at the official 1.18.29 tag:
[plugin API](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/plugin/src/index.ts).
The command fallback follows the
[native command registry](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/command/index.ts).

For an unmatched new user continuation, the adapter revalidates and restores the
selected workflow rather than dropping its ephemeral reference. Config edits
are re-rendered; removal or invalid configuration clears it. This can require
two bounded validator calls: entry selection, then restoration.
