---
title: "refactor: Flatten VM dispatch loop to typed arrays"
type: refactor
status: completed
date: 2026-04-17
origin: docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md
---

# refactor: Flatten VM dispatch loop to typed arrays

## Overview

Replace the polymorphic `Array<{op: number, operands: number[]}>` instruction representation with parallel typed arrays (`Uint8Array` for opcodes, `Int32Array` for operands). This eliminates object destructuring, property lookups, and GC pressure on the VM's hot path — every instruction of every evaluation currently pays for `const { op, operands } = instrs[pc++]`.

This was identified as Phase 2, Target 1 in the decode-caching plan (see origin: `docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md`, lines 132-143).

## Problem Statement

The VM dispatch loop at `src/vm.js:1101` destructures an object on every iteration:

```js
const { op, operands } = instrs[pc++]
```

`instrs` is `Array<{op: number, operands: number[]}>` where `operands` length varies (0, 1, or 2 elements). This creates **polymorphic object shapes** — V8 cannot inline property access on objects with varying hidden classes and falls back to dictionary-mode reads. Additionally, each decoded instruction allocates a fresh `{op, operands}` object in `decode()` at `src/bytecode.js:438`, creating GC pressure proportional to program length.

## Proposed Solution

Change the decoded program's instruction representation from an array of objects to two parallel typed arrays:

```js
// Before (decode output)
{ consts, varTable, instrs: [{op, operands}, ...], debugInfo }

// After (decode output)
{ consts, varTable, opcodes: Uint8Array, operands: Int32Array, debugInfo }
```

The VM dispatch loop becomes:

```js
const op = opcodes[pc]
const operand = operands[pc]
pc++
```

Two indexed reads from typed arrays — no object allocation, monomorphic access, V8 will inline perfectly.

### CALL instruction encoding (2 operands → 1 slot)

CALL is the only instruction with 2 operands: `builtinId` (u16) and `argc` (u8). Bit-pack both into a single `Int32`:

```js
// Encoding (in decode)
operands[i] = (builtinId << 16) | argc

// Decoding (in VM CALL handler)
const builtinId = operand >>> 16
const argc = operand & 0xFFFF
```

This matches the existing binary format constraints (`OPERAND_WIDTH[OP.CALL] = 3` → u16 + u8, fits in 32 bits). No instruction count change, no debug alignment disruption.

## Scope

### In scope — only the decode/evaluate hot path (2 files)

| File | Change |
|------|--------|
| `src/bytecode.js` | `decode()` returns `{opcodes: Uint8Array, operands: Int32Array}` instead of `{instrs: [{op, operands}]}` |
| `src/vm.js` | `evaluate()` reads from typed arrays instead of destructuring objects |

### Out of scope — cold path unchanged

| File | Why unchanged |
|------|---------------|
| `src/compiler.js` | Compiler output feeds into `encode()`, which serializes to binary. The compiler runs once per expression — changing its internal `emit()` format adds complexity to a cold path with no performance benefit. `patchJump()` continues to mutate plain objects. |
| `src/bytecode.js` `encode()` | Consumes compiler output (unchanged shape). The binary wire format does not change — no version bump, no backward-compatibility break. |
| `src/index.js` | `cachedDecode()`, `program()`, `evaluate()` all pass through the decoded program object opaquely. The shape change is transparent to them. |

## Technical Considerations

### Signed operands

Jump offsets (`JUMP`, `JUMP_IF_FALSE`, `JUMP_IF_TRUE`, `JUMP_IF_FALSE_K`, `JUMP_IF_TRUE_K`, `ITER_NEXT`, `OPT_CHAIN`) are signed i16 in the binary format. `Int32Array` handles negative values naturally — `decode()` already reads `readI16()` for these; the value simply goes into an `Int32Array` slot instead of an array element.

### Sentinel values

`IDX_ITER_ELEM = 0xFFFE` and `IDX_ACCU = 0xFFFF` used by `LOAD_VAR` and `ACCUM_PUSH` are within `Int32Array` range (max ~2.1B). No change needed.

### Debug info alignment

Debug info is indexed 1:1 with instructions. Since instruction count does not change (CALL bit-packing preserves count), debug alignment is automatically preserved.

### Decode cache compatibility

