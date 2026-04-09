# CEL-VM: Implementation

## Motivation

CEL-VM implements the [Common Expression Language](https://github.com/google/cel-spec) (CEL) using a **bytecode virtual machine** rather than the conventional tree-walking interpreter.

The fundamental problem with tree-walking is that it re-traverses the parsed AST on every evaluation. In use-cases like policy engines, rule engines, or analytics pipelines, the same expression is evaluated thousands or millions of times against different inputs. A tree-walker pays the full traversal cost every time. CEL-VM pays it once — at compile time — and subsequent evaluations run a tight dispatch loop over a flat array of instructions.

The target is **5–25× faster repeated evaluation** compared to tree-walking implementations, with zero runtime dependencies.

---

## Pipeline Overview

```
Source String
     │
     ▼
 ┌────────┐
 │ Lexer  │   hand-written tokeniser
 └────────┘
     │  token[]
     ▼
 ┌────────┐
 │ Parser │   recursive-descent, operator precedence
 └────────┘
     │  AST
     ▼
 ┌─────────┐
 │ Checker │   macro expansion, security validation
 └─────────┘
     │  checked AST
     ▼
 ┌──────────┐
 │ Compiler │   constant folding, variable indexing, jump patching
 └──────────┘
     │  program { consts, varTable, instrs }
     ▼
 ┌───────────┐
 │ Bytecode  │   binary encode/decode, Base64 transport
 └───────────┘
     │  Uint8Array
     ▼
 ┌────┐
 │ VM │   while/switch dispatch, stack machine
 └────┘
     │
     ▼
  Result
```

Each stage is a pure transformation with no shared mutable state. The compiled `Uint8Array` is the serialisable, cacheable artifact — it can be stored in a database or `localStorage` and loaded without re-parsing.

---

## Components

### Lexer (`src/lexer.js`)

The lexer converts the source string to a flat array of tokens in a single pass. Each token is a plain object `{ type, value, line, col }`.

**What it handles:**

- All CEL literal forms: integers (decimal and `0x` hex), unsigned integers (`42u`), floats, booleans, null
- String variants: single-quoted, double-quoted, triple-quoted (multiline), raw (`r"..."`), and byte literals (`b"..."`)
- Full escape sequence decoding: `\n \r \t \\ \" \' \xHH \uHHHH \UHHHHHHHH` and octal `\NNN`
- All CEL operators including multi-character ones (`==`, `!=`, `<=`, `>=`, `&&`, `||`, `**`, `?.`)
- Line/column tracking for error messages

The lexer is intentionally simple — one character at a time with one character of lookahead. No regular expressions, no parser generator output.

---

### Parser (`src/parser.js`)

A recursive-descent parser that converts the token stream to an AST made of plain JavaScript objects (no class instances). Each node has a `type` field and type-specific properties.

**Operator precedence** (low to high):

| Level | Operators |
|-------|-----------|
| Ternary | `? :` |
| Logical OR | `\|\|` |
| Logical AND | `&&` |
| Equality | `== !=` |
| Relational | `< <= > >= in` |
| Additive | `+ -` |
| Multiplicative | `* / % ^` |
| Power | `**` (right-associative) |
| Unary | `- !` |
| Member / Index | `.` `?.` `[]` |
| Primary | literals, identifiers, `(expr)`, `[list]`, `{map}` |

**Node types produced:** `IntLit`, `FloatLit`, `StringLit`, `BoolLit`, `NullLit`, `BytesLit`, `Ident`, `Unary`, `Binary`, `Ternary`, `Select`, `OptSelect`, `Index`, `List`, `Map`, `Call`, `RCall` (receiver call), `HasMacro`, `Comprehension`.

Reserved words (`if`, `else`, `for`, `var`, `package`, `as`, `import`) are rejected as identifiers but allowed as map keys.

---

### Checker (`src/checker.js`)

The checker walks the AST and performs two jobs: security validation and macro expansion.

**Security validation** blocks access to JavaScript prototype-chain properties (`__proto__`, `constructor`, `prototype`) to prevent prototype pollution.

**Macro expansion** desugars high-level CEL constructs into `Comprehension` nodes that the compiler knows how to emit:

| Macro | Expands to |
|-------|-----------|
| `list.exists(x, pred)` | comprehension that short-circuits on first `true` |
| `list.all(x, pred)` | comprehension that short-circuits on first `false` |
| `list.filter(x, pred)` | comprehension that builds a filtered list |
| `list.map(x, f)` | comprehension that builds a transformed list |
| `list.exists_one(x, pred)` | comprehension that counts truthy predicates |
| `cel.bind(x, val, body)` | binds a name to a value, evaluates body |
| `has(obj.field)` | field-existence check (no error on missing) |

After the checker, the AST contains no macro nodes — only primitives the compiler can handle directly.

---

### Compiler (`src/compiler.js`)

The compiler converts the checked AST to a program structure:

```js
{
  consts:   [{ tag, value }, ...],   // constant pool
  varTable: ['age', 'name', ...],    // external variable names, sorted
  instrs:   [{ op, operands }, ...], // instruction stream
  debugInfo: [...]                   // optional line/col per instruction
}
```

**Variable pre-resolution.** Before compiling, the compiler walks the entire AST and collects all external variable names (excluding comprehension-bound names). It sorts them alphabetically and assigns each an integer index. At compile time every `LOAD_VAR` instruction carries that index. At runtime, variable access is `vars[i]` — a single array lookup with no string comparison.

**Constant folding.** When both operands of an arithmetic or comparison node are literals, the compiler evaluates the result at compile time and emits a single `PUSH_CONST` instruction. `1 + 2` becomes `PUSH_CONST 3`. `!true` becomes `PUSH_CONST false`. Constants are deduplicated in the pool.

**Short-circuit jumps.** `a && b` compiles to: push `a`, `JUMP_IF_FALSE_K` (peek, do not pop) to the exit label, pop `a`, push `b`. If `a` is false the right side is never evaluated. `||` uses `JUMP_IF_TRUE_K` symmetrically.

**Ternary and comprehension jumps** use a two-pass technique: emit a placeholder jump instruction, compile the body, then patch the jump offset once the target address is known.

**Comprehension emission** follows a fixed loop shape:

```
PUSH_CONST   <accuInit>
ITER_INIT    <range>
loop:
  ITER_NEXT  →exit
  <loop condition with K variant>
  POP
  <loop step>
  ACCUM_SET
  JUMP       →loop
exit:
  ITER_POP
  <result expression>
```

The compiler maps built-in method names (`startsWith`, `contains`, `int`, …) to integer BUILTIN IDs so the VM dispatches on a number, not a string.

**Opcode set** is currently 47 opcodes (capped at ~50 for V8 branch predictor effectiveness):

| Category | Opcodes |
|----------|---------|
| Stack | `PUSH_CONST`, `LOAD_VAR`, `POP`, `RETURN` |
| Jumps | `JUMP`, `JUMP_IF_FALSE`, `JUMP_IF_TRUE`, `JUMP_IF_FALSE_K`, `JUMP_IF_TRUE_K` |
| Arithmetic | `ADD`, `SUB`, `MUL`, `DIV`, `MOD`, `POW`, `NEG` |
| Comparison | `EQ`, `NEQ`, `LT`, `LE`, `GT`, `GE` |
| Logic | `NOT`, `XOR`, `LOGICAL_AND`, `LOGICAL_OR` |
| Collections | `BUILD_LIST`, `BUILD_MAP`, `INDEX`, `IN` |
| Field access | `SELECT`, `HAS_FIELD`, `OPT_SELECT` |
| Functions | `CALL`, `SIZE` |
| Iteration | `ITER_INIT`, `ITER_NEXT`, `ITER_POP`, `ACCUM_PUSH`, `ACCUM_SET` |
| Optionals | `OPT_NONE`, `OPT_OF`, `OPT_OR_VALUE`, `OPT_CHAIN`, `OPT_INDEX`, `OPT_HAS_VALUE`, `OPT_OF_NON_ZERO` |

`LOGICAL_AND` and `LOGICAL_OR` implement CEL's commutative error semantics: `error && false = false`, `error || true = true`. They combine two values on the stack with proper error propagation, replacing the earlier `JUMP → POP` pattern that discarded left-side errors.

---

### Bytecode (`src/bytecode.js`)

Turns the program object into a portable binary `Uint8Array` and back.

**Binary layout:**

```
[Magic: 0x4345 (2B)] [Version: 1 (1B)] [Flags (1B)]
[Const pool: count (u16), then entries]
[Var table: count (u16), then length-prefixed UTF-8 strings]
[Instructions: count (u32), then opcode (1B) + up to 2 operands]
[Debug info: count (u32), entries] ← only if flag bit 0 is set
[Adler-32 checksum (4B)]
```

Each const pool entry starts with a type tag:

| Tag | Type | Payload |
|-----|------|---------|
| 0 | null | — |
| 1 | bool | 1 byte |
| 2 | int64 | 8 bytes big-endian |
| 3 | uint64 | 8 bytes big-endian |
| 4 | double | 8 bytes IEEE-754 |
| 5 | string | u32 length + UTF-8 bytes |
| 6 | bytes | u32 length + raw bytes |

The Adler-32 checksum covers all preceding bytes. Decoding verifies magic, version, and checksum before reconstructing the program object.

**Base64 transport:** `toBase64` / `fromBase64` convert between `Uint8Array` and a Base64 string suitable for JSON, databases, or `localStorage`. Encoding is done in chunks to avoid stack overflow on large programs.

---

### VM (`src/vm.js`)

The VM is a **plain function** (not a class) containing a single `while (pc < len) { switch (opcode) { … } }` dispatch loop. This is deliberate: V8 can JIT-compile a monomorphic loop more aggressively than it can a polymorphic method dispatch.

**Stack machine.** A pre-allocated JavaScript `Array` acts as the operand stack. The stack pointer `sp` is an integer — values are accessed as `stack[sp]`, `stack[sp-1]`, etc.

**Value representation** uses native JavaScript types with no boxing:

| CEL type | JS representation |
|----------|------------------|
| null | `null` |
| bool | `boolean` |
| int / uint | `BigInt` |
| double | `number` |
| string | `string` |
| bytes | `Uint8Array` |
| list | `Array` |
| map | `Map` |
| timestamp | `{ __celTimestamp: true, ms }` |
| duration | `{ __celDuration: true, ms }` |
| optional | `{ __celOptional: true, value }` |
| error | `{ __celError: true, message }` |

**Error propagation** is value-based, not exception-based. Operations that receive an error value propagate it as their result. Only `RETURN` throws if the final value is an error. This keeps the hot path free of `try/catch` overhead.

**Comprehension registers.** Two VM-level registers — `accu` (accumulator) and `iterElem` (current element) — hold comprehension state. `ACCUM_PUSH` initialises `accu`; `ACCUM_SET` updates it; `ITER_NEXT` advances the iterator and writes `iterElem`.

**Built-in dispatch.** `CALL` carries a BUILTIN integer ID. The handler switches on this ID to call the appropriate implementation (string methods, type conversions, timestamp/duration accessors, math functions). No string lookup at runtime. String operations use Unicode code-point semantics per cel-spec: `size()`, `charAt()`, `indexOf()`, `lastIndexOf()`, `substring()`, and string indexing (`s[i]`) all count and index by code points, not UTF-16 code units. Zero-allocation helpers (`codePointLen`, `codePointCharAt`) avoid array spreading on the hot path; `indexOf`/`lastIndexOf` use native JS search then convert the UTF-16 offset to a code-point offset. String extensions also include `strings.quote`. Math extensions include `math.greatest` and `math.least` (variable-arity, support 1-N args or a single list arg). Namespace-qualified functions (`math.*`, `strings.*`) are resolved in the compiler via dedicated lookup tables. Full math extensions: `math.ceil`, `math.floor`, `math.round`, `math.trunc` (double → double rounding), `math.abs` (int/uint/double, with int64 min overflow detection), `math.sign` (int/uint/double → same type), `math.isNaN`, `math.isInf`, `math.isFinite` (double → bool), and bitwise operations `math.bitAnd`, `math.bitOr`, `math.bitXor`, `math.bitNot`, `math.bitShiftLeft`, `math.bitShiftRight` (BigInt operands). Note: `bitNot` on uint values returns a signed result because int/uint are indistinguishable at runtime (both BigInt).

**Timestamp and duration support.** `timestamp()` parses ISO 8601 strings via native `Date`; `duration()` parses Go-style strings (`"1h30m"`, `"300s"`). Both store milliseconds in tagged objects. Arithmetic (`+`, `-`) and comparisons (`<`, `<=`, `>`, `>=`, `==`, `!=`) are handled in the main opcode dispatch. Accessor methods (`getFullYear`, `getDate`, `getDayOfMonth`, `getDayOfWeek`, `getDayOfYear`, `getHours`, `getMinutes`, `getSeconds`, `getMilliseconds`) are dispatched via `CALL` with BUILTIN IDs. Duration accessors return **total** values per cel-spec (e.g. `duration("3730s").getMinutes()` = 62, not 2). Type conversions: `int(timestamp)` → Unix seconds, `string(timestamp)` → ISO 8601, `string(duration)` → Go format. No external date library — native `Date` and `Intl.DateTimeFormat` suffice. Precision is milliseconds; sub-millisecond nanosecond support is not yet implemented.

**Timezone-aware accessors.** All timestamp accessor methods accept an optional timezone string argument — e.g. `timestamp.getHours("America/New_York")` or `timestamp.getHours("+02:00")`. When called without an argument, they return UTC values. Timezone resolution uses `Intl.DateTimeFormat.formatToParts()` with `hourCycle: 'h23'` for deterministic output. `Intl.DateTimeFormat` instances are cached in a module-scoped `Map` keyed by timezone string to avoid repeated construction cost. Supported timezone formats: IANA names (`"America/New_York"`), fixed UTC offsets (`"+05:30"`, `"-02:30"`), and bare offsets (`"02:00"` normalised to `"+02:00"`). `getDayOfWeek` and `getDayOfYear` are derived from the timezone-adjusted year/month/day since `formatToParts()` does not provide these directly. Duration accessors (`getHours`, `getMinutes`, `getSeconds`) reject timezone arguments with a CEL error.

---

## Performance Techniques

### Compile once, evaluate many times

The cache in `src/index.js` is a `Map<string, Uint8Array>` keyed on the source expression. The first call to `compile(src)` pays the full lexer + parser + checker + compiler cost. All subsequent calls return the cached `Uint8Array`. `evaluate()` decodes and runs the bytecode directly.

### Pre-resolved variable indices

A tree-walker looks up `activation['fieldName']` (a string hash lookup) every time it encounters an identifier. CEL-VM resolves names to integer indices at compile time. At runtime the access is `vars[2]` — a direct array slot read.

### Constant folding

Literal subexpressions are evaluated at compile time. The runtime never sees them — they become a single `PUSH_CONST` instruction.

### Short-circuit via jump instructions

`a && b` where `a` is `false` never evaluates `b` — the VM jumps past it. This is not just an optimisation; it is required for correctness (`false && error` must return `false`, not an error).

### Cache-friendly linear instruction stream

AST nodes are heap-allocated objects scattered in memory. The instruction array is a compact, sequentially-accessed structure. Modern CPUs prefetch it efficiently.

### V8 JIT friendliness

- Plain function, not a class → monomorphic `this` avoidance
- Single `switch` with integer cases → V8 can build a jump table
- No `try/catch` inside the dispatch loop
- Stack pre-allocated to 256 slots → no reallocation in the common case

---

## Public API (`src/index.js`)

```js
import { compile, evaluate, run, load, toB64 } from './src/index.js';

// Compile once → Uint8Array bytecode
const bytecode = compile('age >= 18 && country == "CZ"');

// Evaluate many times against different activations
const result = evaluate(bytecode, { age: 25n, country: 'CZ' });

// Convenience: compile + evaluate in one call (uses cache)
const result2 = run('1 + 2 * 3', {});

// Serialise for storage or transport
const b64 = toB64(bytecode);

// Load from storage
const bytecode2 = load(b64);
```

`compile()` accepts an optional `{ debugInfo: true }` flag to embed source locations in the binary (used by error messages and future debuggers).

`evaluate()` accepts an activation object whose keys correspond to the variable names referenced in the expression. Numeric values should be `BigInt` for CEL `int`/`uint` types, or `number` for `double`.
