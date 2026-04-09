---
title: "feat: Reduce skipped cel-spec tests with Tier 1 easy wins"
type: feat
status: completed
date: 2026-04-08
---

# feat: Reduce skipped cel-spec tests with Tier 1 easy wins

## Overview

Implement 4 categories of Tier 1 easy wins from PLAN.md Section 13 to reduce the 372 skipped cel-spec tests. Each category is independent, committed incrementally on a `feature/tier1-easy-wins` branch from `develop`.

After verification, 3 categories from the original 7 are **deferred** (see Deferred section below).

## Verified Test Inventory

Actual counts differ from PLAN.md estimates. Verified against `test/cel-spec.test.js`:

| # | Category | Ported & Skipped | Estimated Unskippable | Approach |
|---|----------|------------------|-----------------------|----------|
| 1 | `math.greatest` / `math.least` | 21 | 21 | New BUILTIN IDs + VM dispatch |
| 2 | String extensions (charAt, lastIndexOf, quote, join) | 13 | 13 | New BUILTIN IDs + `strings.` namespace |
| 3 | Unicode SMP strings | 5 | 5 | Likely already works; verify & unskip |
| 4 | Error short-circuit (`&&`/`||`/`!`/macros) | ~25 | 6-12 | Partial; some need new opcodes |
| **Total** | | **~64** | **~45-51** | |

## Proposed Solution

Work through each category sequentially. For each: implement in `src/`, unskip tests in `test/cel-spec.test.js`, run `bun test`, commit.

## Phase 1: `math.greatest` / `math.least` (21 tests)

**What:** Variable-arity greatest/least functions, analogous to existing `math.max`/`math.min`.

**Files to change:**

1. `src/bytecode.js:47` — Add `MATH_GREATEST: 46, MATH_LEAST: 47` to `BUILTIN` enum
2. `src/compiler.js:86-90` — Add `math_greatest` and `math_least` to `MATH_BUILTINS`
3. `src/vm.js:595-625` — Add two `case` blocks in `callBuiltin()`, after `MATH_ABS`

**Implementation pattern** (follows `MATH_MAX`/`MATH_MIN` at `vm.js:596-619`):

```javascript
case BUILTIN.MATH_GREATEST: {
  if (argc === 1) {
    // Single arg: could be a list or a single value
    const v = stack[sp]
    if (isList(v)) {
      if (v.length === 0) return celError('math.greatest() requires at least one arg')
      return v.reduce((a, b) => celGt(a, b) === true ? a : b)
    }
    return v  // single scalar passthrough
  }
  // 2+ args: pairwise comparison
  let best = stack[sp - (argc - 1)]
  for (let i = 1; i < argc; i++) {
    const v = stack[sp - (argc - 1) + i]
    if (celGt(v, best) === true) best = v
  }
  return best
}
```

The `MATH_LEAST` case is identical but with `celLt` instead of `celGt`.

**Key details:**
- Unlike `math.max`/`math.min`, greatest/least must support variable arity (1 to N args). The compiler already passes `argc` = `args.length` for math namespace calls (`compiler.js:710`), so no compiler changes beyond the mapping.
- When `argc === 1`, distinguish scalar from list at runtime via `isList()` check. `math.greatest(5)` returns `5n`; `math.greatest([1,2,3])` reduces the list.
- **Avoid `Math.max`/`Math.min`** — they throw on BigInt. Use manual `>` / `<` comparison which works cross-type (BigInt vs Number) in JS.
- The existing `MATH_MAX` code at vm.js:601 has a no-op ternary (`isInt(a) ? a > b : a > b`). Don't copy this pattern — just use `celGt`/`celLt` for proper cross-type comparison.

**Tests to unskip** (`test/cel-spec.test.js`):
- Lines 1199-1203: `greatest_int_result` (5 tests)
- Lines 1207-1210: `greatest_double_result` (4 tests)
- Lines 1214-1215: `greatest_uint_result` (2 tests)
- Lines 1219-1223: `least_int_result` (5 tests)
- Lines 1227-1229: `least_double_result` (3 tests)
- Lines 1233-1234: `least_uint_result` (2 tests)

