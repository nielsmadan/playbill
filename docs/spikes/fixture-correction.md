# Test fixture correction

The scored Claude `02-unique` run received a malformed generated test: JavaScript
string literals contained raw newlines instead of escaped `\n` characters. Its
`node test.mjs` commands failed to parse. Claude reported the fixture defect,
completed all four registered skills and their artifacts in order, and checked
the same examples with correctly escaped inline assertions.

The scored slot remains unpassed. It was not rerun or replaced. This is a fixture
failure and supplies no evidence that the pipeline caused a code defect.

Before Pi's `02-unique` run or any scored Codex run, the generator was corrected
to emit escaped whitespace. All five generated test programs passed Node's syntax
check. The runner now checks generated syntax before launching a model and records
the generated test hash for subsequent runs.

The original broken file, its harness transcript and artifacts remain unchanged
under `.spike-runs/claude-02-unique/`. The portable run evidence includes the
original failure in tool outputs and review artifacts. The verifier independently
applies the corrected canonical assertions to that solution; those assertions
pass, while the recorded scored sequence still fails because its required test
commands did not pass and its task-local test differs from the corrected fixture.

The pipeline and all four skill texts were unchanged throughout the experiment.
