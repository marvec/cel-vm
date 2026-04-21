---
title: "perf: Skip uintFlags machinery for programs with no uint constants"
type: perf
status: active
date: 2026-04-21
---

# perf: Skip uintFlags machinery for programs with no uint constants

## Enhancement Summary (deepened 2026-04-21)

**Research agents used:** performance-oracle, code-simplicity-reviewer, Explore (V8/JIT + VM dispatch), repo-research-analyst.

### Key changes to the strategy from deepening

1. **Stage the optimisation.** Start with an inline-guard variant (~20-line diff) — a hoisted `const hasUint = program.hasUintConsts` + `if (hasUint) { uintFlags[sp] = … }` around the 6 existing uintFlags sites. Only escalate to the full `evaluateDispatchNoUint()` duplication if the guard variant's benchmark gain is clearly insufficient. Rationale: the "two monomorphic functions for V8" claim was largely unexamined; it is not backed by published V8 guidance and is not how QuickJS / Hermes handle similar situations.
2. **Add a Phase 0 micro-win: skip `fill()` via dirty-tracking.** A `pooledUintFlagsDirty` flag set when the slow path actually writes a `1` would let us skip the per-call `fill(0)` unconditionally — capturing possibly ≥60 % of the 9 ns target with zero code duplication. Worth measuring standalone.
3. **Tighten measurement methodology.** `performance.now()` has ~5 µs resolution in browsers and is marginal in Bun/Node at 9 ns deltas. Move short-program benchmarks to `process.hrtime.bigint()`, bump iteration counts to 1M for short rows, report median + IQR across 5 runs (not a single run), and cross-check with `--trace-opt` / `--trace-deopt` that neither dispatch variant deopts.
4. **Hidden-class hygiene.** Adding `hasUintConsts` to decoded programs mutates the program object's hidden class. Initialise the field in the **same order on every `decode()` path** (even when `false`), and verify via a short WeakMap audit that no cached program from before this change is held elsewhere.
5. **Missed files.** The plan must also edit `src/vm.js:1093` JSDoc (program shape comment) and **revise**, not just append to, `IMPLEMENTATION.md:149` — which currently states unconditionally that `PUSH_CONST` writes `uintFlags[sp]`, a statement that becomes path-dependent.
6. **Missed test coverage.** No existing test mixes an int literal and a uint literal in one arithmetic expression (e.g. `1 + 2u` or `2u + 1`). The plan's "mixed const pool" case exercises **net-new** territory. Add it regardless of which variant ships, and expose a narrow assertion hook for which path ran (otherwise silent fast-path misrouting is undetectable).
7. **Prior-plan calibration.** The last two perf plans (`2026-04-17-002`, `2026-04-17-003`) predicted 3–8 % and delivered up to **+156 %** on short rows. The new 10–25 % target for this plan is plausible and possibly conservative — but only if the staged approach actually removes the loop-invariant reads, which the inline-guard variant may or may not do depending on V8's branch elimination.

### New risks identified

- **Call-site polymorphism at `evaluate()`'s `return`** if Step 3 bimorphises it — not priced in the original plan. Mitigation: duplicate `evaluate()`'s entry too if we escalate to duplication, or keep a single dispatch with a hoisted guard.
- **Benchmark harness cannot reliably measure 9 ns deltas** as currently written. Upgrading the harness is a blocker for honest acceptance-criteria measurement, not a nice-to-have.
- **Hidden-class drift** on the program object if `hasUintConsts` is set conditionally.

### What survives from the original plan

- Decode-time OR-reduce over `constUintFlags` to produce `program.hasUintConsts` — confirmed minimal.
- The invariant "no uint const → uintFlags stays zero" — confirmed airtight against the current opcode set (repo analyst walked every write site).
- No wire-format change needed.
- The slow-path behaviour must remain byte-identical on programs that do use uint literals.

## Overview

Eliminate the `uintFlags` side-channel from `evaluate()` entirely when a program's const pool contains no `uint64` literals. This removes:

1. `pooledUintFlags.fill(0)` at every `evaluate()` call (~16–64 byte memset today, but timing-significant at the nanosecond scale for short programs).
2. Per-arithmetic-op reads of `uintFlags[sp]` (two reads on every `ADD`/`SUB`/`MUL`/`DIV`/`MOD`, one on `NEG`).
3. Per-arithmetic-op writes of `uintFlags[sp] = aIsUint && bIsUint ? 1 : 0`.
4. The `uintFlags[sp] = constUintFlags[operand]` store on `PUSH_CONST`.
5. The `if (uintFlags[sp])` branch on `NEG`.

Expected savings per the user's measurement: ~9 ns from the inner loop per call plus the `fill()` cost. For a 4-instruction program dominated by ~35 ns of per-eval setup, this is a material fraction — roughly targeting a **10–25 % improvement** on the shortest `bench/compare.js` rows (e.g., `arithmetic: 1 + 2 * 3`, `comparison: x > 100 && y < 50`).

