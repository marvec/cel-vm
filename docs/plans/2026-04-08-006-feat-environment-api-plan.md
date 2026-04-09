# Environment API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `Environment` API that lets users register custom functions, constants, and variable declarations — matching the cel-js developer experience while preserving cel-vm's bytecode performance.

**Architecture:** A lightweight `Environment` object collects declarations (functions, constants, variable types) and threads them through the compile → VM pipeline. Custom functions get assigned BUILTIN IDs starting at 64 (above the reserved range 0–53). The VM dispatch loop uses a **split-dispatch** strategy: `OP.CALL` checks `id >= 64` and routes to a separate `callCustom()` function, keeping the existing `callBuiltin()` signature and V8 JIT profile completely untouched. No classes in the hot path — the environment produces a plain config object consumed by compiler and VM.

**Tech Stack:** Pure JavaScript, no dependencies. Node `node:test` for testing. Bun as runner.

---

## Background: How cel-js Does It

The `@marcbachmann/cel-js` package exposes an `Environment` class with a builder pattern:

```javascript
import { Environment } from '@marcbachmann/cel-js'

const env = new Environment()
  .registerVariable('user', 'map')
  .registerConstant('minAge', 'int', 18n)
  .registerFunction('isAdult(int): bool', age => age >= 18n)
  .registerOperator('string * int', (s, n) => s.repeat(Number(n)))

const program = env.compile('isAdult(user.age) && user.name != ""')
const result = program.evaluate({ user: { age: 25n, name: 'Alice' } })
```

Key features:
- **Variables**: declared with name + type, provided at evaluation time
- **Constants**: declared with name + type + value, baked into compilation
- **Custom functions**: declared with signature string + JS implementation
- **Custom operators**: declared with type signature + JS implementation
- **Type declarations**: custom types with field schemas and constructors
- **Fluent builder**: chainable `.register*()` methods

## How cel-vm Currently Works

Our pipeline is: `compile(src) → Uint8Array` then `evaluate(bytecode, activation) → value`.

- Variables: auto-detected from AST by `collectVarNames()`, sorted alphabetically, assigned integer indices. No declarations needed.
- Functions: hardcoded in `CALL_BUILTINS`, `METHOD_BUILTINS`, `MATH_BUILTINS`, `STRINGS_BUILTINS` maps. Unknown function → `CompileError`.
- No environment concept. No custom function registration. No constants.

### Extension Points

| Where | What needs to change |
|-------|---------------------|
| `src/compiler.js:660-675` | `compileCall()` throws on unknown function names — needs fallback to custom registry |
| `src/compiler.js:760-769` | `compileRCall()` throws on unknown methods — needs fallback to custom registry |
| `src/bytecode.js:34-54` | `BUILTIN` enum ends at 50 — custom functions start at 64 |
| `src/vm.js:325-330` | `callBuiltin()` switch — needs custom function dispatch |
| `src/index.js` | Public API — needs `Environment` class or `createEnv()` factory |
| `src/bytecode.js` encode/decode | Needs to encode/decode the custom function table metadata |

---

## File Structure

```
src/environment.js  — NEW: Environment class (declaration collection + config generation)
src/compiler.js     — MODIFY: accept custom function/constant registry; resolve custom calls
src/vm.js           — MODIFY: accept custom function table; dispatch CALL opcode for custom IDs
src/bytecode.js     — MODIFY: reserve BUILTIN ID range 64+ for custom functions
src/index.js        — MODIFY: add Environment to public exports; wire env config through pipeline
test/environment.test.js — NEW: tests for environment API
```

---

## Design Decisions

### 1. Custom Function IDs Start at 64

BUILTIN IDs 0–53 are reserved for built-in functions. Custom functions get IDs 64, 65, 66… This leaves room for ~10 more builtins before the gap. The compiler assigns IDs in registration order. The function table (array of JS functions) is passed to `evaluate()` alongside activation.

### 2. Split-Dispatch Strategy (No New Opcode)

Custom functions use the existing `OP.CALL` opcode with a builtin ID ≥ 64. The `OP.CALL` case in the dispatch loop checks `id >= 64` and routes to a **separate** `callCustom()` function. This is critical for performance:

- **`callBuiltin()` is untouched** — same signature, same V8 monomorphic call site, same JIT profile. Zero regression for expressions with no custom functions.
- **`callCustom()` is a new function** — handles the allocation and JS function invocation. It uses arity-specific fast paths (direct args for 1–3 params) to avoid `new Array()` + spread in the common case.
- **The `id >= 64` branch** is a cheap integer compare in the dispatch loop. V8's branch predictor learns it's almost always false for built-in-only code.

```
OP.CALL dispatch:
  id < 64  → callBuiltin(id, argc, stack, sp)         // unchanged, monomorphic
  id >= 64 → callCustom(id, argc, stack, sp, fnTable)  // separate function, separate JIT
```

### 3. Constants Become Compile-Time Substitutions

When the compiler encounters an `Ident` node whose name is in the constant registry, it emits `PUSH_CONST` with the constant's value instead of `LOAD_VAR`. This means constants are baked into bytecode — zero runtime cost.

### 4. Variable Declarations Are Optional Type Hints

cel-vm currently auto-detects variables from the AST. Declaring variables in the environment adds optional compile-time validation: if declared, the compiler checks that the expression only references declared variables. If no variables are declared, current behavior is preserved (permissive mode).

### 5. Environment Produces a Config Object

The `Environment` class is just a builder. It produces a plain `EnvConfig` object:

