# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files.
Models write edits in four formats — a unified diff (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON — and `mend` reads all four to one specification, finds the
lines an edit names even when the model drifted their line numbers or
whitespace, and changes every file or none.

This is an entry for the [make.fun](https://make.fun) bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
(`hidden-spec-cli-01-run-20261122`).

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is
  relative to it.
- `PATCH` is the patch file; when absent or `-`, the patch is read from
  standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` with one line per changed file (`A`/`D`/`M`, `R old -> new`
for moves) plus `ok: <n> files`; `1` with one `error: <code> <path>` line
per failed edit plus `failed: <k> of <n> edits` (no file is written);
`2` with a single `error: usage`, `error: no-patch`, `error: format` or
`error: parse <N>` line.

## Matching

Named old lines are found at the first of three tiers at which they occur:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed;
- tier 2: every line equal once leading and trailing spaces and tabs are
  removed (new lines are re-indented to the file's indentation).

Unified hunks take the occurrence nearest their (possibly wrong) line
number; SEARCH/REPLACE blocks fail as `ambiguous` when the old lines occur
more than once; V4A chunks advance a cursor and take the first occurrence
at or after it, with `@@` anchors and `*** End of File` chunks.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner (kept as shipped).
- `check.ts` — runs `main.ts` on the kit's 100 public practice checks.
- `SPEC.md` — the specification this implements.
- `tests/run.mjs` — 114 extra checks for sentences of SPEC.md the practice
  set does not show (parse errors, moves, CRLF, no-final-newline, empty
  inserts, unsafe paths, `--check`, `--strict`, byte-order sorting).

## Tests

```sh
node check.ts <path to the kit's program/generator/practice.json>
node tests/run.mjs
```

Both suites pass: 100 of 100 practice checks (practice score 1000) and
114 of 114 extra checks.

## License

MIT — see `LICENSE`.
