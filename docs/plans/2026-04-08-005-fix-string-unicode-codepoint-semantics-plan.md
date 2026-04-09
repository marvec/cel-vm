---
title: "fix: String operations use Unicode code points instead of UTF-16 code units"
type: fix
status: completed
date: 2026-04-08
---

# fix: String operations use Unicode code points instead of UTF-16 code units

## Overview

cel-spec defines string operations in terms of Unicode code points, but cel-vm currently uses JavaScript's native UTF-16 code unit semantics (`String.length`, `String[i]`, `String.substring()`, etc.). This produces wrong results for any string containing characters outside the Basic Multilingual Plane (U+10000+) -- emoji, CJK Extension B, mathematical symbols, etc.

`charAt()` already uses code-point semantics (`[...recv]`), proving the codebase considers this the correct approach. The remaining string operations need to follow suit.

## Problem Statement

```
size("😀")      → 2n (wrong, should be 1n)
"😀"[0]         → "\uD83D" (lone surrogate -- invalid string)
"a😀b"[2]       → "\uDE00" (lone surrogate -- invalid string)
indexOf("a😀b", "b") → 3n (UTF-16 offset, should be 2n code-point index)
```

Fixing only `size()` while leaving INDEX/substring/indexOf on UTF-16 creates an inconsistent API surface where composing operations produces wrong results (e.g., `s.charAt(s.indexOf("x"))` on SMP strings).

## Proposed Solution

Fix all string operations to use code-point semantics in a single change. The scope is limited to `src/vm.js` since the compiler just emits opcodes -- no compiler changes needed.

## Acceptance Criteria

- [ ] `size()` returns code point count, not UTF-16 length (`src/vm.js` celSize function, line ~239)
- [ ] String INDEX opcode uses code-point indexing and code-point-based bounds check (`src/vm.js` lines ~974-977)
- [ ] `substring()` uses code-point offsets (`src/vm.js` lines ~310-319)
- [ ] `indexOf()` returns code-point offset (`src/vm.js` line ~324)
- [ ] `lastIndexOf()` returns code-point offset (`src/vm.js` line ~375)
- [ ] Tests pass for SMP characters (emoji) in all fixed operations
- [ ] Existing cel-spec and marcbachmann tests continue to pass
- [ ] README.md divergence table updated (remove or update the "String Unicode" row)
- [ ] IMPLEMENTATION.md updated if architecture notes change
- [ ] No performance regression on benchmarks (use zero-allocation counters where possible)

## Technical Approach

### Helper: zero-allocation code-point counter

```js
function codePointLen(s) {
  let count = 0
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)
    i += cp > 0xFFFF ? 2 : 1
    count++
  }
  return count
}
```

### Helper: code-point aware indexing

```js
function codePointAt(s, idx) {
  let count = 0
  for (let i = 0; i < s.length; ) {
    if (count === idx) return String.fromCodePoint(s.codePointAt(i))
    const cp = s.codePointAt(i)
    i += cp > 0xFFFF ? 2 : 1
    count++
  }
  return undefined // out of bounds
}
```

### Helper: code-point aware substring

```js
function codePointSubstring(s, start, end) {
  const pts = [...s] // spread into code points
  return pts.slice(start, end).join('')
}
```

### Helper: code-point offset from UTF-16 offset

For `indexOf`/`lastIndexOf`, find the substring using JS native method (correct for locating), then convert the returned UTF-16 offset to a code-point offset:

```js
function utf16OffsetToCodePoint(s, utf16Offset) {
  if (utf16Offset < 0) return -1n
  let cpIdx = 0
  for (let i = 0; i < utf16Offset; ) {
    const cp = s.codePointAt(i)
    i += cp > 0xFFFF ? 2 : 1
    cpIdx++
  }
  return BigInt(cpIdx)
}
```

### Changes by location

| File | Location | Change |
|------|----------|--------|
| `src/vm.js` | `celSize()` ~L239 | `BigInt(v.length)` -> `BigInt(codePointLen(v))` |
| `src/vm.js` | INDEX opcode ~L974-977 | Use `codePointAt()` helper, bounds check with `codePointLen()` |
| `src/vm.js` | `substring()` ~L310-319 | Use `codePointSubstring()` helper |
| `src/vm.js` | `indexOf()` ~L324 | Convert result with `utf16OffsetToCodePoint()` |
| `src/vm.js` | `lastIndexOf()` ~L375 | Convert result with `utf16OffsetToCodePoint()` |
| `README.md` | Divergences table L201 | Update to reflect fix (or remove row if fully resolved) |
| `test/cel-spec.test.js` | After size tests ~L850 | Add SMP character tests |

### New tests to add

```js
// size() with SMP characters
it('size_emoji', () => assertCel('size("😀")', 1n))
it('size_mixed_smp', () => assertCel('size("a😀b")', 3n))
it('size_multiple_smp', () => assertCel('size("😀🎉")', 2n))

// INDEX with SMP characters
it('index_emoji', () => assertCel('"a😀b"[1]', '😀'))
it('index_after_emoji', () => assertCel('"a😀b"[2]', 'b'))

// indexOf with SMP characters
it('indexOf_after_smp', () => {
  const r = run('"a😀b".indexOf("b")')
  assert.strictEqual(r, 2n) // code-point offset, not 3n
})

// substring with SMP characters
it('substring_smp', () => {
  const r = run('"a😀b".substring(1, 2)')
  assert.strictEqual(r, '😀')
})

// ZWJ sequences count as multiple code points (per cel-spec)
// "👨‍👩‍👧" = U+1F468 U+200D U+1F469 U+200D U+1F467 = 5 code points
it('size_zwj', () => assertCel('size("👨‍👩‍👧")', 5n))
```

### Performance considerations

- `size()`: Use `codePointLen()` loop (zero allocation) instead of `[...v].length` (allocates array)
- INDEX: Use `codePointAt()` with linear scan (O(n) per access, zero allocation). Acceptable since string indexing is not typically in tight loops in CEL
- `substring()`: Uses `[...s]` spread. Could optimize with a two-pointer scan if benchmarks show regression
- `indexOf()`/`lastIndexOf()`: JS native search is still used for finding the match (correct regardless of encoding), only the offset conversion adds cost

## Sources

- cel-spec string semantics: code points, not code units
- Existing `charAt()` implementation at `src/vm.js:367` uses `[...recv]` -- established pattern
- README.md divergence table line 201
