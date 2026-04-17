---
title: "perf: Pool evaluate() stack + uintFlags buffers across calls"
type: perf
status: active
date: 2026-04-17
---

# perf: Pool evaluate() stack + uintFlags buffers across calls

## Overview

Eliminate two per-call allocations inside the VM `evaluate()` hot path — `new Array(256)` and `new Uint8Array(256)` at `src/vm.js:1088-1089` — by reusing module-scoped buffers across calls. Re-entrant calls (custom functions that call back into `evaluate()`) fall back to fresh allocations to preserve correctness.

This is a natural successor to the recently-landed "Flatten VM dispatch to typed arrays" refactor (see `docs/plans/2026-04-17-001-refactor-flatten-vm-dispatch-typed-arrays-plan.md`, commit `389d4b4`) — that change eliminated per-instruction allocations; this one eliminates per-evaluation allocations.

## Problem Statement

Every call to `evaluate(program, activation, customFunctionTable)` in `src/vm.js:1078` allocates:

```js
// src/vm.js:1082-1089
const vars = new Array(varTable.length)           // 1 — size is program-specific
for (let i = 0; i < varTable.length; i++) { ... } // populate
const stack = new Array(256)                      // 2 — holey, oversized
const uintFlags = new Uint8Array(256)             // 3 — zero-inits 256 bytes
```

Two of these (`stack`, `uintFlags`) are fixed-size and independent of the program. For a typical program using 2–8 stack slots over a ~10-instruction bytecode, the allocation + zero-init cost of the two buffers is a meaningful fraction of `evaluate()`'s total time.

Measured cost (rough order of magnitude):
- `new Array(256)`: allocates a JS `Array` header + backing store (~2 KB of slot pointers). V8 creates a *holey* array initially (`HOLEY_ELEMENTS`) which is the worst-performing element kind.
- `new Uint8Array(256)`: allocates a typed-array wrapper + 256-byte ArrayBuffer, zero-initialised.
- Per-call GC pressure on a 100k-iteration benchmark loop compounds into observable variance.

The project's core value proposition per `CLAUDE.md` is "5–15× faster than tree-walker interpreters on repeated evaluation". Repeated evaluation is precisely the path that pays this cost, N times.

### Secondary concerns

- **Holey vs packed element kind**: `new Array(256)` starts holey; overwrites via `stack[++sp] = v` keep V8 at `HOLEY_ELEMENTS`. A pooled stack that has been written through all 256 slots once will stabilise at `HOLEY_ELEMENTS` forever after — no improvement from pooling *alone*, but the pooling lets us apply a pack-once optimisation at module load (see Proposed Solution).
- **GC retention via stale stack slots**: if we reuse the stack, references from a prior evaluation linger at indices above the current `sp`, pinning large objects. Need explicit cleanup.
- **`uintFlags` zero-semantics**: the current code relies on `new Uint8Array` giving fresh zeros every call. Opcodes like `LOAD_VAR` (`src/vm.js:1114-1125`) do **not** explicitly set `uintFlags[sp]`; they depend on the slot already being `0`. Reusing the buffer without resetting it breaks this invariant and produces silent type-tag corruption.

## Proposed Solution

Introduce module-scoped pooled buffers with a re-entrancy-safe checkout/return protocol:

```js
// src/vm.js — module top, near other module constants
const STACK_INITIAL_CAPACITY = 64   // covers vast majority of real programs
let pooledStack = new Array(STACK_INITIAL_CAPACITY)
let pooledUintFlags = new Uint8Array(STACK_INITIAL_CAPACITY)
// Pack the stack: force V8 to PACKED_ELEMENTS by filling with undefined via push.
// (Assigning to a holey array keeps it holey; pushing to a length-0 array keeps
// it packed. See `poolInit()` helper.)
for (let i = 0; i < STACK_INITIAL_CAPACITY; i++) pooledStack[i] = undefined
let pooledInUse = false
```

Inside `evaluate()`:

