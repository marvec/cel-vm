---
title: "perf: Lazy pool cleanup — clear only used stack slots after evaluate()"
type: perf
status: completed
date: 2026-04-21
deepened: 2026-04-21
---

# perf: Lazy pool cleanup — clear only used stack slots after evaluate()

## Overview

Reduce per-`evaluate()` overhead (currently ~35 ns, roughly **61 %** of total wall time on a 4-instruction program) by clearing only the stack slots the program actually touched instead of the full 16-slot minimum pool, and by narrowing the `uintFlags` reset to the same range.

This is a direct follow-up to `docs/plans/2026-04-17-002-perf-pool-evaluate-stack-buffers-plan.md` (landed in commits `3e1ec1e` and `9c6860c`). That change introduced the pool; this change pays the remaining per-call tax the first version deliberately left on the table.

> **Runtime note**: CEL-VM is developed/benchmarked on **Bun**, whose engine is **JavaScriptCore (JSC)**, not V8. Earlier perf plans in this repo referenced V8-specific concepts (element kinds, holey/packed). JSC does not expose element-kind classification and its FTL tier is LLVM-backed; design decisions below are validated against JSC behavior where it differs from V8. The code should still perform well under Node/V8, but the hard targets in Acceptance Criteria are measured on Bun.

## Problem Statement

Per-eval overhead — everything *outside* the dispatch loop — dominates short-expression evaluation. For a 4-instruction program (e.g. `1 + 2 * 3` post-folding, or `(x + y) * z`), the dispatch itself costs ~14 ns while the per-call setup+teardown costs ~35 ns (~61 % of total).

**Primary hot-path contributors** in `src/vm.js:1097-1144`:

```js
// src/vm.js:1124 — zeros the full pooled Uint8Array every call
pooledUintFlags.fill(0)

// src/vm.js:1140 — clears the FULL stack pool (minimum 16 slots) every call
for (let i = 0; i < stack.length; i++) stack[i] = undefined
```

For a program that peaks at `sp = 1` (two live slots) we pay 16 `undefined` writes and 16 byte resets; should be 2 each. On a 100k-iteration benchmark row that's ~1.4M wasted writes, ~14 ms of wall time.

**Baseline verification required**: the "35 ns / 61 %" figure predates commits `3e1ec1e` and `9c6860c`. Before finalising acceptance thresholds, re-run `bun run bench/compare.js` on `HEAD` and re-measure per-call overhead for short expressions. If headroom is smaller (say 20 ns), scale the target speedups proportionally.

## Proposed Solution

Track the high-water mark of `sp` during dispatch and clear only `[0..maxSp]`.

### Mechanism: watermark as a local, written through a carrier

Keep `maxSp` as a **local in `evaluateDispatch`** (not a module-level `let`). Closure-scoped locals register-promote in JSC's DFG/FTL; module-level `let` bindings resolve to a fixed environment-record slot and do not. Publish the value to `evaluate()`'s `finally` via a single-element `Int32Array(1)` owned by `evaluate()` on the call stack:

```js
// src/vm.js — inside evaluate()
const hwOut = _hwCarrier  // reused, see below
hwOut[0] = -1
try {
  return evaluateDispatch(program, activation, customFunctionTable, stack, uintFlags, hwOut)
} finally {
  if (fromPool) {
    const hw = hwOut[0]
    for (let i = 0; i <= hw; i++) stack[i] = undefined
    pooledInUse = false
  }
}
```

**Carrier lifetime**: one module-level `Int32Array(1)` works for the non-re-entrant steady state. Re-entrant calls (custom fns calling `evaluate()` from inside) go through the existing `!fromPool` branch, which already fresh-allocates a stack — give it its own fresh `Int32Array(1)` too. Re-entrancy is then naturally safe (each call has its own carrier). No `Math.max`, no save/restore, no module scalar to synchronize.

```js
// module scope
const _hwCarrier = new Int32Array(1)

// inside evaluate(), re-entrant branch:
} else {
  stack = new Array(requiredCapacity)
  for (let i = 0; i < requiredCapacity; i++) stack[i] = undefined
  uintFlags = new Uint8Array(requiredCapacity)
  const hwOut = new Int32Array(1)  // per re-entrant call; trivial cost
  hwOut[0] = -1
  try { return evaluateDispatch(..., hwOut) }
  finally { /* no pool release */ }
}
```

