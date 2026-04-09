---
title: "Skipped Test Gap Analysis & Implementation Roadmap"
type: feat
status: active
date: 2026-04-08
---

# Skipped Test Gap Analysis & Implementation Roadmap

## Overview

CEL-VM currently passes **1234 of 1537** conformance tests (80.3%) with **303 skipped**. This plan categorises every skipped test, identifies what's missing, and defines an implementation roadmap to reach ~91% conformance.

## Current State

| Metric | Value |
|--------|-------|
| Passing | 1234 |
| Skipped | 303 |
| Failing | 0 |
| Total | 1537 |
| Conformance | 80.3% |

All 315 marcbachmann compatibility tests pass (100%). The 303 skips are all in the cel-spec conformance suite (`test/cel-spec.test.js`).

---

## Skipped Test Inventory

### Category Breakdown

| # | Category | Tests | Phase | Compile-Time Impact | Run-Time Impact |
|---|----------|-------|-------|--------------------|-----------------|
| 1 | Math extensions (ceil, floor, round, trunc, sign, isNaN, isInf, isFinite, bitwise) | 33 | A | **None.** New BUILTIN IDs in compiler lookup table — O(1) hash lookup, no new AST nodes or compilation paths. | **None on hot path.** New `case` branches in `callBuiltin` switch — only entered when these functions are actually called. V8 jump table unaffected (still <50 opcodes). Each implementation is a single native `Math.*` or BigInt operator call. |
| 2 | Bytes operations (comparison, concatenation, equality, escapes) | 20 | A | **None (comparison/concat).** Escape fix touches lexer `scanBytes()` — adds a branch per `\u`/`\U` escape during tokenisation. One-time cost, negligible. | **Negligible.** Adds `instanceof Uint8Array` checks in `celLt`/`celLe`/`celAdd`. These are type-dispatch branches that only fire for bytes values — no impact on numeric/string hot paths. Byte comparison is O(n) but bytes are typically small. |
| 3 | Conversion edge cases (range checks, bool from string, identity conversions) | 22 | A | **None.** | **Negligible.** Adds boundary checks (`if (val > MAX_INT64)`) in `TO_INT`/`TO_UINT` cases and a string lookup table for `TO_BOOL`. These execute only during explicit type conversion calls. Identity conversions are early-return branches (cheapest path). |
| 4 | Timestamp/Duration range validation | 18 | A | **None.** | **Negligible.** Adds 2-3 comparisons (`year < 1 || year > 9999`) after timestamp/duration construction. Only fires during `timestamp()`/`duration()` builtin calls, not in the arithmetic hot path. Overflow checks on add/sub are a single BigInt comparison per operation. |
| 5 | String extension overloads (indexOf offset, replace limit, split limit, format) | 12 | A | **None.** Compiler already routes by function name; argc is passed through. | **Negligible.** Adds `argc` branches in existing `callBuiltin` cases. The overloaded operations (`indexOf` with offset, `replace` with limit) use the same native string methods with an extra parameter. `format()` (deferred) would add a new parsing loop — moderate cost but only when called. |
| 6 | cel.bind() / bindings | 8 | B | **Possible minor fix.** If the bug is in checker macro expansion, may change how `expandBind` generates the comprehension AST — affects compile time for expressions using `cel.bind()` only. No change for expressions that don't use it. | **None.** `cel.bind` already compiles to a comprehension (single-iteration loop). The fix addresses correctness, not performance. |
| 7 | Error propagation in comprehension macros | 10 | B | **None.** | **Low risk.** Adds an `isError()` check per iteration step in comprehension loops. `isError()` is a property check on a tagged object — very cheap. But it's inside the iteration hot loop, so it adds one branch per element per comprehension. For a 1000-element list, that's 1000 extra branches. Mitigation: the check is highly predictable (almost always false) so the branch predictor handles it well. |
| 8 | Error propagation in logic/ternary | 10 | B | **None.** | **None.** `LOGICAL_AND`/`LOGICAL_OR` already handle this. Ternary fix is a type check on the condition value — one branch, not in a loop. |
| 9 | Fields/Maps edge cases (quoted fields, qualified idents, map errors) | 17 | B | **Low.** Map error checks (float/null keys, duplicates) add validation in `BUILD_MAP` — compile-time only for literal maps, or one-time at VM construction. Qualified identifier resolution may add a lookup pass in the compiler. | **Negligible for map errors** (construction-time only). **Mixed-type key lookup** adds `celEq` calls during `INDEX` on Map — replaces the current `Map.get()` with a linear scan for numeric keys. This is O(n) per map access instead of O(1) — **measurable regression for large maps with numeric keys**. Mitigation: only use `celEq` scan when the key type differs from map key types; fast-path `Map.get()` for same-type keys. |
| 10 | Optional methods (optMap, optFlatMap, .or(), .value(), equality) | 67 | C | **Medium.** `optMap`/`optFlatMap` need checker macro expansion (similar to `cel.bind`) — adds new AST rewriting paths. Increases compile time for expressions using optional methods. No impact on non-optional expressions. | **Low.** `.value()` and `.or()` are single-operation opcodes (comparable to existing `OPT_OR_VALUE`). `optMap`/`optFlatMap` compile to single-iteration comprehensions — one loop overhead per call. Optional equality extends `celEq` with one `isOpt()` check — negligible. |
| 11 | Cross-type numeric comparisons (mixed int/uint/double) | 30 | B | **None.** | **Low risk.** `celEq`/`celLt`/`celLe` already have cross-type branches for int/double. List/map equality recursion already uses `celEq`. The concern is adding more type-dispatch branches in hot comparison paths — but V8 handles predictable `typeof` checks efficiently. **No regression expected for same-type comparisons** (the common case). |
| 12 | Type system (first-class type values) | 14 | D | Would require identifier resolution for `bool`, `int`, etc. as type values — adds to checker/compiler. | **High risk if implemented naively.** Tagged type objects in the value system would add `isType()` checks to every equality comparison. Deferred for this reason. |
| 13 | Unbound variables | 3 | B | **None.** | **Very low.** Adds one `undefined` check in `LOAD_VAR` — the most-executed opcode for variable-heavy expressions. However, `=== undefined` is a single comparison that V8 optimises to a null check. Branch is highly predictable (almost always bound). **Benchmark to verify.** |
| 14 | Proto-dependent | 20 | D | N/A — out of scope. | N/A |
| 15 | Nanosecond timestamp precision | 5 | D | Would change timestamp representation from `{ms}` to `{seconds, nanos}`. | **Medium risk.** Every timestamp comparison/arithmetic would need to handle two-field objects instead of a single `ms` number. Deferred. |
| 16 | Logic edge cases (no_overload, unsupported comparisons) | 5 | B | **None.** | **None.** Error returns on type mismatches — only fires for invalid expressions. |

