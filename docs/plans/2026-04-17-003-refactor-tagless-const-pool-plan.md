---
title: "refactor: Tagless constant pool on VM hot path"
type: refactor
status: active
date: 2026-04-17
origin: docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md
---

# refactor: Tagless constant pool on VM hot path

## TL;DR — does this contradict the original plan?

**No. It is the original plan.** The decode-caching plan (`docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md`, line 138) explicitly lists tagless constant pool as **Phase 2, Target 2**:

> *Tagless constant pool. Store `consts` as `Array<any>` since the opcode already encodes the type (`LOAD_INT64`, `LOAD_DOUBLE`, etc.). Skip the `{tag, value}` wrapper.*

Phase 2, Target 1 (flat instruction encoding) landed as `2026-04-17-001-refactor-flatten-vm-dispatch-typed-arrays-plan.md` on commit `389d4b4`. This plan picks up Target 2.

The wording "*the opcode already encodes the type*" was aspirational — today we have a single `PUSH_CONST` opcode, not `LOAD_INT64` / `LOAD_DOUBLE`. The realistic reading is: *drop the `{tag, value}` wrapper, and carry the one piece of type information the VM actually needs (the uint bit) separately.*

## Overview

`PUSH_CONST` is one of the hottest opcodes in the VM dispatch loop — every literal and every folded constant evaluates through it, as do `SELECT`/`HAS_FIELD` field-name reads and `ACCUM_PUSH` initial-accu reads. Currently each read pays for two property accesses on a polymorphic-shape wrapper object plus a tag comparison:

```js
// src/vm.js:1107-1112
case OP.PUSH_CONST: {
  const entry = consts[operand]
  stack[++sp] = entry.value                               // property access #1
  uintFlags[sp] = entry.tag === TAG_UINT64 ? 1 : 0        // property access #2 + compare + branch
  break
}
```

Replace the wrapper with a **tagless value array** (`consts: any[]`) plus a **parallel `Uint8Array` of uint flags** populated once at decode time. The hot path becomes two indexed reads — one from a generic array, one from a typed array — with no property access, no tag compare, no branch.

```js
// After
case OP.PUSH_CONST: {
  stack[++sp] = consts[operand]
  uintFlags[sp] = constUintFlags[operand]
  break
}
```

The tag byte stays in the **wire format** (for encode/decode correctness) but disappears from the **decoded in-memory representation**.

## Problem Statement / Motivation

Profiling work for the decode-caching plan established that after `decode()` is out of the hot path, the dispatch loop itself dominates. Flat typed-array instructions already landed (`2026-04-17-001`). The next concentrated cost is per-instruction property access on constant pool entries:

| Site (src/vm.js) | Current cost | Frequency |
|------------------|--------------|-----------|
| `PUSH_CONST` @ 1107 | 2 property reads + tag compare + branch | every literal, every folded constant |
| `SELECT` @ 1359 | 1 property read | every `a.b` access |
| `HAS_FIELD` @ 1365 | 1 property read | every `has(a.b)` |
| `OPT_SELECT` @ 1458 | 1 property read | every `a.?b` access |
| `ACCUM_PUSH` @ 1422 | 1 property read | once per comprehension |

Across a benchmark expression like `inputType == 'recoverable' ? 0.0 : amount * weight / 100.0`, roughly 1 in 5 instructions touches the const pool. Removing the wrapper removes one hidden-class lookup per hit.

V8 can keep the `{tag, value}` shape monomorphic today because every entry is constructed with the same key order in `decode()` at `src/bytecode.js:378-409`. So this is not a deopt hunt — it is a constant-factor win from fewer memory loads.

## Proposed Solution

**Decision: Option A.** Option B (typed push opcodes) is documented below for context only — it is explicitly out of scope for this plan.

### Option A — Tagless values + parallel uint-flag Uint8Array

Decode produces two parallel arrays instead of a wrapper array:

