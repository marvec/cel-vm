---
title: "refactor: Consistent error classes across all modules"
type: refactor
status: completed
date: 2026-04-09
---

# refactor: Consistent error classes across all modules

## Overview

The CEL-VM pipeline has dedicated error classes for 5 of 7 modules (`LexError`, `ParseError`, `CheckError`, `CompileError`, `EvaluationError`), but `environment.js` (6 throw sites) and `bytecode.js` (7 throw sites) still use generic `Error`. This prevents callers from using `instanceof` to distinguish failure categories. Additionally, `LexError` and `ParseError` don't set `this.name`, creating an inconsistency in the error hierarchy.

## Problem Statement / Motivation

- Callers who `catch` errors around `load()` or environment configuration cannot distinguish between a bytecode decode failure and, say, a random `TypeError` — both are just `Error`.
- Log aggregation and error serialisation that relies on `err.name` gets `"Error"` for lex/parse issues instead of the actual class name.
- The library exports 5 typed error classes but the remaining 2 modules break the pattern, making the public API feel incomplete.

## Proposed Solution

1. Add `EnvironmentError` class to `src/environment.js` (Pattern B: `constructor(msg)`, sets `this.name`).
2. Add `BytecodeError` class to `src/bytecode.js` (Pattern B).
3. Fix `LexError` and `ParseError` to set `this.name` (one-line addition each).
4. Re-export both new classes from `src/index.js`.
5. Update tests to use `instanceof` checks where currently using regex matchers.
6. Add bytecode decode error tests (currently untested paths).

## Technical Considerations

- **Backward compatibility:** Both new classes `extend Error`, so any existing `catch(Error)` blocks continue to work. This is purely additive.
- **Performance:** Zero hot-path impact. Error construction only fires on invalid input, never during normal compile/evaluate.
- **`encode()` invariant throws:** The `Unknown const tag` throw in `encode()` (bytecode.js:265) signals an internal bug rather than corrupt external data. We include it under `BytecodeError` for simplicity — the encode path is only called internally and the distinction isn't worth a separate class.
- **JSDoc:** `evaluate()` and `load()` in `src/index.js` should document `BytecodeError` as a possible thrown error alongside `EvaluationError`.

## Acceptance Criteria

- [ ] `EnvironmentError` class in `src/environment.js` — 6 throw sites converted
- [ ] `BytecodeError` class in `src/bytecode.js` — 7 throw sites converted
- [ ] `LexError` sets `this.name = 'LexError'` in `src/lexer.js`
- [ ] `ParseError` sets `this.name = 'ParseError'` in `src/parser.js`
- [ ] `src/index.js` exports `EnvironmentError` and `BytecodeError`
- [ ] JSDoc on `evaluate()` and `load()` updated to include `BytecodeError`
- [ ] `test/environment.test.js` updated: regex matchers → `instanceof EnvironmentError`
- [ ] New bytecode decode error tests: bad magic, version mismatch, checksum mismatch, unknown const tag, too-short input, unknown operand width
- [ ] All existing tests pass (`bun test`)
- [ ] No generic `Error` throws remain in `src/environment.js` or `src/bytecode.js`
- [ ] `DOCS.md` updated with new error classes in the public API section

## Implementation Plan

### Phase 1: Error class definitions (src changes)

#### 1a. `src/environment.js`

Add at top of file:

```js
// src/environment.js
export class EnvironmentError extends Error {
  constructor(msg) {
    super(msg)
    this.name = 'EnvironmentError'
  }
}
```

Replace all 6 `throw new Error(...)` with `throw new EnvironmentError(...)`. No message changes needed.

#### 1b. `src/bytecode.js`

Add at top of file:

```js
// src/bytecode.js
export class BytecodeError extends Error {
  constructor(msg) {
    super(msg)
    this.name = 'BytecodeError'
  }
}
```

Replace all 7 `throw new Error(...)` with `throw new BytecodeError(...)`. No message changes needed.

#### 1c. `src/lexer.js`

Add one line inside the `LexError` constructor:

```js
// src/lexer.js:51 (after super(...))
this.name = 'LexError'
```

#### 1d. `src/parser.js`

Add one line inside the `ParseError` constructor:

```js
// src/parser.js:6 (after super(...))
this.name = 'ParseError'
```

### Phase 2: Exports and documentation

#### 2a. `src/index.js`

Add two export lines alongside existing error exports:

```js
export { EnvironmentError } from './environment.js'
export { BytecodeError }    from './bytecode.js'
```

Update JSDoc for `evaluate()` and `load()` to list `BytecodeError`.

#### 2b. `DOCS.md`

Add `EnvironmentError` and `BytecodeError` to the error classes section of the public API documentation.

### Phase 3: Test updates

#### 3a. `test/environment.test.js`

Import `EnvironmentError` and update existing regex-based assertions to `instanceof` checks. There are ~4 sites using patterns like:

```js
// Before
assert.throws(() => env.registerConstant('x', 'int', 2n), /already registered/)

// After
assert.throws(() => env.registerConstant('x', 'int', 2n), EnvironmentError)
```

#### 3b. New bytecode error tests

Add a test section (in existing test file or new `test/bytecode.test.js`) covering the decode error paths:

| Test case | Input | Expected |
|-----------|-------|----------|
| Too-short bytecode | `new Uint8Array(2)` | `BytecodeError` with "too short" |
| Bad magic bytes | Valid-length buffer, wrong magic | `BytecodeError` with "Invalid CEL magic" |
| Unsupported version | Valid magic, bad version byte | `BytecodeError` with "Unsupported CEL bytecode version" |
| Checksum mismatch | Valid structure, corrupted body | `BytecodeError` with "checksum mismatch" |
| Unknown const tag (decode) | Valid header, invalid tag byte in const pool | `BytecodeError` with "Unknown const tag" |

Each test should verify both `instanceof BytecodeError` and a message substring.

## Files Changed

| File | Change |
|------|--------|
| `src/environment.js` | Add `EnvironmentError` class, replace 6 throw sites |
| `src/bytecode.js` | Add `BytecodeError` class, replace 7 throw sites |
| `src/lexer.js` | Add `this.name = 'LexError'` (1 line) |
| `src/parser.js` | Add `this.name = 'ParseError'` (1 line) |
| `src/index.js` | Add 2 export lines, update JSDoc |
| `DOCS.md` | Add new error classes to API docs |
| `test/environment.test.js` | Update ~4 regex matchers to instanceof |
| `test/bytecode.test.js` | New file — decode error path tests |

## Sources & References

- Existing Pattern B: `src/checker.js:6-11`, `src/compiler.js:119-124`, `src/vm.js:19-24`
- Current exports: `src/index.js:15-20`
- Test patterns: `test/lexer.test.js:496-524` (instanceof), `test/environment.test.js:48` (regex)