### Performance Summary

**Safe (no hot-path impact):** Categories 1, 2, 3, 4, 5, 6, 8, 16 — these add code paths that only execute when the new features are used. Existing expressions are unaffected.

**Monitor (adds branches in hot loops):** Category 7 (error check per comprehension iteration), Category 13 (undefined check per LOAD_VAR). Both are highly predictable branches — benchmark to confirm.

**Caution (potential regression):** Category 9 (mixed-type map key lookup degrades from O(1) to O(n) for maps with numeric keys). Needs a fast-path guard to avoid regression for same-type keys.

**Deferred due to performance risk:** Categories 12 and 15 (type system and nanosecond timestamps) would require representation changes that add overhead to core operations.
| 13 | Unbound variables | 3 | Yes — VM LOAD_VAR check | B |
| 14 | Proto-dependent (proto2/proto3, Any, wrapper types) | 20 | No — out of scope | D |
| 15 | Nanosecond timestamp precision | 5 | Deferred — representation change | D |
| 16 | Logic edge cases (no_overload, unsupported comparisons) | 5 | Yes — error cases | B |

**Total: 303 skipped** (some tests touch multiple categories; counts above reflect primary category)

---

## Detailed Gap Analysis

### Phase A: Low-Hanging Fruit (~83 tests, target +80)

