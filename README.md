# weakspot-ts

Mutation checks on the lines a change touched, for TypeScript projects tested with Vitest. It finds the places where tests run but constrain nothing, without a repo-wide mutation run and without touching the project.

A local tool for coding with LLM agents: a person or an agent runs it against a change, reads the survivors, writes the missing tests. It makes no model calls of its own.

## What it does

1. Takes files, or line ranges inside files (`src/money.ts:12-40`).
2. Drops files that hold no logic (DTOs, modules, barrels, migrations, specs), by configurable patterns.
3. Finds the specs that constrain each file. A file with none is reported as untested, not mutated.
4. Runs [StrykerJS](https://stryker-mutator.io) on exactly those ranges with exactly those specs, so a run takes seconds, not minutes.
5. Writes `report.md` and `report.json`: what ran, what was skipped and why, and the survivors with how many tests reached each one.

Nothing is installed into or written inside the project: Stryker, its Vitest runner and a pinned Vitest live in this repo's `node_modules`, temp dirs and reports live under `~/.weakspot/`, and Vitest's results cache is switched off so nothing lands in the project's `node_modules/.vite`.

## Use

```bash
npm install
node bin/weakspot.js files src/utils/money.ts
node bin/weakspot.js files src/a.ts:10-40 src/b.ts --specs src/a.spec.ts
```

Options: `--repo`, `--specs`, `--out`, `--timeout-ms`, `--concurrency`, `--exclude`, `--quiet`. `node bin/weakspot.js --help` lists them. Paths are relative to the cwd, or to `--repo` when it is given. A path that does not exist or lies outside the repo is an error, not an untested file.

Needs Node 22.18 or later (the CLI runs the TypeScript sources directly) and a project on Vitest 5, the major this tool pins, configured through `vitest.config.*` or `vite.config.*`. A project on another Vitest major needs the pin in `package.json` changed to match, since Stryker's runner loads the tool's copy while the specs import the project's.

## Configure

Per-project settings live outside the project, in `~/.weakspot/repos/<repo folder name>.json`. See [config/example.json](config/example.json). Keys: `skip` (regexes on the repo-relative path), `excludedMutations` (Stryker mutator names), `timeoutMs`, `concurrency`, `vitest` (extra options for Stryker's Vitest runner, for example `{ "pool": "forks" }`).

## Reading a report

- **Survived**: tests reach the line and none fails when it changes. A weak assertion.
- **No coverage**: no test in the spec set executes the line.
- **Static**: module-level code (a top-level constant, a class field initializer). Every test ran against the mutant and none failed; there is no per-test coverage for such lines.
- **Untested**: a changed file with no spec found. Pass `--specs` to name one.
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

Phase 1: the `files` command, the Vitest adapter and the Stryker engine. Coming: diff and PR input, import-graph spec discovery, noise classes and suppressions, model-written mutants, a Jest adapter.
