# Glossary

The words weakspot uses in code, output and docs. Code names match these exactly. A concept that is not here is not used in code; a new one gets its entry in the same change.

Where the [mutation-testing report schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema) has a word, that word is used with its meaning. Those entries are marked (schema).

## Change

| Term | Meaning |
| --- | --- |
| Change | The set of files and line ranges a run looks at: a local diff against a base, the working tree, a pull request, or an explicit list. |
| Base | The commit a local change is compared to, usually `origin/develop` or `origin/main`. |
| Changed file | A source file that appears in the change, with its status (added or modified) and its changed ranges. Deleted files are not changed files. |
| Line range | A start and end line, inclusive, in one file. Written `file.ts:12-40`. |
| Changed range | A line range that the change added or modified. Mutation is limited to changed ranges. |
| Triage | The step that keeps or drops changed files before mutation, by skip patterns and by whether a spec reaches them. |
| Skip pattern | A regular expression on the repo-relative path. A match drops the file from mutation. Configurable. |
| Class | Either `logic` or `component` (a `.tsx` file). Both are mutated; the class steers noise classes only. |
| Spec | A test file. Vitest and Jest both call them specs here, whether named `.spec.ts` or `.test.ts`. |
| Spec set | The specs that import a given source file, directly (depth 1) or through one intermediate file (depth 2). The only tests run for that file. |
| Untested | A changed file with an empty spec set. Reported, not mutated. |
| No test config | A kept file whose package has no test config the tool knows. Reported, not mutated. |
| Changed-spec rule | A changed spec causes the sources it imports to be mutated whole, with that spec alone as the spec set. |
| Package | A directory with its own `package.json` and test config. A monorepo has several; each is run on its own. |

## Mutation

| Term | Meaning |
| --- | --- |
| Target | A file, or the changed ranges inside it, that one engine run mutates. |
| Mutant (schema) | One change to the source: a location, the original text and the replacement. |
| Mutator (schema) | The rule that produced an operator mutant, named as Stryker names it (`ConditionalExpression`, `EqualityOperator`, `StringLiteral`). |
| Operator mutant | A mutant produced by the mutation engine's mutators. |
| Static mutant (schema) | A mutant in code that runs at module load (a top-level constant, a class field initializer). It has no per-test coverage and runs against the whole spec set. |
| Model mutant | A mutant written by an author in answer to a placeholder. |
| Mutation engine | The component that instruments code, generates operator mutants and runs them with per-test coverage. StrykerJS today. |
| Excluded mutations | Mutators switched off for a run, by name. Configurable. |
| Placeholder | A code fragment on a changed line offered to an author for replacement: its location, kind, original text and surrounding context. |
| Placeholder kind | One of `condition`, `loopHeader`, `callArguments`, `returnExpression`. The tool's own enum, not a parser's. |
| Author | Whoever answers placeholders with model mutants: an agent in the session, or a person. Never the tool. |
| Author prompt | The file in `docs/` that tells an author what to produce and how. |
| Rejection | A submitted model mutant the tool refuses before running it, with a reason: does not parse, outside its placeholder, wrong kind, identical to the original, duplicate. |
| Dry run | The run of the spec set before any mutation, to confirm it passes and to record which tests cover which lines. A failing dry run stops the pass. |
| Sandbox | A copy of a package without `node_modules`, with `node_modules` linked back in, where a mutant is written and the spec set run. Never the real working tree. |
| Verdict | The outcome of running one mutant. One of the statuses below. |
| Killed (schema) | At least one test failed with the mutant in place. |
| Survived (schema) | Every covering test passed with the mutant in place. |
| No coverage (schema) | No test in the spec set executes the mutated line. Counted as a survivor. |
| Timeout (schema) | The spec set did not finish within the per-mutant timeout. Treated as killed. |
| Compile error (schema) | The mutant did not type-check. Only possible with a type checker enabled, which is off by default. |
| Runtime error (schema) | The spec set crashed before any test could judge the mutant. Not a survivor, not a kill. |
| Ignored (schema) | A mutant deliberately not run: excluded mutator, or matches a suppression. |
| Per-test coverage | The mapping from each mutant to the tests that execute its line, recorded in the dry run. A mutant runs only its covering tests. |
| Timeout factor | The per-mutant time limit, derived from the dry run's duration plus a fixed margin. Small because spec sets are small. |

## Report

| Term | Meaning |
| --- | --- |
| Survivor | A mutant with verdict survived or no coverage, after suppressions. The unit a consumer acts on. |
| Weak assertion | A survivor whose line is covered: tests reach it and none notices the change. |
| Static survivor | A surviving static mutant: every test ran against it and none failed. Neither covered nor uncovered in the per-test sense. |
| Noise class | A heuristic label on a survivor that makes it unlikely to matter: `logging`, `errorMessage`, `catchOnly`, `jsxAttribute`. Hidden by default, listed in a count. |
| Suppression | A record that a survivor was accepted (equivalent, or deliberately untested), with a reason and date. A matching mutant is ignored in later runs. |
| Mutant key | The identity used by suppressions: repo, file, mutator or `model`, and a hash of original and replacement text. Line numbers are not part of it. |
| Equivalent mutant | A mutant that cannot change observable behaviour, so no test can kill it. Judged by a consumer, recorded as a suppression. |
| Finding | A survivor expressed for a consumer: location, claim, evidence, severity. Severity is `medium` for both untested files and weak assertions unless the consumer raises it. |
| Warning | Something that went wrong without stopping the run, listed in the report: a target that produced no mutants, for example. |
| Report | `report.json` (everything) and `report.md` (what ran, what was skipped and why, survivors by file). Rewritten as packages finish. |
| Mutants file | `mutants.json`, the model mutants an author submitted, stored next to the report as the replayable record of a run. |
| Consumer | Whoever reads the report: a review agent, a person, a skill. Outside the tool. |