```js
// Before (decode output)
consts: Array<{ tag: number, value: * }>

// After (decode output)
consts: Array<*>                   // raw values
constUintFlags: Uint8Array         // 1 = uint64, 0 = anything else
```

- Every read site drops `.value`.
- `PUSH_CONST` reads the uint flag from `constUintFlags[operand]` instead of a `.tag` compare.
- All other sites (`SELECT`, `HAS_FIELD`, `OPT_SELECT`, `ACCUM_PUSH`) never needed the tag — they just stop going through `.value`.

**No wire-format change, no version bump, no backwards-compatibility break.** Existing Base64 / persisted `Uint8Array` bytecode decodes identically.

### Rejected alternative: Option B — Typed push opcodes

Introduce `PUSH_UINT` (and optionally `PUSH_DOUBLE`, `PUSH_INT`, `PUSH_STRING`, …) so the opcode itself carries the uint bit. `PUSH_CONST` becomes the non-uint path; `PUSH_UINT` sets the flag.

| Factor | Option A | Option B |
|---|---|---|
| Wire format change | no | **yes — version bump** |
| Opcode count | 47 (unchanged) | 48–54 depending on granularity |
| Hot-path reads per `PUSH_CONST` | 2 array reads, 0 branches | 1 array read, 0 branches |
| Risk to CLAUDE.md's "~30–50 opcode cap" | none | borderline (still within 50 if we add only `PUSH_UINT`) |
| Impl size | ~30 LoC | ~80 LoC (compiler + encode + decode + vm handler + binary version) |

Option B is marginally faster — one fewer typed-array read on the hot path — but costs a binary-format version bump and additional compiler emit logic. The bytecode binary format is a **documented feature** (CLAUDE.md, README: Base64 transport across DB / `localStorage`), so bumping it has a user-visible cost. Option A captures the vast majority of the win with zero format risk.

Reassess Option B only if benchmarks after Option A show residual `PUSH_CONST` overhead; any future pursuit is a separate plan with its own format version bump.

## Technical Considerations

### Compile-time impact

`decode()` (cold path, runs once per expression thanks to the decode cache from plan `2026-04-16-001`):
- Allocates one extra `Uint8Array(constCount)` — a few hundred bytes at most.
- One assignment (`constUintFlags[i] = tag === TAG_UINT64 ? 1 : 0`) per const pool entry.

`encode()` and `compiler.js`: **unchanged**. The compiler still emits `{ tag, value }` entries; `encode()` still writes the tag byte. The shape change is purely in what `decode()` returns.

Net: decode cost changes by <1% (one tiny typed-array allocation + O(constCount) assignments). **Not measurable in practice**, and the decode cache means it runs once per unique bytecode anyway.

### Run-time impact (the reason for this plan)

Per-instruction savings on const-pool-touching opcodes:

| Opcode | Before | After |
|--------|--------|-------|
| `PUSH_CONST` | `consts[i]` + `.value` + `.tag` + compare + ternary | `consts[i]` + `constUintFlags[i]` |
| `SELECT` / `HAS_FIELD` / `OPT_SELECT` | `consts[i]` + `.value` | `consts[i]` |
| `ACCUM_PUSH` (const-init arm) | `consts[i]` + `.value` | `consts[i]` |

Expected benchmark delta: **~3–8% improvement** on expression-heavy workloads (depends on literal density). Must verify with `bun run bench/compare.js`; any regression blocks merge.

### Monomorphism argument

With the wrapper gone, `consts` holds values of varying runtime types (number, string, bigint, boolean, null, Uint8Array). V8 will treat `consts[i]` as polymorphic **for the consumer** (which is what it already has to do: field names are strings, pushed constants can be anything). The wrapper did not protect against this — it just added a layer. No regression risk.

### Uint flag correctness

The `uintFlags` stack array tracks whether each stack slot holds a `uint64` value. Today every non-PUSH_CONST write site either sets `uintFlags[sp] = 0` explicitly or relies on the fact that the slot is about to be overwritten. That invariant does not change — this plan only changes how `PUSH_CONST` sources its flag.