```js
let stack, uintFlags
const usedPool = !pooledInUse
if (usedPool) {
  pooledInUse = true
  stack = pooledStack
  uintFlags = pooledUintFlags
  // Zero only the portion of uintFlags that could have stale bits.
  // High-water mark from previous call is tracked in `lastHighWater`.
  uintFlags.fill(0, 0, lastHighWater + 1)
} else {
  // Re-entrant call (custom function called evaluate again). Fall back.
  stack = new Array(STACK_INITIAL_CAPACITY)
  uintFlags = new Uint8Array(STACK_INITIAL_CAPACITY)
}

let highWater = -1  // track for slot clearing + next-call uintFlags reset

try {
  // ... existing dispatch loop, with `sp > highWater && (highWater = sp)`
  //     inserted at every `++sp` site (or computed once at end)
  // ... existing dispatch loop body
} finally {
  if (usedPool) {
    // Clear slot references to avoid GC retention.
    for (let i = 0; i <= highWater; i++) stack[i] = undefined
    lastHighWater = highWater
    pooledInUse = false
  }
}
```

### Key design choices

1. **Buffer size**: start at `STACK_INITIAL_CAPACITY = 64` (not 16, not 256). Rationale:
   - 16 is too small; plausible CEL programs with nested comprehensions hit 20–30 depth.
   - 256 is the current size — keeping it wastes memory but avoids growth logic entirely.
   - 64 covers near-100% of real programs based on typical CEL usage (nested `filter`/`map`/`exists` + arithmetic). A one-time grow on the rare deep program is acceptable.
   - **Verify empirically**: instrument `evaluate()` during `bun test` and `bun run bench/compare.js` to measure actual high-water marks. If any test exceeds 64, adjust before landing.

2. **Growth policy (out of hot loop)**: the compiler does not currently track max stack depth. Adding *inline* bounds checks at every `++sp` site would regress the hot path — unacceptable per `CLAUDE.md`. Two acceptable approaches, in priority order:

   **Approach A — Compile-time max depth (preferred, slightly larger scope)**:
   Add max-depth computation in `src/compiler.js` via a simple abstract-interpretation pass over emitted opcodes (each opcode has a known stack delta). Store on the compiled program metadata; `decode()` exposes it as `program.maxStack`. At `evaluate()` entry, grow pooled buffer once if `maxStack > stack.length`:

   ```js
   if (program.maxStack > pooledStack.length) {
     pooledStack = growArray(pooledStack, program.maxStack)
     pooledUintFlags = growTyped(pooledUintFlags, program.maxStack)
   }
   ```

   No per-instruction overhead. Bytecode format changes: add a `maxStack: u16` field to the program header.

   **Approach B — Runtime grow with no compile-time info (simpler, narrower)**:
   Keep a soft ceiling (e.g. 256) and never grow. Throw `EvaluationError` on overflow — same failure mode as today (today we get a `stack[256]` write that silently extends the array and then V8 deopts). Strictly this is *worse* than today for pathological programs, so if we take this path, enforce a size and error cleanly:

   ```js
   if (sp + 1 >= stack.length) {
     throw new EvaluationError('stack overflow (>256 slots)')
   }
   ```

   Per `CLAUDE.md` rule-of-thumb — we should not degrade the hot path. Adding this check at every push is not viable. Instead, compute an *upper bound* once at `evaluate()` entry from `opcodes.length` (stack depth ≤ instruction count) and grow once if needed — zero hot-path cost.

   **Recommendation**: ship with Approach B's upper-bound heuristic (`Math.min(256, opcodes.length)` at entry) for minimum scope, with a TODO to add Approach A's compile-time analysis as a follow-up. This also removes the hardcoded 256 ceiling that exists silently today.

3. **Re-entrancy safety**: `customFunctionTable` entries are arbitrary user JS functions invoked synchronously from `OP.CALL` (`src/vm.js:1371-1380` via `callCustom` at `src/vm.js:392-411`). Those functions can legally call any public API, including `evaluate()` or `env.evaluate()` again. The `pooledInUse` flag detects this and falls back to fresh allocation — preserving correctness with zero complexity in the steady state. The slow path exists only for re-entrant calls, which are rare by construction.

