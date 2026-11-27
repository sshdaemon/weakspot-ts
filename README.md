# weakspot-ts

Mutation checks on the lines a change touched, for TypeScript projects tested with Vitest or Jest. It finds the places where tests run but constrain nothing, without a repo-wide mutation run and without touching the project.

A local tool for coding with LLM agents: a person or an agent runs it against a change, reads the survivors, writes the missing tests. It makes no model calls of its own.

## What it does

1. Takes a change: what differs from the base branch (`diff`), a pull request (`pr 123`), or files and line ranges you name (`files src/money.ts:12-40`).
2. Drops files that hold no logic (DTOs, modules, barrels, migrations, specs), by configurable patterns.
3. Finds the specs that constrain each file by resolving the specs' imports with the TypeScript compiler (so `paths` aliases count), within the file's own package, one hop by default, two with `--depth 2`; `--specs` overrides discovery. A spec that mocks a module with `vi.mock` or only imports its types is not that module's spec. A file with no unit spec goes to the next lane you configure, such as an end-to-end suite with a database per worker (see [Lanes](#lanes)), and is reported as untested, a finding rather than a mutant, only when no lane has a spec for it.
4. A changed spec mutates the sources it imports, whole, against that spec: that is where "I added a test" claims get checked.
5. Runs [StrykerJS](https://stryker-mutator.io) on exactly those ranges with exactly those specs, so a run takes seconds, not minutes.
6. Writes `report.md` and `report.json`: what ran, what was skipped and why, and the survivors with how many tests reached each one.
7. Optionally, offers the changed conditions, loop headers, calls and returned values to an author (an agent in your session, or you) who writes plausible mistakes there, then runs those too (see [Model mutants](#model-mutants)).

Nothing is installed into or written inside the project: Stryker, its Vitest runner and a pinned Vitest live in this repo's `node_modules`, temp dirs, reports and a cache of each file's parsed imports (keyed by its content) live under `~/.weakspot/`, and Vitest's results cache is switched off so nothing lands in the project's `node_modules/.vite`.

## Use

```bash
npm install
node bin/weakspot.js diff                       # everything changed against the base, committed or not
node bin/weakspot.js diff --staged --base origin/main
node bin/weakspot.js files src/utils/money.ts
node bin/weakspot.js files src/a.ts:10-40 src/b.ts --specs src/a.spec.ts
node bin/weakspot.js diff --changes changes.json   # the files and lines another tool already chose
node bin/weakspot.js pr 123                         # a pull request, in a worktree of its own (needs gh)
node bin/weakspot.js map e2e                        # which e2e specs run which files, for "coverage" spec sources
node bin/weakspot.js propose --out /tmp/ws          # placeholders for model mutants, same change as diff
node bin/weakspot.js run --mutants /tmp/ws/answers.json --check  # judge the answers only, no tests
node bin/weakspot.js run --mutants /tmp/ws/answers.json
```

`diff` compares the merge base of HEAD and the base ref with the working tree (committed, staged, unstaged and untracked), or with the index (`--staged`), or with HEAD (`--committed`). The base is `--base`, else the repo config's `base`, else the remote's default branch (`origin/HEAD`); without any of those the command stops and says so. Deleted files are ignored and only added and modified lines are mutated; a spec that only lost lines (a deleted test) still counts as a changed spec. `--repo` must be the top of the git checkout.

`diff --changes <file>` reads the files and lines from a change list instead of running git diff, so several tools can judge exactly the same lines:

```json
{
  "repo": "/abs/path/to/checkout",
  "base": "origin/main",
  "head": "working-tree",
  "files": [
    { "path": "src/a.ts", "status": "modified", "ranges": [[12, 40], [88, 91]], "removedLines": true },
    { "path": "src/b.ts", "status": "renamed", "oldPath": "src/old-b.ts", "ranges": "whole", "removedLines": false },
    { "path": "src/a.test.ts", "status": "modified", "ranges": [], "removedLines": true }
  ]
}
```

Paths are repo-relative, ranges inclusive and on the new side, `status` is `added`, `modified` or `renamed`. `removedLines` says whether the diff removed any line of the file; a file that only lost lines (a deleted test) is listed with `"ranges": []`, and a file that neither gained nor lost a line (a pure move) is left out. Mutants run on the files on disk, so `head` must be `working-tree`, or the commit that is checked out with none of the listed files edited since; a listed file that does not exist is an error. The list does not quote removed lines, so a spec that lost any counts as changed; one marked `"removedLines": false` whose added lines are all imports is skipped, as with `diff`; without the field, a spec always counts as changed. `--repo`, when given, must be the list's `repo`; `--base`, `--staged` and `--committed` do not apply.

`pr <number or URL>` checks a pull request without touching your checkout. It reads the pull request with the GitHub CLI (`gh`, signed in), fetches its head and base from `origin`, makes a detached worktree at the head under `~/.weakspot/worktrees/<repo>/`, links each package's installed `node_modules` from your checkout into it (workspace packages point at the worktree's own copies), and runs the pipeline on the lines the pull request changes against the merge base with its base. The worktree is removed afterwards; `--keep` leaves it and prints its path and the base commit, so `propose --repo <that path> --base <that commit>` offers the same lines and `run --mutants` can follow. Runs without `--keep` each get a worktree of their own, so they never meet, and neither reuse nor `--clean` touches a worktree a running `pr` is using. The next `pr` for the same head reuses a kept worktree, refuses one with edits to tracked files (so nothing you wrote there is lost), and `pr --clean` removes the kept ones. `--repo` is the top of the checkout whose `origin` has the pull request; a URL of another repository is refused. So is a pull request whose lockfiles at its head differ from the ones installed in your checkout, since the linked dependencies would not match: install them in a checkout of its branch and use `diff` there. `--specs` paths read as for `diff` and must exist at the pull request's head. Packages whose tests import other packages' build output need a lane `prepare` to build it, as on a local run.

Other options: `--repo`, `--changes`, `--specs`, `--depth`, `--lanes`, `--escalate`, `--out`, `--timeout-ms`, `--concurrency`, `--exclude`, `--quiet`. `node bin/weakspot.js --help` lists them. Paths are relative to the cwd, or to `--repo` when it is given. A path that does not exist or lies outside the repo is an error, not an untested file.

Needs Node 22.18 or later (the CLI runs the TypeScript sources directly) and a project on Vitest 5, the major this tool pins, configured through `vitest.config.*` or `vite.config.*`, or on Jest. A project on another Vitest major needs the pin in `package.json` changed to match, since Stryker's runner loads the tool's copy while the specs import the project's.

**Jest.** A package's runner follows its configs in this order: a `vitest.config.*` means Vitest, then a `jest.config.{ts,mts,cts,js,mjs,cjs,json}` or a `jest` key in its package.json means Jest, then a `vite.config.*` alone means Vitest (a Jest project may keep one for its build). The package's own Jest reads its config, as Jest itself does, and its own transform (babel-jest, ts-jest, @swc/jest) runs the specs; the tool only adds Stryker's Jest plugin. A lane's `config` may name any `jest*` file, such as Nest's `test/jest-e2e.json`. Paths in the config that lead outside the package, such as a monorepo root preset or setup file, keep pointing at the real files. Operator mutants, model mutants and PR mode work the same on Jest; `weakspot map` needs a Vitest package and refuses a Jest one before anything runs.

## Configure

Per-project settings live outside the project, in `~/.weakspot/repos/<name>.json`, where `<name>` is the repository's name from its origin remote (so worktrees share it), or the checkout folder's name when there is no remote. See [config/example.json](config/example.json). Keys: `base` (the ref `diff` compares with), `specDepth` (1 or 2), `specPattern` and `e2ePattern` (regexes that say which file names are unit specs and end-to-end specs), `skip` (regexes on the repo-relative path; test directories are skipped by default), `excludedMutations` (Stryker mutator names), `timeoutMs`, `concurrency`, `vitest` (extra options for Stryker's Vitest runner, for example `{ "pool": "forks" }`), `lanes`.

### Lanes

A lane is one way of running tests against a package: a runner config, a way to find the specs for a file, and its own limits. The unit lane always exists: the package's own `vitest.config.*`, specs found through imports. Further lanes are yours, in `lanes`, in the order they fall back to each other; a file with no unit spec goes to the next lane that has specs for it, and only such files do, so a slow lane runs for as little as possible. A file no lane can place is reported as untested.

```jsonc
{
  "lanes": {
    "unit": { "timeoutMs": 3000 },
    "e2e": {
      "config": "vitest.e2e.config.mts",
      "specs": { "map": [["^services/(\\w+)/src/([^/]+)/", "services/$1/e2e/$2/*.e2e.ts"]] },
      "envPerWorker": { "TEST_DB": "shop_test_{worker}" },
      "prepare": "npm run build --workspace packages/db",
      "concurrency": 4,
      "timeoutMs": 30000
    }
  }
}
```

- `config`: the lane's runner config inside each package, a file name or a path from the package folder such as `test/jest-e2e.json`. A file's package is the nearest directory up from it with a `package.json` and any configured config (the unit lane's or a lane's); a lane applies to the file only when that directory has the lane's config at that path, so a package with only an e2e config runs in the e2e lane alone, and a lane config in an ancestor package is not consulted.
- `specs`: how to find a file's specs, one source or a list tried in order: `"imports"` (specs matching `e2ePattern` that import the file), `{ "map": [[regex, glob]] }` (the first regex matching the repo-relative path fills `$1`.. in its glob, relative to the repo root), `{ "command": "..." }` (run through the shell in the repo root with the repo-relative path, already single-quoted, in place of `{file}`, or appended as the last argument; prints one repo-relative spec path per line; a non-zero exit fails the run), or `"coverage"` (the lane's coverage map, below). Only existing specs inside the file's package count.
- `envPerWorker`: set in each engine worker before the package's config loads, with `{worker}` replaced by a small integer unique across every engine process of the run (packages and lanes run in parallel, each with its own workers). This is how parallel workers get distinct databases without the tool knowing what a database is. Lane concurrency is per package, so a run touching several packages opens that many times the workers.
- `prepare`: run once in the package before the lane's engine run, for projects whose tests consume built packages.
- `timeoutMs`, `concurrency`: the lane's limits; they default to the top-level values, and `--timeout-ms` or `--concurrency` override every lane.

`escalate` (or `--escalate`) also sends unit-lane survivors to the next lane: `untested` (the default) sends only files with no unit spec, `noCoverage` also retries the lines of the unit lane's no-coverage survivors, `survivors` retries every unit survivor's lines. A file one unit spec imports stays in the unit lane even when that spec reaches almost none of it, so `noCoverage` is the setting that lets an end-to-end lane check such a file. Retries run after the first pass, on the survivors' lines only, and not with `--lanes`, where every lane already ran every file.

**Coverage map.** A path convention misses code that specs of other modules run, such as shared helpers. `weakspot map <lane>` (from the top of the checkout) runs the lane's whole suite once in every package that has the lane's config (after its `prepare`, with its `envPerWorker` and `{worker}` as 0, one spec file at a time, each isolated) and stores which of the repo's source files each spec ran a function of, under `~/.weakspot/maps/<repo>/<lane>.json` with the commit it was made at. A lane that lists `"coverage"` among its `specs` then names, for a file, the specs of its own package that ran it; a file the map lacks goes to the next source in the list, so `["coverage", { "map": [...] }]` keeps the convention as the fallback. A spec "ran" a file when a named function of it ran, other than a class constructor or a transpiler helper (a name starting with `_`, such as SWC's `_ts_decorate` or esbuild's `__decorateClass`), so importing a module, or a dependency container building every class at boot, does not count; in `.tsx` and `.jsx` a component counts. A failing spec still ran code, so it counts. The run has no time limit of its own (the suite's test and hook timeouts apply; Ctrl-C stops it). A package whose suite records nothing is named and left out, the others still make the map, and the command exits 3 so the gap is not missed; later runs say in the report that the map has no record of that package, and so does the untested finding of a file in it. A map made before HEAD is used all the same and the report says how old it is; run `map` again to refresh it. Mutants run against the specs of their own package, so a file only other packages' specs run (a shared package consumed through its build output, say) stays untested, and its finding says which packages run code of its package, found from its nearest package.json. Mapping needs the runner to say which modules each spec file ran, which Vitest does.

```bash
node bin/weakspot.js map e2e     # one full run of the e2e suites; minutes, like the suite itself
```

The `unit` entry may only set limits, `envPerWorker` and `prepare`. `--lanes e2e` (or a list, or `all`) runs the named lanes for every file instead of the fallback; `--specs` names specs for the unit lane only, so it is refused with a `--lanes` list that leaves unit out. The runner's `globalSetup` stays in the real package rather than the engine's sandbox copy, since it runs before any spec and may reach outside the package.

## Reading a report

- **Survived**: tests reach the line and none fails when it changes. A weak assertion.
- **No coverage**: no test in the spec set executes the line.
- **Static**: module-level code (a top-level constant, a class field initializer). Every test ran against the mutant and none failed; there is no per-test coverage for such lines.
- **Untested**: a changed file with no spec found, reported as a finding too. Pass `--specs` to name one.
- **Ignored**: excluded mutators. Not counted against the tests.
- **Warnings**: a target that produced no mutants, for example a range with nothing mutable in it.
- **Noise**: survivors inside a logging call (`logging`), in the message of an error thrown directly (`errorMessage`, the first argument of `throw new XError(...)` only), in a catch block that only logs and rethrows the caught error (`catchOnly`), or in a literal JSX attribute value or a `className`, `class` or `style` expression (`jsxAttribute`). Nothing inside a function, such as an event handler or a callback, is noise for sitting in an attribute or an error. They are listed with their class and left out of the findings; `noise` in the repo config picks which classes are hidden (all four by default, `[]` for none).
- **Accepted**: survivors and untested files you accepted, with your reason. They are not findings.
- **Killed in a later lane**: unit-lane survivors that escalation retried in the next lane, where a test killed them. Unit tests miss them, but the change is checked.

Each finding has an `id` that survives edits elsewhere in the file and moves within its function: the file, the mutator and a hash of the enclosing function's name with the original and replacement text, or `<file>#untested`. Renaming that function changes the id. Accept one so it stops being reported, and revoke it to see it again:

```bash
node bin/weakspot.js accept 'src/price.ts#ConditionalExpression#20853cfd978e' --reason "rounding is covered by the invoice tests"
node bin/weakspot.js accept 'src/price.ts#ConditionalExpression#20853cfd978e' --revoke
```

Decisions live in `~/.weakspot/accepted.json`, per repository (keyed like the repo config, so worktrees share them). An accepted mutant still runs; only its report entry changes.

A spec whose edit added and removed only import declarations or blank lines is listed but not used to mutate the sources it imports; removing a test always counts as a change.

Links to directories inside a package are left out of the sandbox copy, which cannot copy them. A link git ignores, such as one in an editor or tool folder, is left out quietly; any other is named in the report's warnings, since a spec that needs code behind it may fail in the sandbox. The engine logs each one before Stryker starts, and the "never loaded the instrumented copy" error names them too.

If every mutant of a file survives with no covering test, the run fails instead of reporting them: the specs never loaded the instrumented copy, usually because an import resolves outside the sandbox. The shim rebases aliases that point into the package, so this should only happen for imports it cannot see.

The words used in code and reports are defined in [docs/glossary.md](docs/glossary.md).

## Model mutants

Stryker's operators change expressions; they cannot write the mistakes that matter in business code: a role check swapped for another, a date boundary moved by a day, a filter dropped, a scope widened. An author can. The tool never calls a model: whoever runs it, an agent in the session or a person, writes the mutants.

1. `weakspot propose` takes the same change as `diff` (or named files, like `files`) and writes `placeholders.json` to `--out`: every condition (a JSX `&&` included), loop header, call target, argument list, returned expression and statement that is not a call on a changed line of a file some lane has specs for, with an excerpt of the source around them and the author prompt ([docs/mutant-author.md](docs/mutant-author.md)). Logging calls and the message of an error being thrown are left out. A fragment that holds a function or JSX (a callback's argument list, a returned JSX tree) is offered only for changed lines nothing smaller covers, so a one-line change inside a callback is answered on that line. Files mutated whole only because a changed spec imports them are left out: nothing in them changed. It runs no tests.
2. The author answers with up to three replacements per placeholder, each with a one-line `because`, in a file of their own: `{ "mutants": [{ "placeholder", "replacement", "because" }] }`.
3. `weakspot run --mutants <file>` checks every answer: a known placeholder, a reason, at most three, not identical, not a duplicate, still parses, stays inside its placeholder as the same kind of code, and the line still reads as it did at `propose`. Rejected answers are listed with the reason in `rejected.json` and the report; the rest run. `--check` stops after judging: it writes only `check-rejected.json`, runs no tests, leaves the report, the record, the run's `rejected.json` and the cache alone, and exits 1 when any answer is rejected, so an author can fix answers before a slow run. Each lane and package gets a pool of sandboxes, one per worker (a copy of the package with `node_modules` linked back): a dry run first, then a canary (each target replaced by a module that throws on load, so its specs must fail, or they import the real tree and the job stops), then each mutant is written into a sandbox, that file's specs run, and the file is put back. A spec file that fails to load or whose hook throws kills a mutant as surely as a failing test. The real tree is never edited.
4. Results merge into `report.json` in the same `--out` (by default the folder `placeholders.json` is in): model survivors become findings next to the operator ones, with the author's reading in the claim, and a later `run --mutants` replaces the earlier model results. With no report there yet, or one for another repo, the report holds the model mutants only.

Answers that pass are kept per repository in `~/.weakspot/cache/mutants/`, keyed by placeholder (file, kind, enclosing function and text, not the line). The next `propose` marks placeholders that already have mutants as `cached`, and `run --mutants` runs those unless the author answers the placeholder again, so unchanged code needs no new answers. `mutants.json` in `--out` is the record of what ran, and `weakspot run --mutants <out>/mutants.json` replays it.

A model mutant has no per-test coverage: its file's specs all run, and `coveredBy` counts the tests that ran. Survivors can be accepted like any other (`<file>#model#<hash>`).

## Report contract

What a consumer (a review step, a script, an agent) can rely on. New fields may be added at any time; a field removed, renamed or changing meaning bumps `schemaVersion`.

**Exit codes.** 0: the run completed with no findings. 1: it completed with findings in `report.json` (for `run --check`: some answers were rejected, listed in `check-rejected.json`). 2: the command line, the repo config, git, the change list, a placeholders or mutants file, a pull request (unreadable, of another repository, with lockfiles that differ from the installed ones, or a kept worktree with edits), or the accepted store was wrong, and nothing ran. 3: the run could not complete (tests fail before mutation, a prepare or spec command failed, the engine failed); the message names the log. 130: interrupted. Read 0 and 1 as a finished run.

**`--out` layout** (default `~/.weakspot/runs/<repo>/<time>/`):

- `report.json`: the full report, written once at the end.
- `report.md`: the same for a person. It is rewritten as each package run finishes, with an "In progress" line under the title, so it can be read while a slow lane runs; the final version has no such line. A run that fails after a package run finished leaves it with a "Stopped" line instead. Both reports from an earlier run into the same folder are removed when a run starts, so a failure never leaves an old report looking current.
- `engine/<package>-<hash>-<lane>/`: one folder per package and lane: `stryker.config.json`, `stryker-report.json`, `stryker.log`, `runner.shim.mts` (`runner.shim.mjs` for a Jest package), `weakspot-env.mjs`. `engine-escalated/` holds the retries in a later lane, in the same shape.
- `placeholders.json` (from `propose`), `mutants.json` (the model mutants that ran, replayable) and `rejected.json` (answers that did not run, with the reason), and `model/<n>-<lane>/` with each worker's shims.

**`report.json`** carries `schemaVersion` (1), the change, the packages run per lane, what was skipped and why, untested files, the survivors (with noise class, acceptance and escalation), `killedLater`, `accepted`, `model` once model mutants were merged in (the command, the two files and the rejections), and `findings`: what a consumer acts on. Each finding has:

| Field | Meaning |
| --- | --- |
| `id` | Stable across runs: `<file>#<mutator>#<hash>` for a survivor (`model` as the mutator for a model mutant), `<file>#untested`. What `weakspot accept` takes. |
| `kind` | `weakAssertion`, `noCoverage`, `static` or `untested`. |
| `file` | Repo-relative path. |
| `where` | `file:line:column`, or the file for an untested file. |
| `claim` | One sentence to act on. |
| `evidence` | The mutator, lane and status, and how a retry in a later lane ended. |
| `severity`, `category` | `medium` and `tests` today. |
| `mutant` | Survivors only: `lane`, `mutator`, `start` and `end` (1-based, end exclusive), `original`, `replacement`, `coveredBy`, `escalated` when a later lane ran it, and `because` for a model mutant. |

Noise and accepted survivors are in `survivors` but never in `findings`.

## With a review loop

The [fresh-eyes](https://github.com/sshdaemon/workbench) review loop runs weakspot as its mutation check on the change list tangle-ts writes, so both look at the same lines. A survivor is fixed with a test, never by changing the code under test, and one left as it is gets accepted with the ledger entry as the reason. Its [profile recipes](https://github.com/sshdaemon/workbench/blob/main/plugins/fresh-eyes/PROFILE.md#recipes) have the commands to set it up.

## Develop

```bash
npm run typecheck
npm run lint          # oxlint, rules in .oxlintrc.json
npm test              # unit tests
npm run test:contract # runs the fixture projects through Vitest, Jest and Stryker (seconds)
```

`fixtures/vitest-basic` is a tiny project with one deliberately weak test, so the contract tests have known survivors to find. `fixtures/vitest-alias` is the same project with a function config and an absolute `@/` alias, the shape that once made every mutant survive. `fixtures/jest-basic` is the weak-test project again on Jest, with a `jest.config.ts` and Babel, so both runners must give the same verdicts.

## Status

Phases 1 to 9: the `files`, `diff` (also from a change list), `pr`, `map`, `accept`, `propose` and `run --mutants` commands, pull requests checked in a worktree with linked dependencies, a coverage map as a lane's spec source, import-graph spec discovery with a parse cache, lanes with the fallback rule and escalation, noise classes, accepted survivors, model mutants with validation, a cache and a sandbox pool, a versioned report contract with exit codes and a progressive report, the Vitest and Jest adapters and the Stryker engine.