Verify by grep: every opcode that writes to `stack[sp]` or `stack[++sp]` either writes `uintFlags[sp]` explicitly or is correct by the "arithmetic result is uint iff both operands were uint" rule already in `ADD`/`SUB`/`MUL`/`DIV`/`MOD`.

### Opcode cap concern (CLAUDE.md)

CLAUDE.md states "Opcode set is capped at ~30–50 opcodes to keep V8's branch predictor effective." Currently 47. **Option A adds zero opcodes.** Option B would add at least one (`PUSH_UINT`) and potentially more; if ever pursued, keep the total ≤50.

### Binary format unchanged

The on-disk / on-wire byte layout of the const pool does not change. `TAG_*` bytes are still written by `encode()` and consumed by `decode()`. Only the shape of the in-memory object returned by `decode()` changes. No version bump required; no migration needed for persisted `Uint8Array`s or Base64 strings.

## System-Wide Impact

- **Interaction graph:** `decode()` → in-memory program object → `vm.evaluate()`. Only these two functions are in the chain for this change. The decode cache (`WeakMap`) in `src/index.js` and `src/environment.js` stores program objects opaquely — the shape change is transparent.
- **Error propagation:** none affected. No new error paths; no removed error paths. `BytecodeError` on unknown tag stays in `decode()` exactly as today.
- **State lifecycle risks:** the decoded program is immutable at evaluation time (verified as part of the decode-caching plan). Removing a wrapper does not introduce mutation; the `consts` array is still read-only from the VM's perspective.
- **API surface parity:** no public API changes. `compile()`, `evaluate()`, `program()`, `toBase64`, `fromBase64` all keep identical signatures and behavior. TypeScript declarations (`src/index.d.ts`) unchanged.
- **Integration test scenarios worth running:**
  1. Mixed-type const pool (int + uint + double + string in one expression) — confirm uint flag propagates through arithmetic.
  2. Large `consts` pool (benchmark expressions with many folded literals) — confirm `Uint8Array` allocation scales.
  3. Base64 roundtrip: `fromBase64(toBase64(compile(src)))` must produce the new in-memory shape when decoded fresh.
  4. Comprehensions with string-literal accumulator initialization — exercises `ACCUM_PUSH` const-init arm.
  5. `has(obj.field)` over deeply nested selectors — exercises `HAS_FIELD` + `SELECT` const reads in sequence.

## Acceptance Criteria

- [ ] `decode()` returns `{ consts, constUintFlags, varTable, opcodes, operands, debugInfo }` with `consts: any[]` and `constUintFlags: Uint8Array` — `src/bytecode.js`
- [ ] `PUSH_CONST` handler reads `consts[operand]` and `constUintFlags[operand]` without any `.value`/`.tag` access — `src/vm.js:1107`
- [ ] `SELECT` / `HAS_FIELD` / `OPT_SELECT` / `ACCUM_PUSH` handlers drop `.value` — `src/vm.js:1359, 1365, 1458, 1422`
- [ ] `TAG_UINT64` constant import removed from `src/vm.js` (no longer referenced at runtime)
- [ ] `encode()` unchanged; wire format byte-identical to pre-change output (verify with a golden-bytes test if convenient, else roundtrip equality on the test corpus)
- [ ] All existing tests pass: `bun test`
- [ ] Benchmark shows no regression and ideally measurable improvement: `bun run bench/compare.js` run **before** and **after**; results captured in the PR body
- [ ] `IMPLEMENTATION.md` updated — the "Value representation" / const pool section notes the decoded form is tagless
- [ ] No public API or TypeScript declaration changes (`src/index.d.ts` unchanged)
- [ ] No change required to `src/compiler.js` (compiler output shape unchanged — it feeds `encode()`, which still writes tags)

## Success Metrics