### Where to update the watermark in dispatch

`sp` is not modified only at `++sp` sites. A full audit of `src/vm.js` shows:

- `++sp` sites: `PUSH_CONST` (1173), `LOAD_VAR` three branches (1182, 1184, 1186), `ITER_NEXT` (≈1466), optional pushes.
- `sp = base` in `BUILD_LIST` / `BUILD_MAP` (≈1371, 1385-1386) — can raise sp when the built value sits above the popped elements.
- `sp -= argc - 1` in `OP.CALL` — when `argc === 0` this is `++sp`.

Sprinkling updates across ~8 textual sites risks missing one (silent retention bug). **Use a single update at the top of the dispatch `while` loop**, tracking the previous iteration's `sp`:

```js
let maxSp = -1
while (pc < len) {
  if (sp > maxSp) maxSp = sp   // covers every opcode, every sp modification
  const op = opcodes[pc]
  const operand = operands[pc]
  pc++
  switch (op) { /* unchanged */ }
}
hwOut[0] = maxSp
// also handle OP.RETURN case — it returns from within the switch, so set hwOut[0] before return:
case OP.RETURN: {
  const result = stack[sp]
  if (isError(result)) throw new EvaluationError(...)
  if (sp > maxSp) maxSp = sp
  hwOut[0] = maxSp
  return result
}
```

Cost: one compare + conditional write per dispatch iteration. For a 4-instruction program that's ~2 ns total — still leaves a large net win from the 14-ns clear-loop saving. For long programs (macros), the per-instruction cost is still lower than the saved final clear.

**Alternative if bench shows regression**: enumerate the ~8 sp-raising sites and add `if (sp > maxSp) maxSp = sp` after each. More code, slightly faster. Ship the simple version first; swap if needed.

### Narrowed `uintFlags` reset

Replace `pooledUintFlags.fill(0)` at `src/vm.js:1124` with a conditional partial reset, tracked across calls:

```js
// module scope
let _lastHw = -1

// on entry, if reusing pooled buffer:
if (_lastHw >= 0) {
  if (_lastHw < 4) {
    for (let i = 0; i <= _lastHw; i++) pooledUintFlags[i] = 0
  } else {
    pooledUintFlags.fill(0, 0, _lastHw + 1)
  }
}

// on exit, in the fromPool finally branch:
_lastHw = hwOut[0]
```

The `< 4` fast-path is a hedge: JSC's `Uint8Array.fill` is likely implemented as a native intrinsic but is not confirmed to be full `memset`, and call overhead can beat a byte loop below ~4 bytes (per research into JSC typed-array internals; exact threshold is bench-dependent). Measure and drop the branch if it adds no value.

**Safety invariant**: after any partial reset + a full evaluate, slots `> _lastHw` have only ever been written by a `PUSH_CONST` (the only opcode that writes `uintFlags[sp]` to a non-zero value — `src/vm.js:1174`). If no prior call reached that slot, it's still 0 from the initial `new Uint8Array(…)`. Inductive from the all-zero seed. No change to correctness.

### What does NOT change

- Public API, bytecode format, serialisation — identical.
- Pool sizing / growth logic — unchanged.
- Error handling — `finally` still releases pool on throw. Note: a throw partway through dispatch leaves `hwOut[0] = -1` (never updated at the loop top for the iteration that threw). That's conservative — the `finally` clears 0 slots. Slots that were written before the throw retain references until the *next* call's finally; for long-lived modules this is a tiny leak. If tests show it matters, update `hwOut[0] = maxSp` inside the `while` loop body too (costs one write per iteration, not per push). Ship without it first; revisit only if leak is observable.

## Scope explicitly excluded

The first draft of this plan bundled two adjacent micro-optimizations; both are deferred as separate follow-ups to keep review surface small:

