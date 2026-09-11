# Formats and shared validator

M1 defines version 1 of the configuration and pipeline formats. The shared Node
library validates declarations and renders instructions. The model carries out
those instructions through its harness. Optional native coordination tracks visits,
receipts, artifacts, and recorded condition decisions; it does not evaluate natural
language itself or provide a runtime sandbox. Successful
validation does not establish model compliance, artifact existence/content,
actual model capability, or review quality. See the frozen [M0 findings](spikes/2026-09-05-m0-findings.md).

## Configuration

```toml
version = 1

[slots]
implement = "my-implementation"
review = "company:independent-review"

[workflows.coding]
entry = "auto"
priority = 10

[workflows.coding.triggers]
keywords = ["implement", "fix"]
file_patterns = ["src/**", "test/*.mjs"]
repo_conditions = ["git"]
```

An empty TOML file is valid. Version defaults to 1; slots and workflows default to
empty tables. Slot and workflow names start with a letter and contain letters,
digits, underscores, or hyphens (at most 80 characters). Canonical skill IDs may
also contain `.`, `:`, `@`, and `/` (at most 200 characters). They are registry
identifiers, not filesystem paths. A binding can reference any installed custom
skill; bundled skills receive no special treatment.

Merge machine configuration first, then project configuration. Project scalar
fields override matching machine fields. Tables merge by key. Arrays replace
whole arrays; `[]` clears an inherited trigger list. An empty table retains
inherited fields. Both layers and the resulting configuration are validated.
Pipelines are whole-file copies: **pipeline data is never merged**.

Workflow keys identify pipelines by their `id`. Entry defaults to `auto`, priority
to 0. Priorities are integers from -1000 to 1000. Policy governs entry only;
pipeline steps are composed without per-slot `always`/`never` policy.

The following trigger semantics are the contract for adapters in M2/M3; M1 parses
and validates them but does not discover files, match requests, or enter workflows:

| Field                | Meaning                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry = "auto"`     | Explicit invocation is allowed; declared triggers may also select the workflow.                                                                                                                               |
| `entry = "explicit"` | Only an explicit request naming the workflow selects it.                                                                                                                                                      |
| `entry = "disabled"` | Entry is disabled, including explicit requests.                                                                                                                                                               |
| `keywords`           | Case-insensitive literal words or phrases in the user request, bounded by non-letter/digit/underscore characters or string edges.                                                                             |
| `file_patterns`      | Case-sensitive globs over workspace-relative, forward-slash file paths. `*` and `?` stay within a path segment; a whole-segment `**` spans zero or more segments. No braces, brackets, extglobs, or negation. |
| `repo_conditions`    | All listed guards must hold: `git`, `clean`, or `dirty`. `clean` and `dirty` require a Git repository and are mutually exclusive. Dirty includes untracked files.                                             |

A keyword match **or** file-pattern match is sufficient, subject to all repository
guards. If both match lists are empty, a nonempty repository guard list can select
the workflow on its own; with all three lists empty there is no automatic match.
Explicit selection takes precedence over automatic matching. Among multiple
automatic matches, choose one: highest priority, then workflow ID in ascending
code-point order. A specific explicit request does not fall through to another
workflow when its target is disabled or missing. Host adapters determine when
request text and candidate file paths are available; a session-start event alone
does not necessarily contain the first user request.

Glob matching is bounded by pattern and path length. `?` consumes one Unicode
code point. Trailing and repeated whole-segment globstars may consume no segments:
`src/**` and `src/**/**` both match `src` as well as its descendants.

## Native coordination policy

```toml
[workflows.debug.coordination]
enabled = true
artifact_scope = "run"
report_artifact = "report"
redirect_threshold = 2
ask_on_redirect = true
```

Coordination is optional and used by Claude/Codex only. Other hosts continue to
render the same YAML. `enabled` defaults to false, `artifact_scope` to `project`,
`redirect_threshold` to 2 (integer range 2–20), and `ask_on_redirect` to true.
`report_artifact` optionally names a declared artifact ID with exactly one terminal
producer and no consumers. Completion appends generated execution history to that
artifact and preserves its original narrative. Signed external report review is
not required by the installed policy. Unknown fields and invalid types fail
validation. Coordination fields merge individually across configuration layers.

Bundled debug enables coordination, run scope and its report artifact. Disabling
coordination in a project override restores rendered delivery for fresh entries.
Custom workflows default to project artifact paths. Run scope relocates each
declared artifact into a unique run directory; existing pipeline inputs cannot be
relocated. The compiler accepts steps, `if`, and bounded `while`, including an
initial false loop condition. Each condition requires a current visit token,
condition identity, boolean and rationale before advancing. Unsupported control
flow, collection artifacts, fresh-agent requirements and graphs exceeding 100
lowered nodes produce a coordination diagnostic. See the
[installed coordinator contract](adapters/installed-coordinator.md).

## Pipelines

```yaml
version: 1
id: coding
title: Coding workflow
artifacts:
  - { id: task, path: TASK.md }
  - { id: code, path: src/solution.ts }
  - { id: review, path: reviews/final.md }
