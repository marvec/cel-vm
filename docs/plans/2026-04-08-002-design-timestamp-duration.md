# Design: Timestamp & Duration Support

**Date:** 2026-04-08  
**Status:** Completed

---

## Summary

Timestamps and durations are **already wired into the bytecode pipeline** — the right design is in place. No external library (e.g. Moment.js) is needed. This document records the architectural rationale and the remaining gaps.

---

## Architecture Decision: No Moment.js

CEL only needs ~12 datetime accessor methods plus arithmetic on two types. That is ~30 lines of native `Date` arithmetic, not a library.

**Reasons to reject Moment.js:**
- 67 KB minified; deprecated by its own maintainers.
- Violates the project's "no runtime dependencies" rule (`CLAUDE.md`).
- Native `Date` (already used) covers UTC accessors, ISO 8601 parsing, and epoch arithmetic — everything CEL requires.
- Temporal API could be considered for nanosecond precision but is overkill for now.

---

## Architecture Decision: Bytecode CALL, Not Dedicated Opcodes

Every timestamp/duration operation compiles to `OP.CALL` with a `BUILTIN` ID:

```
timestamp("2023-01-01T00:00:00Z").getFullYear()
→  PUSH_CONST  "2023-01-01T00:00:00Z"
   CALL        BUILTIN.TIMESTAMP, 1
   CALL        BUILTIN.GET_FULL_YEAR, 1
```

This is the fastest viable design: integer switch dispatch, no heap allocation per call, no string-keyed lookup. Dedicated opcodes (e.g. `OP.TIMESTAMP_ADD`) would save one indirection level but would push the opcode table past the ~50 target and offer negligible real-world gain.

---

## Architecture Decision: Object Propagation via Activation

Timestamp and duration values flow through expressions as tagged plain objects:

```js
{ __celTimestamp: true, ms: <epoch milliseconds> }
{ __celDuration: true, ms: <signed milliseconds> }
```

These can be passed in from the outside via the activation map:

```js
evaluate(bytecode, { now: { __celTimestamp: true, ms: Date.now() } })
```

The expression `now.getHours()` compiles to `LOAD_VAR(now) + CALL(GET_HOURS, 1)`. No library is invoked at runtime. The tagged-object convention is the "propagation protocol" — no special injection mechanism needed.

---

## Current State (Already Implemented)

| Component | Location | Status |
|-----------|----------|--------|
| `TIMESTAMP`, `DURATION` builtin IDs | `src/bytecode.js:43-45` | Done |
| `GET_FULL_YEAR`…`GET_SECONDS` builtin IDs | `src/bytecode.js:43-45` | Done |
| `callBuiltin()` cases for the above | `src/vm.js:415-462` | Done |
| `parseDuration()` (Go-style: `1h`, `2h45m`, etc.) | `src/vm.js:505-532` | Done |
| Compiler method mappings | `src/compiler.js:56-77` | Done |
| Equality comparison for timestamps/durations | `src/vm.js` EQ/NEQ | Done |

---

## Gaps

### Gap 1: Arithmetic (ADD / SUB opcodes)

The `ADD` and `SUB` opcode handlers in `src/vm.js` only handle int/uint/double/string. They need tagged-object branches:

| Left      | Right     | Result    |
|-----------|-----------|-----------|
| timestamp | duration  | timestamp |
| duration  | timestamp | timestamp |
| timestamp | timestamp | duration  |
| duration  | duration  | duration  |

**Fix:** add branches in the `ADD`/`SUB` opcode cases in `src/vm.js`. No new opcodes needed.

### Gap 2: Missing Accessor Methods

Not yet in compiler or VM:

| Method | Semantics |
|--------|-----------|
| `getDate()` | 1-based day-of-month (distinct from `getDayOfMonth()` which is 0-based) |
| `getDayOfWeek()` | 0=Sunday … 6=Saturday |
| `getDayOfYear()` | 0-based |
| `getMilliseconds()` | Sub-second component (0–999) |

**Fix:** add 4 new BUILTIN IDs in `src/bytecode.js`, dispatch cases in `src/vm.js:callBuiltin`, and method name mappings in `src/compiler.js:METHOD_BUILTINS`.

Timezone-aware variants (e.g. `getHours("America/New_York")`) are implemented — see `2026-04-08-003-feat-timezone-aware-timestamp-accessors-plan.md`.

### Gap 3: Precision (Milliseconds vs Nanoseconds)

Current representation stores `ms: number` (milliseconds). CEL spec supports nanosecond precision (`2009-02-13T23:31:20.123456789Z`). For `getMilliseconds()` this is not an issue; for hypothetical `getNanoseconds()` it would be.

**Options:**

| Option | Trade-off |
|--------|-----------|
| Keep `ms` only | Simple, fast, covers 99% of use cases. Document the limitation. |
| Add optional `ns` field | Backward compatible, handles nanoseconds, trivial to add. |
| Store as BigInt nanoseconds | Most precise, but breaks all arithmetic and comparison code. |

**Recommendation:** add an optional `ns: number` field for sub-millisecond remainder when parsing high-precision ISO strings. No bytecode change required — representation is internal to the VM.

### Gap 4: Comparisons and Type Conversions

| Missing | Fix location |
|---------|-------------|
| `<`, `<=`, `>`, `>=` for timestamps and durations | `src/vm.js` LT/LE/GT/GE opcode cases |
| `int(timestamp)` → Unix seconds | Branch in `TO_INT` builtin case |
| `string(timestamp)` → ISO 8601 | Branch in `TO_STRING` builtin case |
| `type(timestamp)` → `"google.protobuf.Timestamp"` | `celTypeName()` in `src/vm.js` |

---

## Implementation Order

1. **Comparisons** — simplest; unblocks most skipped cel-spec tests
2. **Arithmetic** — 4 new branches in ADD/SUB
3. **Missing accessors** — 4 new BUILTINs across 3 files
4. **Type conversions** — branches in existing TO_INT/TO_STRING builtins
5. **Nanosecond precision** — optional; add `ns` field if full spec conformance is required

---

## Files Affected

| File | Change |
|------|--------|
| `src/bytecode.js:43-47` | Add 4 new BUILTIN IDs |
| `src/vm.js` | Add builtin cases, fix comparison/arithmetic opcode branches |
| `src/compiler.js:METHOD_BUILTINS` | Map new method names to BUILTIN IDs |
| `test/cel-spec.test.js` | Remove `.skip` from now-passing tests |
