---
title: "feat: Add debug source mapping via Environment API"
type: feat
status: completed
date: 2026-04-09
---

# feat: Add debug source mapping via Environment API

## Overview

Add source-mapping debug capabilities to CEL-VM so that runtime errors carry the original source `{line, col}` position from the CEL expression. Debugging is activated via `env.enableDebug()` on the Environment API class and is **off by default** with **zero runtime cost** when disabled.

## Problem Statement / Motivation

When a CEL expression fails at runtime (division by zero, type mismatch, bad duration parse), the `EvaluationError` carries only a message string. Users have no way to locate which part of a complex expression caused the failure. The bytecode format and compiler already have placeholder infrastructure for debug info (`FLAG_DEBUG` section, `debugEntries` array), but it emits all-zeros and the VM ignores it entirely.

## Proposed Solution

### API Surface

```javascript
const env = new Environment()
env.enableDebug()

// Compile emits debug info automatically
const bytecode = env.compile('a / b + c')

// Evaluate uses debug-aware dispatch automatically
try {
  env.evaluate(bytecode, { a: 1, b: 0, c: 3 })
} catch (e) {
  console.log(e.line)  // 1
  console.log(e.col)   // 3  (points to '/')
  console.log(e.message) // "division by zero at 1:3"
}
```

- `env.enableDebug()` sets a persistent boolean flag on the Environment instance
- `env.compile()` automatically passes `debugInfo: true` when debug is enabled
- `env.evaluate()` dispatches to `evaluateDebug()` when debug is enabled
- `env.run()` inherits both behaviors (compile with debug info, evaluate with debug dispatch)
- No `disableDebug()` in v1 (can be added later if needed)

### Architecture: Zero-Cost Debug Dispatch

**Key decision: try/catch wrapper, NOT a duplicated dispatch loop.**

Rather than copying the entire 450-line VM dispatch loop, `evaluateDebug()` wraps a call to the existing `evaluate()` in a try/catch. When an `EvaluationError` is caught, it enriches the error with `{line, col}` from `debugInfo[pc]` before rethrowing.

**Problem:** The `pc` value is local to `evaluate()` and lost when the error is thrown.

**Solution:** `evaluateDebug()` calls a new internal variant `evaluateCore()` that accepts an optional `pcRef` object (`{ value: 0 }`). Before each opcode dispatch, `pcRef.value = pc`. When debug is disabled, no `pcRef` is passed and the assignment is skipped via a single `if (pcRef)` check. However, this adds a branch to every opcode...

**Better solution:** Export `pc` on the error itself. Modify the 6 `throw new EvaluationError(...)` sites in `vm.js` to capture `pc` as a property: `throw new EvaluationError(msg, pc - 1)`. The `EvaluationError` constructor accepts an optional second argument `instrIndex` and stores it (defaults to `-1`). This has **negligible cost** (one extra argument to a constructor that only runs on error paths — errors are already slow). The `evaluateDebug()` wrapper catches the error, looks up `debugInfo[e.instrIndex]`, attaches `{line, col}`, and rethrows.

**Zero-cost guarantee:** The production `evaluate()` function is unchanged except that error constructors receive one extra integer. Error paths are cold — they are never hit during normal execution and do not affect branch prediction or JIT optimization of the hot dispatch loop.

## Technical Approach

### Phase 1: Parser — Attach Source Positions to AST Nodes

**Files:** `src/parser.js`

Every AST node constructor site (15+ locations) must include `line` and `col` from the relevant token:

**Position convention:**
- **Literals** (`IntLit`, `FloatLit`, `StringLit`, `BoolLit`, `NullLit`, `BytesLit`, `UintLit`): position of the literal token
- **Ident**: position of the identifier token
- **Binary**: position of the **operator** token (e.g., `/` in `a / b`) — most useful for error reporting
- **Unary**: position of the operator token (`-`, `!`)
- **Call**: position of the function name token
- **Select** (`a.b`): position of the `.` dot token
- **Index** (`a[b]`): position of the `[` bracket token
- **Ternary**: position of the `?` token
- **List**: position of the `[` token
- **Map**: position of the `{` token

Example change:
```javascript
// Before
return { type: 'IntLit', value: tok.value }

// After
return { type: 'IntLit', value: tok.value, line: tok.line, col: tok.col }
```

