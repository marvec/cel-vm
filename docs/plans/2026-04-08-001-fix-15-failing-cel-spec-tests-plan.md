---
title: "fix: Resolve 15 failing CEL-spec conformance tests"
type: fix
status: active
date: 2026-04-08
---

# fix: Resolve 15 failing CEL-spec conformance tests

## Overview

15 tests fail across 3 root causes: broken error propagation through `&&`/`||` (10 tests), incomplete `dyn()` support (2 tests), and missing optional chaining syntax in the parser (3 tests). All are CEL-spec conformance gaps in the pipeline from lexer through VM.

## Problem Statement

The failures break down into three independent categories:

**Category 1 — Error propagation through `&&`/`||` (10 tests):**
CEL defines commutative error semantics: `error || false` = error, `error && true` = error. The current compiler emits `JUMP_IF_FALSE_K`/`JUMP_IF_TRUE_K` → `POP` → RHS. When LHS is an error and the jump is not taken, `POP` discards the error before RHS evaluates, so RHS's value becomes the result unconditionally. The error is lost.

**Category 2 — `dyn()` function issues (2 tests):**
- `timestamp()` only accepts strings; `timestamp(0)` with an integer arg returns `celError` instead of epoch-zero timestamp.
- `type()` returns `{ __celType: true, name }` object; the test expects the string `'list'`.

**Category 3 — Optional chaining not implemented (3 tests):**
- Lexer doesn't recognise `.?` as `OPT_DOT` (only `?.` JS-style is handled).
- No `[?expr]` optional index syntax in parser, compiler, or VM.
- No `?expr` optional element syntax in list literals.

## Proposed Solution

### Phase 1: `dyn()` fixes (2 tests) — isolated, low-risk

**1a. `timestamp()` accepts integers** — `src/vm.js` BUILTIN.TIMESTAMP

Add an integer branch before the existing string check:

```javascript
// src/vm.js — BUILTIN.TIMESTAMP handler
if (isInt(v)) return { __celTimestamp: true, ms: Number(v) * 1000 }
// existing string handling follows…
```

**1b. `type()` returns string** — `src/vm.js` BUILTIN.TYPE_OF

Change return from `{ __celType: true, name: celTypeName(v) }` to `celTypeName(v)`. String equality (`type(x) == type(y)`) works identically since both sides become the same string. No currently passing tests break (all other `type()` tests are skipped).

**Fixes:** `not_eq_dyn_timestamp_null`, `dyn_heterogeneous_list`

---

### Phase 2: Commutative error semantics for `&&`/`||` (10 tests)

**Strategy:** Add `LOGICAL_AND` and `LOGICAL_OR` opcodes that combine LHS and RHS with CEL's error rules.

**2a. New opcodes** — `src/bytecode.js`

Add `LOGICAL_AND` (next available opcode) and `LOGICAL_OR`. Category: `noArg` (both operands are on the stack).

**2b. Changed compilation** — `src/compiler.js` `compileBinary`

Current pattern for `||`:
```
LHS → JUMP_IF_TRUE_K end → POP → RHS → end:
```

New pattern:
```
LHS → JUMP_IF_TRUE_K end → RHS → LOGICAL_OR → end:
```

Key change: remove `POP` after jump fallthrough. When the jump is taken (LHS is `true` for `||`, `false` for `&&`), only LHS remains on stack — correct short-circuit. When the jump is NOT taken, both LHS and RHS are on stack and `LOGICAL_OR`/`LOGICAL_AND` combines them.

Same pattern for `&&` with `JUMP_IF_FALSE_K` and `LOGICAL_AND`.

**2c. VM dispatch** — `src/vm.js`

`LOGICAL_OR` pops RHS and LHS:
| LHS | RHS | Result |
|-----|-----|--------|
| `true` | any | `true` (never reached — jump taken) |
| `false` | `true` | `true` |
| `false` | `false` | `false` |
| `false` | error | error |
| error | `true` | `true` |
| error | `false` | error |
| error | error | error (first) |

`LOGICAL_AND` is the dual (swap `true`↔`false` roles).

**Fixes:** all 10 `*_or_false` / `*_and_true` tests

---

### Phase 3: Optional chaining (3 tests)

**3a. Lexer `.?` → `OPT_DOT`** — `src/lexer.js`