4. **Packed element kind**: fill the pooled `stack` at module-init time with `undefined` via indexed assignment. V8's classification after this fill is implementation-dependent; the goal is to document the intent and verify with a microbench. Even if V8 leaves it as `HOLEY_ELEMENTS`, the dispatch loop's existing usage pattern is monomorphic, so this is a latent optimisation more than a guaranteed win.

5. **`uintFlags` reset**: use `uintFlags.fill(0, 0, lastHighWater + 1)` — typed-array `fill` is a C++ memset in V8/Bun. Cost ≈ 50 ns for a 64-byte fill vs. `new Uint8Array(64)` which also zeros but additionally allocates a heap object and ArrayBuffer descriptor. Net: pooled path is strictly faster.

6. **Stack slot clearing**: explicit `stack[i] = undefined` for `i ∈ [0, highWater]` in a `finally` block prevents GC retention of prior-evaluation objects. High-water tracking avoids clearing slots we never used. Cost is O(highWater), typically ≤ 10 writes. The `finally` ensures cleanup even if a builtin throws.

### What does NOT change

- Public API (`evaluate`, `evaluateDebug`, `Environment.evaluate`) — same signatures, same return values, same error semantics.
- Bytecode binary format — no version bump, no new fields (Approach B).
- Hot-loop dispatch — no new checks per instruction.
- `vars` activation array (`src/vm.js:1082`) — program-specific size; pooling is harder and gains are smaller. Out of scope.
- `accu` / `iterElem` registers — already per-call locals, no allocation.

## Technical Considerations

### Performance (compile-time)

- **Zero impact** under Approach B (no compiler changes).
- Under Approach A (follow-up), a single linear pass over emitted opcodes to compute max depth — negligible (<1 ms per compile even on large programs). Compilation is a cold path.

### Performance (run-time)

Expected wins on `bun run bench/compare.js` "Evaluate only" row:
- Eliminates two allocations per call.
- Eliminates 256-byte memset per call (`Uint8Array` zero-init).
- Potentially moves stack to `PACKED_ELEMENTS` (TBD, bench-confirm).

Conservative estimate: **3–8% speedup** on the evaluate-only hot loop, scaling inversely with program length (shorter programs gain more because allocation overhead is a larger fraction).

Must-not-regress:
- Compile+Evaluate row (cache-miss path) — should be unchanged.
- Long-running programs (many instructions) — allocation amortises, speedup will be smaller; must not go negative.

### Security / correctness

- **Re-entrancy corruption**: primary correctness hazard. Mitigated by `pooledInUse` flag. Test: register a custom function that calls `env.evaluate()` on a nested expression; assert both outer and inner produce correct results.
- **GC retention via stack slots**: mitigated by `finally` clear loop.
- **`uintFlags` staleness**: mitigated by `fill(0, 0, lastHighWater + 1)` at entry. Alternative considered (audit every opcode to set the flag) rejected: too invasive, easy to miss one opcode, and the memset is cheap.
- **Partial failure mid-evaluation**: if a builtin throws, `finally` still runs, buffer is returned to pool, next call works correctly. Verified by existing tests that exercise error paths (`test/marcbachmann/errors.test.js` or similar).

### Memory

- **Pinned**: `STACK_INITIAL_CAPACITY * (8 + 1) ≈ 576 bytes` per module (effectively permanent). Trivial.
- **Peak during re-entrant calls**: same as today (fresh allocation per re-entry).

### Compatibility

No API, bytecode format, or serialisation changes. Existing base64 bytecodes continue to work. No TypeScript declaration updates needed.

## System-Wide Impact

