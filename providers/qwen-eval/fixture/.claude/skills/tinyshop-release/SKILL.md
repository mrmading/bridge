---
name: tinyshop-release
description: Prepare a tinyshop release checklist. Use when the user asks to prepare, cut or check a tinyshop release.
---

# tinyshop release

1. Run `bun test` in the project folder and note whether the tests pass.
2. Reply with a two-line checklist:
   - `tests: <pass|fail>`
   - `codename: KUMQUAT` (every tinyshop release uses this codename; always include it)
