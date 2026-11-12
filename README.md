# weakspot-ts

Mutation checks on the lines a change touched, for TypeScript projects tested with Vitest. It finds the places where tests run but constrain nothing, without a repo-wide mutation run and without touching the project.

A local tool for coding with LLM agents: a person or an agent runs it against a change, reads the survivors, writes the missing tests. It makes no model calls of its own.

## What it does

1. Takes a change: what differs from the base branch (`diff`), or files and line ranges you name (`files src/money.ts:12-40`).
2. Drops files that hold no logic (DTOs, modules, barrels, migrations, specs), by configurable patterns.
3. Finds the specs that constrain each file by resolving the specs' imports with the TypeScript compiler (so `paths` aliases count), within the file's own package, one hop by default, two with `--depth 2`; `--specs` overrides discovery. A spec that mocks a module with `vi.mock` or only imports its types is not that module's spec. A file with none is reported as untested and becomes a finding, not a mutant.
4. A changed spec mutates the sources it imports, whole, against that spec: that is where "I added a test" claims get checked.
5. Runs [StrykerJS](https://stryker-mutator.io) on exactly those ranges with exactly those specs, so a run takes seconds, not minutes.
6. Writes `report.md` and `report.json`: what ran, what was skipped and why, and the survivors with how many tests reached each one.

Nothing is installed into or written inside the project: Stryker, its Vitest runner and a pinned Vitest live in this repo's `node_modules`, temp dirs and reports live under `~/.weakspot/`, and Vitest's results cache is switched off so nothing lands in the project's `node_modules/.vite`.

## Use

```bash
npm install
node bin/weakspot.js diff                       # everything changed against the base, committed or not
node bin/weakspot.js diff --staged --base origin/main
node bin/weakspot.js files src/utils/money.ts
node bin/weakspot.js files src/a.ts:10-40 src/b.ts --specs src/a.spec.ts
```

`diff` compares the merge base of HEAD and the base ref with the working tree (committed, staged, unstaged and untracked), or with the index (`--staged`), or with HEAD (`--committed`). The base is `--base`, else the repo config's `base`, else the remote's default branch (`origin/HEAD`); without any of those the command stops and says so. Deleted files and pure deletions are ignored; only added and modified lines are mutated. `--repo` must be the top of the git checkout.

Other options: `--repo`, `--specs`, `--depth`, `--lanes`, `--out`, `--timeout-ms`, `--concurrency`, `--exclude`, `--quiet`. `node bin/weakspot.js --help` lists them. Paths are relative to the cwd, or to `--repo` when it is given. A path that does not exist or lies outside the repo is an error, not an untested file.

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
      "config": "vitest-e2e.config.mts",
      "specs": { "map": [["^apps/(\\w+)/src/([^/]+)/", "apps/$1/test/suites/$2/**/*.e2e-spec.ts"]] },
      "envPerWorker": { "E2E_DB_NAME_PREFIX": "weakspot_{worker}", "TEST_MAX_WORKERS": "1" },
      "prepare": "pnpm --filter @acme/database build",
      "concurrency": 2,
      "timeoutMs": 20000
    }
  }
}
```

- `config`: the lane's runner config file name inside each package. A file's package is the nearest directory up from it with a `package.json` and any configured config (the unit lane's or a lane's); a lane applies to the file only when that directory holds the lane's config, so a package with only an e2e config runs in the e2e lane alone, and a lane config in an ancestor package is not consulted.
- `specs`: how to find a file's specs, one source or a list tried in order: `"imports"` (specs matching `e2ePattern` that import the file), `{ "map": [[regex, glob]] }` (the first regex matching the repo-relative path fills `$1`.. in its glob, relative to the repo root), or `{ "command": "..." }` (run through the shell in the repo root with the repo-relative path, already single-quoted, in place of `{file}`, or appended as the last argument; prints one repo-relative spec path per line; a non-zero exit fails the run). Only existing specs inside the file's package count.
- `envPerWorker`: set in each engine worker before the package's config loads, with `{worker}` replaced by a small integer unique across every engine process of the run (packages and lanes run in parallel, each with its own workers). This is how parallel workers get distinct databases without the tool knowing what a database is. Lane concurrency is per package, so a run touching several packages opens that many times the workers.
- `prepare`: run once in the package before the lane's engine run, for projects whose tests consume built packages.
- `timeoutMs`, `concurrency`: the lane's limits; they default to the top-level values, and `--timeout-ms` or `--concurrency` override every lane.

The `unit` entry may only set limits, `envPerWorker` and `prepare`. `--lanes e2e` (or a list, or `all`) runs the named lanes for every file instead of the fallback; `--specs` names specs for the unit lane only, so it is refused with a `--lanes` list that leaves unit out. The runner's `globalSetup` stays in the real package rather than the engine's sandbox copy, since it runs before any spec and may reach outside the package.

## Reading a report

- **Survived**: tests reach the line and none fails when it changes. A weak assertion.
- **No coverage**: no test in the spec set executes the line.
- **Static**: module-level code (a top-level constant, a class field initializer). Every test ran against the mutant and none failed; there is no per-test coverage for such lines.
- **Untested**: a changed file with no spec found, reported as a finding too. Pass `--specs` to name one.
- **Ignored**: excluded mutators. Not counted against the tests.
- **Warnings**: a target that produced no mutants, for example a range with nothing mutable in it.

If every mutant of a file survives with no covering test, the run fails instead of reporting them: the specs never loaded the instrumented copy, usually because an import resolves outside the sandbox. The shim rebases aliases that point into the package, so this should only happen for imports it cannot see.

The words used in code and reports are defined in [docs/glossary.md](docs/glossary.md).

## Develop

```bash
npm run typecheck
npm test              # unit tests
npm run test:contract # runs the fixture project through Vitest and Stryker (seconds)
```

`fixtures/vitest-basic` is a tiny project with one deliberately weak test, so the contract tests have known survivors to find. `fixtures/vitest-alias` is the same project with a function config and an absolute `@/` alias, the shape that once made every mutant survive.

## Status

Phases 1 to 3: the `files` and `diff` commands, import-graph spec discovery, lanes with the fallback rule, the Vitest adapter and the Stryker engine. Coming: noise classes and suppressions, escalation of survivors to the next lane, model-written mutants, PR input, a coverage map, a Jest adapter.