- **Interaction graph**: `cel.evaluate()` → `evalProgram()` (`src/index.js:80`) → `evaluate()` in `src/vm.js`. Same path from `Environment.evaluate()` (`src/environment.js:202-207`). No middleware/callback chains; `callCustom` is the only external-code entry point and is handled explicitly.
- **Error propagation**: unchanged — errors thrown inside the dispatch loop still bubble to the caller; `finally` ensures pool release on throw.
- **State lifecycle risks**: the `pooledInUse` flag IS shared module state. A bug that leaves it set (e.g., missing `finally`) would force all subsequent calls onto the slow allocation path — a perf bug, not a correctness bug. Mitigation: use `try/finally`, never manual release. Also consider a `pooledGeneration` counter for debugging.
- **API surface parity**: `evaluate` (fast path) and `evaluateDebug` (wrapper at `src/vm.js:1582-1597`) both benefit automatically — debug path calls the same `evaluate()` internally.
- **Integration test scenarios**: see Testing below.

## Acceptance Criteria

### Functional

- [ ] All existing tests pass unchanged: `bun test` green, same pass count as baseline.
- [ ] New test: custom function calls back into `evaluate()` from inside its body; both evaluations return correct results with no cross-contamination.
- [ ] New test: custom function that throws mid-evaluation — next `evaluate()` call still works (pool released via `finally`).
- [ ] New test: stack slots are cleared after evaluate returns (can assert by registering a custom fn that captures a large sentinel object, evaluating, then checking weak-ref or heap snapshot — or simply verifying `stack[highWater] === undefined` via a test-only export).

### Performance

- [ ] `bun run bench/compare.js` "Evaluate only" row is ≥ baseline (no regression).
- [ ] Median speedup on short-expression benchmarks (`a + b`, `x > 5`, etc.) ≥ 3%.
- [ ] Compile+Evaluate row unchanged within noise (±2%).

### Quality

- [ ] No new lint warnings.
- [ ] `src/vm.js` line count change: ≤ +40 net.
- [ ] Documentation: update `IMPLEMENTATION.md` section on VM if it describes allocation behaviour.

## Success Metrics

