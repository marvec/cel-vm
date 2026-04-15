---
title: "fix: eliminate redundant bytecode decode on every evaluate() call"
type: fix
status: active
date: 2026-04-16
---

# fix: eliminate redundant bytecode decode on every evaluate() call

## Overview

Every call to `evaluate()` re-decodes the binary `Uint8Array` bytecode into a program object via `decode()`. This is the dominant bottleneck: measured at 940K ops/sec vs 4.4M ops/sec when decode is bypassed (4.6x overhead). The fix is to cache or avoid the redundant decode, closing ~two-thirds of the gap with cel-js.

## Problem Statement

`decode()` (`src/bytecode.js:338`) is expensive per-call:
- Adler-32 checksum over every byte
- Header parsing
- Constant pool reconstruction: allocates `{tag, value}` objects, runs `TextDecoder.decode()` for every string, `BigInt64` reads for ints
- Variable name table reconstruction (more `TextDecoder` calls)
- Instruction array: allocates `{op, operands: [...]}` for every instruction

**Affected call sites (all re-decode on every invocation):**

| Call site | File | Line |
|-----------|------|------|
| `evaluate(bytecode, activation, fnTable)` | `src/index.js` | 67-70 |
| `env.evaluate(bytecode, activation)` | `src/environment.js` | 190-195 |
| `program(src)` closure → calls `evaluate()` | `src/index.js` | 82-86 |
| `env.program(src)` closure → calls `env.evaluate()` | `src/environment.js` | 203-206 |
| `run(src, activation)` → calls `evaluate()` | `src/index.js` | 96-100 |
| `env.run(src, activation)` → calls `env.evaluate()` | `src/environment.js` | 214-217 |

**Measurements** (expression: `inputType == 'recoverable' ? 0.0 : amount * weight / 100.0`):

| Path | ops/sec |
|------|---------|
| Current public `evaluate(bc, act, fnTable)` | 940K |
| Decode-once + `vm.evaluate(program, act, fnTable)` | 4.4M |
| `decode(bc)` alone | 1.4M |
| cel-js baseline | ~12M |

## Proposed Solution

Two-phase approach: **Phase 1** (this plan, 1.0.4) caches the decode; **Phase 2** (future, 1.1.0) flattens the VM instruction format for further gains.

### Phase 1: Decode Caching (1.0.4)

**Strategy: `WeakMap` decode cache + direct VM calls in `program()` closures.**

This approach is non-breaking. `compile()` continues to return `Uint8Array`. No public API signature changes. No TypeScript declaration changes required.

#### 1a. WeakMap decode cache for `evaluate()`

Add a module-level `WeakMap<Uint8Array, DecodedProgram>` in `src/index.js`. Replace `decode(bytecode)` with a `cachedDecode(bytecode)` that checks the WeakMap first.

**Why WeakMap works here:** `compile()` already caches `Uint8Array` instances by source string (`src/index.js:28`). When the same source is compiled twice, the same `Uint8Array` reference is returned (cache hit). So the WeakMap will hit on the identity check. When the `Uint8Array` is GC'd, the decoded program is too — no memory leak.

**Where `WeakMap` does NOT help:** If a consumer calls `fromBase64(b64)` repeatedly with the same Base64 string, each call creates a new `Uint8Array` instance. The WeakMap will miss every time. This is acceptable — the `program()` path (which is the recommended hot-path API) is fixed separately, and `fromBase64` consumers who need performance should hold a reference.

```js
// src/index.js — ~10 lines added
const decodeCache = new WeakMap()

function cachedDecode(bytecode) {
  let program = decodeCache.get(bytecode)
  if (!program) {
    program = decode(bytecode)
    decodeCache.set(bytecode, program)
  }
  return program
}

export function evaluate(bytecode, activation, customFunctionTable) {
  const program = cachedDecode(bytecode)        // ← changed from decode()
  return evalProgram(program, activation || {}, customFunctionTable)
}
```

#### 1b. Direct VM calls in `program()` closures

`program()` and `env.program()` should decode once at creation time and close over the decoded form, calling the VM's `evaluate()` directly. This completely eliminates decode from the hot path for the callable API.

```js
// src/index.js
export function program(src, options = {}) {
  const bytecode = compile(src, options)
  const decoded = decode(bytecode)                // decode once
  const functionTable = options.env ? options.env.functionTable : undefined
  return (activation) => evalProgram(decoded, activation || {}, functionTable)  // VM direct
}
```

```js
// src/environment.js
program(src, options) {
  const bytecode = this.compile(src, options)
  const decoded = decode(bytecode)                // decode once
  const config = this.toConfig()
  const evalFn = this._debug ? evalProgramDebug : evalProgram
  return (activation) => evalFn(decoded, activation || {}, config.functionTable)  // VM direct
}
```

#### 1c. Environment `evaluate()` — same WeakMap pattern

```js
// src/environment.js
const decodeCache = new WeakMap()

function cachedDecode(bytecode) {
  let program = decodeCache.get(bytecode)
  if (!program) {
    program = decode(bytecode)
    decodeCache.set(bytecode, program)
  }
  return program
}

evaluate(bytecode, activation) {
  const program = cachedDecode(bytecode)          // ← changed from decode()
  const config = this.toConfig()
  const evalFn = this._debug ? evalProgramDebug : evalProgram
  return evalFn(program, activation || {}, config.functionTable)
}
```