The mechanism is a second, specialised dispatch function selected at `evaluate()` entry based on a program-level flag computed during `decode()`.

## Problem Statement / Motivation

Recent work (`2026-04-17-001`, `2026-04-17-002`, `2026-04-17-003`) has pushed VM loop cost down to the point where the **per-call overhead around the loop** now dominates for short programs. Measurements provided in the request:

- ~35 ns (~61 % of total) per call is setup/teardown around the VM loop (`activation` build, buffer pool checkout, `uintFlags.fill(0)`, `try/finally`).
- For a 4-instruction program that never touches `uint`, zeroing 16 bytes of `uintFlags` plus reading/writing it inside every arithmetic op is pure waste.

The key invariant that makes this safe is currently held by the VM and can be stated precisely. By grep of `src/vm.js`:

| Site | Behaviour |
|---|---|
| `PUSH_CONST` (`src/vm.js:1174`) | writes `uintFlags[sp] = constUintFlags[operand]` — the **only** source of `1` |
| Arithmetic `ADD`/`SUB`/`MUL`/`DIV`/`MOD` (`src/vm.js:1250,1261,1272,1279,1286`) | writes `aIsUint && bIsUint ? 1 : 0` — only produces `1` if both inputs were `1` |
| `NEG` (`src/vm.js:1300`) | writes `0` |
| `LOAD_VAR`, `CALL` (incl. `uint()` conversion), `SELECT`, comprehension ops, etc. | do **not** write `uintFlags` at all; rely on slot being `0` |

Therefore: **if `constUintFlags[i] === 0` for every `i` in the const pool, `uintFlags` is provably all-zero for the whole evaluation.** Reads are redundant (always return 0), writes are redundant (always write 0), and the arithmetic fast-path check (`aIsUint && bIsUint`) is dead.

This property is cheap to compute once at `decode()`: OR-reduce `constUintFlags`.

## Proposed Solution

### Step 1 — Compute `hasUintConsts` at decode time

In `src/bytecode.js` `decode()`, track whether any constant pool entry has `tag === TAG_UINT64`. The loop at `src/bytecode.js:379-413` already visits every const; add one line:

```js
// src/bytecode.js inside the const-decode switch
case TAG_UINT64:
  consts[i] = readBigUint64();
  constUintFlags[i] = 1;
  hasUintConsts = true;  // ← new
  break;
```