- **Drop `activation || {}` defaulting** in `src/index.js` and `src/environment.js` — ~1 ns win per call; unrelated to pool cleanup.
- **Skip `new Array(varTable.length)` when `varTable` is empty** — narrow win for constant-folded expressions; unrelated.

Land them separately if bench motivates.

## Technical Considerations

### Performance (compile-time)

Zero impact. No compiler changes, no bytecode format changes.

### Performance (run-time)

Target on `bun run bench/compare.js` short-expression rows (after re-measuring baseline):

- "arithmetic: 1 + 2 * 3" row: **≥ +12 %** (scaled down from first-draft +15 % given baseline uncertainty).
- "comparison: x > 100 && y < 50" row: **≥ +8 %**.
- All other rows: within ±3 % (Bun bench noise floor at ns-scale is ~±3–5 %; 2 % was too tight).
- Compile+Evaluate row: unchanged ±3 %.

Per-change estimates (rough, validate with bench):

| Change | Estimated win | Programs affected |
|---|---|---|
| Lazy stack clear (16→≈2 writes) | ~7–10 ns | All short programs |
| Narrow `uintFlags` reset (16→≈2 bytes) | ~3–5 ns | All calls after the first |
| Per-iteration watermark update | **−0.5 to −1 ns** (cost) | All programs |

Net: ~8–14 ns saved per short-program evaluate.

### Correctness

Invariants to maintain:
1. After every `evaluate()` return (normal or throw), every pooled slot in `[0..requiredCapacity)` is either `undefined` or will be overwritten before it is read.
2. `pooledUintFlags[i] === 0` for every `i` above the current call's max watermark.
3. `pooledInUse === false` after every return (throw-safe via `finally`).

Tests:
- [ ] All existing tests pass: `bun test` green, same count as baseline.
- [ ] New test: re-entrancy correctness — custom fn calls `evaluate()` from inside, both results correct, state clean after (new file `test/vm-lazy-clear.test.js` or extend `test/vm-pool.test.js`).
- [ ] New test: GC retention — evaluate with a large sentinel at deep `sp`, then evaluate a trivial expression, `WeakRef` to sentinel is collectable after `Bun.gc(true)`.

### Security / risk

- **Missed sp-modification site**: mitigated by the single-update-at-loop-top design. Cannot miss a site because every case runs through the loop header.
- **GC retention**: mitigated by the watermark-bounded clear.
- **Throw-path tiny retention**: accepted trade-off; documented; revisit only if observable.

### Memory

Steady-state unchanged. Re-entrant path allocates one extra `Int32Array(1)` (24 bytes) per nested call — negligible.

## System-Wide Impact

- **Interaction graph**: `cel.evaluate()` → `evalProgram()` (`src/index.js:82`) → `evaluate()` (`src/vm.js:1097`) → `evaluateDispatch()` (`src/vm.js:1146`). Same from `Environment.evaluate()`. Only behavioral change: one compare+conditional-write per dispatch iteration.
- **Error propagation**: unchanged.
- **State lifecycle risks**: the new module-level `_lastHw` and `_hwCarrier` continue the existing module-state pattern (`pooledStack`, `pooledUintFlags`, `pooledInUse`). Future follow-up (see below) should migrate all of these to `Environment` to support multi-Environment isolation cleanly.
- **API surface parity**: `evaluate` and `evaluateDebug` both benefit (same entry).

## Acceptance Criteria

### Functional

- [ ] `bun test` green, same pass count as baseline.
- [ ] New re-entrancy test passes.
- [ ] New GC-retention test passes.

### Performance

- [ ] Re-measured baseline captured in PR description.
- [ ] Short-expression bench rows hit the targets above (≥ +12 % / ≥ +8 %).
- [ ] No single row regresses by > 3 %.

### Quality

- [ ] `src/vm.js` net line-count change ≤ +20.
- [ ] No new lint warnings.
- [ ] Comment at each new site says *why* (not *what*), per project style.

## Follow-ups (separate plans)

