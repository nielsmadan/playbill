# Playbill

Playbill binds named workflow slots to installed skills and renders YAML pipelines into instructions for coding agents.

## Commands

| Command                      | Description                                             |
| ---------------------------- | ------------------------------------------------------- |
| `npm run setup`              | Install locked dependencies and hooks, then run doctor. |
| `npm run doctor`             | Validate the local setup and Git hooks.                 |
| `npm run build`              | Compile the TypeScript package.                         |
| `npm run check-all`          | Run formatting, lint, and type checks.                  |
| `npm test`                   | Build and run the API and CLI tests.                    |
| `npm run playbill -- --help` | Show CLI options and exit statuses.                     |

## Gotchas

- The editable global command uses this checkout's built output; run `npm run build` after editing TypeScript to update it.
