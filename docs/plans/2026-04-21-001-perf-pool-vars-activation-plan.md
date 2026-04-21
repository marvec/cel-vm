---
title: "perf: Pool vars activation array in evaluate() hot path"
type: perf
status: completed
date: 2026-04-21
---

# perf: Pool vars activation array in evaluate() hot path

## Enhancement Summary

**Deepened on:** 2026-04-21
**Research inputs:** performance oracle, architecture strategist, simplicity reviewer, pattern-recognition, best-practices (V8 element kinds), git-history (commits `3e1ec1e`, `9c6860c`, `389d4b4`, `54949fe`).

### Material corrections to the original draft

1. **Drop `Object.freeze([])` on `EMPTY_VARS`** — freezing transitions the array to `PACKED_FROZEN_ELEMENTS` (V8 6.5+). Mixing frozen and non-frozen arrays at the same `LOAD_VAR` read site (`vars[idx]` at `src/vm.js:1186`) risks forcing the inline cache polymorphic → megamorphic, which would regress *every* program. Use `const EMPTY_VARS = []`. Correctness already holds: the compiler guarantees `LOAD_VAR` is never emitted for external vars on a zero-var program (`idx` would have no value to resolve against `varTable`).

2. **The "PACKED via pre-fill" optimisation isn't real.** `new Array(N)` with `N > 0` starts `HOLEY_SMI_ELEMENTS` in V8 and the element-kind lattice is **one-way** toward more general — you cannot transition back to `PACKED` by assigning slots (see Mathias Bynens, https://v8.dev/blog/elements-kinds). The stack pool has this same property and has not regressed anything. Accept HOLEY, document it, and move on. If we ever care, the fix is `[0,0,0,0,0,0,0,0]` literal (which is `PACKED_SMI`) — out of scope here.

3. **Downgrade typical-case speedup prediction to +1–2%** (was +2–4%). The fill loop still executes — only the `new Array(n)` is eliminated. Per V8 alloc benchmarks (~30–80 ns per small array), and baseline ~360 ns/eval, 1–2% is the realistic envelope for non-zero-var cases. **Zero-var cases hold at +3–6%** because both alloc and fill-loop disappear.

4. **Historical calibration: predictions have been systematically low.** The stack-pool plan predicted +3–8% and landed +38–156% on several benchmarks (commit `3e1ec1e` message). Translation: allocation overhead on short expressions is larger than static analysis suggests. Take the +1–2% prediction as a floor; actual may be 2–3× higher.

5. **Critical prior-art: don't bundle try/finally with the hot dispatch loop.** Commit `3e1ec1e` recorded a **15% regression** when the pool checkout, `try/finally`, and the `while(pc < len) switch` loop lived in the same function — `try/finally` pessimises V8 optimisation of large functions. The plan already preserves the `evaluate()` (boundary) / `evaluateDispatch()` (hot loop) split that fixed that regression. Ship *only* with this split; do not inline the dispatch loop back into evaluate() even if it looks cleaner.

### Accepted simplifications from review

