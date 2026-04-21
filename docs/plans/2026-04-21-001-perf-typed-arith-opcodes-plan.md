---
title: Typed arithmetic opcodes (MUL_DOUBLE, ADD_INT, ...)
type: perf
status: completed
date: 2026-04-21
deepened: 2026-04-21
---

# Typed arithmetic opcodes

## Enhancement Summary

**Deepened on:** 2026-04-21
**Agents used:** performance-oracle, architecture-strategist, pattern-recognition-specialist, code-simplicity-reviewer, best-practices-researcher (V8 JIT / bytecode VM design).

### Key Refinements

1. **Start smaller (MVP-first):** ship 3 opcodes in PR1 (`ADD_DOUBLE`, `MUL_DOUBLE`, `ADD_INT`) to de-risk and prove the gain; expand one opcode at a time in follow-up PRs with their own bench deltas. Full Tier-1 (13 opcodes) remains the eventual target but is no longer Phase-1 scope. See revised **Implementation Plan** below.
2. **Realistic gain estimate lowered from 5–15% to 3–7%.** The retained `isError(a)/isError(b)` check at each specialized case is a compound `null + typeof + property-load` that costs ~0.8–1.2 ns combined per op. The bare `typeof` chain saves ~2.0–2.5 ns, not 3.3 ns.
3. **INT wins are likely small; DOUBLE wins dominate.** Per V8 research (see Research Insights below), `BigInt + BigInt` is 20–100× slower than `Number + Number` due to heap allocation on every result. Eliminating typeof dispatch on BigInt paths is negligible relative to the BigInt op cost. **Measure SMI/double/BigInt workloads separately** — don't assume int gains mirror double gains.
4. **Comparisons (EQ/LT/etc.) are higher-ROI than `MOD_INT`/`SUB_UINT`/`MUL_UINT`.** `celEq` / `celLt` have 10+ typeof branches; comparisons are ubiquitous in CEL predicates. **Drop** `MOD_INT`, `SUB_UINT`, `MUL_UINT` from Tier-1. **Add a follow-up plan stub** for `EQ_INT`/`EQ_DOUBLE`/`LT_INT`/`LT_DOUBLE` (and `CONCAT_STR` for string-heavy paths).
5. **V8 JIT deopt risk on `evaluate()` function-size growth.** Adding 13 cases × ~8 lines risks pushing the function across V8's `--max-optimized-bytecode-size` (~60KB). **Gate merge** on `--trace-opt --trace-deopt` showing `evaluate` remains optimized. If deopt appears, extract per-op helpers or defer later opcodes.
6. **Case-body style must match existing VM code.** Existing arithmetic uses compact `const b = stack[sp--]; const a = stack[sp]` one-liners (`src/vm.js:1242-1302`), not the multi-line style in the original plan. Revised case examples below.
7. **Don't mutate AST nodes.** Use `Map<node, type>` for inference cache instead of `node._celType`; the codebase has no precedent for AST mutation.
8. **Checker-migration path.** Name the inference helper `inferNumericType` and add a `// TODO: migrate to checker when type-inference pass lands` banner — CLAUDE.md's "type inference" is aspirational, and lifting inference into the checker is a likely future move.
9. **Drop version-bump ceremony.** User stated bytecode incompatibility is acceptable. Skip the explicit `VERSION` bump, migration note, and version-rejection test. Unknown opcodes will produce a natural decode error — that's sufficient.
10. **Merge tests into existing files** (`test/marcbachmann/arithmetic.test.js`, `test/int64-overflow.test.js`) rather than adding `test/typed-arith-opcodes.test.js`. Skip the fuzz test — existing suites cover correctness.
11. **Bench protocol expanded.** `bench/compare.js` alone is inadequate (masks per-opcode deltas). Add: per-opcode microbench, SMI/double/BigInt workloads separately, both Bun and Node, median-of-5.
12. **CLAUDE.md opcode-cap comment is folklore.** V8's Ignition dispatches 200+ opcodes successfully. Real risk is megamorphic ICs per handler, not case count. After landing, update CLAUDE.md to cite the measured 60-opcode datapoint.