In the `.` case, peek at next char. If `?`, consume both and emit `OPT_DOT`. The existing `?.` → `OPT_DOT` path remains for backward compat.

**3b. Parser `[?` optional index** — `src/parser.js` `parseMember`

When LBRACKET is followed by QUESTION, consume both, parse the index expression, expect RBRACKET, return `OptIndex` AST node (new node type, analogous to `OptSelect`).

**3c. Parser `?expr` in list literals** — `src/parser.js` `parsePrimary`

In list literal parsing, if current token is QUESTION, consume it, parse the element, wrap in `OptElement` AST node. The compiler strips `optional.none()` values from the final list.

**3d. Compiler + VM for OptIndex** — `src/compiler.js`, `src/vm.js`

- New opcode `OPT_INDEX` in `bytecode.js`
- `compileNode` case for `OptIndex`: compile object, compile index, emit `OPT_INDEX`
- VM: `OPT_INDEX` — if key exists, push `optional.of(value)`; if not, push `optional.none()`

**3e. Compiler + VM for OptElement** — `src/compiler.js`, `src/vm.js`

- `compileNode` case for `OptElement`: compile inner expr, emit `OPT_LIST_ELEM` (or handle inline during list construction)
- VM: during `BUILD_LIST`, skip elements that are `optional.none()`; unwrap `optional.of(v)` to `v`

**3f. Ensure `hasValue()`, `value()`, `ofNonZeroValue()` work**

Verify these optional methods are compiled and dispatched. If `ofNonZeroValue` is registered as `ofNonZero`, add the full name alias. Zero values: `null`, `false`, `0n`, `0`, `0.0`, `''`, empty bytes, `[]`, empty map.

**Fixes:** `map_null_entry_hasValue`, `map_absent_key_absent_field_none`, `optional_chaining_15`

## Technical Considerations

- **Performance**: `LOGICAL_AND`/`LOGICAL_OR` add one opcode per `&&`/`||` on the non-short-circuit path only. The short-circuit (hot) path is unchanged — the jump skips past the new opcode.
- **Stack discipline**: Removing the `POP` after jump fallthrough means the stack has 2 values (LHS + RHS) when reaching `LOGICAL_*`. The opcode must pop both and push one. Verify stack depth analysis in compiler if any exists.
- **Backward compat**: Compiled bytecode format changes (new opcodes). Any cached/serialised bytecode from before this change will have a different opcode numbering. Bump the bytecode version byte.
- **`.?` vs `?.`**: Both syntaxes will produce `OPT_DOT`. CEL spec uses `.?`; JS uses `?.`. Supporting both is harmless.

## Acceptance Criteria

- [ ] All 15 previously failing tests pass
- [ ] No regressions — all 1185 currently passing tests still pass
- [ ] `timestamp(0)` returns epoch-zero timestamp (not error)
- [ ] `type(x)` returns a string (e.g., `'list'`, `'int'`, `'bool'`)
- [ ] `error || false` and `error && true` propagate the error
- [ ] `error || true` returns `true` and `error && false` returns `false`
- [ ] `.?field` parses as optional field select
- [ ] `map[?key]` parses as optional index
- [ ] `[?expr]` in list literals filters out `optional.none()`
- [ ] Bytecode version bumped if opcode numbering changes
- [ ] IMPLEMENTATION.md updated with new opcodes and parser changes

## Dependencies & Risks

- **Phase 1 and 2 are independent** — can be done in parallel.
- **Phase 3a (lexer) must precede 3b–3f** (parser/compiler/VM need `OPT_DOT` tokens).
- **Risk**: Changing `&&`/`||` compilation affects every boolean expression. Regression risk is moderate — mitigated by the 1185 existing passing tests.
- **Risk**: `type()` returning strings instead of objects could affect future `type()` comparison tests. Analysis shows string equality works for all currently skipped `type()` tests, so this is safe.

## Sources & References

- CEL spec commutative logic: [cel-spec §Logical Operators](https://github.com/google/cel-spec/blob/master/doc/langdef.md#logical-operators)
- Existing analysis: `PLAN.md` §12 (open questions), §13 (skipped test analysis)
- Implementation guide: `IMPLEMENTATION.md`
- Key files: `src/vm.js`, `src/compiler.js`, `src/parser.js`, `src/lexer.js`, `src/bytecode.js`