1. **Compile-time `maxStack` on bytecode header** — the industry-standard answer (QuickJS, Lua, JVM, .NET all do this). Stored per-program in the bytecode, computed by a single abstract-interpretation pass over emitted opcodes using per-opcode stack deltas. Subsumes the runtime watermark entirely: `evaluate()` can pre-size the buffer exactly, clear exactly `maxStack` slots, and delete the per-iteration tracking in dispatch. Scope: ~50 lines in `src/compiler.js`, 1-2 bytes in the bytecode header. Referenced as "Approach A" in the prior pool plan.
2. **Environment-scoped pool** — move `pooledStack`, `pooledUintFlags`, `_lastHw`, `_hwCarrier` off module scope onto `Environment` instances. Fixes multi-Environment-same-realm contention and aligns with the broader architecture.
3. **`activation || {}` and empty-varTable allocation cleanup** — the two micro-optimizations dropped from this plan's scope.
4. **Debug-mode push-site invariant** — an optional `if (DEBUG && sp > maxSp) assert(...)` to catch regressions if the "single update at loop top" is ever rewritten to per-site updates.

## Alternatives Considered (brief)

- **Per-site watermark updates** in each sp-raising opcode: faster but easy to miss a site; ship only if the simple version regresses.
- **Module-level `_lastHighWater` scalar**: slower (module `let` doesn't register-promote in JSC) and requires re-entrancy save/restore; rejected.
- **Clear-on-POP**: moves cost into hot loop; rejected.
- **Skip clearing entirely**: pinned references grow unbounded; rejected.

## Sources & References

### Origin / prior work (internal)

- `docs/plans/2026-04-17-002-perf-pool-evaluate-stack-buffers-plan.md` — landed in commits `3e1ec1e` and `9c6860c`. Established the pool; this plan completes the watermark piece it anticipated.
- `docs/plans/2026-04-17-001-refactor-flatten-vm-dispatch-typed-arrays-plan.md` — commit `389d4b4`. Established the `evaluate()` / `evaluateDispatch()` split.

### Code references

- `src/vm.js:1097-1144` — `evaluate()` entry/exit, the target of this change.
- `src/vm.js:1124` — full `uintFlags.fill(0)` (to be narrowed).
- `src/vm.js:1140` — full-stack clear loop (to be narrowed).
- `src/vm.js:1146-1170` — `evaluateDispatch` entry and dispatch `while` loop header (where the single watermark update lives).
- `src/vm.js:1174` — the only opcode that writes `uintFlags[sp]` non-zero.
- `bench/compare.js` — perf harness.

### External research (deepening cycle)

- **Industry pattern for max stack**: QuickJS ([bellard.org/quickjs/quickjs.pdf](https://www.bellard.org/quickjs/quickjs.pdf)), Lua 5.4 (`luaE_extendCI` in [ldo.c](https://www.lua.org/source/5.4/ldo.c.html)), JVM Code attribute `max_stack` ([JVMS §4.7.3](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html#jvms-4.7.3)) — all compute at compile time. This is the follow-up (1) above.
- **JSC element kinds**: not a documented JSC concept ([WebKit docs](https://docs.webkit.org/Deep%20Dive/JSC/JavaScriptCore.html)); references in prior plans to holey/packed are V8-specific and should not drive JSC-targeted decisions.
- **`Array.prototype.fill` on plain Array**: not a memset intrinsic in V8 or JSC for small n; for-loop wins for n ≤ 64 ([V8 Elements Kinds](https://v8.dev/blog/elements-kinds)).
- **Module-level `let` writes**: V8 compiles to `StaCurrentContextSlot` bytecode ([Ignition design doc](https://docs.google.com/document/d/11T2CRex9hXxoJwbYqVQ32yIPMh0uouUZLdyrtmMoL44/mobilebasic)); JSC uses environment-record slots. Neither register-promotes across a hot loop; locals do.
- **cel-go baseline**: ~140 ns/op with 64 B / 3 allocs for short expressions. CEL-VM at ~49 ns/op is already ~3× faster; removing per-call allocations is the dominant remaining lever.

### Project rules

- `CLAUDE.md` — "Performance analysis required: analyse impact on both compile-time and run-time. Run `bun run bench/compare.js` before and after."
- `CLAUDE.md` — "VM is a plain function, not a class" — honored; this plan adds only local variables to dispatch.