| Metric | Before (current) | Target |
|---|---|---|
| `bun run bench/compare.js` — VM-only repeated eval | baseline from commit `389d4b4` | ≥ baseline, ideally +3–8% |
| Test suite (`bun test`) | all pass | all pass |
| Binary wire format | stable | **byte-identical** for same compiler output |

## Dependencies & Risks

- **Dependency:** `2026-04-17-001-refactor-flatten-vm-dispatch-typed-arrays-plan.md` is already landed (commit `389d4b4`). This plan builds on the typed-array dispatch; the two changes compose cleanly.
- **Low risk, high confidence:** the change is mechanical. The only non-trivial correctness point is the uint-flag path, which is mechanically equivalent (`tag === TAG_UINT64 ? 1 : 0` → precomputed into `Uint8Array`).
- **Rollback:** straightforward. Single-commit revert restores prior shape with no external effects (no wire format change to undo).
- **Residual question:** if Option A's benchmark gain is smaller than expected, re-evaluate Option B in a follow-up — but that is a separate plan with a binary-format version bump and should not be bundled.

## MVP

### src/bytecode.js — `decode()` const pool loop

Replace lines 375-410:

```js
const constCount = readU16()
const consts = new Array(constCount)
const constUintFlags = new Uint8Array(constCount)
const decoder = new TextDecoder()
for (let i = 0; i < constCount; i++) {
  const tag = readU8()
  switch (tag) {
    case TAG_NULL:   consts[i] = null; break
    case TAG_BOOL:   consts[i] = readU8() !== 0; break
    case TAG_INT64:  consts[i] = readBigInt64(); break
    case TAG_UINT64: consts[i] = readBigUint64(); constUintFlags[i] = 1; break
    case TAG_DOUBLE: consts[i] = readF64(); break
    case TAG_STRING: { const len = readU32(); consts[i] = decoder.decode(readBytes(len)); break }
    case TAG_BYTES:  { const len = readU32(); consts[i] = new Uint8Array(readBytes(len)); break }
    default: throw new BytecodeError(`Unknown const tag: ${tag} at byte ${pos}`)
  }
}
```

Return shape:

```js
return { consts, constUintFlags, varTable, opcodes, operands, debugInfo }
```

### src/vm.js — handler updates

```js
// Top of evaluate()
const { consts, constUintFlags, varTable, opcodes, operands } = program
// remove `const TAG_UINT64 = 3` and the import comment tying vm.js to bytecode.js

// PUSH_CONST
case OP.PUSH_CONST: {
  stack[++sp] = consts[operand]
  uintFlags[sp] = constUintFlags[operand]
  break
}

// SELECT / HAS_FIELD / OPT_SELECT — change `consts[nameIdx].value` → `consts[nameIdx]`
case OP.SELECT: {
  stack[sp] = celSelect(stack[sp], consts[operand])
  break
}

// ACCUM_PUSH (const-init arm)
} else {
  accu = consts[constIdx]
  if (isList(accu)) accu = [...accu]
  else if (isMap(accu)) accu = new Map(accu)
}
```

## Sources & References

- **Origin document:** [docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md](2026-04-16-001-fix-evaluate-redecode-overhead-plan.md) line 138 — Phase 2, Target 2 (tagless constant pool)
- Preceding Phase 2 work: [docs/plans/2026-04-17-001-refactor-flatten-vm-dispatch-typed-arrays-plan.md](2026-04-17-001-refactor-flatten-vm-dispatch-typed-arrays-plan.md) (landed as commit `389d4b4`)
- Current tagged reads in VM: `src/vm.js:1108-1110`, `1359`, `1365`, `1422`, `1458`
- Const pool decode: `src/bytecode.js:375-410`
- Const pool encode (unchanged): `src/bytecode.js:241-275`
- Opcode cap note: `CLAUDE.md` — "Opcode set is capped at ~30–50 opcodes"
- Rules-of-thumb on compile/run-time analysis: `CLAUDE.md` — "Performance analysis required"
