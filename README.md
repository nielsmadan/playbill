# Playbill

Playbill binds named workflow slots to installed skills, declares when workflows
can start, and renders YAML pipelines into instructions for coding agents.

The package includes the shared validator, CLI, four host adapters, and bundled
workflows and skills. On Claude and Codex, the default debug workflow uses an
[installed coordinator](docs/adapters/installed-coordinator.md) to retain visits,
require native skill receipts and fresh artifacts, and record branch decisions.
Other workflows and the Pi/OpenCode adapters deliver rendered instructions.
These checks do not establish that the model followed a technique or repaired the bug.

Use Node 24.x:

```sh
npm ci
npm run build
npm run --silent playbill -- validate test/fixtures/coding.yaml --config test/fixtures/config.toml --skill-root test/fixtures/skills
npm run --silent playbill -- render test/fixtures/coding.yaml --config test/fixtures/config.toml --skill-root test/fixtures/skills
```

See [formats, contracts, registry and API](docs/formats.md) for custom pipelines,
machine/project precedence, and the explicit registry interface. `playbill --help`
lists CLI options and exit statuses. No global configuration is needed for the
fixture commands.

The [Claude adapter guide](docs/adapters/claude.md) covers local plugin loading,
configuration discovery, workflow requests, native skills, and smoke evidence.

To install the CLI from this checkout, use Just:

```sh
just install
just install-editable
just uninstall
```

`install` installs dependencies, builds, and copies the current package into npm's global
prefix. Re-run it to replace the installed snapshot after changes, even at the same version.
`install-editable` links the global command to this checkout; run `npm run build` after editing
TypeScript to update that command. `uninstall` removes either installation and preserves your
workflow configuration. These are Just recipes because npm reserves `install` as a dependency
installation lifecycle hook.

Development commands:

```sh
npm run format
npm run check-all
npm run build
npm test
```

`check-all` runs format, lint, and type checks; tests remain separately invokable.
`npm test` builds first and exercises the public API and actual CLI. The frozen M0
experiment is excluded from production tooling and can still be replayed with
`node docs/spikes/replay.mjs`.