**Risk:** The currently ported tests are all single-type (int-only, double-only, uint-only). Cross-type tests (e.g., `math.greatest(dyn(5.4), dyn(10u))`) exist in `docs/cel-spec-testdata/math_ext.textproto` but aren't ported yet. Those depend on `dyn()` cross-type comparison which is Tier 2 work.

## Phase 2: String extensions — charAt, lastIndexOf, quote, join (13 tests)

### 2a. `charAt` (5 tests)

**Files to change:**

1. `src/bytecode.js:39` — Add `STRING_CHAR_AT: 12` to `BUILTIN`
2. `src/compiler.js:42` — Add `charAt: BUILTIN.STRING_CHAR_AT` to `METHOD_BUILTINS`
3. `src/vm.js` — Add case in `callBuiltin()`:

```javascript
case BUILTIN.STRING_CHAR_AT: {
  // argc=2: stack[sp]=index, stack[sp-1]=receiver
  const idx = stack[sp]; const recv = stack[sp - 1]
  if (!isStr(recv)) return celError('charAt() requires string receiver')
  const i = typeof idx === 'bigint' ? Number(idx) : idx
  const codepoints = [...recv]  // codepoint-aware iteration
  if (i < 0 || i > codepoints.length) return celError(`charAt: index ${i} out of range`)
  if (i === codepoints.length) return ''  // charAt(length) returns '' per spec
  return codepoints[i]
}
```

**Edge case:** `charAt(length)` returns `''` (not error), but `charAt(length+1)` errors. Test at line 1115 confirms: `'tacocat'.charAt(7)` → `''` (length is 7, index 7 = past end = empty). Test at line 1184: `'tacocat'.charAt(30)` → error.

**Codepoint awareness:** The `[...recv]` spread produces an array of codepoints (not UTF-16 code units). This is critical for the `multiple` test at line 1116 which uses `'\u00a9\u03b1T'.charAt(0)` expecting `'\u00a9'` — this works because BMP chars are 1 codepoint = 1 element.

**Tests:** Lines 1114-1116 (3 passing cases), 1184 (out-of-range error), 1189 (invalid type error)

### 2b. `lastIndexOf` (4 tests)

1. `src/bytecode.js` — Add `STRING_LAST_INDEX_OF: 13`
2. `src/compiler.js` — Add `lastIndexOf: BUILTIN.STRING_LAST_INDEX_OF` to `METHOD_BUILTINS`
3. `src/vm.js`:

```javascript
case BUILTIN.STRING_LAST_INDEX_OF: {
  const sub = stack[sp]; const recv = stack[sp - 1]
  if (!isStr(recv) || !isStr(sub)) return celError('lastIndexOf() requires strings')
  return BigInt(recv.lastIndexOf(sub))
}
```

**Tests:** Lines 1129-1132

### 2c. `strings.quote` (2 tests)

This requires a `strings.` namespace, similar to the existing `math.` namespace.

1. `src/bytecode.js` — Add `STRINGS_QUOTE: 14`
2. `src/compiler.js` — Add `STRINGS_BUILTINS` map and handle `strings.` namespace in `compileRCall()`:

```javascript
const STRINGS_BUILTINS = {
  strings_quote: BUILTIN.STRINGS_QUOTE,
}

// In compileRCall(), after the math namespace check (~line 713):
if (receiver.type === 'Ident' && receiver.name === 'strings') {
  const strId = STRINGS_BUILTINS[`strings_${method}`]
  if (strId !== undefined) {
    for (const a of args) compileNode(a)
    emit(OP.CALL, strId, args.length)
    return
  }
}
```

3. `src/vm.js`:

```javascript
case BUILTIN.STRINGS_QUOTE: {
  const v = stack[sp]
  if (!isStr(v)) return celError('strings.quote() requires string')
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}
```

**Tests:** Lines 1167-1168

### 2d. `join` — verify existing implementation (2 tests)

`join()` is already implemented in the VM (`vm.js:351-361`) and registered in `METHOD_BUILTINS` (`compiler.js:54`). The tests may already pass — try unskipping first.

**Tests:** Lines 1162-1163

**Potential issue:** The test `['x', 'y'].join() == 'xy'` calls `join()` with 0 args on a list. The VM handles `argc === 1` (receiver only, no separator) at line 356-359. This should work.