For compound nodes like `Binary`, capture the operator token before building the node:
```javascript
// Before
const opTok = advance()
const right = parseUnary()
node = { type: 'Binary', op: opTok.value, left: node, right }

// After
const opTok = advance()
const right = parseUnary()
node = { type: 'Binary', op: opTok.value, left: node, right, line: opTok.line, col: opTok.col }
```

**Checker macro expansion:** Synthetic `Comprehension` nodes created by the checker (`has()`, `exists()`, `filter()`, `map()`, `all()`, `exists_one()`) should inherit the position of the macro call site token. The checker receives AST nodes that now carry positions — the `Call` node for `list.exists(x, x > 10)` has the position of `exists`. The `Comprehension` node should copy that position.

**File:** `src/checker.js` — when constructing `Comprehension` nodes, copy `line`/`col` from the source `Call`/`Select` node.

### Phase 2: Compiler — Emit Real Source Positions

**File:** `src/compiler.js`

Modify the `emit()` helper to accept an optional AST node reference and extract its position:

```javascript
function emit(op, ...operands) {
  instrs.push({ op, operands })
  if (emitDebug) {
    debugEntries.push({ line: currentLine, col: currentCol })
  }
  return instrs.length - 1
}
```

Add a `currentLine`/`currentCol` tracking mechanism. Before compiling each AST node in `compileNode()`, update:
```javascript
function compileNode(node) {
  if (emitDebug && node.line !== undefined) {
    currentLine = node.line
    currentCol = node.col
  }
  // ... existing switch on node.type
}
```

All instructions emitted during a node's compilation inherit that node's position. Child nodes override with their own positions. This is simple, correct, and matches how source maps work in JS compilers.

### Phase 3: VM — Enrich Errors with Source Positions

**File:** `src/vm.js`

**3a. Extend `EvaluationError`:**

```javascript
export class EvaluationError extends Error {
  constructor(msg, instrIndex = -1) {
    super(msg)
    this.name = 'EvaluationError'
    this.instrIndex = instrIndex
  }
}
```

**3b. Update all 6 throw sites** to pass `pc - 1` (the current instruction index, since `pc` was already incremented):

```javascript
// Before
throw new EvaluationError(`division by zero`)

// After
throw new EvaluationError(`division by zero`, pc - 1)
```

The 6 sites are:
1. `vm.js:1017` — duration parse failure
2. `vm.js:1087` — RETURN with error result
3. `vm.js:1101` — JUMP_IF_FALSE type check
4. `vm.js:1108` — JUMP_IF_TRUE type check
5. `vm.js:1484` — unknown opcode
6. `vm.js:1490` — post-loop error result

**Note:** The duration parse site (`vm.js:1017`) is inside a helper function outside the dispatch loop. It does not have access to `pc`. Two options:
- (a) Move the throw to the call site inside the dispatch loop (where `pc` is available)
- (b) Leave it without `instrIndex` — `evaluateDebug()` can still catch it, it just won't have a position

Option (a) is preferred for consistency.

**3c. Create `evaluateDebug()` wrapper:**

```javascript
export function evaluateDebug(program, activation, customFunctionTable) {
  const { debugInfo } = program
  try {
    return evaluate(program, activation, customFunctionTable)
  } catch (e) {
    if (e instanceof EvaluationError && debugInfo && e.instrIndex >= 0) {
      const entry = debugInfo[e.instrIndex]
      if (entry && (entry.line > 0 || entry.col > 0)) {
        e.line = entry.line
        e.col = entry.col
        e.message = `${e.message} at ${entry.line}:${entry.col}`
      }
    }
    throw e
  }
}
```

### Phase 4: Environment API — `enableDebug()`

**File:** `src/environment.js`

```javascript
import { evaluate as evalProgram, evaluateDebug as evalProgramDebug } from './vm.js'

export class Environment {
  constructor() {
    // ... existing fields
    this._debug = false
  }

  enableDebug() {
    this._debug = true
    return this
  }

  compile(src, options = {}) {
    const config = this.toConfig()
    const tokens  = tokenize(src)
    const ast     = parse(tokens)
    const checked = check(ast)
    const program = compileAst(checked, {
      debugInfo: this._debug || options.debugInfo || false,
      env: config,
    })
    return encode(program)
  }

  evaluate(bytecode, activation) {
    const program = decode(bytecode)
    const config = this.toConfig()
    const evalFn = this._debug ? evalProgramDebug : evalProgram
    return evalFn(program, activation || {}, config.functionTable)
  }

  // run() unchanged — calls this.compile() + this.evaluate(), inherits debug behavior
}
```

