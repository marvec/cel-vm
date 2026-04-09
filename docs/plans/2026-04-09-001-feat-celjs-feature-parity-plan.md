---
title: "feat: Achieve cel-js Feature Parity on Advertised Properties"
type: feat
status: completed
date: 2026-04-09
---

# feat: Achieve cel-js Feature Parity on Advertised Properties

## Overview

cel-js advertises four properties in its README. This plan audits our current state against each claim and proposes the work needed to match or exceed them.

## Current State vs cel-js Claims

| Claim | cel-js | cayenne (us) | Verdict |
|-------|--------|-------------|---------|
| ES Modules / tree-shaking | ESM, `sideEffects: false` | ESM-native, no barrel exports, no `sideEffects` field | **~Parity.** One-line fix. |
| Type-safe Environment API | TypeScript source, typed overloads | `Environment` class with registerConstant/Function/Method/Variable; variable types informational only, no overloads | **Partial.** Functional but weaker type guarantees. |
| CEL Spec coverage | Unknown (no published conformance %) | 86.9% (1335/1537 cel-spec tests); 100% marcbachmann compat (315/315) | **Likely parity or better.** cel-js doesn't publish numbers. |
| TypeScript support | Full — written in TypeScript | **None.** No `.d.ts`, no `"types"` field, limited JSDoc | **Major gap.** |

## Detailed Analysis

### 1. ES Modules / Tree-shaking

**Status: Effectively at parity.**

- `"type": "module"` in package.json
- `"exports": { ".": "./src/index.js" }` — modern Node exports map
- All 8 source files use `import`/`export` exclusively
- No barrel re-exports, no `export * from` patterns
- Module-level state is limited to `const cache = new Map()` in index.js (inert allocation, not a bundler-visible side effect)

**Work needed:**
- Add `"sideEffects": false` to package.json — **5 minutes**

**Risk:** Near-zero. Audited all `src/*.js` files; no top-level side effects exist.

### 2. Type-Safe Environment API

**Status: Functional, but weaker than cel-js's TypeScript-native types.**

What we have (`src/environment.js`, 175 lines):

| Method | What it does | Type safety |
|--------|-------------|-------------|
| `registerConstant(name, type, value)` | Compile-time constants inlined into bytecode | Validates type against known set (`int`, `uint`, `double`, `string`, `bool`, `bytes`, `null`) |
| `registerFunction(name, arity, impl)` | Custom global functions | No input/output type declarations |
| `registerMethod(name, arity, impl)` | Custom methods on receivers | No receiver type constraint |
| `registerVariable(name, type)` | Declares variables; enables strict mode | **Informational only — no runtime enforcement** |

**Gaps:**

1. **No overload resolution.** `registerFunction` throws on duplicate names. Cannot register `format(string)` and `format(string, map)` as overloads. The compiler does a single `customFunctions.get(name)` lookup (`src/compiler.js:707-708`).

2. **Variable types not enforced.** `registerVariable('age', 'int')` followed by `evaluate(bytecode, { age: "not-a-number" })` silently produces wrong results (`src/environment.js:103-109`).

3. **No function signature types.** No way to declare input/output types for registered functions.

4. **No Environment-level caching.** `Environment.compile()` has no cache, unlike the global `compile()` which caches by source string. This undermines the "compile once, evaluate many" value prop when using the Environment API.

**Work needed (incremental):**

| Item | Effort | Priority |
|------|--------|----------|
| Arity-based overloads (same name, different arg count) | 4-6 hours | High — core CEL pattern |
| Environment.compile() cache (keyed on source string) | 1-2 hours | High — performance |
| Opt-in runtime type validation on activation values | 2-4 hours | Medium — nice-to-have |
| Function signature type declarations | 4-8 hours | Low — mostly benefits TS consumers |

### 3. CEL Spec Coverage

**Status: 86.9% and likely at or above cel-js.**

cel-js does not publish a conformance percentage against the google/cel-spec test suite. Our 315/315 pass rate on cel-js's own test suite (marcbachmann compat) confirms we handle everything cel-js handles.

**202 skipped tests by category:**

| Category | Count | Difficulty | Phase |
|----------|-------|-----------|-------|
| Optional methods (`optMap`, `optFlatMap`, extended equality) | 67 | Medium — depends on cel.bind() fix | C |
| Math extensions (`ceil`, `floor`, `round`, etc.) | 33 | Easy — standard Math.* wrappers | A |
| Cross-type numeric comparisons | 30 | Medium — risks O(1)→O(n) map key lookup | B |
| Conversion edge cases | 22 | Easy — range checks, bool from string | A |
| Proto-dependent (proto2/proto3, Any, wrappers) | 20 | **Permanent skip** — out of scope | D |
| Bytes operations | 20 | Easy — comparison, concat, escapes | A |
| Timestamp/Duration range validation | 18 | Easy — bounds checking | A |
| Fields/Maps edge cases | 17 | Medium | B |
| Type system (first-class type values) | 14 | Hard — architectural | D (deferred) |
| String extension overloads | 12 | Easy | A |
| Error propagation (comprehensions) | 10 | Medium | B |
| Error propagation (logic/ternary) | 10 | Medium | B |
| cel.bind bugs | 8 | Unknown — **investigate first** | B |
| Nanosecond precision | 5 | **Permanent skip** — JS lacks precision | D |
| Logic edge cases | 5 | Medium | B |
| Unbound variables | 3 | Easy | B |