- **Primary**: ≥ 3% speedup on `bench/compare.js` evaluate-only row for short expressions (where allocation overhead dominates).
- **Secondary**: reduced GC allocation count per 100k evaluations (observable via `--inspect` heap profile or Bun's `Bun.gc(true)` + counters).

## Dependencies & Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Missed re-entrancy path corrupts shared stack | Medium | `pooledInUse` flag; explicit test with custom-fn re-entry |
| Stale `uintFlags` causes wrong uint semantics | Medium-High if not handled | `fill(0, 0, highWater + 1)` at entry; high-water mark tracking |
| GC retention via stack slots bloats heap | Low | Explicit `undefined` clear loop in `finally` |
| Pool lock leak (inUse stuck `true`) after a throw | Low | `try/finally` releases unconditionally |
| Measured win is within noise (no benefit) | Medium | Bench before/after per CLAUDE.md; if < 1%, abandon or fold into Approach A follow-up |
| V8 deopts on reshaped pooled array | Low | Pre-fill at module init; confirm element-kind stability empirically |

## Alternative Approaches Considered

1. **Allocate smaller buffers per-call (e.g., 16 instead of 256)** — less zeroing but still allocates. Half-win. Also risks overflow on deeper programs without the compile-time analysis.
2. **Move stack to a `Float64Array` or `BigInt64Array`** — rejected; stack holds heterogeneous values (strings, objects, bigints, optionals). Typed arrays force numeric-only.
3. **Thread-local / per-Environment pool** — `Environment` already exists as a natural scope. Could attach pool to each `Environment` instance (`src/environment.js`). Benefit: handles re-entrancy naturally if each nested call uses a different `Environment`. Cost: doesn't help the direct `cel.evaluate()` API (module-level call), still need a fallback. Decision: start with module-level pool; reconsider if re-entrancy via custom functions is common.
4. **Compile-time max-stack in bytecode (Approach A above)** — strictly better than the upper-bound heuristic but adds compiler + bytecode format scope. Defer to a follow-up plan once this one lands cleanly.
5. **Audit every opcode to set `uintFlags` explicitly** — rejected as invasive; each of ~40 opcodes would need review, risk of missing one is high, and the net cost of `memset(0, n)` is lower than a branch per PUSH.

## Testing Plan

### Unit tests (new)

Add to a new `test/vm-pool.test.js`:

1. **Re-entrancy correctness**:
   ```js
   const env = cel.environment({
     functions: {
       inner: () => cel.evaluate(cel.compile('1 + 2'), {})
     }
   })
   assert.equal(env.evaluate('inner() + 10', {}), 13)
   ```

2. **Error path releases pool**: custom fn throws; subsequent `evaluate()` works and produces correct result.

3. **Stack clearing**: after evaluation with a large-object intermediate, no reference retained (use a `WeakRef` + forced GC via `Bun.gc(true)`).

4. **Deep stack**: a synthetic expression with stack depth > `STACK_INITIAL_CAPACITY` (if Approach A lands) grows the pool correctly.

### Regression tests

- Full run of `test/cel-spec/**` — broadest conformance coverage.
- `test/marcbachmann/macros.test.js` — deep comprehension stacks.
- `test/environment.test.js` — custom function paths (critical per research findings).

### Performance verification

- **Baseline**: `git stash && bun run bench/compare.js > bench-before.txt`
- **After**: `git stash pop && bun run bench/compare.js > bench-after.txt`
- Compare both "Evaluate only" and "Compile+Evaluate" rows.
- Record deltas in the PR description.

## Implementation Sketch (not code — structural only)

### `src/vm.js` changes

```js
// Near top, after imports — module state
const STACK_INITIAL_CAPACITY = 64
let pooledStack = (() => {
  const a = new Array(STACK_INITIAL_CAPACITY)
  for (let i = 0; i < STACK_INITIAL_CAPACITY; i++) a[i] = undefined
  return a
})()
let pooledUintFlags = new Uint8Array(STACK_INITIAL_CAPACITY)
let pooledInUse = false
let lastHighWater = -1  // tracks max sp from last pooled use

// Inside evaluate(), replace lines 1088-1089
// ... (see Proposed Solution above)
```

### Files touched

| File | Change |
|------|--------|
| `src/vm.js` | Add module-scoped pool, refactor `evaluate()` head/tail to check out/return, track `highWater` inside dispatch loop |
| `test/vm-pool.test.js` | New test file covering re-entrancy, error paths, stack clearing |
| `IMPLEMENTATION.md` | Update VM section if it describes allocation |

### Files NOT touched

- `src/compiler.js`, `src/bytecode.js` — bytecode format unchanged (Approach B).
- `src/index.js`, `src/environment.js` — public API unchanged.
- Existing tests — all continue to pass unchanged.

## Sources & References

### Origin / prior work (internal)

- `docs/plans/2026-04-17-001-refactor-flatten-vm-dispatch-typed-arrays-plan.md` — landed in commit `389d4b4`. Established the pattern of V8-JIT-friendly VM optimisations; this plan is the allocation-side counterpart.
- `docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md` — lines 132-142 explicitly list allocation avoidance as a Phase-2 goal.
- `docs/plans/2026-04-08-003-feat-timezone-aware-timestamp-accessors-plan.md:68` — precedent for module-scoped caches persisting across evaluations.

### Code references

- `src/vm.js:1078` — `evaluate()` entry point.
- `src/vm.js:1088-1089` — target lines for this optimisation.
- `src/vm.js:1110, 1180, 1186, 1208, 1236` — `uintFlags` write sites.
- `src/vm.js:1114-1125` — `LOAD_VAR` (does NOT explicitly set `uintFlags[sp]`; relies on zero-init).
- `src/vm.js:392-411` — `callCustom` (re-entrancy entry point).
- `src/vm.js:1371-1380` — `OP.CALL` handler.
- `src/environment.js:202-207` — `Environment.evaluate`.
- `bench/compare.js` — performance verification harness.

### Project rules

- `CLAUDE.md` — "Performance analysis required: analyse impact on both compile-time and run-time. Run `bun run bench/compare.js` before and after."
- `CLAUDE.md` — "VM is a plain function, not a class, for V8 JIT." Pool sits alongside this constraint.
