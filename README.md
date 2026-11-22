# hidden-spec-cli-01-run-20261122-v1

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/moonku-ai/hidden-spec-cli-01-run-20261122-v1/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/moonku-ai/hidden-spec-cli-01-run-20261122-v1/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies AI-written edits in four formats (unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of text files, to the specification in SPEC.md: it finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` (or absent) to read it from standard input. Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`, detected), `--check` (report what would change, write nothing), `--strict` (exact line matching only). See SPEC.md for the whole contract; `node check.ts ../path/to/practice.json` runs the kit's practice set against it.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