inputs: [task, code]
outputs: [code, review]
steps:
  - type: step
    id: implement
    title: Implement
    skill: '{{implement}}'
    consumes: [task, code]
    produces: [code]
  - type: step
    id: review
    title: Review
    skill: '{{review}}'
    consumes: [task, code]
    produces: [review]
    requires: { fresh: true, read_only: true, model: capable }
    agent: { fresh: true, read_only: true, model: capable }
    instruction: report concrete findings and executable check results
```

`version`, `id`, `title`, `artifacts`, and `steps` are required. `introduction` is
optional single-line text; a short common introduction is supplied otherwise.
`inputs` and `outputs` default to empty arrays. At least one step is required.
Every step must have a globally unique `id`, a `title`, and a `skill` containing
exactly `{{slot_name}}`. Titles need not be unique. Unknown fields are errors.
Optional `instruction` is concise single-line prose, not executable code.

Artifacts have a unique `id`, a unique workspace-relative `path`, and optional
`kind` (`file` by default, or `collection`). IDs are user-defined within the same
identifier syntax as slots. Paths may contain conventional filenames and spaces;
absolute paths, traversal, empty segments, backslashes, colons, backticks, and
templates are unsupported. Rendered instructions delimit each artifact path with
its own code span, including collection paths, so a filename containing `and`
remains distinct from a list of files. A collection is a file containing a JSON
array of task-description strings. The renderer describes that requirement; it
does not read the collection or assert that its contents satisfy it.

`consumes` and `produces` reference artifact IDs and default to empty arrays. An
artifact may be produced by multiple steps, including updates to an input or
outputs from alternative branches. Duplicate **declarations** and duplicate IDs
inside a reference list are errors. Inputs are promises from the caller, not
filesystem checks. Every final output must be definitely available.

### Agent contracts

`requires` declares the step's requirements. An installed registry entry may
declare additional skill requirements; both must be satisfied. `agent` declares
the execution properties the coordinator is to provide. It defaults to
`{fresh: false, read_only: false, model: balanced}`. Empty requirements impose no
restriction. Boolean requirements match exactly when specified; model requirements
are a minimum under `fast < balanced < capable`. Tier names are portable declared
categories, not provider model IDs or guarantees about model quality. Adapters
and coordinators must map them to actual available execution capabilities.

`fresh: true` means a new agent context supplied with the task and declared
artifact paths, independent of earlier conversation. `read_only: true` means the
agent may read files and run non-mutating checks, and must return findings or
other output to its coordinator. The coordinator may persist that returned output
at declared artifact paths. Thus a read-only reviewer may declare produced report
files; it does not receive permission to mutate workspace files itself. Build or
test commands that write caches or other files are not read-only checks. These
are declarative contracts, not enforced access controls.

### Control flow

Each control-flow body uses the same `steps` node array; `if` uses `then`/`else`.
Conditions, selectors, and case labels are natural-language model decisions. No
expression language, interpolation, shell execution, or evaluation is provided.

```yaml
- type: if
  condition: the task needs a design change
  then: []
  else: []
