---
title: "docs: Thorough DOCS.md and IMPLEMENTATION.md Audit"
type: docs
status: completed
date: 2026-04-09
---

# docs: Thorough DOCS.md and IMPLEMENTATION.md Audit

## Overview

Audit and update DOCS.md and IMPLEMENTATION.md so they thoroughly and accurately reflect the current CEL-VM implementation. Fix false claims in README.md, update stale TypeScript definitions, and resolve the license discrepancy.

## Problem Statement

Both documentation files have significant gaps relative to the current implementation. DOCS.md is missing entire feature categories (math extensions, string extensions, timestamp/duration methods). README.md makes 3 false claims about supported features. TypeScript definitions are incomplete for 2 public API functions. A license discrepancy (README says GPLv3, package.json says MIT) creates legal ambiguity.

## Proposed Solution

A single documentation pass across DOCS.md, IMPLEMENTATION.md, README.md, and `src/index.d.ts` to bring everything into alignment with the source code.

## Technical Considerations

- **No runtime changes** — this is purely documentation and type definitions
- **Performance impact** — none (no compile-time or run-time changes)
- **Verify claims against code** — every documented feature must be grep-confirmed in the source before documenting

## Acceptance Criteria

### Phase 1: Fix False/Dangerous Claims (Critical)

- [ ] **Resolve license discrepancy** — README.md says "GNU GPLv3", `package.json` says "MIT". Ask user which is correct, update both to match.
- [ ] **Fix `toLowerCase`/`toUpperCase` in README** — README lists these as CEL method aliases but the compiler's `METHOD_BUILTINS` table only maps `lowerAscii`/`upperAscii`. Either add 2 entries to `src/compiler.js` METHOD_BUILTINS or remove the aliases from README. Recommend: add the aliases (2 lines, trivial, improves DX).
- [ ] **Fix `optional.or()` and `optional.value()` in README** — listed as supported but not implemented in compiler. Remove from README's supported features or move to a "Planned" section.
- [ ] **Fix README Divergences table** — "Commutative errors: Partial" is listed in both Divergences and Resolved sections. Remove from Divergences since `LOGICAL_AND`/`LOGICAL_OR` opcodes are implemented.

### Phase 2: Update TypeScript Definitions (`src/index.d.ts`)

- [ ] Add `customFunctionTable?: Function[]` third parameter to `evaluate()` signature
- [ ] Add `options?: CompileOptions` third parameter to `run()` signature
- [ ] Add `instrIndex?: number`, `line?: number`, `col?: number` properties to `EvaluationError`

### Phase 3: DOCS.md — Add Missing Feature Documentation

**API completeness:**
- [ ] Document `customFunctionTable` third parameter on `evaluate()`
- [ ] Document `options` third parameter on `run()`
- [ ] Document `Environment.compile()` accepts `options.cache` (not just `debugInfo`)

**Activation values:**
- [ ] Add activation value types table (what JS types to use for each CEL type: `BigInt` for int/uint, `number` for double, `Uint8Array` for bytes, etc.) — currently only in README

**String methods (missing from DOCS.md):**
- [ ] `charAt(index)` — returns character at position
- [ ] `lastIndexOf(substr)` — returns last occurrence index
- [ ] `join(separator?)` — joins list elements (0-arg = empty string, 1-arg = with separator)
- [ ] `replace(old, new, limit?)` — document the 3-arg limit form (`-1` = all, `0` = none)
- [ ] `format(args...)` — string formatting with `%s`, `%d`, `%%` placeholders

**Built-in functions (missing from DOCS.md):**
- [ ] `dyn(value)` — dynamic type wrapper

**Math extensions (18 functions, missing from DOCS.md):**
- [ ] `math.greatest(a, b, ...)` / `math.greatest(list)` — variable-arity max
- [ ] `math.least(a, b, ...)` / `math.least(list)` — variable-arity min
- [ ] `math.ceil(x)`, `math.floor(x)`, `math.round(x)`, `math.trunc(x)`
- [ ] `math.abs(x)` — with int64 min overflow detection note
- [ ] `math.sign(x)`
- [ ] `math.isNaN(x)`, `math.isInf(x)`, `math.isFinite(x)`
- [ ] `math.bitAnd(a,b)`, `math.bitOr(a,b)`, `math.bitXor(a,b)`, `math.bitNot(a)`, `math.bitShiftLeft(a,n)`, `math.bitShiftRight(a,n)`
- [ ] `math.max(a,b)`, `math.min(a,b)` — legacy aliases

**String extensions (missing from DOCS.md):**
- [ ] `strings.quote(s)` — quote a string with escaping

**Timestamp methods (missing from DOCS.md):**
- [ ] `getFullYear(tz?)`, `getMonth(tz?)`, `getDayOfMonth(tz?)`, `getDate(tz?)`, `getDayOfWeek(tz?)`, `getDayOfYear(tz?)`, `getHours(tz?)`, `getMinutes(tz?)`, `getSeconds(tz?)`, `getMilliseconds(tz?)`
- [ ] Document optional timezone string argument (IANA timezone names)

**Duration methods (missing from DOCS.md):**
- [ ] `getHours()`, `getMinutes()`, `getSeconds()`, `getMilliseconds()` — return total values per cel-spec

**Optional types (undocumented features):**
- [ ] `optional.ofNonZero(value)` / `optional.ofNonZeroValue(value)`

**CLI:**
- [ ] Add CLI usage section to DOCS.md (currently only in README) — `cel <expr>`, `cel compile <expr>`, `cel eval <b64>`

### Phase 4: IMPLEMENTATION.md — Fill Gaps

- [ ] Add `string.format()` to builtin dispatch documentation (BUILTIN ID 65, `STRING_FORMAT`)
- [ ] Add `OPT_OF_NON_ZERO` (opcode 46) to the optionals row in the opcode table
- [ ] Verify opcode count statement ("currently 47 opcodes") is accurate — it is, but add `OPT_OF_NON_ZERO` to the list
- [ ] Document `join()`, `charAt()`, `lastIndexOf()` in the string methods section if not present
- [ ] Verify the comprehension emission loop shape documentation matches current code

### Phase 5: Cross-Document Consistency Check

- [ ] Ensure every feature listed in README's "Supported Features" section exists in DOCS.md with full API details
- [ ] Ensure README's built-in functions list includes `bytes()` (currently omitted)
- [ ] Ensure all error classes documented in DOCS.md match the TypeScript definitions
- [ ] Run `bun test` to ensure no regressions from any compiler changes (if `toLowerCase`/`toUpperCase` aliases are added)

## Dependencies & Risks

- **License resolution blocks publication** — the GPLv3 vs MIT discrepancy must be resolved by the project owner before any release
- **`toLowerCase`/`toUpperCase` decision** — if we add compiler aliases, this becomes a code change (2 lines in `src/compiler.js`) requiring a test run; if we just fix the README, it's pure docs
- **`optional.or()` / `optional.value()`** — if the user wants to implement these rather than remove the claim, scope expands significantly

## Sources & References

### Internal References
- Public API: `src/index.js`
- Compiler builtins: `src/compiler.js:42-113` (METHOD_BUILTINS, FUNCTION_BUILTINS)
- VM dispatch: `src/vm.js:429+` (callBuiltin)
- Bytecode enums: `src/bytecode.js:24-66` (OP, BUILTIN)
- TypeScript types: `src/index.d.ts`
- Current DOCS.md, IMPLEMENTATION.md, README.md