**Cross-flow behavior:**
- Debug bytecode evaluated without debug dispatch: debug info is present but ignored. Works fine.
- Non-debug bytecode evaluated with debug dispatch: `evaluateDebug()` catches errors, `debugInfo` is null/undefined, enrichment is skipped. Falls back to plain error. Works fine.

## Acceptance Criteria

- [ ] `env.enableDebug()` method exists and returns `this` for chaining
- [ ] `env.compile()` emits real `{line, col}` debug info when debug is enabled
- [ ] `env.evaluate()` dispatches to `evaluateDebug()` when debug is enabled
- [ ] `env.run()` produces debug-enriched errors when debug is enabled
- [ ] `EvaluationError` carries `.line` and `.col` properties when thrown in debug mode
- [ ] `EvaluationError.message` includes `at line:col` suffix in debug mode
- [ ] Error in `1 / 0` points at the `/` operator (col position)
- [ ] Error in `a.b` with missing field points at `.`
- [ ] AST nodes carry `{line, col}` from source tokens
- [ ] Checker-expanded macros (`exists`, `all`, `filter`, `map`, `has`) inherit call-site position
- [ ] Zero performance impact on production `evaluate()` — verify with `bun run bench/compare.js`
- [ ] Bytecode without debug info works correctly with debug dispatch (graceful fallback)
- [ ] Debug bytecode works correctly with non-debug dispatch (debug info ignored)
- [ ] IMPLEMENTATION.md updated with debug architecture
- [ ] DOCS.md updated with `enableDebug()` usage

## System-Wide Impact

- **Interaction graph:** `enableDebug()` sets `_debug` flag → `compile()` reads flag to set `debugInfo` option → compiler emits real positions → `evaluate()` reads flag to choose dispatch function → `evaluateDebug()` catches errors → enriches with debug info → rethrows
- **Error propagation:** Errors flow unchanged through the existing path. The only addition is a try/catch wrapper in `evaluateDebug()` that enriches before rethrowing. No new error types.
- **State lifecycle risks:** None. The `_debug` flag is a simple boolean on the Environment instance. No shared state, no side effects.
- **API surface parity:** The standalone `compile()`/`evaluate()` from `src/index.js` does NOT gain debug evaluation. This is intentional — debug evaluation requires the Environment class. The standalone `compile(src, { debugInfo: true })` will now emit real positions (benefit of Phase 2), but `evaluate()` from `src/index.js` has no debug dispatch. This can be added later if needed.
- **Performance:** The only change to the production hot path is that `EvaluationError` constructors receive one extra integer argument. This is on the error path only (cold) and has zero impact on the dispatch loop.

## Dependencies & Risks

**Risk: Parser position propagation breaks existing tests.** Mitigation: AST nodes gain extra `line`/`col` fields. Existing tests that assert on node shape may fail if they use deep equality. Use spread/subset assertions or update test expectations.

**Risk: Compiler `currentLine`/`currentCol` tracking introduces subtle position bugs.** Mitigation: Write targeted tests that assert specific positions for specific error types.

**Risk: `pc - 1` is wrong for errors thrown from helper functions.** Mitigation: Audit all `throw new EvaluationError` sites. For helpers called from the dispatch loop (like `duration()`), restructure to throw from the call site where `pc` is available.

## Implementation Sequence

Per the project's build order (red-to-green), write failing tests first:

1. **Tests** — Write tests for `enableDebug()`, error positions, zero-cost verification
2. **Parser** — Attach `{line, col}` to all AST nodes
3. **Checker** — Propagate positions through macro expansion
4. **Compiler** — Emit real positions in `debugEntries`
5. **VM** — Extend `EvaluationError`, add `evaluateDebug()`, update throw sites
6. **Environment** — Add `enableDebug()`, wire compile/evaluate

## Sources & References

- `src/parser.js` — 15+ AST node construction sites need `{line, col}`
- `src/compiler.js:267-270` — `emit()` + `debugEntries` placeholder
- `src/bytecode.js:9,117,298-305` — `FLAG_DEBUG` encoding/decoding
- `src/vm.js:19-24` — `EvaluationError` class
- `src/vm.js:1035-1492` — dispatch loop, 6 throw sites
- `src/environment.js:35-175` — Environment class
- `src/checker.js` — macro expansion creates synthetic AST nodes