## Phase 3: Unicode SMP strings (5 tests)

**Hypothesis:** These may already work. The lexer correctly decodes `\U0001F431` to JavaScript surrogate pairs via `String.fromCodePoint()` (lexer.js:124-126). JS `startsWith`, `endsWith`, `includes` handle surrogate pairs natively.

**Action:** Try unskipping all 5 tests first. If any fail, investigate.

**Tests:**
- Line 859: `startsWith` with emoji — `'\U0001F431\U0001F600\U0001F61B'.startsWith('\U0001F431')`
- Line 869: `endsWith` with emoji
- Line 881: `matches` with emoji regex `(a|\U0001F600){2}`
- Line 892: string concatenation with mixed ASCII + BMP + SMP
- Line 902: `contains` with emoji

**Potential issues:**

1. `matches()` uses `new RegExp(pat)` (vm.js:308). The `u` flag may be needed for proper SMP regex matching. The pattern `(a|\U0001F600){2}` after escape decoding becomes `(a|😀){2}` — the `{2}` quantifier might count surrogate pairs differently without `u`. **Fix if needed:** Change `new RegExp(pat)` to `new RegExp(pat, 'u')` at vm.js:308.

2. `size()` returns `v.length` (UTF-16 code units) not codepoint count at vm.js:239. While none of the 5 listed SMP tests call `size()`, this should be fixed for correctness: `return BigInt([...v].length)` for strings. **Note:** This also affects `substring()` which uses `recv.substring(Number(start))` — JS `substring` uses UTF-16 offsets. These are not in scope for this PR but should be tracked.

3. `charAt()` (Phase 2a) already uses codepoint-aware `[...recv]` in the proposed implementation.

## Phase 4: Error short-circuit in `&&`/`||`/`!` (partial — 6-12 of ~25 tests)

This category is more complex than PLAN.md suggests. CEL has a commutative error model for `&&`/`||` where both sides matter even with short-circuit evaluation. Analysis of each subcategory:

### 4a. Tests that should already pass — try unskipping (3 tests)

These involve deterministic short-circuit where the jump opcode's existing behavior is correct:

| Line | Expression | Why it should pass |
|------|------------|-------------------|
| 741 | `false && 32` | Left is `false` → `JUMP_IF_FALSE_K` jumps → result is `false` |
| 755 | `true \|\| 32` | Left is `true` → `JUMP_IF_TRUE_K` jumps → result is `true` |
| 767 | `!0` | `OP.NOT`: `!isBool(0)` → pushes `celError` → `assertCelError` expects this |

### 4b. Non-bool left-hand side — needs VM fix (4 tests)

Currently `JUMP_IF_FALSE_K` and `JUMP_IF_TRUE_K` throw `EvaluationError` on non-bool non-error values. Per CEL spec, they should convert to `celError` and fall through (letting the right side potentially "win").

**Fix in `vm.js` lines 783-798:**

```javascript
case OP.JUMP_IF_FALSE_K: {
  const cond = stack[sp]
  if (cond === false) pc += operands[0]
  else if (!isBool(cond) && !isError(cond)) {
    stack[sp] = celError(`no such overload`)  // was: throw
  }
  break
}
case OP.JUMP_IF_TRUE_K: {
  const cond = stack[sp]
  if (cond === true) pc += operands[0]
  else if (!isBool(cond) && !isError(cond)) {
    stack[sp] = celError(`no such overload`)  // was: throw
  }
  break
}
```

**Tests this fixes:**

| Line | Expression | Expected | Flow |
|------|------------|----------|------|
| 742 | `'horses' && false` | `false` | left→error→fall through→POP→right=false |
| 756 | `'horses' \|\| true` | `true` | left→error→fall through→POP→right=true |
| 758 | `(2/0>3?false:true) \|\| true` | `true` | left→error→fall through→POP→right=true |
| 744 | `(2/0>3?false:true) && false` | `false` | left→error→fall through→POP→right=false |

**Caveat:** This fix works when the right-side value is deterministic (false for &&, true for ||). But it **breaks** when right is true for && or false for || with an error left — the error gets discarded. See 4c.

### 4c. Full CEL error propagation — defer to Tier 2 (10+ tests)