```javascript
{
  constants: Map<string, {tag, value}>,       // name → const pool entry
  customFunctions: Map<string, {id, impl, arity}>, // name → fn metadata
  customMethods: Map<string, {id, impl, arity}>,   // method → fn metadata
  declaredVars: Map<string, string> | null,   // name → type (null = permissive)
}
```

This config is passed to `compile()` via options and to `evaluate()` via a function table array.

### 6. Bytecode Portability Caveat

Bytecode compiled with custom functions references function IDs that only make sense with the same environment. The bytecode itself is still portable (same binary format), but evaluation requires passing the matching function table. This is documented, not enforced.

---

## Performance Impact Analysis

### Zero-cost features (compile-time only)
- **Constants** → `PUSH_CONST` substitution, no runtime effect
- **Variable declarations** → checked once during compilation
- **Custom function/method resolution** → compile-time lookup, emits same `OP.CALL` opcode

### Runtime: expressions with NO custom functions
- **`callBuiltin()` is completely untouched** — same signature `(id, argc, stack, sp)`, same V8 monomorphic call site, same JIT profile. Zero regression.
- **One `id >= 64` integer compare** per `OP.CALL` in the dispatch loop. V8's branch predictor learns this is always false. Cost: effectively zero.
- **`evaluate()` gains one extra parameter** (`customFunctionTable`, undefined). No measurable impact.

### Runtime: expressions WITH custom functions
- **`callCustom()` is a separate function** from `callBuiltin()`, so V8 JIT optimizes them independently. No pollution of the builtin dispatch profile.
- **Arity-specific fast paths** for 1–3 args avoid `new Array()` + spread allocation:
  - `argc=1`: `fn(stack[sp])` — direct call, zero allocation
  - `argc=2`: `fn(stack[sp-1], stack[sp])` — direct call, zero allocation
  - `argc=3`: `fn(stack[sp-2], stack[sp-1], stack[sp])` — direct call, zero allocation
  - `argc≥4`: `new Array(argc)` + spread (rare, unavoidable)
- **Overhead per custom call**: one JS function call + the user's implementation. This is inherent — the user provides a JS function, we must call it.

### Summary

| Scenario | Impact |
|----------|--------|
| No custom functions registered | Zero — `callBuiltin()` untouched, one cheap untaken branch |
| Custom functions called (1–3 args) | One function call, zero allocation |
| Custom functions called (4+ args) | One function call + one array allocation |
| Constants | Negative (faster!) — compile-time substitution eliminates `LOAD_VAR` |

---

## Task 1: Environment Class — Core Builder

**Files:**
- Create: `src/environment.js`
- Test: `test/environment.test.js`

- [ ] **Step 1: Write failing tests for Environment construction and constant registration**

```javascript
// test/environment.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Environment } from '../src/environment.js'

describe('Environment', () => {
  it('creates an empty environment', () => {
    const env = new Environment()
    const config = env.toConfig()
    assert.equal(config.constants.size, 0)
    assert.equal(config.customFunctions.size, 0)
    assert.equal(config.customMethods.size, 0)
    assert.equal(config.declaredVars, null)
  })

  it('registers a constant', () => {
    const env = new Environment()
    env.registerConstant('maxAge', 'int', 100n)
    const config = env.toConfig()
    assert.equal(config.constants.size, 1)
    assert.deepStrictEqual(config.constants.get('maxAge'), { tag: 2, value: 100n })
  })

  it('registers a string constant', () => {
    const env = new Environment()
    env.registerConstant('greeting', 'string', 'hello')
    const config = env.toConfig()
    assert.deepStrictEqual(config.constants.get('greeting'), { tag: 5, value: 'hello' })
  })

  it('registers a bool constant', () => {
    const env = new Environment()
    env.registerConstant('debug', 'bool', true)
    const config = env.toConfig()
    assert.deepStrictEqual(config.constants.get('debug'), { tag: 1, value: true })
  })

  it('registers a double constant', () => {
    const env = new Environment()
    env.registerConstant('pi', 'double', 3.14)
    const config = env.toConfig()
    assert.deepStrictEqual(config.constants.get('pi'), { tag: 4, value: 3.14 })
  })

  it('rejects duplicate constant names', () => {
    const env = new Environment()
    env.registerConstant('x', 'int', 1n)
    assert.throws(() => env.registerConstant('x', 'int', 2n), /already registered/)
  })

  it('chains register calls fluently', () => {
    const env = new Environment()
      .registerConstant('a', 'int', 1n)
      .registerConstant('b', 'string', 'hi')
    const config = env.toConfig()
    assert.equal(config.constants.size, 2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/environment.test.js`
Expected: FAIL — module `../src/environment.js` not found

- [ ] **Step 3: Implement Environment class with constant registration**

