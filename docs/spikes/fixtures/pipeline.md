Playbill M0 coding workflow

For this coding task, use the following steps in order. Each step invokes its named skill through the harness skill registry.

1. Implement — invoke `pb-implement`; consume TASK.md and solution.mjs; produce solution.mjs and implementation.md.
2. Task review — invoke `pb-task-review`; consume TASK.md, solution.mjs and implementation.md; produce reviews/task.md.
3. Fix — invoke `pb-fix`; consume reviews/task.md and solution.mjs; produce any repairs and fixes.md (record no changes when the review is clean).
4. Final review — invoke `pb-final-review`; consume the task, code and prior artifacts; run the executable checks and produce reviews/final.md.
