# Pi adapter

The adapter targets `@earendil-works/pi-coding-agent` 0.84.1 and Node 24.
Run `npm ci && npm run build`, then load the production TypeScript extension:

```sh
pi -e /absolute/path/to/playbill/adapters/pi/playbill.ts
```

Package metadata declares `pi.extensions` and `pi.skills`, so a normal Pi package
installation can discover both. For a persistent checkout integration, add the
extension path to the user's chosen Pi settings scope. Installation and host
settings remain user operations; the adapter does not edit them. The host SDK is
an optional peer dependency and a pinned development dependency used to verify
its real event types. The public adapter export is `@playbill/core/pi`; the core
export does not require host SDK declarations.

## Lifecycle and inventory

Pi emits `session_start` **before** `resources_discover`. The extension returns
its bundled `skills/` directory from resource discovery when present. A startup
event cannot yet validate a complete native inventory: validation happens at
`before_agent_start`, after native resource loading and before the first model
request. Both startup validation and prompt selection use the same Node
validator subprocess. Invalid configuration becomes visible model context and
an error notification when UI is available.

`before_agent_start.systemPromptOptions.skills` is the authoritative `Skill[]`:
its native name, filePath and disableModelInvocation flag govern selection.
External skills may omit a frontmatter name: Pi supplies the installed directory
name, including the directory used for a symlink installation. Playbill preserves
that native name without re-deriving it from the canonical file path.
The adapter retains this event's inventory for later context and compaction
callbacks. In 0.84.1, `getSystemPromptOptions()` belongs to
`ExtensionCommandContext`, not the ordinary event `ExtensionContext`; the
extension does not call an unavailable event-context getter.

Bundled files default to canonical `playbill:<frontmatter-name>` IDs, while Pi
continues to advertise its actual native name. For explicit aliases, set
`PLAYBILL_PI_INVENTORY` to the version-1 snapshot described in
[the Codex inventory contract](codex.md#native-inventory). The adapter preserves
snapshot IDs and verifies every attested invocation/file against this session's
native `Skill[]`. A missing or disabled native entry is unavailable even when a
snapshot says true. Pi's native disabled flag remains authoritative, including
for description-only frontmatter and explicit aliases. Duplicate
canonical IDs and ambiguous native invocations are errors.

Pi activates a skill by reading its registered `SKILL.md`; it has no built-in
`Skill` tool. Its appendix names that read path and the resolved project root
for artifact paths. Pi also has no standard fresh-subagent tool. The appendix
explicitly requires reporting a missing capability before a step that needs it;
it does not replace a fresh reviewer with the coordinator or weaken the
pipeline's declared contract.

## Context and restoration

The `context` event runs before every model request. The extension preserves
native user messages, tool results and compaction/branch summaries, replaces
only its own `playbill:workflow` custom message, and adds at most one current
workflow reference. The complete message, including mappings, capability notes,
root and restoration suffix, is capped at 16 KiB. Overflow produces a bounded
error and clears saved selection.

`session_compact` revalidates and restores the last selected workflow on the
next context callback, using the latest captured native inventory. `session_start`
with resume/reload restores the saved selection when inventory becomes
available; new/fork/startup and tree navigation clear it. Entry policy governs
new selections, so disabling entry after selection does not cancel compaction
restoration. Invalid configuration clears the saved selection. No step counter,
artifact contents, prompt transcript or workflow runner is maintained.

Configuration discovery, candidate files and subprocess limits follow
[the common adapter contract](common.md). `PLAYBILL_NODE` can select a specific
Node executable. The package extension resources and any skills explicitly
loaded by the host remain subject to its native settings.

## Verification

Deterministic tests load `adapters/pi/playbill.ts` using Pi's real extension
loader, load fixture skills using Pi's real skill loader, and invoke the
registered native event handlers with offline host events. They verify the
shared Node subprocess output, actual SDK shape, lifecycle ordering, disabled
skills, alias mapping, context preservation, compaction, restoration and bounds.

`node scripts/smoke/hosts.mjs pi` runs the paid production extension smoke. Its
observer records the actual custom message after transformation and stops at
12 turns. The successful trial used native inventory, a successful `read` of the
registered skill, a matching injected path, a skill-only receipt and four
independent tests with unchanged original bytes. See
[the retained evidence](m3-smoke.json). It used
`openai-codex/gpt-5.6-sol`, low thinking, and reported $0.09386 in usage cost.
No additional trial was run after the artifact-root appendix refinement.

Primary API references are the installed 0.84.1 package's
`dist/core/extensions/types.d.ts`, `dist/core/agent-session.js`,
`dist/core/skills.d.ts`, and `docs/extensions.md`. Their event ordering and native
activation were also exercised in the real smoke.

A nonmatching continuation such as `yes` revalidates and restores the selected
workflow rather than dropping the ephemeral reference. Config edits are
re-rendered; removal or invalid configuration clears it. This can require two
bounded validator calls: entry selection, then restoration.