#### 1d. `run()` benefits automatically

Both `run()` (`src/index.js:96`) and `env.run()` (`src/environment.js:214`) call `evaluate()` internally. They get the WeakMap cache for free — `compile()` returns a cached `Uint8Array` reference, so the second `run()` with the same expression will hit both the compilation cache and the decode cache.

### Phase 2: VM-Level Optimizations (1.1.0 — future, not this PR)

Once decode is out of the hot path, these become the next targets:

1. **Flat instruction encoding.** Replace `Array<{op, operands}>` with parallel typed arrays (`Uint8Array` for opcodes, `Int32Array` for operands). Eliminates property lookups and array allocations in the inner loop. This is where cel-js's advantage comes from.

2. **Tagless constant pool.** Store `consts` as `Array<any>` since the opcode already encodes the type (`LOAD_INT64`, `LOAD_DOUBLE`, etc.). Skip the `{tag, value}` wrapper.

3. **Activation lookup optimization.** The `vars[i] = activation[varTable[i]]` loop runs once per evaluate. For repeated evaluation, the key-to-index resolution is already done at compile time. Ensure activations use `Object.create(null)` to avoid prototype walks.

4. **Monomorphic dispatch.** Verify all call sites pass consistent object shapes to `evaluate(program, activation, fnTable)` so V8 keeps the call mono.

## Technical Considerations

- **No public API changes.** `compile()` still returns `Uint8Array`. `evaluate()` still accepts `Uint8Array`. TypeScript declarations (`src/index.d.ts`) unchanged.
- **Memory.** WeakMap entries are GC'd when the `Uint8Array` key is collected. `program()` closures hold a strong reference to the decoded program for as long as the closure lives — this is intentional and matches the expected lifetime.
- **Thread safety.** JavaScript is single-threaded. No concerns. Workers would need their own compile/evaluate calls anyway since decoded programs contain mutable JS objects.
- **Cache invalidation.** The `Environment._invalidate()` method (`src/environment.js:154`) clears `_cache` (the compilation cache). It should also clear the decode WeakMap entries indirectly — when `_cache` is cleared, the old `Uint8Array` references are released, so the WeakMap entries become eligible for GC. No explicit invalidation needed.

## Acceptance Criteria

- [ ] `evaluate(bytecode, activation)` does not call `decode()` when the same `bytecode` reference is passed more than once (`src/index.js`)
- [ ] `env.evaluate(bytecode, activation)` has the same caching behavior (`src/environment.js`)
- [ ] `program(src)` closure calls the VM directly without going through `decode()` or the public `evaluate()` (`src/index.js`)
- [ ] `env.program(src)` closure calls the VM directly (`src/environment.js`)
- [ ] All existing tests pass (`bun test`)
- [ ] Benchmark shows measurable improvement (`bun run bench/compare.js`)
- [ ] `fromBase64()` → `evaluate()` path still works (fallback decode on WeakMap miss)
- [ ] `toBase64(compile(src))` still works (compile still returns `Uint8Array`)
- [ ] `Environment._invalidate()` does not leave stale decode cache entries that cause incorrect evaluation after re-registration

## Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| `evaluate()` repeated call | 940K ops/sec | >4M ops/sec |
| `program()` closure call | ~940K ops/sec | >4M ops/sec |
| Benchmark regression on any case | — | 0 regressions |

## Dependencies & Risks

- **Low risk.** The change is additive (WeakMap cache) and substitutive (program() closure). No data structures change. No public API changes.
- **One subtle risk:** If the VM's `evaluate()` mutates the `program` object (e.g., modifying `instrs` or `consts` in place), caching the decoded program would produce incorrect results on subsequent calls. **Mitigation:** Verify the VM's dispatch loop (`src/vm.js:1078+`) is read-only on the program object. From reading the code, it destructures `{ consts, varTable, instrs }` and only reads from them — no mutation observed.

## Implementation

### Files to modify

| File | Change |
|------|--------|
| `src/index.js` | Add `decodeCache` WeakMap, `cachedDecode()` helper. Update `evaluate()` to use it. Update `program()` to decode once and close over decoded form. |
| `src/environment.js` | Add `decodeCache` WeakMap, `cachedDecode()` helper. Update `evaluate()` to use it. Update `program()` to decode once and close over decoded form. |
| `bench/compare.js` | Add a benchmark case that isolates decode cost: raw `Uint8Array` evaluate vs `program()` closure. |
| `IMPLEMENTATION.md` | Document the decode caching strategy. |
| `DOCS.md` | Note that `program()` is the recommended API for repeated evaluation. |

### Files unchanged

| File | Reason |
|------|--------|
| `src/index.d.ts` | No public API changes |
| `src/bytecode.js` | `decode()` unchanged; caching is external |
| `src/vm.js` | VM dispatch unchanged (Phase 2 target) |
| `src/compiler.js` | No changes |

## Sources & References

- User-provided performance analysis with isolated decode/VM measurements
- `src/index.js:67-70` — standalone `evaluate()` re-decode
- `src/environment.js:190-195` — Environment `evaluate()` re-decode
- `src/bytecode.js:338-449` — full `decode()` function
- `src/vm.js:1078` — VM `evaluate()` entry point (accepts decoded program)
- `bench/compare.js` — existing benchmark infrastructure