```javascript
// src/environment.js
// Environment — declaration builder for CEL-VM
//
// Collects custom function, constant, and variable declarations.
// Produces a plain config object consumed by compiler and VM.

// Const pool tags (must match bytecode.js / compiler.js)
const TAG_NULL   = 0
const TAG_BOOL   = 1
const TAG_INT64  = 2
const TAG_UINT64 = 3
const TAG_DOUBLE = 4
const TAG_STRING = 5
const TAG_BYTES  = 6

// First custom function BUILTIN ID (0–53 reserved for builtins)
const CUSTOM_ID_BASE = 64

const TYPE_TAGS = {
  int:    TAG_INT64,
  uint:   TAG_UINT64,
  double: TAG_DOUBLE,
  string: TAG_STRING,
  bool:   TAG_BOOL,
  bytes:  TAG_BYTES,
  null:   TAG_NULL,
}

export class Environment {
  constructor() {
    this._constants = new Map()       // name → {tag, value}
    this._functions = new Map()       // name → {id, impl, arity}
    this._methods = new Map()         // name → {id, impl, arity}
    this._declaredVars = null         // null = permissive; Map = strict
    this._nextCustomId = CUSTOM_ID_BASE
  }

  /**
   * Register a compile-time constant.
   * @param {string} name
   * @param {string} type - one of: int, uint, double, string, bool, bytes, null
   * @param {*} value
   * @returns {this}
   */
  registerConstant(name, type, value) {
    if (this._constants.has(name) || (this._functions.has(name))) {
      throw new Error(`'${name}' is already registered`)
    }
    const tag = TYPE_TAGS[type]
    if (tag === undefined) throw new Error(`Unknown constant type: '${type}'`)
    this._constants.set(name, { tag, value })
    return this
  }

  /**
   * Produce a plain config object for compiler and VM consumption.
   * @returns {{ constants, customFunctions, customMethods, declaredVars, functionTable }}
   */
  toConfig() {
    // Build ordered function table (array indexed by id - CUSTOM_ID_BASE)
    const functionTable = new Array(this._nextCustomId - CUSTOM_ID_BASE)
    for (const { id, impl } of this._functions.values()) {
      functionTable[id - CUSTOM_ID_BASE] = impl
    }
    for (const { id, impl } of this._methods.values()) {
      functionTable[id - CUSTOM_ID_BASE] = impl
    }

    return {
      constants: new Map(this._constants),
      customFunctions: new Map(this._functions),
      customMethods: new Map(this._methods),
      declaredVars: this._declaredVars ? new Map(this._declaredVars) : null,
      functionTable,
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/environment.test.js`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/environment.js test/environment.test.js
git commit -m "feat(env): add Environment class with constant registration"
```

---

## Task 2: Custom Function Registration

**Files:**
- Modify: `src/environment.js`
- Test: `test/environment.test.js`

- [ ] **Step 1: Write failing tests for function registration**

Add to `test/environment.test.js`:

```javascript
describe('Custom functions', () => {
  it('registers a global function', () => {
    const env = new Environment()
    env.registerFunction('isAdult', 1, (age) => age >= 18n)
    const config = env.toConfig()
    assert.equal(config.customFunctions.size, 1)
    const fn = config.customFunctions.get('isAdult')
    assert.equal(fn.arity, 1)
    assert.equal(fn.id, 64)
    assert.equal(typeof fn.impl, 'function')
  })

  it('registers multiple functions with sequential IDs', () => {
    const env = new Environment()
      .registerFunction('foo', 1, x => x)
      .registerFunction('bar', 2, (a, b) => a + b)
    const config = env.toConfig()
    assert.equal(config.customFunctions.get('foo').id, 64)
    assert.equal(config.customFunctions.get('bar').id, 65)
  })

  it('rejects duplicate function names', () => {
    const env = new Environment()
    env.registerFunction('foo', 1, x => x)
    assert.throws(() => env.registerFunction('foo', 1, x => x), /already registered/)
  })

  it('rejects non-function impl', () => {
    const env = new Environment()
    assert.throws(() => env.registerFunction('foo', 1, 'not-a-function'), /must be a function/)
  })

  it('builds function table in correct order', () => {
    const impl1 = x => x * 2n
    const impl2 = x => x + 1n
    const env = new Environment()
      .registerFunction('double', 1, impl1)
      .registerFunction('inc', 1, impl2)
    const config = env.toConfig()
    assert.equal(config.functionTable[0], impl1)
    assert.equal(config.functionTable[1], impl2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/environment.test.js`
Expected: FAIL — `registerFunction` is not a function

- [ ] **Step 3: Add registerFunction to Environment**

Add to `src/environment.js` inside the `Environment` class:

```javascript
  /**
   * Register a custom global function.
   * @param {string} name     - function name as used in expressions
   * @param {number} arity    - number of arguments
   * @param {Function} impl   - JavaScript implementation
   * @returns {this}
   */
  registerFunction(name, arity, impl) {
    if (typeof impl !== 'function') throw new Error(`impl for '${name}' must be a function`)
    if (this._functions.has(name) || this._constants.has(name)) {
      throw new Error(`'${name}' is already registered`)
    }
    const id = this._nextCustomId++
    this._functions.set(name, { id, impl, arity })
    return this
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/environment.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/environment.js test/environment.test.js
git commit -m "feat(env): add custom function registration"
```

---

## Task 3: Custom Method Registration

**Files:**
- Modify: `src/environment.js`
- Test: `test/environment.test.js`

- [ ] **Step 1: Write failing tests for method registration**

Add to `test/environment.test.js`:

```javascript
describe('Custom methods', () => {
  it('registers a method', () => {
    const env = new Environment()
    env.registerMethod('double', 0, (receiver) => receiver + receiver)
    const config = env.toConfig()
    assert.equal(config.customMethods.size, 1)
    const m = config.customMethods.get('double')
    assert.equal(m.arity, 0) // arity excludes receiver
    assert.equal(m.id, 64)
  })

  it('functions and methods share the ID space', () => {
    const env = new Environment()
      .registerFunction('foo', 1, x => x)
      .registerMethod('bar', 0, r => r)
    const config = env.toConfig()
    assert.equal(config.customFunctions.get('foo').id, 64)
    assert.equal(config.customMethods.get('bar').id, 65)
  })

  it('methods appear in function table', () => {
    const impl = r => r
    const env = new Environment()
      .registerMethod('myMethod', 0, impl)
    const config = env.toConfig()
    assert.equal(config.functionTable[0], impl)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/environment.test.js`
Expected: FAIL — `registerMethod` is not a function

- [ ] **Step 3: Add registerMethod to Environment**

Add to `src/environment.js` inside the `Environment` class:

```javascript
  /**
   * Register a custom method (called on a receiver).
   * @param {string} name     - method name as used in expressions (e.g. 'double')
   * @param {number} arity    - number of arguments EXCLUDING the receiver
   * @param {Function} impl   - (receiver, ...args) => result
   * @returns {this}
   */
  registerMethod(name, arity, impl) {
    if (typeof impl !== 'function') throw new Error(`impl for '${name}' must be a function`)
    if (this._methods.has(name)) {
      throw new Error(`method '${name}' is already registered`)
    }
    const id = this._nextCustomId++
    this._methods.set(name, { id, impl, arity })
    return this
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/environment.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/environment.js test/environment.test.js
git commit -m "feat(env): add custom method registration"
```

---

## Task 4: Variable Declarations (Strict Mode)

**Files:**
- Modify: `src/environment.js`
- Test: `test/environment.test.js`

- [ ] **Step 1: Write failing tests for variable declarations**

Add to `test/environment.test.js`:

```javascript
describe('Variable declarations', () => {
  it('defaults to permissive mode (null declaredVars)', () => {
    const env = new Environment()
    const config = env.toConfig()
    assert.equal(config.declaredVars, null)
  })

  it('declares a variable', () => {
    const env = new Environment()
    env.registerVariable('user', 'map')
    const config = env.toConfig()
    assert.equal(config.declaredVars.size, 1)
    assert.equal(config.declaredVars.get('user'), 'map')
  })

  it('declares multiple variables', () => {
    const env = new Environment()
      .registerVariable('name', 'string')
      .registerVariable('age', 'int')
    const config = env.toConfig()
    assert.equal(config.declaredVars.size, 2)
    assert.equal(config.declaredVars.get('name'), 'string')
    assert.equal(config.declaredVars.get('age'), 'int')
  })

  it('rejects duplicate variable names', () => {
    const env = new Environment()
    env.registerVariable('x', 'int')
    assert.throws(() => env.registerVariable('x', 'string'), /already registered/)
  })

  it('constants do not count as declared vars', () => {
    const env = new Environment()
      .registerConstant('pi', 'double', 3.14)
    const config = env.toConfig()
    // No declared vars (still permissive for non-constant variables)
    assert.equal(config.declaredVars, null)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/environment.test.js`
Expected: FAIL — `registerVariable` is not a function

- [ ] **Step 3: Add registerVariable to Environment**

Add to `src/environment.js` inside the `Environment` class:

```javascript
  /**
   * Declare a variable that must exist in the activation at evaluation time.
   * Calling this at least once enables "strict mode": the compiler will reject
   * references to undeclared variables.
   * @param {string} name
   * @param {string} type - CEL type name (informational; no runtime enforcement yet)
   * @returns {this}
   */
  registerVariable(name, type) {
    if (this._declaredVars === null) this._declaredVars = new Map()
    if (this._declaredVars.has(name)) {
      throw new Error(`variable '${name}' is already registered`)
    }
    this._declaredVars.set(name, type)
    return this
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/environment.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/environment.js test/environment.test.js
git commit -m "feat(env): add variable declarations with strict mode"
```

---

## Task 5: Wire Constants Through Compiler

**Files:**
- Modify: `src/compiler.js:318-336` (Ident case)
- Modify: `src/compiler.js:203` (compile function signature)
- Test: `test/environment.test.js`

- [ ] **Step 1: Write failing integration test for constants**

Add to `test/environment.test.js`:

```javascript
import { compile, evaluate } from '../src/index.js'

describe('Environment integration — constants', () => {
  it('compiles and evaluates an expression with a constant', () => {
    const env = new Environment()
      .registerConstant('maxAge', 'int', 100n)

    const bytecode = compile('maxAge + 1', { env: env.toConfig() })
    const result = evaluate(bytecode, {})
    assert.equal(result, 101n)
  })

  it('constant takes precedence over activation variable', () => {
    const env = new Environment()
      .registerConstant('x', 'int', 42n)

    const bytecode = compile('x', { env: env.toConfig() })
    // Even if activation provides x, the constant wins (it's baked into bytecode)
    const result = evaluate(bytecode, { x: 999n })
    assert.equal(result, 42n)
  })

  it('mixes constants and variables', () => {
    const env = new Environment()
      .registerConstant('threshold', 'int', 10n)

    const bytecode = compile('score > threshold', { env: env.toConfig() })
    assert.equal(evaluate(bytecode, { score: 15n }), true)
    assert.equal(evaluate(bytecode, { score: 5n }), false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/environment.test.js`
Expected: FAIL — `compile` does not accept `env` option (constants treated as unknown variables)

- [ ] **Step 3: Modify compiler to accept env config and resolve constants**

In `src/compiler.js`, modify the `compile()` function signature at line 203:

```javascript
export function compile(ast, options = {}) {
  const { debugInfo: emitDebug = false, env = null } = options
```

Then modify the `Ident` case in `compileNode()` (around line 318). Replace the existing `case 'Ident':` block:

```javascript
      case 'Ident': {
        const { name } = node
        // Check comprehension scope first
        const comp = lookupCompVar(name)
        if (comp !== null) {
          if (comp.kind === 'iter') {
            emit(OP.LOAD_VAR, IDX_ITER_ELEM)
          } else {
            emit(OP.LOAD_VAR, IDX_ACCU)
          }
        } else if (env && env.constants.has(name)) {
          // Compile-time constant substitution
          const { tag, value } = env.constants.get(name)
          const idx = addConst(tag, value)
          emit(OP.PUSH_CONST, idx)
        } else {
          const idx = varIndex.get(name)
          if (idx === undefined) {
            throw new CompileError(`Unknown variable: '${name}'`)
          }
          emit(OP.LOAD_VAR, idx)
        }
        break
      }
```

Also modify `collectVarNames()` to exclude constants. At the top of `compile()`, after building env, modify the var collection:

```javascript
  // ── 1. Collect external variables ─────────────────────────────────────────
  const constantNames = env ? env.constants : new Map()
  const varNameSet = new Set()
  collectVarNames(ast, new Set(), varNameSet)
  // Remove constants from var table (they are compile-time substitutions)
  for (const name of constantNames.keys()) varNameSet.delete(name)
  const varTable = Array.from(varNameSet).sort()
  const varIndex = new Map(varTable.map((n, i) => [n, i]))
```

- [ ] **Step 4: Modify index.js to pass env config through to compiler**

In `src/index.js`, update the `compile()` function:

```javascript
export function compile(src, options = {}) {
  const useCache = options.cache !== false
  const cacheKey = src // Note: env changes invalidate semantics but not cache key — see Step 6
  if (useCache && !options.env && cache.has(cacheKey)) return cache.get(cacheKey)

  const tokens  = tokenize(src)
  const ast     = parse(tokens)
  const checked = check(ast)
  const program = compileAst(checked, {
    debugInfo: options.debugInfo || false,
    env: options.env || null,
  })
  const bytes   = encode(program)

  if (useCache && !options.env) cache.set(cacheKey, bytes)
  return bytes
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/environment.test.js`
Expected: All constant integration tests PASS

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `bun test`
Expected: All existing tests PASS (env defaults to null, no behavior change)

- [ ] **Step 7: Commit**

```bash
git add src/compiler.js src/index.js test/environment.test.js
git commit -m "feat(env): wire constants through compiler as compile-time substitutions"
```

---

## Task 6: Wire Custom Functions Through Compiler and VM

**Files:**
- Modify: `src/compiler.js:649-676` (compileCall)
- Modify: `src/vm.js:807` (evaluate signature + OP.CALL dispatch)
- Create: `callCustom()` function in `src/vm.js` (separate from callBuiltin)
- Modify: `src/index.js` (pass function table to evaluate)
- Test: `test/environment.test.js`

- [ ] **Step 1: Write failing integration tests for custom functions**

Add to `test/environment.test.js`:

```javascript
describe('Environment integration — custom functions', () => {
  it('calls a custom global function', () => {
    const env = new Environment()
      .registerFunction('double', 1, (x) => {
        if (typeof x === 'bigint') return x * 2n
        return x * 2
      })

    const config = env.toConfig()
    const bytecode = compile('double(21)', { env: config })
    const result = evaluate(bytecode, {}, config.functionTable)
    assert.equal(result, 42n)
  })

  it('calls a custom function with multiple args', () => {
    const env = new Environment()
      .registerFunction('add3', 3, (a, b, c) => a + b + c)

    const config = env.toConfig()
    const bytecode = compile('add3(1, 2, 3)', { env: config })
    const result = evaluate(bytecode, {}, config.functionTable)
    assert.equal(result, 6n)
  })

  it('custom function can access activation variables', () => {
    const env = new Environment()
      .registerFunction('negate', 1, (x) => -x)

    const config = env.toConfig()
    const bytecode = compile('negate(val)', { env: config })
    assert.equal(evaluate(bytecode, { val: 5n }, config.functionTable), -5n)
  })

  it('custom function combined with built-in operators', () => {
    const env = new Environment()
      .registerFunction('square', 1, (x) => x * x)

    const config = env.toConfig()
    const bytecode = compile('square(3) + square(4)', { env: config })
    assert.equal(evaluate(bytecode, {}, config.functionTable), 18n)
  })

  it('unknown function still throws CompileError', () => {
    assert.throws(() => compile('unknown(1)'), /Unknown function/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/environment.test.js`
Expected: FAIL — `CompileError: Unknown function: 'double'`

- [ ] **Step 3: Modify compileCall to fall back to custom function registry**

In `src/compiler.js`, modify `compileCall()` (around line 649). Replace the final `throw` with a custom function lookup:

```javascript
  function compileCall(node) {
    const { name, args } = node

    // size(x) → SIZE opcode
    if (name === 'size' && args.length === 1) {
      compileNode(args[0])
      emit(OP.SIZE)
      return
    }

    // Built-in type conversions / type() / timestamp() / duration()
    const builtinId = CALL_BUILTINS[name]
    if (builtinId !== undefined) {
      for (const a of args) compileNode(a)
      emit(OP.CALL, builtinId, args.length)
      return
    }

    // Math extensions: math.max(), math.min(), math.abs()
    const mathId = MATH_BUILTINS[name]
    if (mathId !== undefined) {
      for (const a of args) compileNode(a)
      emit(OP.CALL, mathId, args.length)
      return
    }

    // Custom functions from environment
    if (env && env.customFunctions.has(name)) {
      const { id, arity } = env.customFunctions.get(name)
      if (args.length !== arity) {
        throw new CompileError(`'${name}' expects ${arity} argument(s), got ${args.length}`)
      }
      for (const a of args) compileNode(a)
      emit(OP.CALL, id, args.length)
      return
    }

    throw new CompileError(`Unknown function: '${name}'`)
  }
```

- [ ] **Step 4: Add `callCustom()` function to VM (separate from `callBuiltin()`)**

In `src/vm.js`, add a new function **before** `callBuiltin()` (around line 322). This is a separate function so that `callBuiltin()` keeps its existing signature and V8 JIT profile:

```javascript
// ---------------------------------------------------------------------------
// Custom function dispatch (IDs >= 64, separate from callBuiltin for JIT)
// ---------------------------------------------------------------------------

function callCustom(id, argc, stack, sp, functionTable) {
  // Propagate error values from any argument
  for (let i = 0; i < argc; i++) {
    if (isError(stack[sp - i])) return stack[sp - i]
  }

  const fn = functionTable[id - 64]
  if (!fn) return celError(`unknown custom function id: ${id}`)

  // Fast paths for common arities (avoid Array allocation + spread)
  switch (argc) {
    case 1: return fn(stack[sp])
    case 2: return fn(stack[sp - 1], stack[sp])
    case 3: return fn(stack[sp - 2], stack[sp - 1], stack[sp])
    default: {
      const args = new Array(argc)
      for (let i = 0; i < argc; i++) args[i] = stack[sp - (argc - 1 - i)]
      return fn(...args)
    }
  }
}
```

**Do NOT modify `callBuiltin()`** — its signature and behavior stay exactly the same.

- [ ] **Step 5: Modify the `OP.CALL` dispatch case to split between builtin and custom**

In `src/vm.js`, update the `evaluate` function signature (around line 807):

```javascript
export function evaluate(program, activation, customFunctionTable) {
```

Then find the `case OP.CALL:` in the dispatch loop and replace it with a split dispatch:

```javascript
      case OP.CALL: {
        const builtinId = operands[0]
        const argc = operands[1]
        const result = builtinId >= 64
          ? callCustom(builtinId, argc, stack, sp, customFunctionTable)
          : callBuiltin(builtinId, argc, stack, sp)
        sp -= argc
        stack[++sp] = result
        break
      }
```

This keeps `callBuiltin()` monomorphic (always called with 4 args) and routes custom IDs to the separate `callCustom()` function.

- [ ] **Step 6: Update index.js to pass function table through evaluate**

In `src/index.js`, update the `evaluate` and `run` functions:

```javascript
export function evaluate(bytecode, activation, customFunctionTable) {
  const program = decode(bytecode)
  return evalProgram(program, activation || {}, customFunctionTable)
}

export function run(src, activation, options) {
  const bytecode = compile(src, options)
  const functionTable = options && options.env ? options.env.functionTable : undefined
  return evaluate(bytecode, activation || {}, functionTable)
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/environment.test.js`
Expected: All custom function tests PASS

- [ ] **Step 8: Run full test suite**

Run: `bun test`
Expected: All existing tests PASS (customFunctionTable is undefined by default)

- [ ] **Step 9: Commit**

```bash
git add src/compiler.js src/vm.js src/index.js test/environment.test.js
git commit -m "feat(env): wire custom functions through compiler and VM dispatch"
```

---

## Task 7: Wire Custom Methods Through Compiler and VM

**Files:**
- Modify: `src/compiler.js:760-769` (compileRCall)
- Test: `test/environment.test.js`

- [ ] **Step 1: Write failing integration tests for custom methods**

Add to `test/environment.test.js`:

```javascript
describe('Environment integration — custom methods', () => {
  it('calls a custom method on a string', () => {
    const env = new Environment()
      .registerMethod('reverse', 0, (receiver) => {
        if (typeof receiver !== 'string') throw new Error('reverse requires string')
        return [...receiver].reverse().join('')
      })

    const config = env.toConfig()
    const bytecode = compile('"hello".reverse()', { env: config })
    const result = evaluate(bytecode, {}, config.functionTable)
    assert.equal(result, 'olleh')
  })

  it('calls a custom method with arguments', () => {
    const env = new Environment()
      .registerMethod('repeat', 1, (receiver, n) => {
        return receiver.repeat(Number(n))
      })

    const config = env.toConfig()
    const bytecode = compile('"ab".repeat(3)', { env: config })
    const result = evaluate(bytecode, {}, config.functionTable)
    assert.equal(result, 'ababab')
  })

  it('custom method on a variable', () => {
    const env = new Environment()
      .registerMethod('double', 0, (receiver) => receiver * 2n)

    const config = env.toConfig()
    const bytecode = compile('x.double()', { env: config })
    assert.equal(evaluate(bytecode, { x: 21n }, config.functionTable), 42n)
  })

  it('built-in methods still work alongside custom methods', () => {
    const env = new Environment()
      .registerMethod('reverse', 0, (r) => [...r].reverse().join(''))

    const config = env.toConfig()
    // Built-in: contains; Custom: reverse
    const bytecode = compile('"hello".reverse().contains("oll")', { env: config })
    assert.equal(evaluate(bytecode, {}, config.functionTable), true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/environment.test.js`
Expected: FAIL — `CompileError: Unknown method: 'reverse'`

- [ ] **Step 3: Modify compileRCall to fall back to custom method registry**

In `src/compiler.js`, modify `compileRCall()`. Replace the final `throw` (around line 769):

```javascript
    // Custom methods from environment
    if (env && env.customMethods.has(method)) {
      const { id, arity } = env.customMethods.get(method)
      if (args.length !== arity) {
        throw new CompileError(`method '${method}' expects ${arity} argument(s), got ${args.length}`)
      }
      compileNode(receiver)
      for (const a of args) compileNode(a)
      emit(OP.CALL, id, args.length + 1) // +1 for receiver
      return
    }

    throw new CompileError(`Unknown method: '${method}'`)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/environment.test.js`
Expected: All custom method tests PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/compiler.js test/environment.test.js
git commit -m "feat(env): wire custom methods through compiler"
```

---

## Task 8: Variable Declaration Enforcement (Strict Mode)

**Files:**
- Modify: `src/compiler.js` (collectVarNames validation)
- Test: `test/environment.test.js`

- [ ] **Step 1: Write failing tests for strict variable checking**

Add to `test/environment.test.js`:

```javascript
import { CompileError } from '../src/index.js'

describe('Environment integration — strict variable mode', () => {
  it('allows declared variables', () => {
    const env = new Environment()
      .registerVariable('x', 'int')

    const config = env.toConfig()
    const bytecode = compile('x + 1', { env: config })
    assert.equal(evaluate(bytecode, { x: 5n }), 6n)
  })

  it('rejects undeclared variables in strict mode', () => {
    const env = new Environment()
      .registerVariable('x', 'int')

    const config = env.toConfig()
    assert.throws(
      () => compile('x + y', { env: config }),
      (err) => err instanceof CompileError && err.message.includes('y')
    )
  })

  it('permissive mode (no registerVariable calls) allows anything', () => {
    const env = new Environment()
      .registerConstant('c', 'int', 1n)

    const config = env.toConfig()
    // declaredVars is null → no checking
    const bytecode = compile('x + c', { env: config })
    assert.equal(evaluate(bytecode, { x: 2n }), 3n)
  })

  it('constants are allowed even when not declared as variables', () => {
    const env = new Environment()
      .registerVariable('x', 'int')
      .registerConstant('limit', 'int', 100n)

    const config = env.toConfig()
    // 'limit' is a constant, not a variable — should still work
    const bytecode = compile('x < limit', { env: config })
    assert.equal(evaluate(bytecode, { x: 50n }), true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/environment.test.js`
Expected: FAIL — undeclared variable `y` is not rejected

- [ ] **Step 3: Add variable declaration enforcement to compiler**

In `src/compiler.js`, after building `varTable` and `varIndex` (around line 210), add validation:

```javascript
  // ── 1b. Enforce strict variable declarations if env has declared vars ───
  if (env && env.declaredVars) {
    for (const name of varNameSet) {
      if (!env.declaredVars.has(name) && !env.constants.has(name)) {
        throw new CompileError(`Undeclared variable: '${name}'`)
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/environment.test.js`
Expected: All strict mode tests PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/compiler.js test/environment.test.js
git commit -m "feat(env): enforce variable declarations in strict mode"
```

---

## Task 9: Convenience API — `env.compile()` and `env.evaluate()`

**Files:**
- Modify: `src/environment.js`
- Modify: `src/index.js` (export Environment)
- Test: `test/environment.test.js`

- [ ] **Step 1: Write failing tests for convenience methods**

Add to `test/environment.test.js`:

```javascript
describe('Environment convenience API', () => {
  it('env.compile() + env.evaluate()', () => {
    const env = new Environment()
      .registerConstant('bonus', 'int', 10n)
      .registerFunction('double', 1, x => x * 2n)

    const bytecode = env.compile('double(score) + bonus')
    const result = env.evaluate(bytecode, { score: 5n })
    assert.equal(result, 20n)
  })

  it('env.run() convenience method', () => {
    const env = new Environment()
      .registerFunction('greet', 1, name => `Hello, ${name}!`)

    const result = env.run('greet(name)', { name: 'World' })
    assert.equal(result, 'Hello, World!')
  })

  it('env.run() with no activation', () => {
    const env = new Environment()
      .registerConstant('answer', 'int', 42n)

    assert.equal(env.run('answer'), 42n)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/environment.test.js`
Expected: FAIL — `env.compile` is not a function

- [ ] **Step 3: Add convenience methods to Environment and export it**

Add to `src/environment.js`, importing from index:

```javascript
import { compile as celCompile, evaluate as celEvaluate } from './index.js'
```

Wait — this creates a circular dependency. Instead, have Environment accept the compile/evaluate functions or import from the lower-level modules directly. Better approach: import from the pipeline modules directly.

```javascript
import { tokenize } from './lexer.js'
import { parse } from './parser.js'
import { check } from './checker.js'
import { compile as compileAst } from './compiler.js'
import { encode, decode } from './bytecode.js'
import { evaluate as evalProgram } from './vm.js'
```

Add these imports to the top of `src/environment.js`, then add methods to `Environment`:

```javascript
  /**
   * Compile a CEL expression within this environment.
   * @param {string} src
   * @param {object} [options]
   * @returns {Uint8Array}
   */
  compile(src, options = {}) {
    const config = this.toConfig()
    const tokens  = tokenize(src)
    const ast     = parse(tokens)
    const checked = check(ast)
    const program = compileAst(checked, {
      debugInfo: options.debugInfo || false,
      env: config,
    })
    return encode(program)
  }

  /**
   * Evaluate bytecode compiled within this environment.
   * @param {Uint8Array} bytecode
   * @param {object} [activation]
   * @returns {*}
   */
  evaluate(bytecode, activation) {
    const program = decode(bytecode)
    const config = this.toConfig()
    return evalProgram(program, activation || {}, config.functionTable)
  }

  /**
   * Convenience: compile + evaluate in one call.
   * @param {string} src
   * @param {object} [activation]
   * @returns {*}
   */
  run(src, activation) {
    const bytecode = this.compile(src)
    return this.evaluate(bytecode, activation)
  }
```

Then in `src/index.js`, add the export:

```javascript
export { Environment } from './environment.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/environment.test.js`
Expected: All convenience API tests PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/environment.js src/index.js test/environment.test.js
git commit -m "feat(env): add convenience compile/evaluate/run methods and export Environment"
```

---

## Task 10: Documentation

**Files:**
- Modify: `DOCS.md`
- Modify: `README.md`
- Modify: `IMPLEMENTATION.md`

- [ ] **Step 1: Read current DOCS.md, README.md, IMPLEMENTATION.md**

Read all three files to understand existing documentation structure.

- [ ] **Step 2: Add Environment API section to DOCS.md**

Add a new section documenting:
- `Environment` class
- `registerConstant(name, type, value)`
- `registerFunction(name, arity, impl)`
- `registerMethod(name, arity, impl)`
- `registerVariable(name, type)`
- `env.compile(src)` / `env.evaluate(bytecode, activation)` / `env.run(src, activation)`
- `toConfig()` for low-level use with `compile()` and `evaluate()`
- Usage examples

- [ ] **Step 3: Add Environment mention to README.md**

Add a brief example in the README showing the environment API.

- [ ] **Step 4: Update IMPLEMENTATION.md**

Document:
- Custom function ID scheme (64+ range)
- Constants as compile-time substitutions
- Strict variable mode
- Function table passed to VM alongside activation

- [ ] **Step 5: Commit**

```bash
git add DOCS.md README.md IMPLEMENTATION.md
git commit -m "docs: add Environment API documentation"
```

---

## Task 11: End-to-End Integration Test

**Files:**
- Test: `test/environment.test.js`

- [ ] **Step 1: Write comprehensive end-to-end test**

Add to `test/environment.test.js`:

```javascript
describe('Environment — end-to-end', () => {
  it('real-world use case: authorization policy', () => {
    const env = new Environment()
      .registerVariable('user', 'map')
      .registerVariable('resource', 'map')
      .registerConstant('minAge', 'int', 18n)
      .registerFunction('hasRole', 2, (user, role) => {
        if (!user || !Array.isArray(user.roles)) return false
        return user.roles.includes(role)
      })

    const policy = 'user.age >= minAge && hasRole(user, "admin")'
    const bytecode = env.compile(policy)

    const allowed = env.evaluate(bytecode, {
      user: { age: 25n, roles: ['admin', 'user'] },
      resource: { type: 'document' },
    })
    assert.equal(allowed, true)

    const denied = env.evaluate(bytecode, {
      user: { age: 16n, roles: ['user'] },
      resource: { type: 'document' },
    })
    assert.equal(denied, false)
  })

  it('real-world use case: string formatting with custom methods', () => {
    const env = new Environment()
      .registerMethod('titleCase', 0, (s) => {
        return s.replace(/\b\w/g, c => c.toUpperCase())
      })

    assert.equal(
      env.run('"hello world".titleCase()', {}),
      'Hello World'
    )
  })

  it('real-world use case: math extensions', () => {
    const env = new Environment()
      .registerFunction('clamp', 3, (val, lo, hi) => {
        if (val < lo) return lo
        if (val > hi) return hi
        return val
      })

    assert.equal(env.run('clamp(x, 0, 100)', { x: 150n }), 100n)
    assert.equal(env.run('clamp(x, 0, 100)', { x: -5n }), 0n)
    assert.equal(env.run('clamp(x, 0, 100)', { x: 50n }), 50n)
  })

  it('bytecode portability: same bytecode, different activations', () => {
    const env = new Environment()
      .registerFunction('prefix', 2, (s, p) => p + s)

    const bytecode = env.compile('prefix(name, "Dr. ")')
    assert.equal(env.evaluate(bytecode, { name: 'Smith' }), 'Dr. Smith')
    assert.equal(env.evaluate(bytecode, { name: 'Jones' }), 'Dr. Jones')
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test test/environment.test.js`
Expected: All end-to-end tests PASS

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add test/environment.test.js
git commit -m "test(env): add end-to-end integration tests for Environment API"
```

---

## Out of Scope (Future Work)

These features are intentionally excluded from this plan. They can be addressed in future iterations:

1. **Type-safe function signatures** (e.g., `'isAdult(int): bool'` string parsing) — cel-js does this, but it adds complexity for marginal benefit in a dynamically-typed JS runtime. Our approach uses explicit arity + runtime duck-typing.

2. **Custom operator overloading** (e.g., `registerOperator('string * int', ...)`) — requires parser changes to recognize new operator/type combinations. Significant complexity.

3. **Custom type registration** (e.g., `registerType('User', { fields: ... })`) — requires field resolution in `celSelect()` and type-aware checking. Can be built on top of the function/method infrastructure.

4. **Async custom functions** — would require making the VM loop async, which kills performance. Better handled by pre-resolving async values before evaluation.

5. **Environment inheritance / composition** — `env.extend()` to create child environments. Useful but not essential for v1.

6. **Bytecode cache keying by environment** — currently, caching is disabled when env is provided. Could hash the env config for cache keying.