#### A1. Math Extensions (33 tests)

**What's missing:** 14 BUILTIN functions have no IDs, no compiler mappings, no VM cases.

| Function | Tests | Implementation |
|----------|-------|---------------|
| `math.ceil(double)` | 2 | `Math.ceil()` |
| `math.floor(double)` | 2 | `Math.floor()` |
| `math.round(double)` | 3 | `Math.round()` |
| `math.trunc(double)` | 2 | `Math.trunc()` |
| `math.abs(int\|uint\|double)` | 6 | Branch on type; int overflow check for `-2^63` |
| `math.sign(int\|uint\|double)` | 8 | Return -1/0/1 based on sign |
| `math.isNaN(double)` | 2 | `Number.isNaN()` |
| `math.isInf(double)` | 2 | `!Number.isFinite() && !Number.isNaN()` |
| `math.isFinite(double)` | 3 | `Number.isFinite()` |
| `math.bitAnd(int\|uint, int\|uint)` | 4 | BigInt `&` operator |
| `math.bitOr(int\|uint, int\|uint)` | 2 | BigInt `\|` operator |
| `math.bitXor(int\|uint, int\|uint)` | 2 | BigInt `^` operator |
| `math.bitNot(int\|uint)` | 3 | BigInt `~` operator (needs masking) |
| `math.bitShiftLeft(int\|uint, int)` | 2 | BigInt `<<` operator |
| `math.bitShiftRight(int\|uint, int)` | 2 | BigInt `>>` operator |

**Files to change:** `src/bytecode.js` (BUILTIN IDs), `src/compiler.js` (name mappings), `src/vm.js` (callBuiltin cases)

**Effort:** Low (1-2 hours). Zero dependencies.

#### A2. Bytes Operations (15 of 20 tests)

**What's missing:**
- Bytes comparison (`<`, `>`, `<=`, `>=`): Add to `celLt`/`celLe` in `vm.js` — lexicographic byte-by-byte comparison
- Bytes concatenation (`+`): Add to `celAdd` in `vm.js` — `new Uint8Array([...a, ...b])`
- Bytes equality edge cases: Already handled in `celEq`

**Deferred (5 tests):** Bytes escape semantics (`\u`/`\U` in `b"..."` should produce UTF-8 encoded bytes, not raw charCodeAt). Requires lexer `scanBytes()` changes.

**Files to change:** `src/vm.js` (celLt, celLe, celAdd)

**Effort:** Low (1 hour). Zero dependencies.

#### A3. Conversion Edge Cases (15 of 22 tests)

**What's missing:**
- `bool()` from extended string values: Accept `"1"`, `"0"`, `"t"`, `"f"`, `"TRUE"`, `"FALSE"`, `"True"`, `"False"` (10 tests)
- Identity conversions: `bytes(b'abc')` → pass-through, `duration(duration(...))` → pass-through, `timestamp(timestamp(...))` → pass-through (3 tests)
- Int/uint range checks on conversion: `int(18446744073709551615u)` should error (2 tests)

**Deferred (7 tests):** Double-to-int precision tests require BigInt boundary checks; some depend on uint distinction.

**Files to change:** `src/vm.js` (callBuiltin TO_BOOL, TO_INT, TIMESTAMP, DURATION cases)

**Effort:** Low (1-2 hours). Zero dependencies.

#### A4. Timestamp/Duration Range Validation (12 of 18 tests)

**What's missing:**
- Timestamp range: Reject years outside 0001-9999 on construction
- Duration range: Reject durations outside ~±10,000 years on construction
- Arithmetic overflow: Check timestamp+duration and duration+duration results are in range