Return a new `hasUintConsts: boolean` on the decoded program object. This is pure in-memory state — **no wire-format change** is required. (Wire-format backwards compatibility is stated as non-blocking by the user, but we don't need it anyway since decode is cold and the scan is O(constCount).)

Decode cost impact: one additional boolean assignment per uint constant (none otherwise). Immeasurable; well within the existing decode cache (`2026-04-16-001`) amortisation.

### Step 2 — Duplicate the dispatch loop into a fast path

Add a second function `evaluateDispatchNoUint(program, activation, customFunctionTable, stack)` alongside the existing `evaluateDispatch()`. Differences from the existing function:

| Change | Rationale |
|---|---|
| Drop `uintFlags` parameter | Not needed |
| `PUSH_CONST` handler drops `uintFlags[sp] = constUintFlags[operand]` line | Store is always `0` |
| Arithmetic `ADD`/`SUB`/`MUL`/`DIV`/`MOD` handlers drop both reads (`aIsUint`, `bIsUint`), the `aIsUint && bIsUint && isInt(a) && isInt(b)` fast-path branch, the `checkUintOverflow(...)` arm, and the flag write | Path is provably cold; always takes `celAdd`/`celSub`/… |
| `NEG` handler drops the `if (uintFlags[sp])` check and the `uintFlags[sp] = 0` write | Always non-uint |
| All other opcodes unchanged | |

All non-arithmetic handlers are copied verbatim. The dispatch loop structure (flat `opcodes`/`operands` typed arrays, `while(pc<len) switch(op)`) is preserved per `CLAUDE.md`'s V8 JIT guidance.

### Step 3 — Select dispatch function and elide the fill in `evaluate()`

`src/vm.js:1097-1144` currently does:

```js
pooledUintFlags.fill(0)        // always
…
return evaluateDispatch(program, activation, customFunctionTable, stack, uintFlags)
```

Change to:

```js
const useFastPath = !program.hasUintConsts
…
if (useFastPath) {
  // no fill, no uintFlags allocation for the fallback re-entrant path
  stack = fromPool ? pooledStack : freshStackOnly(requiredCapacity)
  return evaluateDispatchNoUint(program, activation, customFunctionTable, stack)
}
// slow path — existing behaviour, unchanged
pooledUintFlags.fill(0)
…
return evaluateDispatch(program, activation, customFunctionTable, stack, uintFlags)
```

Skip the `fill()` and the `uintFlags` fallback allocation entirely on the fast path. The pool's `uintFlags` buffer stays allocated (module state) but is never touched on fast-path calls — any stale bits in it are harmless because the fast dispatch function never reads them.

When a later slow-path call executes, `fill(0)` zeroes up to `pooledUintFlags.length` bytes as today. **Potential subtle issue** (see Risks): if the pool has grown (via `pooledStack.length` growth at `src/vm.js:1112-1119`) during a fast-path call, the paired `pooledUintFlags` is also grown to match. Confirm the grow logic stays atomic — both buffers must resize together, even on fast-path entry, because a later slow-path call at depth N requires `uintFlags.length ≥ N`.

### Alternative considered and rejected

**Inline branch on `program.hasUintConsts` at each arithmetic op.** A single loop body with `if (hasUintConsts && ...) { uint path } else { plain path }`. Rejected: V8's type-feedback on a hot switch case with an outer-scope constant boolean is reliable in principle, but in practice adds a redundant load and branch on every arithmetic op for *all* programs, including those that do use uint. The clean duplication keeps the fast path strictly smaller than today's loop and the slow path byte-identical.

**Header flag bit in wire format.** An alternative to the decode-time OR-reduce. Rejected for now: same information, more complexity, format bump for no measurable benefit (decode is cold and cached).

**Collapse `evaluateDispatch` / `evaluateDispatchNoUint` via a shared source** (e.g. string template or generator). Rejected: defeats JIT stability. Two concrete, separately-monomorphic functions is the point.

## Revised Strategy: Staged Rollout (added during deepening)

> **This section supersedes the monolithic "duplicate the dispatch" framing above.** After deepening research pushed back on two assumptions — (a) that V8 needs two sibling functions to stay monomorphic here, and (b) that the inner-loop reads are a larger share of the 9 ns than the per-call `fill()` — the right shape is a **staged** rollout. Each phase ships and benchmarks independently. Stop as soon as the measured gain plateaus.

### Phase 0 — Skip `fill(0)` via dirty-tracking (≤5 lines)

The per-call `pooledUintFlags.fill(0)` is likely the **biggest single contributor** to the 9 ns target — it is a 16–64 byte memset that runs on every call regardless of whether any uint arithmetic occurred. Replace with a dirty flag:

```js
// module scope, near `let pooledInUse = false`
let pooledUintFlagsDirty = false

// evaluate() entry (pooled path)
if (pooledUintFlagsDirty) {
  pooledUintFlags.fill(0)
  pooledUintFlagsDirty = false
}

// inside arithmetic op where uint propagates (slow path only)
if (aIsUint && bIsUint) pooledUintFlagsDirty = true
// inside PUSH_CONST
if (constUintFlags[operand]) pooledUintFlagsDirty = true
```

Sets the flag anywhere a `1` is written. On the next call's entry, zero only if dirty. Zero duplication, zero new dispatch, zero opcode cap risk. **Ship this alone first and measure.** If it captures most of the 9 ns (highly plausible), Phase 1 may be unnecessary.

### Phase 1 — Hoisted-guard variant (≤25 lines)

If Phase 0 still leaves meaningful gain on the table, add `hasUintConsts` detection at decode and a hoisted guard inside the existing single dispatch:

```js
function evaluateDispatch(program, activation, customFunctionTable, stack, uintFlags) {
  const { consts, constUintFlags, varTable, opcodes, operands, hasUintConsts } = program
  // ... existing locals ...

  while (pc < len) {
    // ...
    switch (op) {
      case OP.PUSH_CONST: {
        stack[++sp] = consts[operand]
        if (hasUintConsts) uintFlags[sp] = constUintFlags[operand]
        break
      }
      case OP.ADD: {
        if (hasUintConsts) {
          const bIsUint = uintFlags[sp]
          const b = stack[sp--]; const aIsUint = uintFlags[sp]; const a = stack[sp]
          if (aIsUint && bIsUint && isInt(a) && isInt(b)) stack[sp] = checkUintOverflow(a + b)
          else stack[sp] = celAdd(a, b)
          uintFlags[sp] = aIsUint && bIsUint ? 1 : 0
        } else {
          const b = stack[sp--]; const a = stack[sp]
          stack[sp] = celAdd(a, b)
        }
        break
      }
      // ... same pattern for SUB/MUL/DIV/MOD/NEG ...
    }
  }
}
```

`hasUintConsts` is loop-invariant and stored in a local — V8 is highly likely to hoist the branch out of the loop once the function optimises. The guard also makes the hot path (no-uint) structurally smaller: fewer reads, fewer writes, no `checkUintOverflow` branch.

**Why this may be enough:** No published V8 guidance (Ignition, TurboFan, Maglev) endorses duplicating a whole function to "stay monomorphic" — monomorphism happens at inline-cache sites, not function entries. Major JS bytecode interpreters (QuickJS, Hermes) ship unified switch dispatch. The "two sibling functions" claim in the original plan is plausible but unexamined; a hoisted-guard with measured results is the more defensible structure.

### Phase 2 — Full dispatch duplication (escalation only)

Only escalate to the originally-proposed `evaluateDispatchNoUint()` if **both**:
1. Phase 0 + Phase 1 together fall below the user's expected 10–25 % on short rows.
2. Careful `--trace-opt` / `--trace-deopt` inspection shows V8 is not eliminating the hoisted guard (either due to deopts, polymorphism at the `evaluate()` return site, or IC instability).

If escalating, **also duplicate `evaluate()`'s entry** — otherwise the `return useFastPath ? fast(...) : slow(...)` bimorphises the call site and undoes some of the gain.

### Decision gate between phases

After each phase, run the full benchmark methodology (see updated Run-time impact below) and compare against the baseline captured before Phase 0. If a phase yields < 2 % additional gain beyond the previous phase — or introduces any regression on uint programs > ±2 % — do not proceed to the next phase.

## Technical Considerations

### Compile-time impact

- `src/compiler.js`: **no changes**. The compiler continues emitting `TAG_UINT64` const pool entries exactly as today.
- `src/bytecode.js` encode: **no changes**.
- `src/bytecode.js` decode: one extra boolean and one extra assignment per uint constant. Negligible.

### Run-time impact

Must verify with `bun run bench/compare.js` per `CLAUDE.md`. Expected results:

| Row | Fast path applies? | Expected delta |
|---|---|---|
| `arithmetic: 1 + 2 * 3` | yes (all int literals) | +10–25 % (highest, short program) |
| `arithmetic: (x + y) * z` | yes | +5–15 % |
| `comparison: x > 100 && y < 50` | yes | +5–15 % |
| `string: s.contains("world")` | yes | +3–10 % |
| `ternary: x > 0 ? "pos" : "neg"` | yes | +3–10 % |
| `list literal: [1,2,3,4,5]` | yes | +3–8 % |
| `index: list[2]` | yes | +3–8 % |
| `map access: m.x` | yes | +3–8 % |
| `exists / filter / map macros` | yes | +2–6 % (loop amortises) |
| `complex: nested && + comparison` | yes | +3–8 % |
| (hypothetical) `5u + 3u` | **no** | 0 % (slow path, byte-identical) |

No row may regress; slow-path is byte-identical to today.

### Measurement methodology (upgraded during deepening)

The existing `bench/compare.js` harness uses `performance.now()` over 100 000 iterations with 1 000 warmup iterations. At a 9 ns delta on a ~60 ns operation, this is **below the reliable measurement floor** — typical run-to-run stddev on a quiet machine is 1–3 ns, and `performance.now()` resolution in Node/Bun is limited. Observations to address before acceptance-criteria measurement:

1. **Switch short-program rows to `process.hrtime.bigint()`.** Nanosecond-precision monotonic clock. Single change at `bench/compare.js:21-23`: replace `performance.now()` with `process.hrtime.bigint()`, scale accordingly.
2. **Bump iteration count to 1 000 000 for short programs.** A 9 ns delta × 1M iterations = 9 ms signal, which sits well above noise for 100 ms-range totals.
3. **Report median and IQR across 5 runs.** Single-run deltas at this scale are not defensible. Add a `--runs=5` harness option that reports median and inter-quartile range; treat a delta as real only if the 5-run IQR does not cross zero.
4. **Cross-check with `--trace-opt` / `--trace-deopt`.** Run `bun --trace-opt --trace-deopt bench/compare.js 2>&1 | grep evaluate` after Phase 0, 1, 2. Verify the dispatch function(s) stabilise as optimised and do not deopt under benchmark load. A silent deopt would invalidate any claimed delta.
5. **Capture against a known commit.** Checksum the baseline benchmark output against a commit-tagged reference (e.g. commit `9c6860c` head) so future perf work can verify this change's contribution didn't erode.

Treat the existing `bench/compare.js` output as directional, not authoritative, for deltas < 3 %. If the harness upgrade is deferred, raise the short-program gain threshold to ≥ 10 % before declaring victory — delta signals below that are not distinguishable from noise with the current tooling.

### Correctness

The invariant behind the optimisation — "uintFlags stays zero iff no uint const" — must be preserved by any future VM change. Document this at the top of the fast-path function:

```js
// evaluateDispatchNoUint: specialised dispatch for programs whose const pool
// contains no uint64 literals. Relies on the invariant that the ONLY source of
// a `1` in `uintFlags` is `PUSH_CONST` reading from a `constUintFlags[i] === 1`
// entry; every other write is either `0` or a propagation (AND of inputs).
// Adding a new opcode that sets `uintFlags[sp] = 1` breaks this — if you add
// one, either extend `hasUintConsts` detection to the new source, or delete
// this function and route all traffic through `evaluateDispatch`.
```

Parallel, stronger mitigation: add a CI test that asserts `grep -n "uintFlags\[sp\] = 1" src/vm.js` returns nothing (or only lines inside `evaluateDispatch`, never in `evaluateDispatchNoUint`).

### Security

None. The behaviour change is evaluation-semantics-preserving: on the fast path, arithmetic always takes the non-uint branch, which is exactly what today's code does when `aIsUint=0` and `bIsUint=0`. No new inputs, no new error paths.

### Compatibility

- Public API (`evaluate`, `evaluateDebug`, `Environment.evaluate`, `compile`, `toBase64`, `fromBase64`): unchanged.
- TypeScript declarations (`src/index.d.ts`): unchanged.
- Bytecode wire format: unchanged. Existing persisted Base64 / `Uint8Array` bytecodes continue to decode identically and are auto-classified by the new decode-time scan.
- Error semantics: unchanged. Uint overflow errors still raised on the slow path where they matter.

### Hidden-class hygiene for the decoded program object (added during deepening)

Adding a new property (`hasUintConsts`) to the decoded program object mutates its V8 hidden class. The decode cache (`src/index.js:34-41`, `WeakMap`) caches program objects across calls — if some cached programs have the property and others don't, the VM sees a polymorphic shape at property-access sites and the IC degrades. Two mitigations, both cheap:

1. **Set `hasUintConsts` unconditionally in `decode()`, always in the same declaration order**, so every decoded program shares one hidden class. Do not set it conditionally inside the const-pool loop; set it to `false` before the loop and flip to `true` on first uint constant seen. The final return-object literal should list `hasUintConsts` in a fixed position alongside `consts`, `constUintFlags`, `varTable`, `opcodes`, `operands`, `debugInfo`.
2. **Audit the WeakMap cache for pre-existing program objects** decoded before this change lands. If any are held in long-lived scopes across the deployment boundary (e.g. a process that imports the new module but holds a pre-update reference), they will lack `hasUintConsts` and polymorphise the cache. In practice this is a non-issue for a single-process Bun/Node app that restarts to pick up the new code — but document it as an invalidation expectation.

## System-Wide Impact

- **Interaction graph:** `evaluate()` → `evaluateDispatch()` (today). After: `evaluate()` → `evaluateDispatchNoUint()` XOR `evaluateDispatch()`. `Environment.evaluate` routes through the same `evaluate()` entry, so both dispatch variants are reachable through every public API path without additional plumbing.
- **Error propagation:** unchanged. `EvaluationError`s thrown inside either dispatch function still bubble to `evaluate()`'s `try/finally`, which returns pooled buffers correctly.
- **State lifecycle risks:** the module-scoped pool (`pooledStack`, `pooledUintFlags`, `pooledInUse`) is shared between both dispatch variants. Growth on fast-path entry must still resize *both* buffers together (fast path doesn't use `pooledUintFlags`, but a *later* slow-path call would crash if `pooledUintFlags.length < pooledStack.length`). Keep the grow block exactly as today; only skip the `fill()` and only drop the `uintFlags` assignment on the fast path.
- **API surface parity:** `evaluate` and `evaluateDebug` both benefit — `evaluateDebug` wraps `evaluate` today; it will see the same speedup automatically.
- **Integration test scenarios:**
  1. Pure arithmetic on int literals (`1 + 2`, `(x + y) * z`) — fast path; correctness unchanged.
  2. Pure arithmetic on uint literals (`5u + 3u`, `10u * 2u`) — slow path; uint overflow semantics preserved.
  3. Mixed const pool with both int and uint (`1 + 2u`) — slow path; error semantics preserved.
  4. `uint()` conversion without uint literals (`uint(x) + uint(y)`) — fast path. **Behaviour note:** this already does not use the uint fast-path today because `CALL` doesn't set `uintFlags`; the fast path is correctness-preserving here.
  5. Comprehension over uint list — slow path if the comprehension expression references a uint literal, else fast.

## Acceptance Criteria

### Functional

- [ ] `decode()` returns `program.hasUintConsts: boolean` computed from the const pool. — `src/bytecode.js`
- [ ] New `evaluateDispatchNoUint(program, activation, customFunctionTable, stack)` function in `src/vm.js`. — `src/vm.js`
- [ ] `evaluate()` selects dispatch variant based on `program.hasUintConsts`; skips `pooledUintFlags.fill(0)` and skips fallback `new Uint8Array(requiredCapacity)` on the fast path. — `src/vm.js`
- [ ] Existing `evaluateDispatch()` is untouched except for a one-line comment clarifying when it applies. — `src/vm.js`
- [ ] All `bun test` suites pass, same count as baseline.
- [ ] New targeted test (`test/uint-fastpath.test.js` or folded into existing arithmetic tests):
  - [ ] `5u + 3u` evaluates to `8u` (slow path; uint overflow semantics preserved).
  - [ ] `18446744073709551615u + 1u` raises uint overflow error (slow path, preserves today's error).
  - [ ] `1 + 2` evaluates to `3` (fast path).
  - [ ] `uint(x) + uint(y)` with `{x: 1n, y: 2n}` evaluates to `3n` (fast path, matches today's behaviour).
  - [ ] After a fast-path call, a subsequent slow-path call still produces correct uint arithmetic (pool is clean for uint semantics despite having been used by fast-path).

### Performance

- [ ] `bun run bench/compare.js` baseline captured (commit before change) and saved.
- [ ] Post-change benchmark shows no regression on any row (tolerance ±2 %).
- [ ] Short-program rows (`arithmetic: 1 + 2 * 3`, `comparison: x > 100 && y < 50`) show **≥ 5 % improvement**; failure to hit this threshold triggers re-measurement and investigation but is not an auto-abandon — the user-provided 9 ns figure is a plausible floor, not a guarantee.

### Quality

- [ ] `src/vm.js` net growth: ≤ +400 lines (the duplicated dispatch is naturally large; keep it a literal copy minus the uint lines — no refactor bundling).
- [ ] A comment at the top of `evaluateDispatchNoUint` documents the invariant behind the fast path.
- [ ] `IMPLEMENTATION.md` updated — VM section notes the two dispatch variants and when each runs.

## Success Metrics

- **Primary:** ≥ 5 % speedup on `bench/compare.js` short-program rows (`arithmetic: 1 + 2 * 3`, `comparison: x > 100 && y < 50`) per `CLAUDE.md` measurement discipline.
- **Secondary:** no regression (±2 %) on any uint-using benchmark if one exists; if none exists, add one (`5u + 3u` across 100k iterations) to guarantee slow-path coverage in regression checks.
- **Tertiary:** qualitative reduction in per-call overhead (from the reported ~35 ns / 61 % of total toward something closer to ~25–27 ns / 50 %).

## Dependencies & Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Future opcode sets `uintFlags[sp] = 1` outside `PUSH_CONST` | Low | Invariant comment at top of `evaluateDispatchNoUint` (or above the guarded block in Phase 1); optionally a CI grep — but per simplicity review, the comment may suffice |
| `pooledUintFlags` growth path broken by fast-path skipping the field | Medium | Growth logic remains in `evaluate()` entry, runs for BOTH paths; only `fill()` and fallback allocation are skipped |
| V8 fails to monomorphise two dispatch variants because both call the same builtins | Low | Two sibling functions with the same structure should stabilise independently; verify with `bun run bench/compare.js` — if slow-path regresses, reassess |
| Measured win is within benchmark noise | **High at current harness** | `performance.now()` × 100k iters cannot reliably resolve a 9 ns delta. Upgrade harness (see Measurement methodology above) or raise acceptance threshold to ≥ 10 %. |
| `hasUintConsts` detection misses a path (e.g. some other writer of `uintFlags` exists) | **Already audited**: the only source of `1` is `PUSH_CONST` per the grep table above | Make the invariant explicit in code comments; add the CI grep |
| `uint()` builtin conversion produces uint value but doesn't set flag — latent issue | Pre-existing | Out of scope for this plan; noted in test case (4) above |
| **Call-site polymorphism at `evaluate()`'s `return`** (Phase 2 only) | Medium | `return useFastPath ? fast(...) : slow(...)` bimorphises the call site. If Phase 2 is escalated, duplicate `evaluate()`'s entry too — two top-level entry functions selected once by caller (decode-cached) — rather than a branch at the return. Or accept bimorphism and measure. |
| **Hidden-class drift on `program` object** from adding `hasUintConsts` | Medium | Always set `hasUintConsts` in `decode()` (even when `false`), always in the same declaration order, so all program objects share one shape. See "Hidden-class hygiene" in Technical Considerations. |
| **Prior perf plans under-predicted by 10–50×** (`2026-04-17-002` predicted 3–8 %, delivered +156 %/86 %/38 %) | Calibration note | The 10–25 % target here may be conservative — but only with the upgraded benchmark harness can we tell; don't retro-fit the claim. |
| Phase 0 alone captures most of the 9 ns → Phases 1 & 2 deliver < 2 % additional | Medium | Explicit decision-gate between phases (see "Staged Rollout" section). Ship Phase 0 and stop if further phases don't clear the gate. |

## Alternative Approaches Considered

1. **Inline `hasUintConsts` branch in the single existing dispatch.** Rejected — adds per-op overhead for uint-using programs and is less V8-JIT-friendly than two monomorphic functions.
2. **Wire-format flag bit.** Rejected — no benefit; decode already walks constUintFlags.
3. **Eliminate `uintFlags` entirely by type-tagging values with a wrapper on the uint path.** Rejected — much larger scope, regresses the slow path, and contradicts the "avoid boxing" note in `CLAUDE.md`.
4. **Compile-time tracking of uint through variables/CALL results (full uint-flow analysis).** Rejected as out of scope; also largely redundant because LOAD_VAR and CALL currently don't set uintFlags, so users who pass uint values via activation or `uint()` already don't get uint semantics (a separate latent correctness question, not this plan).

## Testing Plan

### Unit tests

Add to `test/uint-fastpath.test.js` (new file) or extend existing arithmetic test:

1. **Fast-path correctness (no uint literals):**
   - `compile('1 + 2 * 3').hasUintConsts === false`
   - `evaluate(bc, {})` → `7n`
2. **Slow-path correctness (uint literal present):**
   - `compile('5u + 3u').hasUintConsts === true`
   - `evaluate(bc, {})` → `8n` (with uint tagging preserved through arithmetic)
3. **Slow-path uint overflow preserved:**
   - `evaluate(compile('18446744073709551615u + 1u'), {})` throws overflow error
4. **Cross-contamination check:**
   - Evaluate a fast-path expression, then a slow-path expression — both correct.
   - Reverse order — both correct.
5. **`uint()` builtin conversion:** `uint(x) + uint(y)` with `{x:1n, y:2n}` → `3n` via fast path. Documents the (pre-existing) behaviour that `uint()` conversion does not propagate the uint tag through arithmetic.
6. **Mixed int + uint literal in one arithmetic expression** *(net-new coverage — no existing test asserts this)*:
   - `compile('1 + 2u').hasUintConsts === true` — must take the slow path.
   - `evaluate(compile('1 + 2u'), {})` and `evaluate(compile('2u + 1'), {})` — confirm today's mixed-numeric error/result semantics are preserved.
7. **Dispatch-path assertion hook:** expose a test-only `__lastDispatchWasFast` module-level flag or wrap the two dispatch functions so tests can confirm **which** path ran. Silent fast-path misrouting of a uint program must be detectable by a unit test, not just by observing a crash or wrong result. One-line module export, gated behind `globalThis.__CEL_VM_TEST__` if preferred.

### Regression tests (existing uint coverage — confirmed slow-path)

The repo-research-analyst confirmed the following tests exercise uint and will all route to the slow path unchanged:

- `test/cel-spec.test.js:647-651` — `'42u + 2u', 44n` / `'40u * 2u', 80n` / `'42u % 5u', 2n` / `'75u + 15u == 15u + 75u', true`
- `test/cel-spec.test.js:641-643` — uint overflow (`'18446744073709551615u + 1u'`, `'0u - 1u'`, `'5000000000u * 5000000000u'`) — all assert error
- `test/vm-pool.test.js:124` — `compile('1u + 2u')` interleaved with int programs (critical cross-contamination guard already present)
- `test/marcbachmann/comparisons.test.js:46-117` — `uint()` conversion comparisons (use `<`/`<=` etc., never uint arithmetic fast-path today)

No pre-existing test exercises int + uint literal mixing in a single arithmetic expression — **add case 6 above**.

### Regression tests

- Full `bun test` run — entire existing suite must remain green.
- Spot-check conformance tests that touch uint: `test/cel-spec/` — identify any `.test.js` exercising uint arithmetic and confirm unchanged behaviour.

### Performance verification

Per `CLAUDE.md` rule:

```bash
# Baseline (before changes)
git stash
bun run bench/compare.js | tee bench-before.txt

# After changes
git stash pop
bun run bench/compare.js | tee bench-after.txt

# Compare
diff bench-before.txt bench-after.txt
```

Record both output files in the PR description; call out per-row deltas for the short-program cases specifically.

## Implementation Sketch (structural only — not final code)

### `src/bytecode.js` — decode()

```js
// Near top of decode(), after checksum validation
let hasUintConsts = false;

// Inside the const-decode loop, the TAG_UINT64 arm:
case TAG_UINT64:
  consts[i] = readBigUint64();
  constUintFlags[i] = 1;
  hasUintConsts = true;
  break;

// Return:
return { consts, constUintFlags, hasUintConsts, varTable, opcodes, operands, debugInfo };
```

### `src/vm.js` — evaluate() entry

```js
export function evaluate(program, activation, customFunctionTable) {
  const fromPool = !pooledInUse
  const len = program.opcodes.length
  const requiredCapacity = len > STACK_MAX_CAPACITY
    ? STACK_MAX_CAPACITY
    : (len < STACK_MIN_CAPACITY ? STACK_MIN_CAPACITY : len)

  const useFastPath = !program.hasUintConsts

  let stack, uintFlags
  if (fromPool) {
    pooledInUse = true
    // Grow logic unchanged — both buffers resize together regardless of path.
    if (pooledStack.length < requiredCapacity) { /* … grow both … */ }
    else if (!useFastPath) {
      pooledUintFlags.fill(0)   // skipped on fast path
    }
    stack = pooledStack
    uintFlags = useFastPath ? null : pooledUintFlags
  } else {
    stack = new Array(requiredCapacity)
    for (let i = 0; i < requiredCapacity; i++) stack[i] = undefined
    uintFlags = useFastPath ? null : new Uint8Array(requiredCapacity)
  }

  try {
    return useFastPath
      ? evaluateDispatchNoUint(program, activation, customFunctionTable, stack)
      : evaluateDispatch(program, activation, customFunctionTable, stack, uintFlags)
  } finally {
    if (fromPool) {
      for (let i = 0; i < stack.length; i++) stack[i] = undefined
      pooledInUse = false
    }
  }
}
```

### `src/vm.js` — evaluateDispatchNoUint()

A near-verbatim copy of `evaluateDispatch()` with the changes listed in **Step 2** above. Start from the existing function, make the stripped edits, stop. No refactoring, no bundling, no collapsing back into one function.

### Files touched

| File | Change |
|---|---|
| `src/bytecode.js` | +2 lines in `decode()` (track `hasUintConsts`, add to return shape, always in same key order for hidden-class stability). Line ~391–393 for the flip, line ~454 for the return literal. |
| `src/vm.js` | **Phase 0:** ≤5 lines (dirty-tracking flag on `pooledUintFlags.fill`). **Phase 1:** ≤25 lines (hoisted-guard variant inside existing dispatch). **Phase 2 (if escalated):** +~450 lines duplicated dispatch + ~10 in `evaluate()` entry. |
| `src/vm.js:1093` | **JSDoc update** — add `hasUintConsts: boolean` to the program shape comment. Originally missed; caught during deepening. |
| `test/uint-fastpath.test.js` | New test file, ~80 lines (6 test cases + dispatch-path assertion hook). |
| `test/vm-pool.test.js` | Possibly one added case exercising a mixed int+uint literal interleaved with the existing `1u + 2u` cross-contamination guard (belt-and-braces — avoids a second test file if preferred). |
| `IMPLEMENTATION.md:149` | **Revise**, not append. The current line states `PUSH_CONST` writes `uintFlags[sp]` unconditionally — becomes path-dependent under Phase 1/Phase 2. Caught during deepening. |
| `bench/compare.js` | Optional: upgrade to `process.hrtime.bigint()` + 1 M iterations for short rows + 5-run median/IQR reporting. Blocker for defending a < 3 % delta claim; skippable if gain is > 10 %. |

### Files NOT touched

- `src/compiler.js` — no changes.
- `src/index.js` / `src/environment.js` — public API unchanged; decode cache (`WeakMap`) in `src/index.js:34-41` passes program objects through transparently (confirmed).
- `src/index.d.ts` — no TypeScript surface change.
- Bytecode wire format — unchanged.
- `src/vm.js` `evaluateDebug` (`src/vm.js:1641-1656`) — delegates to `evaluate()`, benefits automatically (confirmed).

## Sources & References

### Origin / prior work (internal)

- `docs/plans/2026-04-17-002-perf-pool-evaluate-stack-buffers-plan.md` — established pooled buffers with `fill(0)` reset; this plan elides that fill for a large class of programs.
- `docs/plans/2026-04-17-003-refactor-tagless-const-pool-plan.md` — introduced `constUintFlags: Uint8Array`; the detection in this plan OR-reduces that same array.
- `docs/plans/2026-04-17-001-refactor-flatten-vm-dispatch-typed-arrays-plan.md` — established the flat-typed-array dispatch pattern that both `evaluateDispatch` variants will share.
- `docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md` — decode cache ensures the O(constCount) OR-reduce runs once per unique program.

### Code references

- `src/vm.js:1097-1144` — `evaluate()` entry (target of the dispatch-selection change).
- `src/vm.js:1146` — `evaluateDispatch()` entry (keep, untouched).
- `src/vm.js:1174` — `PUSH_CONST` handler (only source of `uintFlags[sp] = 1`).
- `src/vm.js:1243-1287` — arithmetic handlers (primary beneficiaries of the fast path).
- `src/vm.js:1295-1300` — `NEG` handler (the one uint read outside arithmetic).
- `src/bytecode.js:375-413` — const-pool decode (site of `hasUintConsts` tracking).
- `bench/compare.js` — performance verification harness per `CLAUDE.md`.

### Project rules

- `CLAUDE.md` — "Performance analysis required: analyse impact on both compile-time and run-time. Run `bun run bench/compare.js` before and after."
- `CLAUDE.md` — "VM is a plain function, not a class, for V8 JIT." A second sibling function preserves this pattern.
- `CLAUDE.md` — "Opcode set is capped at ~30–50 opcodes." Unchanged here — no new opcodes.

### Scope boundaries (explicit non-goals)

- Not tackling the broader ~35 ns per-call overhead items (activation array build, `try/finally`, pool checkout) — each warrants its own plan.
- Not tackling `uint()`-conversion-loses-uint-tag (pre-existing semantics question).
- Not collapsing the two dispatch functions via a source-level template.