These tests require the result to be the **error** when error is on the left and the right-side doesn't "win":

- `1/0 != 0 && true` → error (left error, right true → should be error, but POP discards left)
- `true && 1/0 != 0` → error (works: right is error, stays on stack)
- `1/0 != 0 || false` → error (left error, right false → should be error)
- `'less filling' && 'tastes great'` → error
- Macro error tests (exists, all, exists_one, map) — lines 779-817

**Why it's hard:** The current compilation pattern for `&&` is:
```
[left] → JUMP_IF_FALSE_K → end → POP → [right] → end:
```
The POP discards the left value, losing error information. Proper fix requires either a new opcode (`OP.LOGICAL_AND`) that combines two values with CEL's error semantics, or restructuring the compilation to preserve both values.

**Recommendation:** Defer to a dedicated `feature/cel-error-model` branch.

### 4d. `!` no_overload — should already pass (1 test)

Line 767: `!0` → `assertCelError`. The `OP.NOT` handler at vm.js:870-875 already produces `celError` for non-bool. Unskip and verify.

## Deferred Categories (flagged for later)

### Integer math errors — uint negation, uint underflow (3 tests)

**Why deferred:** Both `int` and `uint` are stored as `BigInt` at runtime — the type distinction exists only in the constant pool (`TAG_INT64` vs `TAG_UINT64`). To detect `-(42u)` as an error, the VM would need runtime type tagging to distinguish uint from int. This is an architectural change affecting the entire value representation.

- Line 616: `-(42u)` → error
- Line 642: `0u - 1u` → error
- Line 652: `-(5u)` → error

### Bytes escape parsing (4+ tests)

**Why deferred:** The lexer's `scanBytes()` uses `scanString()` then `charCodeAt()`, which treats `\u00ff` as a single byte (0xFF). Per cel-spec, `b'\u00ff'` should produce UTF-8 bytes `[0xC3, 0xBF]` (2 bytes). Fixing this requires the lexer to distinguish between raw-byte escapes (`\x`, octal) and character escapes (`\u`, `\U`) in bytes context, then UTF-8 encode the character escapes. Additionally, many bytes tests require comparison operators (`<`, `>`, `<=`, `>=`) which are a separate feature.

### List index coercion (0 tests)

**Already passing.** The INDEX opcode at vm.js:906-928 already coerces BigInt to Number. `dyn(0u)` returns a BigInt which is handled correctly. Removed from scope.

## Acceptance Criteria

- [ ] `math.greatest` / `math.least`: 21 tests unskipped and passing
- [ ] `charAt`: 5 tests unskipped and passing
- [ ] `lastIndexOf`: 4 tests unskipped and passing
- [ ] `strings.quote`: 2 tests unskipped and passing
- [ ] `join`: 2 tests unskipped and passing (verify existing impl)
- [ ] Unicode SMP: 5 tests unskipped and passing
- [ ] Error short-circuit (easy subset): 4-8 tests unskipped and passing
- [ ] All existing tests continue to pass (`bun test` green)
- [ ] README.md updated if any CEL spec divergence documented
- [ ] IMPLEMENTATION.md updated with new builtins

## Success Metrics

- Reduce skipped test count from 372 by ~45-51 tests
- No regressions in passing tests

## Dependencies & Risks

- **No external dependencies.** All work is self-contained JS.
- **Risk: Unicode regex.** The `matches()` builtin may need the `u` flag for SMP support. This could theoretically change behavior for existing regex tests (unlikely — `u` flag only affects how surrogate pairs are counted).
- **Risk: `JUMP_IF_FALSE_K` change scope.** Changing throw→celError in jump opcodes affects comprehension loop conditions too. Need to verify no regressions in `exists`/`all`/`filter`/`map` tests.

## Sources

- **Origin:** PLAN.md Section 13 — Tier 1 Easy Wins
- **Test file:** `test/cel-spec.test.js` (line numbers referenced throughout)
- **Source testdata:** `docs/cel-spec-testdata/math_ext.textproto`, `docs/cel-spec-testdata/string_ext.textproto`, `docs/cel-spec-testdata/lists.textproto`
- **Implementation files:** `src/bytecode.js`, `src/compiler.js`, `src/vm.js`, `src/lexer.js`
