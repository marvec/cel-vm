---
title: "fix: Reject \\u/\\U escapes in bytes literals"
type: fix
status: active
date: 2026-04-10
---

# Reject `\u`/`\U` Escapes in Bytes Literals

## Overview

The lexer currently accepts `\u` and `\U` escape sequences inside bytes literals (`b"..."`) and UTF-8 encodes them. The Go reference implementation (cel-go) **rejects** these as parse errors. Align with the reference implementation by erroring on `\u`/`\U` in bytes, guiding users to `\xHH` or octal `\OOO` instead.

## Background

Bytes literals are already fully implemented across the entire pipeline. The only issue is that `scanBytes()` in the lexer incorrectly accepts `\u`/`\U` escapes.

### Why `\u`/`\U` don't belong in bytes

- **Bytes** (`b"..."`) represent raw octets. The valid escapes for arbitrary byte values are `\xHH` (0x00–0xFF) and octal `\OOO` (0–377).
- **Strings** (`"..."`) represent Unicode text. `\u`/`\U` exists to express Unicode code points, which can be multi-byte — a concept that doesn't map cleanly to raw bytes.
- The Go reference implementation explicitly rejects them: `parser/unescape.go` returns an error when `isBytes` is true for `\u`/`\U` cases.
- There are zero cel-spec conformance tests for `\u`/`\U` inside bytes — the spec simply doesn't expect them to work there.

### Current behavior (incorrect)

```javascript
// src/lexer.js:222-236
case 'u': {
  const hex = src.slice(pos, pos + 4)
  parts.push(String.fromCodePoint(parseInt(hex, 16)))  // UTF-8 encodes
  break
}
```

`b"\u00E9"` → UTF-8 encoding of é → `Uint8Array [0xC3, 0xA9]` (2 bytes — surprising)

### Proposed behavior (error with guidance)

`b"\u00E9"` → parse error: `\u escape not allowed in bytes literal, use \xHH or \OOO instead`

## Difficulty: Trivial

**2 lines changed** in `src/lexer.js`, plus tests. No other pipeline stages affected.

- **Compile-time impact:** None — removes a code path, marginally simpler.
- **Run-time impact:** Zero — the VM is untouched.
- **Spec alignment:** Moves **closer** to cel-spec/cel-go, not further away. No divergence to document.
- **Test impact:** No existing tests use `\u`/`\U` in bytes.

## Acceptance Criteria

- [ ] `\u` in `b"..."` produces a clear parse error with guidance message
- [ ] `\U` in `b"..."` produces a clear parse error with guidance message
- [ ] `\u`/`\U` in string literals (`"..."`) continue to work unchanged
- [ ] Tests added for the error cases
- [ ] `bun run bench/compare.js` confirms no performance regression

## MVP

### src/lexer.js

```javascript
// Replace lines 222-227
case 'u':
  err('\\u escape not allowed in bytes literal, use \\xHH or \\OOO instead')

// Replace lines 229-237
case 'U':
  err('\\U escape not allowed in bytes literal, use \\xHH or \\OOO instead')
```

### test/lexer.test.js

```javascript
describe('bytes rejects \\u/\\U escapes', () => {
  it('\\u in bytes literal is an error', () => {
    assert.throws(() => lex('b"\\u0041"'), /\\u escape not allowed in bytes literal/)
  })
  it('\\U in bytes literal is an error', () => {
    assert.throws(() => lex('b"\\U00000041"'), /\\U escape not allowed in bytes literal/)
  })
  it('\\u in string literal still works', () => {
    const t = tok('"\\u0041"')
    assert.strictEqual(t.value, 'A')
  })
})
```

## Sources

- Lexer bytes scanning: `src/lexer.js:184-279`
- Current `\u` handling in bytes: `src/lexer.js:222-227`
- Current `\U` handling in bytes: `src/lexer.js:229-237`
- cel-go reference: `parser/unescape.go` — rejects `\u`/`\U` when `isBytes` is true
