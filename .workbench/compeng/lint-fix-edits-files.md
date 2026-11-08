---
name: lint-fix-edits-files
description: "npm run lint runs knip --fix, which edits unrelated files; revert what it touched outside the change"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 6ce9fe7e-0f7f-4a94-9dd8-9108c58f35e0
  modified: 2026-11-08T10:58:27.844Z
---

`npm run lint` runs `knip --fix --fix-type exports,types`, which strips `export` from unused exports in any file, even ones the current change never touched (it once broke `src/renderer/components/usage/clawd/sky.ts`, leaving `daylight` unused and failing the type check).

**Why:** the user had to revert such an edit and asked why it was made; it looked like an unexplained change.

**How to apply:** after running `npm run lint`, check `git status` and revert files the current work didn't touch (or run `npx knip --production` to check without fixing).