### New Considerations Discovered

- **`uintFlags[sp]` error-path stale leak:** specialized cases that exit early on `isError` must still normalize `uintFlags[sp]` (or argue why it's safe). An uint result slot left `= 1` when the value is a `celError` could mislead a downstream op.
- **`ADD_UINT`/`SUB_UINT`/`MUL_UINT` are the first non-`PUSH_CONST` ops to write `uintFlags[sp] = 1`** (existing arithmetic sets it ternary; `NEG` clears to 0). New correctness surface — needs a dedicated test.
- **Architectural debt from helper duplication:** keeping generic `celAdd`/`celMul`/etc. alongside inlined specialized cases duplicates overflow/error logic. Consider factoring module-local arrow helpers (`addIntPath`, `mulDoublePath`, ...) that both the generic `ADD` opcode and the specialized `ADD_INT` opcode call — V8 inlines small local functions reliably.
- **Peephole follow-up:** operands produced by typed arithmetic or numeric literals are provably non-error. A future `ADD_INT_UNCHECKED` that skips `isError` could double the savings.
- **Real-world VM precedent:** QuickJS and Wren use single polymorphic opcodes + tag dispatch; V8 Ignition uses per-site IC feedback. Multiplying typed opcodes at compile time is justified here **only because** CEL's checker can statically prove types — without that guarantee, the approach would regress. This validates the plan's direction but bounds its applicability to statically-known-type subtrees.

## Overview

Replace the generic arithmetic opcodes (`ADD`, `SUB`, `MUL`, `DIV`, `MOD`, `NEG`) with type-specialized variants (`ADD_DOUBLE`, `ADD_INT`, `ADD_UINT`, `MUL_DOUBLE`, ...) emitted by the compiler when operand types are statically known. Specialized opcodes inline the single relevant arithmetic branch directly in the VM dispatch switch, eliminating the ~6-branch `typeof` chain inside `celAdd`/`celSub`/`celMul`/... that currently costs ~3.3 ns (~6% of total) per arithmetic op.

This is the re-evaluation of "Option B" rejected in `docs/plans/2026-04-17-003-refactor-tagless-const-pool-plan.md:87-101`, and the continuation of Phase-2 target #4 (monomorphic dispatch) from `docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md:132-143`. Prior plans deferred this work pending residual dispatch overhead evidence; that evidence now exists.

Bytecode incompatibility is acceptable — a wire format version bump is part of the plan.

## Problem Statement / Motivation

Profiling places ~3.3 ns per arithmetic op inside the helper-function dispatch chain:

```js
// src/vm.js:152-159 (celMul)
function celMul(a, b) {
  if (isError(a)) return a           // 1. typeof/object shape
  if (isError(b)) return b           // 2. typeof/object shape
  if (isInt(a) && isInt(b)) ...      // 3-4. typeof bigint × 2
  if (isNum(a) && isNum(b))          // 5-6. typeof number × 2
    return a * b
}
```

Six typeof checks + a function call reduces to `a * b` in the overwhelmingly common `double × double` case. The compiler already knows the operand types at many call sites (literals, declared-typed variables, results of other typed ops). Moving the dispatch from run-time to compile-time collapses each arithmetic op to the bare inline expression.

cel-js's tree-walker solves the same problem by resolving `ast.staticHandler` once at check time. Our equivalent is emitting the right opcode at compile time.

## Proposed Solution

**Compile-time type inference, VM-side specialization.**

1. **Add a lightweight type-inference step in the compiler** (not the checker — matches existing constant-folding precedent at `src/compiler.js:582,587` which already distinguishes `IntLit`/`FloatLit` numerics). Infer a `celType ∈ {int, uint, double, dyn}` for numeric AST nodes.

2. **Emit specialized opcodes** for the hot combinations (`int+int`, `uint+uint`, `double+double`, and the int/uint neg variants). Fall back to the generic opcode for mixed types, non-numeric overloads (`list + list`, `bytes + bytes`, timestamp/duration math), and `dyn`.

3. **Add specialized opcode cases to the VM dispatch switch.** Each case inlines the single relevant branch from `celAdd`/etc. (including required `checkIntOverflow` / `checkUintOverflow` / div-by-zero / `isError` propagation).

4. **Bump bytecode version.** Wire format unchanged (still 1-byte opcode + 0 operands), only opcode IDs change.

## Technical Considerations

**Opcode budget.** Current opcode count is 47 (`src/bytecode.js:24-35`). CLAUDE.md notes a ~30–50 cap for V8 branch predictor health. Naive full matrix (6 ops × 3 numeric types = 18 opcodes) lands at 65, above the cap. **Scope to the hot subset first** and reassess: see "Opcode Selection" below.

**Checker currently has no type inference.** `src/checker.js:446` is a 3-line stub; CLAUDE.md's mention of "type inference + CEL macro expansion" describes intent, not reality. We will **not** build a full type-inference pass for this plan. Instead, do inline inference in the compiler during walk, matching the shape of `foldConstant` at `src/compiler.js:582-620`. This keeps scope tight and avoids a separate checker phase.

**Overflow semantics are load-bearing.** `ADD_INT`/`SUB_INT`/`MUL_INT`/`NEG_INT`/`POW_INT` must call `checkIntOverflow`. `ADD_UINT`/`SUB_UINT`/`MUL_UINT`/`POW_UINT` must call `checkUintOverflow`. `SUB_UINT` must also detect underflow (`b > a` case in BigInt). `DIV_INT`/`MOD_INT`/`DIV_UINT`/`MOD_UINT` must check for divide-by-zero. `NEG_INT` must error on `INT64_MIN` (already handled by `checkIntOverflow(-a)`). `NEG_UINT` must always error (no negation of uint per CEL spec — already rejected by current NEG at `src/vm.js:1294-1300`, so no `NEG_UINT` opcode is needed).

**Error propagation still needs `isError` checks.** A `MUL_DOUBLE` on operands produced by upstream ops could still receive a `celError` object if an earlier op failed. Match the existing celMul pattern: `if (isError(a)) return a; if (isError(b)) return b;` at the top of each specialized case. This costs one object-shape test — much cheaper than the 6-typeof chain but not free. Alternative (sideband error flag) is more invasive; defer to a future plan.

**UintFlags maintenance.** The existing parallel `uintFlags: Uint8Array` tracks uint-ness of each stack slot (`src/vm.js:1242-1302`). Specialized opcodes must continue to set/clear this flag correctly on the result slot. `ADD_UINT`/etc. set the flag; `ADD_DOUBLE`/`ADD_INT` clear it. The existing uint fastpath in the generic `ADD`/`SUB`/`MUL` cases becomes dead code at those sites where the compiler emitted `ADD_UINT` — but is retained for `dyn`-typed fallback.

**V8 JIT impact.** Adding ~12–18 switch cases to the dispatch loop is within V8's handling capacity per `docs/plans/2026-04-17-001-refactor-flatten-vm-dispatch-typed-arrays-plan.md` evidence. The recently flattened typed-array dispatch (commit 389d4b4) monomorphizes reads; adding cases of identical shape to existing arithmetic cases should keep the switch table inlineable. Verify via benchmark.

**Double constants and the uint flag.** `constUintFlags` (from tagless const pool, commit 9c6860c) is already populated at decode. `PUSH_CONST` of a double literal clears it; uint literal sets it. Type inference inside the compiler uses the `IntLit`/`UintLit`/`FloatLit` AST node kind directly — no extra state needed.

## Opcode Selection

### Revised staging (post-deepen)

**Phase-1 MVP (3 opcodes, 47→50 total):**

- `ADD_DOUBLE`, `MUL_DOUBLE` — highest-confidence wins; directly covers the bench expression `1 + 2 * 3` (parsed as doubles when literals are floats; int path is separate)
- `ADD_INT` — validates the int/BigInt path and measures whether BigInt ops dominate the remaining cost (per V8 research, they likely do)

Ship Phase-1 in a single PR with before/after `bun run bench/compare.js` plus per-op microbench numbers. If gain ≥ 3%, expand. If gain < 3%, **stop and reassess** — the design may need sideband error flags or comparison-opcode specialization before arithmetic-opcode expansion is worth it.

**Phase-2 follow-up opcodes (one PR per opcode, each with its own bench delta):**

- `SUB_DOUBLE`, `DIV_DOUBLE`, `NEG_DOUBLE` — likely net wins, confirm individually
- `SUB_INT`, `MUL_INT`, `NEG_INT` — BigInt paths; measure first (BigInt op cost may dominate)
- `ADD_UINT`, `SUB_UINT`, `MUL_UINT` — only if uint expressions appear in real workloads

**Explicitly dropped from earlier Tier-1:**

- `MOD_INT` — modulo rare in CEL predicates/filters
- `MOD_UINT`, `DIV_INT`, `DIV_UINT` — confirmed rare; generic path adequate
- `POW_INT`/`POW_DOUBLE` — POW is rare; generic path fine

**Higher-ROI follow-ups (separate plan, not this one):**

- `EQ_INT`, `EQ_DOUBLE`, `EQ_STR`, `LT_INT`, `LT_DOUBLE` — `celEq` / `celLt` have 10+ typeof branches and comparisons dominate CEL predicates; likely larger gain than the remaining arithmetic opcodes combined
- `CONCAT_STR` — string concatenation via `ADD` currently typeof-chains through int/num before reaching string

**Not specialized (kept generic forever):**

- `list + list`, `bytes + bytes`, `string + string`, timestamp/duration arithmetic, mixed-type operands, any `dyn` path

## Implementation Plan

### PR 1 — MVP (3 opcodes)

Files: `src/compiler.js`, `src/vm.js`, `src/bytecode.js`, `test/marcbachmann/arithmetic.test.js`, `test/int64-overflow.test.js`, `bench/compare.js` (add microbench rows).

**One-step emission + dispatch:**

1. **Inference as a tiny on-demand helper** (not a pre-pass, no AST mutation):
   ```js
   // Not cached; computed at emit time. Returns 'int' | 'uint' | 'double' | null.
   function numericKind(node) {
     if (node.type === 'IntLit') return 'int'
     if (node.type === 'UintLit') return 'uint'
     if (node.type === 'FloatLit') return 'double'
     if (node.type === 'Binary') return node._resultKind || null
     if (node.type === 'Unary' && node.op === '-') return numericKind(node.operand)
     return null  // includes Ident, Call, etc. — conservative fallback to generic opcode
   }
   ```
   `node._resultKind` is populated by `emitBinaryOp` after it decides to emit a specialized opcode — it's a "result-type tag" produced in-line with emission, not a pre-pass. Stored on the Binary node only for this purpose. If AST mutation is unacceptable, replace with a local `Map<node, kind>` scoped to `compileProgram`.

2. **In `emitBinaryOp`** (`src/compiler.js:550-577`), after `tryFoldBinary` returns null:
   ```js
   const lk = numericKind(left), rk = numericKind(right)
   if (op === '+' && lk === 'double' && rk === 'double') { emit(OP.ADD_DOUBLE); node._resultKind = 'double'; return }
   if (op === '*' && lk === 'double' && rk === 'double') { emit(OP.MUL_DOUBLE); node._resultKind = 'double'; return }
   if (op === '+' && lk === 'int' && rk === 'int')       { emit(OP.ADD_INT);    node._resultKind = 'int';    return }
   // fall through to generic emit(OP.ADD) / OP.MUL
   ```

3. **Opcodes** in `src/bytecode.js`:
   - Add `ADD_DOUBLE`, `MUL_DOUBLE`, `ADD_INT` (3 new IDs, 47→50).
   - Extend `OPERAND_WIDTH` and `SIGNED_OPERAND` to size 64 (`new Uint8Array(64)`) to leave headroom for follow-ups without re-growing.
   - No wire-format version bump. Opcode IDs will shift; old cached bytecode will fail naturally on unknown opcode — error is "unknown opcode N" which is sufficient per user requirements.

4. **VM dispatch** in `src/vm.js` — match existing arithmetic case-body style (compact one-liner at `src/vm.js:1242-1302`):
   ```js
   case OP.ADD_DOUBLE: {
     const b = stack[sp--]; const a = stack[sp]
     if (isError(a)) { uintFlags[sp] = 0; break }
     if (isError(b)) { stack[sp] = b; uintFlags[sp] = 0; break }
     stack[sp] = a + b
     uintFlags[sp] = 0
     break
   }
   case OP.MUL_DOUBLE: {
     const b = stack[sp--]; const a = stack[sp]
     if (isError(a)) { uintFlags[sp] = 0; break }
     if (isError(b)) { stack[sp] = b; uintFlags[sp] = 0; break }
     stack[sp] = a * b
     uintFlags[sp] = 0
     break
   }
   case OP.ADD_INT: {
     const b = stack[sp--]; const a = stack[sp]
     if (isError(a)) { uintFlags[sp] = 0; break }
     if (isError(b)) { stack[sp] = b; uintFlags[sp] = 0; break }
     stack[sp] = checkIntOverflow(a + b)
     uintFlags[sp] = 0
     break
   }
   ```
   The `uintFlags[sp] = 0` assignment is present on every exit path (including error paths) to prevent stale-flag leak — see "uintFlags error-path normalization" under New Considerations.

5. **Tests** — inline into existing files:
   - `test/marcbachmann/arithmetic.test.js`: add emission-assertion helpers that decode emitted bytecode and verify `ADD_DOUBLE`/`MUL_DOUBLE`/`ADD_INT` appear where expected and that `dyn + dyn` still emits generic `ADD`.
   - `test/int64-overflow.test.js`: verify `INT64_MAX + 1` under `ADD_INT` still errors.
   - Add a `(a + b) + 1.0` test (int result → double op) confirming `uintFlags[sp]` is correctly `0` after the second add.
   - Do NOT add `test/typed-arith-opcodes.test.js` — keep it colocated.

6. **Bench** — extend `bench/compare.js`:
   - Add SMI-only row: `1 + 2 * 3` (all IntLit → currently emits generic ADD/MUL; after PR1 emits `ADD_INT` inside `MUL_INT`-gap-filled-by-generic).
   - Add double-only row: `1.5 + 2.5 * 3.0` (all FloatLit → emits `ADD_DOUBLE` inside `MUL_DOUBLE`).
   - Run median-of-5, both on Bun and Node, capture in PR body.

7. **V8 deopt verification — MERGE GATE:** run `node --trace-opt --trace-deopt bench/compare.js 2>&1 | grep -E '(evaluate|deoptimizing)'`. The `evaluateDispatch` function must remain in the optimized list with no deopt events during steady-state (post-warmup). If deopt appears, investigate before merge.

**Commit boundary:** PR1 lands as a single PR. Do not expand before PR1 is green, merged, and the bench gain is documented.

### PR 2+ — Expansion (one opcode per PR)

Once PR1 is merged and establishes the approach, add opcodes one at a time in the order below. Each PR is small (~20 LOC), has its own bench delta in the body, and is independently revertable.

**Order (by expected ROI):**

1. `SUB_DOUBLE`, `DIV_DOUBLE`, `NEG_DOUBLE` — double path extensions
2. `SUB_INT`, `MUL_INT`, `NEG_INT` — int/BigInt path extensions (likely smaller gain per V8 research; confirm individually)
3. `ADD_UINT`, `SUB_UINT`, `MUL_UINT` — uint variants (only if uint expressions appear in real workloads)

**Abort criteria:** if any PR shows <1% gain on its target workload, close it and do not continue the expansion — the remaining opcodes are unlikely to be worth the opcode-space cost. Open the follow-up plan for comparison opcodes or sideband error flags instead.

### Separate follow-up plans (not this plan)

- **Comparison opcodes** (`EQ_INT`, `EQ_DOUBLE`, `LT_INT`, `LT_DOUBLE`, etc.) — `celEq` / `celLt` have 10+ typeof branches and comparisons are ubiquitous in CEL predicates. Per performance-oracle review, this is likely higher-ROI than most remaining arithmetic expansions.
- **Sideband error flag** (parallel `errorFlags: Uint8Array` analogous to `uintFlags`) — would let specialized opcodes skip `isError` checks entirely, potentially doubling the per-op gain. Invasive refactor deferred pending arithmetic-opcode evidence.
- **String concatenation opcode** (`CONCAT_STR`) — `celAdd`'s typeof chain currently walks int/num before reaching string.
- **Peephole unchecked variants** (`ADD_INT_UNCHECKED`, etc.) — when both operands are provably non-error (output of typed arithmetic or numeric literal), skip `isError`. Requires a cross-op peephole pass.
- **Factor shared overflow-path helpers** — invert the `celAdd` → inline relationship so that a module-local `addIntPath(a,b)` arrow is the single source of truth, called from both the generic `ADD` opcode and the `ADD_INT` opcode. Addresses the duplication architectural debt noted by architecture-strategist review.

## System-Wide Impact

- **Interaction graph**: Compiler → emits opcode with specialized variant when types known → VM dispatch switch → inlined arithmetic. Affects: `src/compiler.js`, `src/vm.js`, `src/bytecode.js`. Not affected: lexer, parser, checker (no changes), public API.
- **Error propagation**: `celError` objects still flow through the stack. Each specialized case checks `isError(a) || isError(b)` and skips compute. Behavior identical to current `celAdd`/etc. at the helper entry.
- **State lifecycle risks**: `uintFlags[sp]` must be set/cleared correctly in every specialized case. A bug here leaks a stale uint flag into a subsequent op. Mitigation: audit every Tier-1 opcode case for `uintFlags[sp] = 0` or `= 1` on the result slot; add a specific test that checks `(a + b) + 1.0` correctly treats the intermediate int result and final double result.
- **API surface parity**: No external API change. Bytecode version bump invalidates cached bytecode in `localStorage`/DB — document migration in IMPLEMENTATION.md.
- **Integration test scenarios**:
  1. Mixed-type expression like `int_var + double_lit` (with `dyn int_var`) — must fall back to generic `ADD`, not emit `ADD_INT`.
  2. Nested typed: `(a + b) * c` with all int — emits `ADD_INT`, `MUL_INT`; intermediate overflow correctly detected.
  3. Short-circuit with error: `false && (INT64_MAX + 1)` — must return false without materializing the overflow error (reuses `test/int64-overflow.test.js` precedent).
  4. Cached bytecode invalidation: old base64 v1 bytecode → clear error on decode.

## Acceptance Criteria (PR1)

- [ ] Three opcodes (`ADD_DOUBLE`, `MUL_DOUBLE`, `ADD_INT`) added to `src/bytecode.js`
- [ ] `OPERAND_WIDTH` and `SIGNED_OPERAND` grown to `Uint8Array(64)` (future headroom)
- [ ] Compiler emits specialized opcode when both operand kinds resolve to the target numeric type; emits generic otherwise
- [ ] VM dispatch cases match the compact one-liner style of existing arithmetic cases
- [ ] `uintFlags[sp]` explicitly normalized to `0` on every exit path (including error paths)
- [ ] All existing tests pass (`bun test` green)
- [ ] Emission-assertion tests added to `test/marcbachmann/arithmetic.test.js`
- [ ] `bun run bench/compare.js` shows ≥ 3% gain on the double-heavy and int-heavy arithmetic rows, no regression > 2% elsewhere (median of 5 runs, Bun and Node)
- [ ] `node --trace-opt --trace-deopt bench/compare.js` shows `evaluateDispatch` remains optimized, no deopt events post-warmup

## Success Metrics (PR1)

- **Primary**: double-heavy bench (`1.5 + 2.5 * 3.0`) gains ≥ 3%. Stretch: ≥ 5%. Realistic range per deepen research: 3–7% (not the earlier 5–15% estimate).
- **Secondary**: int-heavy bench (`1 + 2 * 3` as IntLit) gain measurable — but expect smaller than double case due to BigInt op dominance. If gain is < 1% for int, that's a signal to deprioritize int-variant expansion in PR2+.
- **Tertiary**: no regression > 2% on non-arithmetic benches (`comparison`, `string`, `list`, `macro`). Specifically check `equality (a == b)` — if it regresses, dispatch-table size is the cause and comparison-opcode follow-up becomes urgent.
- **Quaternary**: `evaluateDispatch` remains optimized under V8 (verified via `--trace-opt`).

## Dependencies & Risks

- **Risk — V8 TurboFan deopt** (SEV-1): adding cases grows `evaluateDispatch` byte-size. If the function crosses V8's `--max-optimized-bytecode-size` threshold, TurboFan may bail out and **all** opcodes regress catastrophically. **Mitigation:** PR1's 3-opcode scope keeps growth minimal; merge gate on `--trace-opt` evidence. If deopt appears in PR1 or any PR2+ step, extract specialized arithmetic into a smaller per-opcode-group helper function and confirm V8 inlines it.
- **Risk — BigInt op cost dominates** (likely): per V8 research, `BigInt + BigInt` is 20–100× slower than `Number + Number` due to heap allocation. Int specialization may show ≤ 1% gain. **Mitigation:** PR1 includes an int opcode specifically to measure this; if gain is tiny, deprioritize int expansion in favor of comparison-opcode follow-up plan.
- **Risk — inference correctness**: emitting a typed opcode for operands that aren't actually that type at run-time would produce wrong results. **Mitigation:** `numericKind()` returns non-null only for definite literal/typed-result cases; `Ident` returns `null` (falls through to generic). The conservative-null path makes false positives impossible — false negatives (missed optimization) are acceptable. Covered by the "dyn + dyn emits generic" assertion test.
- **Risk — `uintFlags[sp]` stale-flag leak**: specialized cases that short-circuit on `isError` must still write `uintFlags[sp]`. **Mitigation:** every case example in this plan writes `uintFlags[sp] = 0` on every exit path; enforce via code review and a test for `(1u + 2u) * dyn_x` mixed-flag flow.
- **Risk — error-propagation overhead caps the gain**: retaining `isError` at every specialized case is a compound `null + typeof + property-load` check (~0.8–1.2 ns combined). This erodes the 3.3 ns typeof-chain savings. **Mitigation:** measured; if gain is below the 3% threshold in PR1, open the sideband error flag plan before continuing arithmetic opcode expansion.
- **Risk — cached bytecode invalidation**: users with persisted base64 bytecode will fail with "unknown opcode N" when loading post-landing. **Mitigation:** acceptable per user requirement. No version-bump ceremony needed — the unknown-opcode error is natural and sufficient. Document briefly in `IMPLEMENTATION.md` that bytecode caches should be invalidated on upgrade.
- **Dependency**: none external. Landed commits through 9c6860c are the baseline.

## Alternative Approaches Considered

1. **Full checker type-inference pass**: Rejected for this plan. Too invasive for the scoped gain. Compiler-side inference is sufficient for numeric-only specialization and matches existing constant-folding precedent.
2. **Single `NUMERIC_FAST` opcode with internal branch**: Rejected — still has a typeof check in the hot path, defeating the purpose.
3. **Sideband error flag** (analogous to `uintFlags`): Potential future work. Would allow specialized opcodes to skip `isError` checks entirely. Deferred — measure first.
4. **Resolving `staticHandler` on the AST a la cel-js**: Rejected — our model is bytecode, not tree-walk; the opcode itself is our staticHandler.

## Sources & References

### Internal

- **Prior plan (rejected Option B)**: `docs/plans/2026-04-17-003-refactor-tagless-const-pool-plan.md:87-101` — explicitly flagged this work for a future plan with format bump.
- **Phase-2 roadmap origin**: `docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md:132-143` — "monomorphic dispatch" target.
- **Flat dispatch precedent**: `docs/plans/2026-04-17-001-refactor-flatten-vm-dispatch-typed-arrays-plan.md` (commit 389d4b4) — typed-array dispatch evidence.
- **Stack-pooling precedent**: `docs/plans/2026-04-17-002-perf-pool-evaluate-stack-buffers-plan.md` (commit 3e1ec1e).
- **Current opcodes**: `src/bytecode.js:24-35`.
- **Current arithmetic helpers**: `src/vm.js:98-194` (`celAdd`/`celSub`/`celMul`/`celDiv`/`celMod`/`celPow`/`celNeg`).
- **Current arithmetic dispatch**: `src/vm.js:1242-1302`.
- **uintFlags write precedent**: `src/vm.js:1174` (PUSH_CONST), `src/vm.js:1300` (NEG clears to 0).
- **Constant-folding precedent (compiler already distinguishes numeric kinds)**: `src/compiler.js:582,587`, `src/compiler.js:581-629` (`tryFoldBinary`).
- **Type predicates**: `src/vm.js:31-41`.
- **Overflow helpers**: `src/vm.js:72-80` (`checkIntOverflow`, `checkUintOverflow`).
- **Error marker**: `src/vm.js:43` (`celError`, `isError`).
- **Checker is a stub (no inference today)**: `src/checker.js:446`.
- **Overflow tests to preserve**: `test/int64-overflow.test.js`.
- **Benchmark**: `bench/compare.js` — baseline is commit 9c6860c.

### External research (from deepen pass)

- [Firing up the Ignition interpreter (V8)](https://v8.dev/blog/ignition-interpreter) — Ignition dispatches 200+ opcodes successfully; the "30-50 cap" in CLAUDE.md is folklore.
- [Ignition design doc (V8)](https://v8.dev/docs/ignition) — per-site type feedback (IC) is V8's native approach to type specialization; multiplying opcodes at compile time is only justified when types are statically provable (our case).
- [Adding BigInts to V8](https://v8.dev/blog/bigint) — BigInt ops are heap-allocating and not inlined in TurboFan/Maglev fast path.
- [tc39/proposal-bigint#117](https://github.com/tc39/proposal-bigint/issues/117) — empirical evidence that `BigInt + BigInt` is 20–100× slower than `Number + Number` for 64-bit-fitting values. Informs the realistic expectation that int-variant gains will be small relative to double-variant gains.
- [Maglev — V8's Fastest Optimizing JIT](https://v8.dev/blog/maglev) — context on when TurboFan/Maglev bail out; relevant to the deopt risk.
- [QuickJS bytecode interpreter (DeepWiki)](https://deepwiki.com/bellard/quickjs/2.4-bytecode-interpreter) — QuickJS uses single polymorphic `OP_add` with internal tag dispatch; validates that typed opcode expansion is an unusual choice that is only justified when the emitting compiler can statically prove types.
- [Wren: Pseudo Computed Goto PR #272](https://github.com/wren-lang/wren/pull/272) — 10–12% gain from pseudo-computed-goto dispatch; a potential future optimization orthogonal to typed opcodes.
- [Benedikt Meurer — Speculative optimization in V8](https://benediktmeurer.de/2017/12/13/an-introduction-to-speculative-optimization-in-v8/) — background on IC-driven specialization and deoptimization triggers.