**Deferred (6 tests):** Nanosecond precision (3 tests), `getMilliseconds` proto binding (1 test), duration nanosecond overflow (2 tests)

**Files to change:** `src/vm.js` (TIMESTAMP/DURATION builtins, celAdd/celSub for timestamp/duration)

**Effort:** Low (1-2 hours). Zero dependencies.

#### A5. String Extension Overloads (8 of 12 tests)

**What's missing:**
- `indexOf(string, offset)` — 3-arg overload: search starting from codepoint offset (3 tests)
- `replace(old, new, limit)` — 4-arg overload: replace at most N occurrences (3 tests)
- `split(separator, limit)` — 3-arg overload: limit number of splits (2 tests; `split("", 0)` and `split("", 1)`)

**Deferred (4 tests):** `format()` / format errors (4 tests) — needs format string parser. `trim` escaped chars (1 test).

**Files to change:** `src/vm.js` (callBuiltin STRING_INDEX_OF, STRING_REPLACE, STRING_SPLIT — branch on argc)

**Effort:** Low (1 hour). Zero dependencies.

---

### Phase B: Medium Effort (~45 tests, target +40)

#### B6. cel.bind() (8 tests)

**Status:** Infrastructure exists in checker (`expandBind`) and compiler. All 8 tests skipped — likely a variable shadowing bug where the bound variable index collides with activation variable indices.

**Action:** Unskip tests, run, debug. The fix is likely in how the compiler assigns variable indices for comprehension iteration variables vs activation variables.

**Files to change:** Likely `src/checker.js` or `src/compiler.js`

**Effort:** Medium (2-4 hours of debugging).

#### B7. Error Propagation in Comprehension Macros (10 tests)

**What's missing:** Errors produced during iteration body evaluation (e.g., div/0) are silently swallowed by `ACCUM_SET`. The accumulator logic does not check for error values.

**Tests:** `all()` with errors, `exists_one()` div/0, `map()` div/0, `filter()` div/0, nested macro errors.

**Fix approach:** After evaluating loop body, check if result is `celError` and propagate it out of the comprehension.

**Files to change:** `src/vm.js` (ACCUM_SET, comprehension error handling)

**Effort:** Medium (3-5 hours).

#### B8. Error Propagation in Logic/Ternary & Logic Edge Cases (10-15 tests)

**What's missing:**
- Ternary with error condition: `(1/0) ? 'a' : 'b'` should propagate error
- Ternary with mixed types: `true ? 1 : 'foo'` — should this work?
- Unsupported comparisons: `null < null`, `[1] < [2]`, `{} < {}` should return error
- `no_overload` for `&&`/`||` with non-bool: `'cow' && true` should error

**Note:** Some may already pass given LOGICAL_AND/LOGICAL_OR implementation. Unskip first.

**Files to change:** `src/vm.js` (comparison operators, ternary handling)

**Effort:** Medium (2-3 hours).

#### B9. Fields/Maps Edge Cases (10 of 17 tests)

**What's missing:**
- Map construction errors: float keys, null keys, duplicate keys (4 tests)
- Mixed-type map key lookup: `{1u: 'a'}[1]` needs `celEq` for key comparison (4 tests)
- Qualified identifier resolution: `a.b.c` as single variable (2 tests)

**Deferred (7 tests):** Quoted field access with special characters (slash, dash, dot in map keys via backtick syntax) — needs parser changes. `has()` on special-char fields.

**Files to change:** `src/vm.js` (BUILD_MAP, INDEX), possibly `src/compiler.js` for qualified idents

**Effort:** Medium (3-5 hours).

#### B10. Cross-Type Numeric Comparisons (15 of 30 tests)

**Current state:** `celEq` already handles `int == double` cross-type. Many list/map comparison tests may pass if lists recursively use `celEq`.

**What's implementable:**
- Mixed-type list equality: `[1.0, 2.0, 3] == [1u, 2, 3u]` — relies on `celEq` handling int/double
- List length inequality: `['one'] == [2, 3]` should be false
- Mixed-type map equality