**Key risk:** The 67 optional method tests (largest gap) depend on cel.bind() working correctly. The current cel.bind() status is "likely a variable shadowing bug" — this is speculation. If the bug is architectural, the Phase C estimate is wrong.

**Work needed to reach ~91%:**

| Phase | Tests recovered | Effort | Conformance after |
|-------|----------------|--------|-------------------|
| A — Easy wins (math, conversions, bytes, strings, timestamps) | ~105 | 8-12 hours | ~90% |
| B — Medium (cross-type numerics, maps, error propagation, cel.bind) | ~83 | 16-24 hours | ~91% |
| C — Optional extensions | ~67 | 8-12 hours | ~95% (if cel.bind works) |
| D — Permanent skips (proto, nanoseconds, first-class types) | ~39 | N/A | Documented divergences |

### 4. TypeScript Support

**Status: Non-existent. This is our biggest gap.**

- No `.d.ts` files anywhere
- No `tsconfig.json`
- No `"types"` field in package.json
- JSDoc exists on the public API but is insufficient — `evaluate()` returns `*` (maps to `any`), activation is untyped

**What a TypeScript consumer sees today:**
```typescript
import { compile } from 'cel-vm'; // implicit any on everything
// No autocomplete, no type checking, noImplicitAny fails
```

**Work needed:**

Write a hand-crafted `src/index.d.ts` covering:
- `compile(source: string, options?: CompileOptions): Uint8Array`
- `evaluate(bytecode: Uint8Array, activation?: Record<string, unknown>): unknown`
- `run(source: string, activation?: Record<string, unknown>): unknown`
- `load(base64: string): Uint8Array`
- `toB64(bytecode: Uint8Array): string`
- `Environment` class with all 4 registration methods + compile/evaluate/run
- 5 error classes (`CelTypeError`, `CelSyntaxError`, `CelReferenceError`, `CelRuntimeError`, `CelDivisionByZeroError`)

**Design decisions needed:**
1. Hide `customFunctionTable` third param of `evaluate()` — it's internal, used by `run()` to pass environment functions. Users should use `Environment.evaluate()` instead.
2. Return type of `evaluate()`: use `unknown` (forces caller to narrow) rather than `any`.
3. Activation type: `Record<string, unknown>` for the basic API; generic on `Environment` for strict mode.

**Package.json changes:**
```json
"types": "./src/index.d.ts",
"exports": {
  ".": {
    "types": "./src/index.d.ts",
    "import": "./src/index.js"
  }
},
"files": ["src/", "bin/"]  // src/ already covers .d.ts if placed there
```

**Effort:** 3-4 hours for a complete, accurate `.d.ts` file with tests.

## Effort Summary

| Work item | Effort | Impact |
|-----------|--------|--------|
| `sideEffects: false` in package.json | 5 min | Completes ESM parity |
| Hand-written `src/index.d.ts` + package.json types | 3-4 hours | Closes biggest gap |
| Environment caching | 1-2 hours | Performance for env users |
| Arity-based function overloads | 4-6 hours | Core CEL pattern |
| Spec Phase A (easy wins → ~90%) | 8-12 hours | Major conformance jump |
| Spec Phase B (medium → ~91%) | 16-24 hours | Solid conformance |
| Spec Phase C (optionals → ~95%) | 8-12 hours | Stretch goal, blocked on cel.bind |
| **Total to credibly claim parity** | **~16-24 hours** | sideEffects + TypeScript + Phase A + env caching |
| **Total for comprehensive parity** | **~40-60 hours** | All of the above |

## Recommended Priority

1. **`sideEffects: false`** — 5 min, zero risk, close ESM gap
2. **`src/index.d.ts`** — 3-4 hours, closes the biggest gap
3. **Environment.compile() cache** — 1-2 hours, important for perf story
4. **Investigate cel.bind() bug** — 1-2 hours, unblocks Phase C estimate
5. **Spec Phase A** — 8-12 hours, jumps to ~90%
6. **Arity-based overloads** — 4-6 hours, strengthens Environment API
7. **Spec Phase B** — 16-24 hours if time permits

Items 1-3 give us a credible parity claim in ~5 hours. Items 1-5 give us a strong parity claim in ~15-20 hours.

## Acceptance Criteria

- [ ] `package.json` has `"sideEffects": false`
- [ ] `src/index.d.ts` exists with accurate types for all public exports
- [ ] `package.json` has `"types"` field and conditional exports for types
- [ ] TypeScript consumer can `import { compile, Environment } from 'cel-vm'` with full autocomplete and no `any` leaks
- [ ] `tsc --noEmit` passes on a test `.ts` file that exercises the full API
- [ ] `evaluate()` third parameter (`customFunctionTable`) is not exposed in `.d.ts`
- [ ] `Environment.compile()` caches bytecode by source string
- [ ] `bun run bench/compare.js` shows no performance regression
- [ ] cel-spec conformance >= 90% (currently 86.9%)

## Sources

- cel-js README claims: https://github.com/nicholasgasior/cel-js (or marcbachmann/cel-js)
- Existing gap analysis: `docs/plans/2026-04-08-006-feat-skipped-test-gap-analysis-plan.md`
- Environment API implementation: `src/environment.js`
- Public API surface: `src/index.js`
- cel-spec test suite: `test/cel-spec.test.js`