The `WeakMap<Uint8Array, DecodedProgram>` decode cache in `src/index.js:31-41` stores decoded program objects in memory only. After this change, all cached entries will have the new typed-array shape. No versioning or invalidation needed — the code deploys atomically.

### Binary format unchanged

The wire format (`encode()`/`decode()` binary layout) does not change. Existing serialized bytecode (Base64 strings, persisted `Uint8Array`s) remains compatible. No version bump required.

## Acceptance Criteria

- [ ] `decode()` returns `{ consts, varTable, opcodes: Uint8Array, operands: Int32Array, debugInfo }` — `src/bytecode.js`
- [ ] CALL operands bit-packed as `(builtinId << 16) | argc` in the `Int32Array` — `src/bytecode.js`
- [ ] VM dispatch loop uses `opcodes[pc]` / `operands[pc]` instead of object destructuring — `src/vm.js`
- [ ] Every opcode handler updated from `operands[0]` → `operand` (and CALL unpacks via bit shift) — `src/vm.js`
- [ ] All existing tests pass: `bun test`
- [ ] Benchmark shows no regression (expect improvement): `bun run bench/compare.js`
- [ ] `IMPLEMENTATION.md` updated to reflect the new internal representation
- [ ] Binary format unchanged — existing Base64-serialized bytecode still loads correctly

## MVP

### src/bytecode.js — `decode()` instruction loop

Replace lines 422-439:

```js
// --- Instructions ---
const instrCount = readU32()
const opcodes = new Uint8Array(instrCount)
const operands = new Int32Array(instrCount)
for (let i = 0; i < instrCount; i++) {
  const op = readU8()
  opcodes[i] = op
  const width = OPERAND_WIDTH[op] ?? 0
  if (width === 0) {
    // operands[i] already 0
  } else if (width === 2) {
    operands[i] = SIGNED_OPERAND[op] ? readI16() : readU16()
  } else if (width === 3) {
    // CALL: bit-pack builtinId (u16) and argc (u8) into one i32
    const builtinId = readU16()
    const argc = readU8()
    operands[i] = (builtinId << 16) | argc
  } else {
    throw new BytecodeError(`Unknown operand width ${width} for opcode ${op}`)
  }
}
```

Return shape change:

```js
return { consts, varTable, opcodes, operands, debugInfo }
```

### src/vm.js — `evaluate()` dispatch loop

Replace the program destructuring and loop:

```js
// Before
const { consts, varTable, instrs } = program
// ...
const len = instrs.length
// ...
while (pc < len) {
  const { op, operands } = instrs[pc++]
  switch (op) { ... }
}

// After
const { consts, varTable, opcodes, operands } = program
// ...
const len = opcodes.length
// ...
while (pc < len) {
  const op = opcodes[pc]
  const operand = operands[pc]
  pc++
  switch (op) {
    case OP.PUSH_CONST: {
      const entry = consts[operand]
      // ...
    }
    case OP.LOAD_VAR: {
      const idx = operand
      // ...
    }
    case OP.CALL: {
      const builtinId = operand >>> 16
      const argc = operand & 0xFFFF
      // ...
    }
    // All other 1-operand cases: operands[0] → operand
    // All 0-operand cases: unchanged (operand unused)
  }
}
```

### Opcode handler migration reference

| Pattern | Before | After |
|---------|--------|-------|
| 0 operands (`ADD`, `SUB`, `NOT`, etc.) | `operands` unused | `operand` unused — no change |
| 1 operand (`PUSH_CONST`, `LOAD_VAR`, `JUMP`, etc.) | `operands[0]` | `operand` |
| 2 operands (`CALL` only) | `operands[0]`, `operands[1]` | `operand >>> 16`, `operand & 0xFFFF` |

## Sources

- **Origin document:** [docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md](docs/plans/2026-04-16-001-fix-evaluate-redecode-overhead-plan.md) — Phase 2 targets: flat instruction encoding, tagless constant pool, monomorphic dispatch
- Dispatch loop: `src/vm.js:1100-1101`
- Instruction decode: `src/bytecode.js:422-439`
- CALL handler: `src/vm.js:1369-1378`
- OPERAND_WIDTH table: `src/bytecode.js:87-104`
- SIGNED_OPERAND table: `src/bytecode.js:110-117`
- Decode cache: `src/index.js:31-41`
