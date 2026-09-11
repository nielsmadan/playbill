# Codex adapter

The installed coordinator targets Codex 0.154.0 and Node 24. Build this checkout with
`npm ci && npm run build`. The manifest at `.codex-plugin/plugin.json` selects
`adapters/codex/hooks.json`; `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `Stop`, and `SessionEnd` call the production hook entrypoint. A normal plugin installation supplies `PLUGIN_ROOT`
and `PLUGIN_DATA`. Codex also supplies Claude-compatible aliases.

For an existing marketplace containing this repository, the user installs with
`codex plugin add playbill@<marketplace>`. Local marketplace source paths are
relative to the marketplace repository root, so an entry for this repository
itself uses `./`. This milestone supplies the adapter and package seams; public
marketplace distribution is separate. See the official
[plugin packaging reference](https://developers.openai.com/plugins/build/plugins).

For project-local testing without installing a plugin, copy the event
registrations into the project's `.codex/hooks.json`, replace each command with
`node "/absolute/path/to/playbill/adapters/codex/hook.mjs"`, and enable
`[features] hooks = true` in normal Codex configuration. This mode runs the same
production adapter. Register its skills separately through Codex's native
`.agents/skills` or installed plugin resources. Configuration bindings never
install skills.

## Trust and complete delivery

Codex's normal hook trust gate applies to each hook group. Review the actual
command and source, then accept it through the host's trust flow. Changing a
command can require new trust. Playbill does not set global trust, bypass the
gate, or change the user's sandbox.

The read-only app-server `hooks/list` method reports the exact key, current hash,
source path, enabled flag, trust status, errors, and warnings for each cwd.
Initialize with `capabilities.experimentalApi = true`, send the `initialized`
notification, then request `hooks/list` with `{ "cwds": ["/project"] }`. This
creates no thread or model turn. Prefer the returned `currentHash` to calculating
a hash from an assumed schema.

For a reviewed, ephemeral test only, a CLI override can supply the exact keys:

```text
-c 'hooks.state={"/project/.codex/hooks.json:session_start:0:0"={trusted_hash="sha256:<reported-hash>"},"/project/.codex/hooks.json:user_prompt_submit:0:0"={trusted_hash="sha256:<reported-hash>"}}'
-c 'projects={"/project"={trust_level="trusted"}}'
```

These are whole TOML table values. Codex 0.153.4 splits dotted override keys even
inside quoted path segments; `-c 'hooks.state."/path.with.dots/..."...'` therefore
does not create the intended key. The smoke preflight reads hashes, applies the
ephemeral table, and independently confirms both groups report `trusted`.

Context-producing handlers set `additionalContextLimit: 0` because the adapter bounds the
**complete** workflow, invocation appendix, artifact root and restoration text
to 16 KiB. Oversized instructions produce an error and clear the selection;
there is no partial workflow. The setting prevents Codex's default context
preview/file spill. Hook timeout is 15 seconds, allowing five seconds each for
native discovery and the shared validator. See the
[Codex hooks reference](https://developers.openai.com/codex/hooks).

The [installed debug coordinator](installed-coordinator.md) returns the current
visit, records exact native full-file skill-read receipts, and retains condition
decisions and execution history. Active and released runs route before inventory
or trigger discovery. Tool and Stop events with no coordinated run stay quiet.
`Stop` returns only `{}` or a block decision with a reason; Codex 0.154.0 does not
register Claude's `PostToolUseFailure` event. Packed artifacts include the runtime
YAML/TOML dependencies and coordinator modules.

## Native inventory

Startup and prompt events without a retained coordinated run start a bounded,
read-only `codex -C <cwd> app-server`,
initializes the experimental protocol, requests `skills/list` with that cwd and
`forceReload: true`, then terminates the helper. It never starts threads, turns,
or model calls. Discovery has a five-second process deadline and a 2 MiB combined
stdout/stderr bound. The owned helper and its pipe handles are terminated at the
limit, including if it ignores SIGTERM.

Native `name`, `path`, and `enabled` determine registration. Names from installed
plugins are already namespace-qualified. Skills in this package's canonical
`skills/` tree default to `playbill:<frontmatter-name>`; native invocation remains
separate. `agents/openai.yaml` with
`policy.allow_implicit_invocation: false`, or frontmatter
`disable-model-invocation: true`, prevents filling a workflow slot. Malformed
third-party metadata makes that individual native entry unavailable with its
specific reason. Duplicate native identities fail as ambiguous; Playbill does
not invent precedence.

A separate discovery process cannot inherit arbitrary parent CLI overrides.
For such sessions, or an ambiguous native registry, set
`PLAYBILL_CODEX_INVENTORY` to an absolute YAML/JSON snapshot:

```yaml
version: 1
skills:
  - id: company/custom@v1
    path: /installed/skills/review/SKILL.md
    invocation: company:review
    model_invocable: true
    requires: { fresh: true, read_only: true, model: capable }
```

The snapshot attests what the intended session has installed. Paths resolve
relative to its file and canonicalize to readable `SKILL.md` files. Canonical
IDs, including explicit aliases of bundled files, are preserved. Native
invocations must match the frontmatter name with an optional namespace. Native
invocation policy cannot be enabled by a snapshot; duplicate IDs or invocations
pointing at different files fail. This is installation evidence, not permission
to read files, invoke tools, or create fresh agents.

The read-only native probe on the implementation machine returned 69 skills.
Its registry contained duplicate `skill-creator` IDs and one third-party plugin
with malformed YAML. Consequently, the live smoke used the documented explicit
snapshot, with a separately registered `.agents/skills` fixture. Native API
availability and the successful snapshot smoke are distinct evidence.

`PLAYBILL_CODEX_EXECUTABLE` selects the inventory CLI; `PLAYBILL_NODE` selects the
Node validator executable. The other discovery and state overrides, explicit
`[playbill:<workflow>]` marker, backtick-delimited candidate paths, layer order,
and entry rules follow [the common adapter contract](common.md).

## Verification

Offline tests drive the production hook command, a real app-server-shaped
protocol helper, malformed and ambiguous registries, metadata policy, process
termination, context bounds, and four-host conformance. `node
scripts/smoke/hosts.mjs codex` runs a paid, isolated production-hook test; it is
outside normal test discovery. The retained [M3 smoke evidence](m3-smoke.json)
records a successful native skill-file read, matching injected invocation,
skill-only receipt, preserved original test bytes and four independent checks.
It used project hook registration with an observer forwarding unchanged input
and output to the production entrypoint. Marketplace installation itself was
not exercised. No trust settings were persisted.
