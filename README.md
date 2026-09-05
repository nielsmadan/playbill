# Playbill

Playbill binds named workflow slots to installed skills, declares when workflows
can start, and renders YAML pipelines into instructions for coding agents.

The shared validator and CLI are implemented. Harness adapters and the default
workflow suite are later milestones. This is a model-executed router; validation
checks declarations and composition, not whether a model follows instructions.

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