- type: switch
  select: the appropriate review depth
  cases:
    - when: the change crosses module boundaries
      steps: []
  default: []
- type: while
  condition: actionable findings remain
  max_iterations: 3
  steps: []
- type: for_each
  collection: tasks
  as: task
  max_items: 20
  steps: []
```

Empty bodies are permitted, but a whole pipeline must contain a step. A switch
needs at least one unique case label and uses the first matching case. `else` and
`default` are optional: an omitted branch is a real path that performs no work.
After an `if` or `switch`, only artifacts available on **every** branch remain
definitely available. The analysis is compositional, including nested branches.

Both loop kinds require a positive integer cap of at most 100. While conditions
are checked before every iteration; reaching the cap continues after the loop.
A `for_each` references an available artifact with `kind: collection`, binds the
current task description to its `as` name, and processes file order. An empty
array skips the loop. A collection exceeding `max_items` stops the workflow with
a report rather than silently truncating work. Both loops may execute zero times,
so newly produced body artifacts are not definitely available afterward. Body
dependencies are checked from the state entering the first iteration.

Artifact paths are fixed. Iterations reuse the same scratch/output paths;
per-item path substitution and automatic accumulated output files do not exist.
Declare a collection/report as an input or produce it before a loop if a later
step needs it regardless of whether that loop executes.

## Installed skill registry

```yaml
version: 1
skills:
  - id: company:independent-review
    path: ./skills/review/SKILL.md
    model_invocable: true
    requires: { fresh: true, read_only: true, model: capable }
```

The explicit registry accepts YAML or its JSON subset. Paths resolve relative to
the registry file, are canonicalized, and must point to readable, nonempty regular
`SKILL.md` files. Adapters can normalize native names to canonical IDs in these
snapshots. Their registry snapshots are a trust boundary: core validates the
installation files and declarations, not whether a host has registered an alias
correctly. Config bindings never create registry entries.

`model_invocable` defaults to true; adapters must set it false for native skills
disabled for model invocation. Such entries cannot fill workflow slots.
`requires` defaults to empty. Duplicate canonical IDs fail as ambiguous even when
the paths are identical. Multiple IDs for one file are allowed for explicit
adapter aliases. Every configured binding is checked, including bindings unused
by the currently selected pipeline.

`--skill-root DIR` scans immediate child directories or directory symlinks with
`SKILL.md`, using the **frontmatter `name`**, which may differ from the directory
name. Frontmatter is required for scanning. Native `disable-model-invocation` is
preserved. Files without a child skill file are ignored; unreadable skills fail.
There is no recursive scan, basename fallback, global registry discovery, or
automatic assumption that the future bundled suite is installed.

## CLI and public API

After `npm ci && npm run build`, the package exposes the `playbill` binary. In the
checkout, use `npm run --silent playbill --` as the command prefix, or
`node dist/cli.js`. Registry and skill-root flags can be repeated; their entries
are combined and checked for ambiguity. Machine and project files are explicit
M1 inputs; discovery belongs to the adapters.

```sh
node dist/cli.js validate test/fixtures/coding.yaml --config test/fixtures/config.toml --skill-root test/fixtures/skills
node dist/cli.js render test/fixtures/coding.yaml --config test/fixtures/config.toml --skill-root test/fixtures/skills
```

`validate` writes `Valid: <pipeline-id>`. `render` writes only common prose with
canonical IDs, independent of native invocation mechanics or absolute registry
paths. Errors go to stderr, with diagnostic code and field/source path. Exit codes
are 0 for success/help, 1 for invalid data or unavailable files, and 2 for usage
errors. Rendering failures emit no partial instructions.

```ts
import {
  mergeConfig,
  parseConfig,
  parsePipeline,
  loadRegistry,
  validatePipeline,
  renderPipeline,
} from '@playbill/core';