**Deferred (~15 tests):** Tests requiring uint vs int distinction remain blocked.

**Action:** Unskip and run. Many may already pass.

**Effort:** Low-Medium (1-3 hours).

#### B11. Unbound Variables (3 tests)

**What's missing:** `LOAD_VAR` returns `undefined` for missing activation keys instead of producing a `celError`.

**Fix:** Check if variable exists in activation before loading.

**Files to change:** `src/vm.js` (LOAD_VAR case)

**Effort:** Low (30 min).

---

### Phase C: Optionals Completion (~67 tests, target +40)

#### C10. Optional Methods (30 tests)

**Current infrastructure:** `OPT_NONE`, `OPT_OF`, `OPT_OR_VALUE`, `OPT_SELECT`, `OPT_CHAIN`, `OPT_INDEX`, `OPT_HAS_VALUE`, `OPT_OF_NON_ZERO` opcodes all exist in the VM.

**Missing methods:**
- `.value()` — unwrap optional or error if none. New opcode or BUILTIN.
- `.or(other_optional)` — return first with value, or none. New opcode or BUILTIN.
- `.optMap(var, expr)` — apply expr to value if present. Needs checker macro expansion (like `cel.bind`).
- `.optFlatMap(var, expr)` — like optMap but expr must return optional. Same pattern.

**Dependencies:** `cel.bind()` should work first since `optMap`/`optFlatMap` use similar lambda patterns.

**Effort:** High (5-8 hours).

#### C11. Optional Equality, List/Map Optionals, has() with Optional (37 tests)

**What's missing:**
- Optional equality: `optional.of(1) == optional.of(1)`, `optional.none() == optional.none()`
- Optional list index: `[1,2,3][?0]` optional index syntax
- Optional map entry: `{?'key': optional.none()}` construction (filter out none entries)
- `has()` with optional fields

**Dependencies:** Phase C10 (basic optional methods).

**Effort:** Medium (3-5 hours).

---

### Phase D: Deferred / Permanent Divergences (~39 tests)

| Category | Tests | Reason |
|----------|-------|--------|
| Proto-dependent (proto2/proto3, Any, wrapper types) | ~20 | No protobuf runtime in JS. Permanent divergence. |
| Type system first-class values | ~14 | Requires type values as distinct runtime type + identifier resolution for `bool`, `int`, etc. Significant architectural change for few tests. |
| Nanosecond timestamp precision | ~5 | Requires changing timestamp representation from `ms: number` to `{seconds, nanos}`. Affects all timestamp operations. |

---

## Projected Impact

| Phase | Tests Unlocked | Cumulative Passing | Conformance |
|-------|---------------|-------------------|-------------|
| Current | — | 1234 / 1537 | 80.3% |
| A (low-hanging fruit) | +80 | ~1314 / 1537 | 85.5% |
| B (medium effort) | +40 | ~1354 / 1537 | 88.1% |
| C (optionals) | +40 | ~1394 / 1537 | 90.7% |
| D (deferred) | — | — | — |

**Remaining ~39 tests** (Phase D) are documented divergences.

---

## Acceptance Criteria

- [ ] Phase A: All 5 sub-features implemented, ~80 tests unskipped and passing
- [ ] Phase B: All 6 sub-features implemented, ~40 additional tests unskipped and passing
- [ ] Phase C: Optional methods complete, ~40 additional tests unskipped and passing
- [ ] README.md divergences table updated to reflect current state
- [ ] IMPLEMENTATION.md updated with new features
- [ ] PLAN.md updated — completed items removed, remaining work documented

## Sources

- cel-spec conformance suite: `test/cel-spec.test.js` (303 skipped tests analysed line-by-line)
- Existing plans: `docs/plans/2026-04-08-001` through `005`
- VM implementation: `src/vm.js` (1,263 lines)
- Compiler: `src/compiler.js` (857 lines)
- Checker: `src/checker.js` (382 lines)
