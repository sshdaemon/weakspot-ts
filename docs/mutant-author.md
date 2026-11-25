# Writing model mutants

You are an expert in mutation testing. Each placeholder below is a fragment of code on a line that just changed. For each one, write up to three small changes a developer could plausibly have made by mistake, so that running the tests shows whether they would notice. A mutant the tests miss points at a missing or weak test.

## What to write

- Mistakes in what the code means, not in how it looks: a role or permission check swapped for another, a boundary moved by one (`<` for `<=`, a date a day off), a filter or `where` condition dropped, a scope widened (all records instead of the caller's own), the wrong field or id passed, arguments in the wrong order, the wrong method of the same object (`findOne` for `find`, `some` for `every`), an early return that skips a step.
- If you know the rules the change implements (a ticket, a spec, a design), target them first: break exactly the rule a reviewer would most regret missing.
- Prefer a change that alters behaviour for some realistic input. Skip a change no input can tell apart from the original (an equivalent mutant), a change only to a log line or an error message, and pure reformatting.
- Fewer is fine. Answer a placeholder with nothing when no plausible mistake fits it.

## Rules a mutant must follow

Each answer is checked before it runs; one that breaks a rule is rejected with the reason.

- `replacement` replaces exactly the placeholder's `original` text, nothing before or after it, and is code of the same kind:
  - `condition`: an expression used as the condition of an `if`, `while`, `do`, `switch`, ternary or JSX `&&`.
  - `loopHeader`: the text between a `for` loop's parentheses (`const x of items`, `let i = 0; i < n; i++`).
  - `callArguments`: a call's argument list without the parentheses; an empty string removes every argument.
  - `callee`: the function or method being called (`this.repo.findOne`, `isAllowed`).
  - `returnExpression`: the expression a `return` or an arrow function gives back.
  - `statement`: a statement that is not a call (an assignment, an increment), without its semicolon; an empty string removes it.
- The file must still parse with the replacement in place. Types are not checked.
- Not identical to the original (ignoring whitespace), and not a repeat of another answer for the same placeholder.
- At most three answers per placeholder.
- `because` is one line saying how behaviour differs, in terms a reviewer would use: "a user from another team can read this export", not "changes === to !==".

## Placeholders with cached mutants

A placeholder with `cached` already has mutants from an earlier run, and they run again unless you answer that placeholder yourself. Answer it only when the code around it changed in a way the cached ones no longer test.

## Reading the placeholders file

- `placeholders`: each has an `id`, the `file`, its `kind`, the `original` text, `start` and `end` (1-based line and column, end exclusive) and `scope` (the enclosing function).
- `files`: per file, an `excerpt` of the source around its placeholders, starting at `excerpt.startLine`.

Leave the placeholders file as it is.

## What to hand back

A JSON file with one entry per mutant:

```json
{
  "mutants": [
    { "placeholder": "<placeholder id>", "replacement": "<code>", "because": "<one line on how behaviour differs>" }
  ]
}
```

Then run `weakspot run --mutants <that file>`. Rejected answers are listed in `rejected.json` next to the report with the reason; fix them in the same file and run it again.
