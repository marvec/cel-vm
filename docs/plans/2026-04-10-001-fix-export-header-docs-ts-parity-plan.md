---
title: "fix: Align exported function headers across source, docs, and TypeScript"
type: fix
status: completed
date: 2026-04-10
---

# fix: Align exported function headers across source, docs, and TypeScript

The JavaScript source (`src/index.js`) is the authority. The TypeScript definitions (`src/index.d.ts`), DOCS.md, and README.md have drifted out of sync with it. This plan fixes every discrepancy so all four surfaces agree.

## Discrepancies Found

### Critical (will cause runtime errors or missing types)

| # | Issue | Where |
|---|-------|-------|
| 1 | `program()` exported in JS but **missing from `.d.ts`** | `src/index.d.ts` |
| 2 | DOCS.md documents `toBase64` / `fromBase64` — actual exports are `toB64` / `fromB64` | `DOCS.md` |
| 3 | README.md code example imports `toBase64` / `fromBase64` — these don't exist | `README.md` |

### Moderate (misleading but won't break at runtime)

| # | Issue | Where |
|---|-------|-------|
| 4 | README uses `expr` for the expression parameter; source and DOCS.md use `src` | `README.md` |
| 5 | README omits optional parameters: `compile` missing `options`, `evaluate` missing `customFunctionTable`, `run` missing `options` | `README.md` |
| 6 | README heading mixes `toBase64(bytecode)` / `fromB64(base64)` in the same line | `README.md` |

### Minor (JSDoc gaps in source)

| # | Issue | Where |
|---|-------|-------|
| 7 | `evaluate()` JSDoc lists 2 params but function has 3 (`customFunctionTable` undocumented) | `src/index.js` |
| 8 | `run()` JSDoc lists 2 params but function has 3 (`options` undocumented) | `src/index.js` |
| 9 | `compile()` JSDoc doesn't document `options.env` | `src/index.js` |

### Design note

Per prior learnings (`docs/plans/2026-04-09-001-feat-celjs-feature-parity-plan.md`), `customFunctionTable` is internal — it should **not** appear in `.d.ts`. Users should use `Environment.evaluate()` instead. Fix #7 by documenting the param in JSDoc as `@internal`, but do not add it to the public TypeScript surface.

## Acceptance Criteria

- [ ] **`src/index.d.ts`**: Add `program()` type declaration matching the JS signature
- [ ] **DOCS.md**: Replace every `toBase64` with `toB64` and `fromBase64` with `fromB64`
- [ ] **README.md**: Fix import example to use `toB64` / `fromB64`
- [ ] **README.md**: Rename `expr` to `src` in function headings and code examples (or match the actual parameter name)
- [ ] **README.md**: Add missing optional parameters to function headings (`compile(src, options?)`, `evaluate(bytecode, activation?, customFunctionTable?)` or omit internal param, `run(src, activation?, options?)`)
- [ ] **README.md**: Fix mixed Base64 heading to use consistent `toB64` / `fromB64`
- [ ] **src/index.js**: Update JSDoc for `evaluate()`, `run()`, and `compile()` to document all parameters
- [ ] **Verify**: Run `bun test` — all tests pass, no regressions
- [ ] **Verify**: Grep for any remaining `toBase64` / `fromBase64` references across the repo

## MVP

### src/index.d.ts — add `program()`

```typescript
/**
 * Compile and immediately return a reusable program object.
 */
export function program(
  src: string,
  options?: CompileOptions
): { evaluate: (activation?: Record<string, unknown>) => unknown };
```

### DOCS.md — fix function names

Replace `toBase64(` with `toB64(` and `fromBase64(` with `fromB64(` in all occurrences.

### README.md — fix imports and signatures

```javascript
import { compile, evaluate, toB64, fromB64 } from '@anthropic-ai/cel-vm';
```

### src/index.js — fix JSDoc

Add `@param` entries for `customFunctionTable` (marked `@internal`), `options` on `run()`, and `options.env` on `compile()`.

## Sources

- JS source (authority): `src/index.js`
- TypeScript definitions: `src/index.d.ts`
- API docs: `DOCS.md`
- Readme: `README.md`
- Prior learning on `customFunctionTable` visibility: `docs/plans/2026-04-09-001-feat-celjs-feature-parity-plan.md`
- Prior learning on `fromB64` rename: `docs/plans/2026-04-09-002-refactor-rename-load-to-fromb64-plan.md`
