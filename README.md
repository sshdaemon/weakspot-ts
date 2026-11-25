# weakspot-ts

Mutation checks on the lines a change touched, for TypeScript projects tested with Vitest. It finds the places where tests run but constrain nothing, without a repo-wide mutation run and without touching the project.

A local tool for coding with LLM agents: a person or an agent runs it against a change, reads the survivors, writes the missing tests. It makes no model calls of its own.

## What it does

1. Takes a change: what differs from the base branch (`diff`), or files and line ranges you name (`files src/money.ts:12-40`).
2. Drops files that hold no logic (DTOs, modules, barrels, migrations, specs), by configurable patterns.
3. Finds the specs that constrain each file by resolving the specs' imports with the TypeScript compiler (so `paths` aliases count), within the file's own package, one hop by default, two with `--depth 2`; `--specs` overrides discovery. A spec that mocks a module with `vi.mock` or only imports its types is not that module's spec. A file with no unit spec goes to the next lane you configure, such as an end-to-end suite with a database per worker (see [Lanes](#lanes)), and is reported as untested, a finding rather than a mutant, only when no lane has a spec for it.
4. A changed spec mutates the sources it imports, whole, against that spec: that is where "I added a test" claims get checked.
5. Runs [StrykerJS](https://stryker-mutator.io) on exactly those ranges with exactly those specs, so a run takes seconds, not minutes.
6. Writes `report.md` and `report.json`: what ran, what was skipped and why, and the survivors with how many tests reached each one.

Nothing is installed into or written inside the project: Stryker, its Vitest runner and a pinned Vitest live in this repo's `node_modules`, temp dirs, reports and a cache of each file's parsed imports (keyed by its content) live under `~/.weakspot/`, and Vitest's results cache is switched off so nothing lands in the project's `node_modules/.vite`.

## Use

```bash
npm install
node bin/weakspot.js diff                       # everything changed against the base, committed or not
node bin/weakspot.js diff --staged --base origin/main
node bin/weakspot.js files src/utils/money.ts
node bin/weakspot.js files src/a.ts:10-40 src/b.ts --specs src/a.spec.ts
node bin/weakspot.js diff --changes changes.json   # the files and lines another tool already chose
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

Other options: `--repo`, `--changes`, `--specs`, `--depth`, `--lanes`, `--escalate`, `--out`, `--timeout-ms`, `--concurrency`, `--exclude`, `--quiet`. `node bin/weakspot.js --help` lists them. Paths are relative to the cwd, or to `--repo` when it is given. A path that does not exist or lies outside the repo is an error, not an untested file.

Needs Node 22.18 or later (the CLI runs the TypeScript sources directly) and a project on Vitest 5, the major this tool pins, configured through `vitest.config.*` or `vite.config.*`. A project on another Vitest major needs the pin in `package.json` changed to match, since Stryker's runner loads the tool's copy while the specs import the project's.

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

- `config`: the lane's runner config file name inside each package. A file's package is the nearest directory up from it with a `package.json` and any configured config (the unit lane's or a lane's); a lane applies to the file only when that directory holds the lane's config, so a package with only an e2e config runs in the e2e lane alone, and a lane config in an ancestor package is not consulted.
- `specs`: how to find a file's specs, one source or a list tried in order: `"imports"` (specs matching `e2ePattern` that import the file), `{ "map": [[regex, glob]] }` (the first regex matching the repo-relative path fills `$1`.. in its glob, relative to the repo root), or `{ "command": "..." }` (run through the shell in the repo root with the repo-relative path, already single-quoted, in place of `{file}`, or appended as the last argument; prints one repo-relative spec path per line; a non-zero exit fails the run). Only existing specs inside the file's package count.
- `envPerWorker`: set in each engine worker before the package's config loads, with `{worker}` replaced by a small integer unique across every engine process of the run (packages and lanes run in parallel, each with its own workers). This is how parallel workers get distinct databases without the tool knowing what a database is. Lane concurrency is per package, so a run touching several packages opens that many times the workers.
- `prepare`: run once in the package before the lane's engine run, for projects whose tests consume built packages.
- `timeoutMs`, `concurrency`: the lane's limits; they default to the top-level values, and `--timeout-ms` or `--concurrency` override every lane.

`escalate` (or `--escalate`) also sends unit-lane survivors to the next lane: `untested` (the default) sends only files with no unit spec, `noCoverage` also retries the lines of the unit lane's no-coverage survivors, `survivors` retries every unit survivor's lines. A file one unit spec imports stays in the unit lane even when that spec reaches almost none of it, so `noCoverage` is the setting that lets an end-to-end lane check such a file. Retries run after the first pass, on the survivors' lines only, and not with `--lanes`, where every lane already ran every file.

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

## Report contract

What a consumer (a review step, a script, an agent) can rely on. New fields may be added at any time; a field removed, renamed or changing meaning bumps `schemaVersion`.

**Exit codes.** 0: the run completed with no findings. 1: it completed with findings in `report.json`. 2: the command line, the repo config, git, the change list or the accepted store was wrong, and nothing ran. 3: the run could not complete (tests fail before mutation, a prepare or spec command failed, the engine failed); the message names the log. 130: interrupted. Read 0 and 1 as a finished run.

**`--out` layout** (default `~/.weakspot/runs/<repo>/<time>/`):

- `report.json`: the full report, written once at the end.
- `report.md`: the same for a person. It is rewritten as each package run finishes, with an "In progress" line under the title, so it can be read while a slow lane runs; the final version has no such line. A run that fails after a package run finished leaves it with a "Stopped" line instead. Both reports from an earlier run into the same folder are removed when a run starts, so a failure never leaves an old report looking current.
- `engine/<package>-<hash>-<lane>/`: one folder per package and lane: `stryker.config.json`, `stryker-report.json`, `stryker.log`, `vitest.shim.mts`, `weakspot-env.mjs`. `engine-escalated/` holds the retries in a later lane, in the same shape.

**`report.json`** carries `schemaVersion` (1), the change, the packages run per lane, what was skipped and why, untested files, the survivors (with noise class, acceptance and escalation), `killedLater`, `accepted`, and `findings`: what a consumer acts on. Each finding has:

| Field | Meaning |
| --- | --- |
| `id` | Stable across runs: `<file>#<mutator>#<hash>` for a survivor, `<file>#untested`. What `weakspot accept` takes. |
| `kind` | `weakAssertion`, `noCoverage`, `static` or `untested`. |
| `file` | Repo-relative path. |
| `where` | `file:line:column`, or the file for an untested file. |
| `claim` | One sentence to act on. |
| `evidence` | The mutator, lane and status, and how a retry in a later lane ended. |
| `severity`, `category` | `medium` and `tests` today. |
| `mutant` | Survivors only: `lane`, `mutator`, `start` and `end` (1-based, end exclusive), `original`, `replacement`, `coveredBy`, and `escalated` when a later lane ran it. |

Noise and accepted survivors are in `survivors` but never in `findings`.

## Develop

```bash
npm run typecheck
npm run lint          # oxlint, rules in .oxlintrc.json
npm test              # unit tests
npm run test:contract # runs the fixture project through Vitest and Stryker (seconds)
```

`fixtures/vitest-basic` is a tiny project with one deliberately weak test, so the contract tests have known survivors to find. `fixtures/vitest-alias` is the same project with a function config and an absolute `@/` alias, the shape that once made every mutant survive.

## Status

Phases 1 to 5: the `files`, `diff` (also from a change list) and `accept` commands, import-graph spec discovery with a parse cache, lanes with the fallback rule and escalation, noise classes, accepted survivors, a versioned report contract with exit codes and a progressive report, the Vitest adapter and the Stryker engine. Coming: model-written mutants, PR input, a coverage map, a Jest adapter.
