---
name: main-process-no-shared-alias
description: Main-process code must import runtime values from src/shared by relative path; the @shared alias only works there for type imports
metadata:
  node_type: memory
  type: project
  originSessionId: 6ce9fe7e-0f7f-4a94-9dd8-9108c58f35e0
  modified: 2026-11-07T19:11:53.780Z
---

In `src/main`, import runtime values (functions, constants) from `src/shared` with a relative path (`../../shared/...`), never `@shared/...`. The main-process Vite build doesn't resolve the `@shared` alias, so `npm run dev` / `npm run build` fail with "Rollup failed to resolve import". `tsc` and Vitest still pass, so tests don't catch it. `import type` from `@shared` works because it is erased.

**Why:** `npm run dev` broke on `@shared/utils/api-profile-key` imported by `profile-service.ts` (2026-11-07) after every test had passed.

**How to apply:** use relative imports for shared runtime code in main-process files, and run `npx electron-vite build` after adding such imports.