const config = mergeConfig(parseConfig(machineToml), parseConfig(projectToml));
const pipeline = parsePipeline(pipelineYaml);
const installed = loadRegistry('/path/to/registry.yaml');
const validated = validatePipeline(pipeline, config, installed);
const prose = renderPipeline(validated);
```

The package exports config/AST/registry/diagnostic types, parser functions,
`validateConfig`, `pipelineData`, `validateRegistry`, `discoverSkills`, `readText`,
`validatePipeline`, `renderPipeline`, `compilePipeline`, `PlaybillError`,
`formatDiagnostic`, and `LIMITS`. `compilePipeline(pipeline, config, registry)`
combines validation and rendering. `parseRegistry(text, baseDir?, sourcePath?)`
supports native registry snapshots without a temporary file. Validation APIs
check plain object inputs as well as parsed documents. Validation stores a bounded
prose snapshot; pass that exact returned object to the renderer. Changing its data
does not change the snapshot: call validation again after edits. A forged or copied
result is rejected by the renderer.

## Parsing, bounds, and tooling decisions

YAML is strict 1.2 core schema. Duplicate mapping keys, aliases/anchors, merge
keys, explicit tags, complex/non-string keys, multiple documents, warnings, and
nonfinite numbers fail. TOML dates, nonfinite numbers, custom objects, accessors,
cyclic/shared object data, sparse arrays, symbol keys, and reserved prototype keys
are unsupported. File decoding requires valid UTF-8. No custom TOML/YAML parser
is used.

Limits are 256 KiB per source/skill file, 2,000 characters per data string, 20,000
data nodes, 64 data levels, 1,000 array items/registry entries, 256 control-flow
nodes, and 16 control-flow levels. YAML syntax nodes count toward the data limit
before conversion. Worst-case expanded step/loop visits may not exceed 10,000;
nested caps multiply. Rendered instructions may not exceed 64 KiB, checked during
validation before retaining the prose snapshot. Adapters apply their host's
delivery limit separately; the [Claude adapter](adapters/claude.md#runtime-boundary-and-limits)
requires the complete context, including its invocation mapping and event text,
to fit 10,000 characters. These are authoring/validation bounds, not execution
enforcement. Diagnostics reject oversized data instead of rendering it.

Production is TypeScript ESM compiled to Node JavaScript, supported on **Node
24.x** (`>=24 <25`), verified locally on 24.16.0. The narrow major range makes the
initial support promise testable; widening it requires compatibility checks.
TypeScript is pinned to 6.0.3 because the installed typescript-eslint 8.69.0 peer
range excludes TypeScript 7. Format with Prettier; lint with ESLint; test the built
public API and real CLI with Node's test runner. Frozen `docs/spikes/` and local
`.spike-runs/` evidence are excluded from production format/lint/compilation.

The only runtime dependencies are [smol-toml 1.8.0](https://github.com/squirrelchat/smol-toml)
(`parse` named export) and [yaml 2.9.0](https://eemeli.org/yaml/)
(`parseDocument`, AST guards, `toJS({maxAliasCount: 0})`). Official npm metadata
and maintainer documentation were checked on 2026-09-05: both had 2026 releases;
their engine ranges include Node 24. Versions and transitive dependencies are
locked in `package-lock.json`.

The [four-step fixture](../test/fixtures/coding.yaml) and
[golden](../test/fixtures/coding.golden.md) preserve the tested M0 sequence, bound
IDs, and concise prose shape. Each artifact path has its own code span; the last
two lines enumerate declared artifacts and separate check instructions. This is
**M0-equivalent structured prose** in meaning, not a byte-identical reproduction
of the frozen experiment. Shared byte-identical rendering across adapters remains
the M3 acceptance requirement.