- **Keep the `activation == null` fill-skip** but restructured: write a single branch at fill-loop entry rather than per-slot. Simplicity reviewer was right that per-slot branching adds noise; the "skip entirely when null" path is clean.
- **Six tests → four tests.** Drop (1) the `EMPTY_VARS` reference-identity test (removed feature — no freeze, and sentinel identity isn't a meaningful contract), and (4) the throw-releases-pool test (already covered by existing stack-pool error-path tests per the source plan).

### Rejected simplifications from review

- **Keep `EMPTY_VARS` sentinel.** The simplicity reviewer argued `new Array(0)` is free; the perf oracle and V8-alloc benches disagree (~10–30 ns per call even for length 0). On a ~360 ns/eval baseline that's 3–8% of total time on zero-var programs. The sentinel costs one module constant + one `n === 0` branch — cheap for the measured win. Stands.
- **Keep the dispatch signature change** (drop `activation` param from `evaluateDispatch`, add `vars`). The simplicity reviewer called it churn, but the git-history analyst's rule-#1 says the hot loop must be insulated from boundary concerns. Moving the fill loop out of `evaluateDispatch()` is the whole point.

### Related opportunity (not in scope, flagged for follow-up)

Performance oracle spotted that the stack pool's `finally` clears **all** slots in `pooledStack` (line ~1140, `for (let i = 0; i < stack.length; i++)`), regardless of how far `sp` actually reached. For short programs this wastes ~60 writes per call. Tracking `maxSp` during dispatch and clearing only `[0..maxSp]` could save more than the vars pool itself delivers. Recommended as a separate plan; not bundled here to keep scope crisp and blast radius small.

## Overview

Eliminate the `new Array(varTable.length)` allocation at `src/vm.js:1151` — the last remaining per-call allocation inside the VM `evaluate()` hot path. This is the natural successor to the landed "pool stack + uintFlags buffers" work (commits `3e1ec1e`, `9c6860c`; plan `docs/plans/2026-04-17-002-perf-pool-evaluate-stack-buffers-plan.md`). With stack and flags pooled, `vars` is the only remaining per-evaluation heap allocation.

The user's framing: for a 4-instruction program with 1 variable, per-call setup dominates the actual dispatch work. The `new Array(varTable.length)` + property-lookup loop is the largest chunk of that setup.

## Problem Statement

At the top of `evaluateDispatch()` (`src/vm.js:1146-1154`):

```js
function evaluateDispatch(program, activation, customFunctionTable, stack, uintFlags) {
  const { consts, constUintFlags, varTable, opcodes, operands } = program
  const len = opcodes.length

  // Build activation array (string → index resolved at compile time)
  const vars = new Array(varTable.length)
  for (let i = 0; i < varTable.length; i++) {
    vars[i] = activation != null ? activation[varTable[i]] : undefined
  }
  ...
}
```

Every call to `evaluate()` allocates a fresh `Array` of length `varTable.length`, populates it from `activation[varTable[i]]`, then discards it when `evaluate()` returns. For the common case (programs with 0–3 external variables), this allocation dominates the non-dispatch portion of the per-call cost.

Measured baseline (`bun run bench/compare.js`, commit `9c6860c`):

| Case | vars | K ops/s |
|------|-----:|--------:|
| `1 + 2 * 3`                      | 0 | 6118 |
| `(x + y) * z`                    | 3 | 6351 |
| `x > 100 && y < 50`              | 2 | 6562 |
| `s.contains("world")`            | 1 | 7643 |
| `x > 0 ? "pos" : "neg"`          | 1 | 2439 |
| `[1, 2, 3, 4, 5]`                | 0 | 6967 |
| `x > 0 && y > 0 && x + y < 100`  | 2 | 5137 |
| **Evaluate-only aggregate**      | — | **2745–2768** |

For a 0-var program (`1 + 2 * 3`), we currently allocate a zero-length `Array` and still pay the allocation cost — pure waste.

### Why this is the remaining bottleneck

The recent three-commit sequence (`389d4b4`, `3e1ec1e`, `9c6860c`) eliminated every *other* per-call allocation inside `evaluate()`:
- `389d4b4` — flattened instructions to typed arrays (no more per-instruction object allocation).
- `3e1ec1e` — pooled stack + uintFlags.
- `9c6860c` — removed constant-pool tag wrapper.

After those, `new Array(varTable.length)` is the only remaining allocation on the hot path. CPU-profile flame graphs (take with a grain of salt — V8's sampler undercounts tiny allocations) show the memory allocator tip at this site on short programs.

## Proposed Solution

Pool the `vars` array at module scope, mirroring the existing stack/uintFlags pool pattern. Add two low-hanging pre-optimisations:

1. **Fast-path zero-var programs**: use a single shared empty-array sentinel and skip the fill loop entirely.
2. **Skip re-fill when safe**: if `activation == null`, skip the fill loop — pooled slots are already `undefined` from prior cleanup.

### Module state (near existing stack pool, ~`src/vm.js:1060`)

```js
// Pooled activation vars array. Grows monotonically to the largest
// varTable seen. Re-entrant calls fall back to a fresh Array (see below).
// Initialised via IIFE to mirror the adjacent `pooledStack` declaration
// (src/vm.js:1075-1079) and keep the style symmetric.
const VARS_INITIAL_CAPACITY = 8   // covers the vast majority of CEL programs
let pooledVars = (() => {
  const a = new Array(VARS_INITIAL_CAPACITY)
  for (let i = 0; i < VARS_INITIAL_CAPACITY; i++) a[i] = undefined
  return a
})()
// `pooledInUse` (existing) gates both stack+vars pools — they check out and
// return together, so one flag suffices.

// Shared empty-array sentinel for 0-var programs. Never written to
// (compiler never emits an external-variable LOAD_VAR when varTable is
// empty — only IDX_ITER_ELEM / IDX_ACCU indices, which bypass `vars`).
// Do NOT Object.freeze this: a frozen array has a different element kind
// (PACKED_FROZEN_ELEMENTS) than `pooledVars` (HOLEY_*), and mixing the two
// at the hot `vars[idx]` read site in LOAD_VAR (src/vm.js:1186) would
// force the inline cache megamorphic and regress every program.
const EMPTY_VARS = []
```

### Checkout / return in `evaluate()`

Fold vars checkout into the existing pool-checkout block at `src/vm.js:1110-1132`. The existing `fromPool` flag and `pooledInUse` semantics carry over unchanged.

```js
// Existing block, augmented:
let stack, uintFlags, vars

if (fromPool) {
  pooledInUse = true
  // ... existing stack/uintFlags checkout ...
  stack = pooledStack
  uintFlags = pooledUintFlags

  const n = program.varTable.length
  if (n === 0) {
    vars = EMPTY_VARS
  } else {
    if (pooledVars.length < n) {
      // Grow (rare). Monotonic; never shrinks. Mirror stack-pool doubling
      // idiom (src/vm.js:1112-1119) for consistency.
      let newCap = pooledVars.length
      while (newCap < n) newCap *= 2
      const grown = new Array(newCap)
      for (let i = 0; i < newCap; i++) grown[i] = undefined
      pooledVars = grown
    }
    vars = pooledVars
    // Fill from activation. If activation is null/undefined, skip entirely —
    // pooledVars slots [0..n) are `undefined` from the post-call clear loop,
    // so `LOAD_VAR` correctly reads `undefined`.
    if (activation != null) {
      const varTable = program.varTable
      for (let i = 0; i < n; i++) vars[i] = activation[varTable[i]]
    }
  }
} else {
  // Re-entrant path (custom function called back into evaluate). Fresh alloc.
  stack = new Array(requiredCapacity)
  for (let i = 0; i < requiredCapacity; i++) stack[i] = undefined
  uintFlags = new Uint8Array(requiredCapacity)
  const n = program.varTable.length
  if (n === 0) {
    vars = EMPTY_VARS
  } else {
    vars = new Array(n)
    if (activation != null) {
      const varTable = program.varTable
      for (let i = 0; i < n; i++) vars[i] = activation[varTable[i]]
    } else {
      for (let i = 0; i < n; i++) vars[i] = undefined
    }
  }
}

try {
  return evaluateDispatch(program, customFunctionTable, stack, uintFlags, vars)
} finally {
  if (fromPool) {
    // Clear stack slots (existing)
    for (let i = 0; i < stack.length; i++) stack[i] = undefined
    // Clear vars slots (new) — same GC-retention concern as stack.
    // Only touches the portion we actually populated; cost is O(varTable.length).
    if (vars !== EMPTY_VARS) {
      for (let i = 0; i < program.varTable.length; i++) vars[i] = undefined
    }
    pooledInUse = false
  }
}
```

### Dispatch signature change

`evaluateDispatch()` currently takes `(program, activation, customFunctionTable, stack, uintFlags)` and builds `vars` itself. With pooling, `vars` is passed in and the fill loop moves to `evaluate()`:

```js
function evaluateDispatch(program, customFunctionTable, stack, uintFlags, vars) {
  const { consts, constUintFlags, opcodes, operands } = program
  const len = opcodes.length
  // (removed: the vars build loop — now done in evaluate())
  ...
}
```

This is a trivial refactor; the dispatch loop body is unchanged. `activation` is no longer passed into the dispatch function (it's consumed at the boundary), which also removes a parameter-shape variation that could pessimise V8 inlining.

### Why not "synthetic registers v0..v7"?

The user's alternative framing was: for programs with ≤8 vars, promote slots to JS locals `v0, v1, ..., v7` and have `LOAD_VAR` switch on `idx`:

```js
case OP.LOAD_VAR: {
  switch (operand) {
    case 0: stack[++sp] = v0; break
    case 1: stack[++sp] = v1; break
    ...
  }
  break
}
```

This **probably loses** on net for three reasons:

1. **Hot-path cost**: the current `stack[++sp] = vars[idx]` is a single indexed read from a local array pointer. V8 inlines this to ~2–3 µops. The switch adds a dispatch branch per `LOAD_VAR`. For programs with many `LOAD_VAR`s (comprehensions, long expressions), the per-load overhead dwarfs the one-time allocation saving.

2. **Register pressure**: declaring 8 locals `v0..v7` in the already-large `evaluateDispatch()` function risks pushing V8 over its register budget. `evaluateDispatch` already has `pc`, `sp`, `accu`, `iterElem`, `stack`, `uintFlags`, `vars`, `opcodes`, `operands`, `consts`, `constUintFlags`, `len` — adding 8 more *cold* locals competes with the hot ones.

3. **Branch predictor cost**: the switch on `operand` is data-dependent (different `LOAD_VAR` sites load different indices). Modern predictors handle this but pay a steady-state penalty of a mispredict on site changes.

**Decision**: pool the array. It is a direct analogue of the already-landed stack pool, preserves the dispatch-loop shape proven to JIT well (`CLAUDE.md`: "VM is a plain function, not a class, for V8 JIT"), and the savings (one `Array` alloc per call) are captured without adding any per-instruction overhead.

If someone wants to revisit `v0..v7` later, it's a clean follow-up experiment — but only if a bench proves it wins, which this plan's author does not expect.

### What does NOT change

- Public API (`evaluate`, `evaluateDebug`, `Environment.evaluate`, `program`, `run`) — same signatures, same return values, same error semantics.
- Bytecode binary format — no changes; `varTable` is unchanged.
- Compiler — no changes (`src/compiler.js:229` still produces the same sorted `varTable`).
- Decoder / `decode()` — no changes.
- LOAD_VAR opcode semantics — unchanged; `vars[idx]` still reads from the same positional array.
- `accu` / `iterElem` registers — already per-call locals, no allocation.
- Existing stack / uintFlags pool — unchanged, extended with a sibling vars pool.

## Technical Considerations

### Performance (compile-time)

**Zero impact.** No compiler, bytecode, or decoder changes.

### Performance (run-time)

Expected wins on `bun run bench/compare.js`:

| Benchmark | Mechanism | Expected delta |
|-----------|-----------|----------------|
| 0-var cases (`1 + 2 * 3`, `[1,...5]`)     | `EMPTY_VARS` sentinel — no alloc, no fill loop | +3–6% |
| 1–3 var cases (`x + y`, `x > 100 && y < 50`) | Pool — no alloc; fill cost unchanged             | +1–2% |
| Long programs (`l.filter(...)` macros)    | Pool — alloc savings amortise over many ops      | +0–2% |
| **Compile + Evaluate (cache miss)**       | Unchanged — compile dominates                    | ±0% |

Rationale: the alloc cost is O(1) per call (~30–80 ns per `new Array(n)` on modern V8 per https://v8.dev/blog/elements-kinds discussion + Benedikt Meurer's benchmarks); short programs feel it proportionally more. The pool-hit path for typical var counts (1–3) skips exactly one `new Array(n)` per call, and the fill loop executes at the same cost either way.

**Historical calibration note.** The analogous stack-pool plan (`docs/plans/2026-04-17-002-...`) predicted +3–8% and landed +38–156% on several benchmarks (per commit `3e1ec1e` message). Predictions on this codebase have been systematically low because allocation overhead on short expressions is larger than napkin math suggests. Treat the numbers above as a floor; actual delta may be 2–3× higher, especially on arithmetic micro-benches.

Must-not-regress rows (per `CLAUDE.md`):
- Any benchmark case ≥ baseline within noise (±1%).
- `Compile + Evaluate` row unchanged (this change touches only evaluate).
- All macro benchmarks (`exists`, `filter`, `map`) ≥ baseline — macros call the dispatch loop many times per evaluate *through iteration*, not re-entry, so they see the fill loop once. No regression expected.

### Security / correctness

- **Re-entrancy**: the existing `pooledInUse` flag already gates this correctly. The vars pool rides the same flag — stack, uintFlags, and vars all check out/return together. A custom function calling `evaluate()` inside its body sees `pooledInUse === true` and takes the fallback allocation path — preserving both correctness and the outer call's pooled state.

- **GC retention via stale vars slots**: same concern as the stack pool. Mitigation: explicit `vars[i] = undefined` loop in the `finally`. Cost is O(varTable.length), typically ≤ 5 writes.

- **Stale data from prior evaluation**: the fill loop writes every slot from `activation` when `activation != null`. When `activation == null`, slots stay `undefined` because the previous call's `finally` cleared them. No staleness window.

- **`EMPTY_VARS` mutation**: **do not freeze.** The compiler never emits `LOAD_VAR` with an external-variable index when `varTable.length === 0`, so `EMPTY_VARS[i] = x` is unreachable. Freezing would change the element kind (`PACKED_FROZEN_ELEMENTS`) and risk polymorphising the `vars[idx]` inline cache at the shared LOAD_VAR site. Correctness guarantee is the compiler, not the freeze.

- **Partial failure mid-evaluation**: `try/finally` releases the pool unconditionally. Existing error-path tests (`test/vm-pool.test.js` if it exists, plus `test/environment.test.js` custom-fn error cases) cover this.

### Memory

- **Pinned**: `VARS_INITIAL_CAPACITY = 8` slots × 8 bytes = 64 bytes per module. Trivial.
- **Growth ceiling**: no explicit cap. `pooledVars` grows monotonically to the largest `varTable.length` ever seen. Programs with hundreds of vars would grow the pool accordingly. No shrink logic — the array stabilises at high-water mark. Acceptable: var counts are bounded by the number of distinct identifiers in an expression, practically ≤ 50.

### Compatibility

No API, bytecode format, or serialisation changes. Existing base64 bytecodes continue to work. No TypeScript declaration updates needed. `program.varTable` is still accessible for debugging.

## System-Wide Impact

- **Interaction graph**: `cel.evaluate()` → `cachedDecode()` → `evalProgram()` (`src/vm.js:1097`). `Environment.evaluate()` → `evalProgram()`. `program()` returns a closure over `decoded` → `evalProgram()`. All paths benefit.
- **Error propagation**: unchanged. Errors from dispatch bubble through `try/finally`; pool is released on throw.
- **State lifecycle risks**: the `pooledInUse` flag already coordinates shared module state for stack/flags; extending it to vars adds no new risk surface.
- **API surface parity**: `evaluate` (fast path) and `evaluateDebug` (wrapper at `src/vm.js:1641`) both call the same `evalProgram()` — both benefit automatically.
- **Integration test scenarios** (cross-layer, unit-test-resistant):
  1. Compile once, evaluate N times with *different* activations of the same shape — verify no value bleed between calls.
  2. Compile once, evaluate N times with *different* activations of *different* shapes (first has `x`, second adds `y`) — not a real scenario since shape is fixed per-program, but worth asserting for paranoia.
  3. Nested `Environment` with a custom function that calls `env.evaluate('x + 1', {x: 5})` from inside an outer `evaluate` — verify both return correct results; pool fallback exercised.
  4. Evaluate with `activation == null` — verify `LOAD_VAR` returns `undefined` (current semantics) and doesn't leak prior call's values.
  5. A comprehension (`l.filter(v, v > sentinel)`) over a list of heap objects — verify `vars[idx]` holding the heap-object reference is cleared after evaluate returns (no GC pinning).

## Acceptance Criteria

### Functional

- [ ] All existing tests pass unchanged: `bun test` green, same pass count as baseline (`9c6860c`).
- [ ] New test: evaluate two *different* programs with different `varTable` lengths in sequence (`x + y` then `a + b + c + d + e`) — verify no cross-program state leak.
- [ ] New test: custom function calls back into `evaluate()` from inside its body with a *different* `activation` — both outer and inner return correct results.
- [ ] New test: evaluate with `activation == null` on a program with vars after populating the pool in a prior call — all `LOAD_VAR`s return `undefined`, no leak from prior call's values.
- [ ] Existing test: GC-retention test (if present from stack-pool plan) extended or mirrored for `vars` — heap object referenced by `activation` is eligible for GC after `evaluate()` returns.
- [ ] (Dropped from draft: `EMPTY_VARS` reference-identity test — removed along with `Object.freeze`; sentinel identity is not a meaningful contract.)
- [ ] (Dropped from draft: throw-releases-pool test — covered by existing stack-pool error-path tests per `docs/plans/2026-04-17-002-perf-pool-evaluate-stack-buffers-plan.md:237`.)

### Performance

- [ ] `bun run bench/compare.js` "Evaluate only" aggregate ≥ 2800 K ops/s (current baseline 2745–2768; target ≥ +1% headline).
- [ ] Zero-var cases (`1 + 2 * 3`, `[1,2,3,4,5]`) show ≥ +2% improvement.
- [ ] No individual benchmark case regresses > 1% from baseline.
- [ ] `Compile + Evaluate` row unchanged within ±1%.

### Quality

- [ ] No new lint warnings.
- [ ] `src/vm.js` net line count change: ≤ +30 lines.
- [ ] `IMPLEMENTATION.md` updated if it describes allocation behaviour of `evaluate()`.

## Success Metrics

- **Primary**: ≥ +2% on zero-var eval benchmarks; ≥ +1% on aggregate evaluate-only row.
- **Secondary**: allocation-count reduction per evaluate (observable via `Bun.gc()` counters in a test harness).
- **Tertiary**: enables follow-up "register v0..v7" experiment on a clean baseline, should the numbers justify it.

## Dependencies & Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Measured win is inside benchmark noise | Medium | Run bench 5× before/after; report medians. If < 1% aggregate, still land for the zero-var sentinel + consistency with stack pool, but flag as a small win. |
| Missed re-entrancy path corrupts shared vars | Low | Existing `pooledInUse` gates both pools; re-entrancy test case added. |
| GC retention via stale vars slots | Low | Explicit `vars[i] = undefined` in `finally`. |
| `EMPTY_VARS` mutation somewhere unexpected | Very low | Compiler never emits external `LOAD_VAR` for 0-var programs; pool-fallback code writes to `vars` only when `n > 0`, at which point `vars === pooledVars`, not `EMPTY_VARS`. Verify by reading the updated `evaluate()` code. |
| V8 deopts pooled `vars` via HOLEY→DICTIONARY transition | Low | Pre-fill at module init with `undefined`; pattern matches already-landed stack pool which has not exhibited this problem. Note: the array stays `HOLEY_ELEMENTS` forever (element kinds only widen) — that is accepted; the goal is to stay out of `DICTIONARY_ELEMENTS`, which only happens on sparse indexing or delete, neither of which occurs here. |
| Frozen-vs-unfrozen element-kind mix at `vars[idx]` IC pessimises every program | Was Medium, now N/A | `EMPTY_VARS` is a plain `[]`, not `Object.freeze([])`. See Enhancement Summary §1. |
| Long-running program regression (macro benches) | Low | Fill loop runs once; dispatch unchanged. Confirmed by bench. |
| Pool lock leak (`pooledInUse` stuck true) after a throw | Low | Shared `try/finally` with existing stack-pool releases — no new leak surface. |

## Alternative Approaches Considered

1. **Synthetic registers v0..v7 (user's alternative framing)** — rejected as the primary approach. Per-instruction `switch(operand)` cost likely exceeds per-call alloc savings; see "Why not synthetic registers" above. Keep as a future experiment behind a measurement.

2. **Size the stack pool to also hold vars** — use pooled-stack slots above `sp` as vars storage. Rejected: muddles two concerns (stack vs activation) and risks overflow into the dispatch-loop working set under comprehensions. The separate vars pool is tiny.

3. **Attach vars pool to `Environment` instead of module scope** — rejected: the module pool works uniformly for direct `cel.evaluate()` callers (who don't have an `Environment`). The re-entrancy path handles the edge case.

4. **Skip the pool entirely and rely on V8's allocation sinking** — V8 in theory can sink a short-lived array allocation into registers. In practice, `evaluateDispatch()` is too large and hot for reliable sinking; the allocation shows up on flame graphs. Measurable win is worth the minor complexity.

5. **Cache `varTable` → index-ordered activation reads** — e.g. if `activation` is always the same object identity across calls, skip the fill loop. Rejected: `activation` is typically a fresh object per call in user code (benchmarks, HTTP request contexts, row processors). The fill loop is cheap.

6. **Move the fill loop into the compiled bytecode as a series of `BUILD_VAR` opcodes** — rejected as strictly worse: N dispatch iterations instead of one tight native loop.

## Testing Plan

### Unit tests (new — add to `test/vm-pool.test.js` if present, else `test/vm-vars-pool.test.js`)

Four tests total (trimmed from six per simplicity review — throw-releases and sentinel-identity tests dropped; see Enhancement Summary).

```js
// 1. Cross-program no-leak (covers pool re-use + grow across varTable sizes)
test('different programs do not leak vars across evaluations', () => {
  const bc1 = cel.compile('x + y')
  const bc2 = cel.compile('a + b + c + d + e')
  assert.equal(cel.evaluate(bc1, {x: 1n, y: 2n}), 3n)
  assert.equal(cel.evaluate(bc2, {a:1n,b:2n,c:3n,d:4n,e:5n}), 15n)
  assert.equal(cel.evaluate(bc1, {x: 10n, y: 20n}), 30n)  // pool reused
})

// 2. Re-entrant correctness with vars
test('custom fn calling evaluate() with different activation', () => {
  const env = cel.environment({
    functions: {
      inner: (x) => cel.evaluate(cel.compile('y + 1'), {y: x})
    }
  })
  assert.equal(env.evaluate('inner(z)', {z: 5n}), 6n)
})

// 3. null activation on a var-bearing program must not leak prior call's values
test('null activation yields undefined vars, no leak', () => {
  const bc = cel.compile('x')
  cel.evaluate(bc, {x: 42n})  // populate pool
  // null activation: must return undefined, not the leaked 42n
  assert.equal(cel.evaluate(bc, null), undefined)
})

// 4. GC retention — heap objects in activation must be released after evaluate
test('heap refs in activation are released after evaluate', async () => {
  const bc = cel.compile('l.size()')
  let big = { data: new Array(1_000_000) }
  const ref = new WeakRef(big)
  cel.evaluate(bc, { l: big })
  big = null
  await new Promise(r => setTimeout(r, 10))
  Bun.gc(true)
  assert.equal(ref.deref(), undefined)
})
```

### Regression tests

- Full `bun test` — all cel-spec + marcbachmann suites.
- `test/environment.test.js` — custom-function paths.
- `test/marcbachmann/macros.test.js` — deep comprehension stacks.
- Any existing `test/vm-pool.test.js` — re-entrancy and error paths already cover the shared pool.

### Performance verification

Capture baseline & post-change on the same machine, same power state:

```bash
# Baseline (already captured at .context/bench-baseline.txt for this branch)
git stash && bun run bench/compare.js > .context/bench-baseline.txt

# After
git stash pop && for i in 1 2 3 4 5; do
  bun run bench/compare.js > .context/bench-after-$i.txt
done

# Report medians per case in PR description
```

Compare:
- Evaluate-only aggregate (primary metric).
- Per-case: zero-var cases (largest expected win).
- Compile+Evaluate (must-not-regress).

## Implementation Sketch (structural)

### `src/vm.js` changes

| Location | Change |
|----------|--------|
| `~1071` (after `STACK_MAX_CAPACITY`) | Add `VARS_INITIAL_CAPACITY`, `pooledVars`, `EMPTY_VARS`. |
| `~1108-1132` (checkout block) | Add vars checkout alongside stack/flags; branch on `n === 0`. |
| `~1136-1143` (finally block) | Clear vars slots alongside stack; skip if `vars === EMPTY_VARS`. |
| `~1146` (`evaluateDispatch` signature) | Replace `activation` param with `vars`; drop internal vars build loop. |
| `~1151-1154` (vars build loop) | **Remove** — moved to `evaluate()` boundary. |

### Files touched

| File | Change |
|------|--------|
| `src/vm.js` | Pool setup, checkout/return, dispatch signature, removed build loop. |
| `test/vm-vars-pool.test.js` (or extend existing `test/vm-pool.test.js`) | 4 new tests per Testing Plan. |
| `IMPLEMENTATION.md` | Update VM / evaluate() allocation description per `CLAUDE.md` rule. |

### Files NOT touched

- `src/compiler.js`, `src/bytecode.js`, `src/checker.js`, `src/parser.js`, `src/lexer.js` — pipeline unchanged.
- `src/index.js`, `src/environment.js` — public API unchanged.
- `bench/compare.js` — harness unchanged; only outputs change.

## Sources & References

### Origin / prior work (internal)

- `docs/plans/2026-04-17-002-perf-pool-evaluate-stack-buffers-plan.md` — direct template for this plan. The vars pool is the sibling of the stack pool described there.
- `docs/plans/2026-04-17-001-refactor-flatten-vm-dispatch-typed-arrays-plan.md` — landed in `389d4b4`. Established the V8-JIT-first VM optimisation approach.
- `docs/plans/2026-04-17-003-refactor-tagless-const-pool-plan.md` — landed in `9c6860c`. Last of the cluster; after it, `vars` alloc is the largest remaining per-call cost.
- `docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md` — lists allocation avoidance as Phase-2 goal (this plan continues that work).

### Code references

- `src/vm.js:1097` — `evaluate()` entry point.
- `src/vm.js:1110-1132` — existing pool checkout (extend here).
- `src/vm.js:1136-1143` — existing pool finally block (extend here).
- `src/vm.js:1146-1154` — `evaluateDispatch()` entry + target vars build loop.
- `src/vm.js:1178-1189` — `LOAD_VAR` opcode (unchanged; reads `vars[idx]`).
- `src/vm.js:1071-1081` — stack pool state (pattern to mirror).
- `src/compiler.js:229` — `varTable = Array.from(varNameSet).sort()` (stable ordering).
- `src/bytecode.js:417-421` — `varTable` decode (unchanged).
- `src/index.js:80-83` — `evaluate()` public wrapper (unchanged).
- `bench/compare.js` — performance harness.
- `.context/bench-baseline.txt` — captured baseline for this branch.

### Project rules

- `CLAUDE.md` — "Performance analysis required: analyse impact on both compile-time and run-time. Run `bun run bench/compare.js` before and after."
- `CLAUDE.md` — "VM is a plain function, not a class, for V8 JIT." Pool sits alongside this constraint.
- `CLAUDE.md` — "Opcode set is capped at ~30–50 opcodes to keep V8's branch predictor effective." Rules out register-variant opcodes.

### External references (added during deepening)

- Mathias Bynens, "Elements kinds in V8" — https://v8.dev/blog/elements-kinds. Canonical on why `new Array(N)` starts `HOLEY_SMI_ELEMENTS` and why the element-kind lattice is one-way. Informs the "accept HOLEY" decision.
- V8 blog, "V8 release v6.5" — https://v8.dev/blog/v8-release-65. Introduces `PACKED_FROZEN_ELEMENTS` / `HOLEY_FROZEN_ELEMENTS`. Informs the decision to NOT `Object.freeze(EMPTY_VARS)`.
- Benedikt Meurer's benchmarks — https://benediktmeurer.de/. Small-array alloc cost reference (~30–80 ns).
- V8 Ignition bytecode interpreter — https://v8.dev/blog/ignition-interpreter. Canonical example of register-based activation frames; informs the "vars pool stays heterogeneous JS Array" scoping (no typed-array stack for vars because values are heterogeneous).
- LuaJIT, Hermes, QuickJS interp designs — surveyed for activation-frame idioms. All pool or use native stack frames; none allocate per call. This plan mirrors that principle within the constraints of heterogeneous JS values.
