# CEL-VM Implementation Plan

> **Sources researched:** google/cel-spec (37 conformance test files, textproto format) and marcbachmann/cel-js (47 test files, full source). All design decisions below are grounded in those test suites.

---

## 1. Lexer Token Set

The hand-written tokeniser (`src/lexer.js`) must produce exactly these tokens:

### Literal Tokens

| Token | Examples | Notes |
|---|---|---|
| `INT` | `0`, `42`, `-7`, `0xFF`, `0xDEAD` | Parsed as `BigInt`; hex prefix supported |
| `UINT` | `1u`, `42U` | Suffix `u`/`U`; stored as unsigned BigInt |
| `FLOAT` | `3.14`, `1e2`, `1e-2`, `.5` | JS `number` (double) |
| `STRING` | `"hello"`, `'world'`, `"""triple"""`, `'''triple'''` | Double- and single-quoted, triple-quoted multiline |
| `BYTES` | `b"hello"`, `b'world'` | Prefix `b`/`B`; yields `Uint8Array` |
| `RAW_STRING` | `r"no\n escape"`, `r'raw'` | Prefix `r`/`R`; backslash not interpreted |

### Keyword Tokens

| Token | Lexeme |
|---|---|
| `TRUE` | `true` |
| `FALSE` | `false` |
| `NULL` | `null` |
| `IN` | `in` |

Reserved (reject at parser, not lexer): `if`, `else`, `for`, `var`, `package`, `as`, `import`.

### Operator Tokens

| Token | Lexeme | Token | Lexeme |
|---|---|---|---|
| `PLUS` | `+` | `EQ` | `==` |
| `MINUS` | `-` | `NEQ` | `!=` |
| `STAR` | `*` | `LT` | `<` |
| `SLASH` | `/` | `LE` | `<=` |
| `PERCENT` | `%` | `GT` | `>` |
| `AND` | `&&` | `GE` | `>=` |
| `OR` | `\|\|` | `QUESTION` | `?` |
| `NOT` | `!` | `DOT` | `.` |
| `OPT_DOT` | `?.` | `COMMA` | `,` |
| `COLON` | `:` | `POWER` | `**` |
| `CARET` | `^` | | |

### Delimiter Tokens

`LPAREN` `(`, `RPAREN` `)`, `LBRACKET` `[`, `RBRACKET` `]`, `LBRACE` `{`, `RBRACE` `}`

### Special

`IDENT` (identifier: `[a-zA-Z_][a-zA-Z0-9_]*`), `EOF`

### String Escape Sequences (must support)

`\n \r \t \\ \" \' \a \b \f \v \0 \xHH \uHHHH \UHHHHHHHH \NNN` (octal)

---

## 2. AST Node Types

The recursive-descent parser (`src/parser.js`) returns plain JS objects. Every node carries `{type, ...fields}`. No classes.

### Literals

```js
{ type: 'IntLit',    value: 42n }
{ type: 'UintLit',   value: 42n }
{ type: 'FloatLit',  value: 3.14 }
{ type: 'StringLit', value: 'hello' }
{ type: 'BytesLit',  value: Uint8Array }
{ type: 'BoolLit',   value: true }
{ type: 'NullLit' }
```

### Identifier

```js
{ type: 'Ident', name: 'x' }
```

### Unary Operations

```js
{ type: 'Unary', op: '-' | '!', operand: <node> }
```

### Binary Operations

```js
{ type: 'Binary', op: '+' | '-' | '*' | '/' | '%' | '**'
                     | '==' | '!=' | '<' | '<=' | '>' | '>='
                     | '&&' | '||' | '^' | 'in',
  left: <node>, right: <node> }
```

### Ternary (Conditional)

```js
{ type: 'Ternary', cond: <node>, then: <node>, else: <node> }
```

### Field / Index Access

```js
{ type: 'Select', object: <node>, field: 'name' }       // obj.field
{ type: 'Index',  object: <node>, index: <node> }        // obj[expr]
{ type: 'OptSelect', object: <node>, field: 'name' }     // obj?.field
```

### Collections

```js
{ type: 'List', elements: [<node>,...] }
{ type: 'Map',  entries: [{key: <node>, value: <node>},...] }
```

### Function Call

```js
{ type: 'Call',  name: 'size', args: [<node>,...] }           // size(x)
{ type: 'RCall', receiver: <node>, method: 'contains',        // x.contains("y")
                 args: [<node>,...] }
```

### Macros (expanded by checker into special AST nodes)

```js
{ type: 'HasMacro',        expr: <select_node> }
{ type: 'Comprehension',   iterVar: 'x', iterRange: <node>,
                           accuVar: '__result__', accuInit: <node>,
                           loopCondition: <node>, loopStep: <node>,
                           result: <node> }
```

Macros `all`, `exists`, `exists_one`, `map`, `filter`, `cel.bind` are all desugared to `Comprehension` during the checker phase.

---

## 3. Opcode Table

Cap: **42 opcodes** (leaves headroom under 50). Each instruction is `opcode:u8` + 0–2 operand bytes.

### Phase 1 — Core (32 opcodes)

| # | Opcode | Operands | Stack Effect | Description |
|---|---|---|---|---|
| 0 | `PUSH_CONST` | `u16` idx | `→ v` | Push `constants[idx]` |
| 1 | `LOAD_VAR` | `u16` idx | `→ v` | Push `activation[idx]` |
| 2 | `POP` | — | `v →` | Discard top of stack |
| 3 | `RETURN` | — | — | End; TOS is result |
| 4 | `JUMP` | `i16` offset | — | `pc += offset` (from next instr) |
| 5 | `JUMP_IF_FALSE` | `i16` offset | `b →` | Pop bool; jump if false |
| 6 | `JUMP_IF_TRUE` | `i16` offset | `b →` | Pop bool; jump if true |
| 7 | `JUMP_IF_FALSE_K` | `i16` offset | — | Peek bool; jump if false (keep on stack) |
| 8 | `JUMP_IF_TRUE_K` | `i16` offset | — | Peek bool; jump if true (keep on stack) |
| 9 | `ADD` | — | `a b → r` | Numeric add, string concat, list concat, duration+timestamp |
| 10 | `SUB` | — | `a b → r` | Numeric subtract |
| 11 | `MUL` | — | `a b → r` | Numeric multiply |
| 12 | `DIV` | — | `a b → r` | Numeric divide |
| 13 | `MOD` | — | `a b → r` | Integer modulo |
| 14 | `POW` | — | `a b → r` | Exponentiation (`**`); int or double |
| 15 | `NEG` | — | `a → r` | Unary minus |
| 16 | `EQ` | — | `a b → bool` | Equality |
| 17 | `NEQ` | — | `a b → bool` | Inequality |
| 18 | `LT` | — | `a b → bool` | Less than |
| 19 | `LE` | — | `a b → bool` | Less or equal |
| 20 | `GT` | — | `a b → bool` | Greater than |
| 21 | `GE` | — | `a b → bool` | Greater or equal |
| 22 | `NOT` | — | `b → bool` | Logical NOT |
| 23 | `XOR` | — | `a b → int` | Bitwise XOR (`^`); integer only |
| 24 | `BUILD_LIST` | `u16` n | `v₀..vₙ → list` | Pop n items, push list |
| 25 | `BUILD_MAP` | `u16` n | `k₀v₀..kₙvₙ → map` | Pop 2n items (k,v pairs), push map |
| 26 | `INDEX` | — | `obj idx → v` | Collection index; error on OOB |
| 27 | `IN` | — | `v col → bool` | Membership test (list or map keys) |
| 28 | `SELECT` | `u16` name_idx | `obj → v` | Field/key access; error if missing |
| 29 | `HAS_FIELD` | `u16` name_idx | `obj → bool` | `has()` macro: does field exist? |
| 30 | `CALL` | `u16` id, `u8` argc | `args… → v` | Call built-in by id; pop argc args |
| 31 | `SIZE` | — | `v → int` | `size()` for string/list/map/bytes |

### Phase 2 — Comprehensions (5 opcodes)

| # | Opcode | Operands | Stack Effect | Description |
|---|---|---|---|---|
| 32 | `ITER_INIT` | — | `list → iter` | Replace list with iterator state |
| 33 | `ITER_NEXT` | `i16` done_offset | `iter → iter elem` | Push next element; jump-at-end |
| 34 | `ITER_POP` | — | `iter →` | Discard exhausted iterator |
| 35 | `ACCUM_PUSH` | `u16` init_idx | `→ acc` | Push accumulator from constant |
| 36 | `ACCUM_SET` | — | `acc v → acc` | Replace accumulator with v |

Macro desugar patterns (generated by compiler):

```
// [1,2,3].exists(x, x > 0)  →
PUSH_CONST  [1,2,3]
ITER_INIT
ACCUM_PUSH  false          // accumulator starts false
loop:
  ITER_NEXT  done          // push next element
  LOAD_VAR   x_idx         // (x bound to element via LOAD_VAR pattern)
  PUSH_CONST 0
  GT
  JUMP_IF_TRUE_K exit_early
JUMP loop
exit_early:
  ACCUM_SET  true
done:
  ITER_POP
  // accumulator on stack = result
```

### Phase 3 — Optional Types (5 opcodes)

| # | Opcode | Operands | Stack Effect | Description |
|---|---|---|---|---|
| 37 | `OPT_SELECT` | `u16` name_idx | `obj → opt` | `?.` safe navigation; push `none` if absent |
| 38 | `OPT_NONE` | — | `→ none` | Push `optional.none()` |
| 39 | `OPT_OF` | — | `v → opt(v)` | Wrap in optional |
| 40 | `OPT_OR_VALUE` | — | `opt def → v` | Unwrap optional or use default |
| 41 | `OPT_CHAIN` | `i16` offset | — | Peek; jump to offset if TOS is `none` |

### Builtin Function IDs (for `CALL` operand)

```js
const BUILTIN = {
  // String
  STRING_CONTAINS:    0,   STRING_STARTS_WITH: 1,
  STRING_ENDS_WITH:   2,   STRING_SUBSTRING:   3,
  STRING_INDEX_OF:    4,   STRING_SPLIT:        5,
  STRING_LOWER_ASCII: 6,   STRING_UPPER_ASCII:  7,
  STRING_TRIM:        8,   STRING_MATCHES:      9,
  STRING_REPLACE:     10,  STRING_JOIN:         11,
  // Type conversions
  TO_INT:    20,  TO_UINT:   21,  TO_DOUBLE: 22,
  TO_STRING: 23,  TO_BOOL:   24,  TO_BYTES:  25,
  TYPE_OF:   26,
  // Timestamps / Duration
  TIMESTAMP:    30,  DURATION:     31,
  GET_FULL_YEAR:32,  GET_MONTH:    33,  GET_DAY:    34,
  GET_HOURS:    35,  GET_MINUTES:  36,  GET_SECONDS:37,
  // Math ext
  MATH_MAX: 40,  MATH_MIN: 41,  MATH_ABS: 42,
}
```

---

## 4. Bytecode Binary Format

```
┌───────────────────────────────────────────────────┐
│ magic: u16  = 0x4345 ("CE")                        │
│ version: u8 = 1                                    │
│ flags: u8   = 0x00 (reserved)                      │
├───────────────────────────────────────────────────┤
│ CONST POOL                                         │
│   count: u16                                       │
│   entry × count:                                   │
│     tag: u8 (0=null,1=bool,2=int64,3=uint64,       │
│              4=double,5=string,6=bytes)             │
│     payload (tag-dependent):                       │
│       null  →  (none)                              │
│       bool  →  u8 (0 or 1)                         │
│       int64 →  i64 (8 bytes, big-endian)           │
│       uint64→  u64 (8 bytes, big-endian)           │
│       double→  f64 IEEE-754 (8 bytes, big-endian)  │
│       string→  u32 len + UTF-8 bytes               │
│       bytes →  u32 len + raw bytes                 │
├───────────────────────────────────────────────────┤
│ VAR TABLE                                          │
│   count: u16                                       │
│   entry × count:                                   │
│     u32 name_len + name_bytes (UTF-8)              │
│   (order = activation array index)                 │
├───────────────────────────────────────────────────┤
│ INSTRUCTIONS                                       │
│   count: u32                                       │
│   instr × count:                                   │
│     opcode: u8                                     │
│     operands: 0–3 bytes (per opcode table)         │
├───────────────────────────────────────────────────┤
│ DEBUG INFO (optional, flag bit 0)                  │
│   count: u32 (= instruction count)                 │
│   entry × count:                                   │
│     line: u16, col: u16                            │
├───────────────────────────────────────────────────┤
│ checksum: u32 (Adler-32 of all preceding bytes)    │
└───────────────────────────────────────────────────┘
```

**Operand byte widths by opcode:**

| Opcodes | Encoding |
|---|---|
| `PUSH_CONST`, `LOAD_VAR`, `SELECT`, `HAS_FIELD`, `OPT_SELECT`, `ACCUM_PUSH` | 2 bytes (u16) |
| `JUMP`, `JUMP_IF_FALSE`, `JUMP_IF_TRUE`, `JUMP_IF_FALSE_K`, `JUMP_IF_TRUE_K`, `ITER_NEXT`, `OPT_CHAIN` | 2 bytes (i16, signed) |
| `BUILD_LIST`, `BUILD_MAP` | 2 bytes (u16 count) |
| `CALL` | 3 bytes: u16 builtin_id + u8 argc |
| All others (`ADD`…`SIZE`, `RETURN`, `POP`, etc.) | 0 bytes |

**Serialisation/deserialisation** (`src/bytecode.js`):

```js
// encode:  Uint8Array → Base64 string
const b64 = btoa(String.fromCharCode(...uint8arr))

// decode:  Base64 string → Uint8Array
const uint8arr = Uint8Array.from(atob(b64), c => c.charCodeAt(0))

// DataView used for all multi-byte reads/writes to handle endianness
const view = new DataView(buf.buffer)
view.setInt16(offset, value, false)   // big-endian
```

---

## 5. VM Dispatch Strategy

`src/vm.js` exports a plain function (not a class) for V8 JIT friendliness:

```js
export function evaluate(bytecode, activation) {
  // Decode header + const pool once
  const { consts, varTable, instrs } = decode(bytecode)

  // Build activation array (string → index resolved at compile time)
  const vars = new Array(varTable.length)
  for (let i = 0; i < varTable.length; i++) {
    vars[i] = activation[varTable[i]]
  }

  const stack = []
  let sp = -1   // stack pointer
  let pc = 0
  const len = instrs.length

  while (pc < len) {
    const op = instrs[pc++]
    switch (op) {
      case OP.PUSH_CONST: { /* ... */ break }
      case OP.LOAD_VAR:   { /* ... */ break }
      // ...
    }
  }
  return stack[sp]
}
```

**Key dispatch rules:**

- `&&` short-circuit: compiled as `JUMP_IF_FALSE_K` (peek, don't pop) + `POP` after the right branch.
- `||` short-circuit: compiled as `JUMP_IF_TRUE_K` + `POP`.
- Ternary `? :`: `JUMP_IF_FALSE` to else-branch, `JUMP` over else at end of then-branch.
- Type errors (e.g. `int + string`) throw `EvaluationError` with position info from debug section.

**Value representation (stack items):** Plain JS values for MVP; the `Uint32Array` pool described in the brief is a post-benchmark optimisation.

- `null` → JS `null`
- `bool` → JS `boolean`
- `int64` → JS `BigInt`
- `uint64` → JS `BigInt` (tagged separately in const pool)
- `double` → JS `number`
- `string` → JS `string`
- `bytes` → `Uint8Array`
- `list` → JS `Array`
- `map` → JS `Map`
- `type` → `{ _celType: true, name: 'int' }`
- `optional` → `{ _celOptional: true, value: ... | undefined }`

Type tags are checked at runtime inside each operator case of the dispatch loop.

---

## 6. Checker Responsibilities (`src/checker.js`)

Before the compiler sees the AST, the checker must:

1. **Macro expansion** — rewrite `exists(x, pred)`, `all(x, pred)`, `filter(x, pred)`, `map(x, f)`, `exists_one(x, pred)`, `cel.bind(x, v, e)` into `Comprehension` AST nodes.
2. **`has()` expansion** — rewrite `has(obj.field)` into `HasMacro` node.
3. **Type inference** (optional for MVP; mark nodes with inferred type for compiler hints).
4. **Reserved identifier rejection** — reject `if`, `else`, `for`, `var`, `package`, `as`, `import` as root-level identifiers.
5. **Security checks** — reject `__proto__`, `constructor`, `prototype` as field names.

---

## 7. Compiler Strategy (`src/compiler.js`)

### Constant Folding

Collapse literal-only subexpressions at compile time:

```
IntLit(1) + IntLit(2)  →  PUSH_CONST(3n)   (not ADD)
!BoolLit(true)         →  PUSH_CONST(false)
```

Fold: all arithmetic on two `IntLit`/`FloatLit` nodes, comparison of two literals, `!` of `BoolLit`.

### Short-Circuit Compilation

```
// a && b
compile(a)
JUMP_IF_FALSE_K  +N      // jump to POP if false
POP                       // discard a (it was true)
compile(b)
// fall through; result of b is on stack
// +N:
POP                       // discard a (it was false); false stays as result

// Actually simpler: emit a, then JUMP_IF_FALSE over b+POP:
compile(a)
JUMP_IF_FALSE  skip       // if a is false, skip b (false stays)
POP                        // a was true, discard it
compile(b)
skip:
```

### Activation Index Resolution

At compile time, collect all `Ident` nodes that refer to external variables (not macro-bound vars). Build a sorted `varTable = [name0, name1, ...]`. Replace each `Ident` with `LOAD_VAR idx`.

### Comprehension Emission

For `Comprehension(iterVar, iterRange, accuInit, loopCond, loopStep, result)`:

```
compile(iterRange)
ITER_INIT
ACCUM_PUSH   init_const      // or compile(accuInit) if not constant
loop_start:
ITER_NEXT    done_offset      // push element or jump to done
// bind element to iterVar slot (use LOAD_VAR with special slot)
compile(loopStep)
ACCUM_SET
JUMP   loop_start
done:
ITER_POP
// accumulator is result
```

---

## 8. Test Porting Strategy

### Phase 0 — Infrastructure

Port tests **before** writing any source. Tests start failing (red); implementation makes them pass (green).

1. Write `test/helpers.js` — shared utilities:
   - `cel(expr, vars?)` — call `compile()` + `evaluate()`; throw on error
   - `assertCel(t, expr, expected, vars?)`
   - Simple textproto parser (for cel-spec files): extract `name`, `expr`, `value`, `eval_error`, `bindings`
   - Value converter: textproto `{ int64_value: 42 }` → `42n`

2. Write `test/cel-spec/runner.js` — reads `*.textproto` files and generates `node:test` suites dynamically.

### Phase 1 — Port First (Unblock Lexer + Parser)

**From marcbachmann/cel-js** → `test/marcbachmann/`:

| File | Expressions covered |
|---|---|
| `arithmetic.test.js` | `1+1`, `2*3`, `2+3*4`, precedence |
| `comparisons.test.js` | `1==1`, `1<2`, `"a"<"b"`, `false<true` |
| `logical-operators.test.js` | `&&`, `\|\|`, `!`, short-circuit |
| `conditional-ternary.test.js` | `true?1:2`, nested ternary |
| `unary-operators.test.js` | `-5`, `!true`, `!!false` |
| `string-literals.test.js` | Escape sequences, triple-quoted, raw, bytes |
| `identifiers.test.js` | Variable binding, `{x:123}` activation |
| `atomic-expression.test.js` | Bare literals, `null`, `true`, `false` |

**From cel-spec** → `test/cel-spec/`:

| File | Priority |
|---|---|
| `basic.textproto` | ★★★ |
| `integer_math.textproto` | ★★★ |
| `logic.textproto` | ★★★ |
| `comparisons.textproto` | ★★★ |

### Phase 2 — Collections + Functions

**marcbachmann:**

| File | Coverage |
|---|---|
| `lists.test.js` | Index, concat, `in` |
| `maps.test.js` | Literal, dot access, bracket access |
| `in-operator.test.js` | `in` for list and map |
| `built-in-functions.test.js` | `size`, `contains`, `startsWith`, type conversions |
| `precedence.test.js` | Full operator precedence |

**cel-spec:**

| File | Priority |
|---|---|
| `string.textproto` | ★★★ |
| `lists.textproto` | ★★★ |
| `fields.textproto` | ★★☆ |
| `fp_math.textproto` | ★★☆ |

### Phase 3 — Macros + Advanced

**marcbachmann:**

`macros.test.js` — `all`, `exists`, `filter`, `map`, `cel.bind`

`optional-type.test.js` — `?.`, `optional.of`, `optional.none`, `orValue`

**cel-spec:**

`macros.textproto`, `conversions.textproto`, `string_ext.textproto`, `optionals.textproto`

### Phase 4 — Timestamps, Protos, Extended

`timestamps.textproto`, `enums.textproto`, `math_ext.textproto`, `async-functions.test.js` — defer until core is solid.

---

## 9. Implementation Phases

### Phase 1: Lexer + Basic Parser Tests (Week 1)

**Goal:** `bun test test/marcbachmann/arithmetic.test.js` fully green.

Files:
- `test/helpers.js`
- `test/marcbachmann/arithmetic.test.js`
- `test/marcbachmann/comparisons.test.js`
- `test/marcbachmann/logical-operators.test.js`
- `test/marcbachmann/conditional-ternary.test.js`
- `test/marcbachmann/unary-operators.test.js`
- `test/marcbachmann/string-literals.test.js`
- `test/marcbachmann/identifiers.test.js`
- `test/marcbachmann/atomic-expression.test.js`
- `src/lexer.js`
- `src/parser.js`
- `src/index.js` (stub: `compile`, `evaluate`)

### Phase 2: Checker + Compiler + VM Core (Week 2)

**Goal:** Phase 1 + Phase 2 marcbachmann tests green; all cel-spec Phase 1 files green.

Files:
- `src/checker.js`
- `src/compiler.js`
- `src/vm.js`
- `test/marcbachmann/lists.test.js`
- `test/marcbachmann/maps.test.js`
- `test/marcbachmann/in-operator.test.js`
- `test/marcbachmann/built-in-functions.test.js`
- `test/cel-spec/runner.js`
- `test/cel-spec/basic.test.js`
- `test/cel-spec/integer_math.test.js`
- `test/cel-spec/logic.test.js`
- `test/cel-spec/comparisons.test.js`
- `test/cel-spec/string.test.js`
- `test/cel-spec/lists.test.js`

### Phase 3: Bytecode Serialiser (Week 2–3)

**Goal:** `compile(src)` → `Uint8Array`; `load(b64)` round-trips correctly.

Files:
- `src/bytecode.js`
- `test/bytecode.test.js` (encode/decode round-trip, checksum validation)

### Phase 4: Macros + Extended Functions (Week 3)

**Goal:** Comprehension macros green; most cel-spec files pass.

Files:
- `test/marcbachmann/macros.test.js`
- `test/cel-spec/macros.test.js`
- `test/cel-spec/conversions.test.js`
- `test/cel-spec/string_ext.test.js`
- `test/cel-spec/fp_math.test.js`
- `test/cel-spec/fields.test.js`

### Phase 5: Optional Types + Remaining (Week 4)

Files:
- `test/marcbachmann/optional-type.test.js`
- `test/cel-spec/optionals.test.js`
- `test/cel-spec/timestamps.test.js`

### Phase 6: Benchmark (Week 4)

- `bench/compare.js` — compare throughput vs `marcbachmann/cel-js` on repeated evaluation.
- Target: 5–15× faster on hot-path evaluation.

---

## 10. File Structure (Final)

```
cel-vm/
├── src/
│   ├── lexer.js        — tokeniser (hand-written)
│   ├── parser.js       — recursive-descent AST
│   ├── checker.js      — macro expansion + type inference
│   ├── compiler.js     — AST → bytecode; const folding, short-circuit
│   ├── bytecode.js     — encode/decode (DataView), Base64 ser/deser
│   ├── vm.js           — while/switch dispatch loop
│   └── index.js        — public API: compile(), evaluate(), load()
├── test/
│   ├── helpers.js      — assertCel, textproto parser, value converter
│   ├── cel-spec/
│   │   ├── runner.js           — textproto → node:test dynamic runner
│   │   ├── basic.test.js
│   │   ├── integer_math.test.js
│   │   ├── logic.test.js
│   │   ├── comparisons.test.js
│   │   ├── string.test.js
│   │   ├── lists.test.js
│   │   ├── fields.test.js
│   │   ├── fp_math.test.js
│   │   ├── macros.test.js
│   │   ├── conversions.test.js
│   │   ├── string_ext.test.js
│   │   ├── optionals.test.js
│   │   └── timestamps.test.js
│   └── marcbachmann/
│       ├── arithmetic.test.js
│       ├── comparisons.test.js
│       ├── logical-operators.test.js
│       ├── conditional-ternary.test.js
│       ├── unary-operators.test.js
│       ├── string-literals.test.js
│       ├── identifiers.test.js
│       ├── atomic-expression.test.js
│       ├── lists.test.js
│       ├── maps.test.js
│       ├── in-operator.test.js
│       ├── built-in-functions.test.js
│       ├── macros.test.js
│       └── optional-type.test.js
└── bench/
    └── compare.js      — throughput vs marcbachmann/cel-js
```

---

## 11. Key Design Constraints (Do Not Break)

1. **No runtime dependencies.** `package.json` devDependencies only.
2. **VM is a plain function**, not a class. `export function evaluate(...)`.
3. **Variables resolved to integer indices at compile time.** Zero string lookups in the hot loop.
4. **Opcode count ≤ 50.** Protects V8 branch predictor.
5. **BigInt for all integers** (both `int64` and `uint64`). Required for 64-bit correctness per cel-spec.
6. **No implicit numeric coercion.** `2.5 * 2` is a runtime `EvaluationError` (no such overload: double × int).
7. **Prototype safety.** Drop `__proto__`, `constructor`, `prototype` as field names silently.
8. **Short-circuit must suppress errors.** `false && (1/0 == 0)` must return `false`, not throw.

---

## 12. Open Questions

- **Prototype-based messages (proto2/proto3):** cel-spec tests include proto message field access. Defer until after core is solid; treat proto messages as plain JS objects initially.
- **RE2 regex:** `matches()` uses RE2 semantics. The native JS `RegExp` is PCRE-ish. Use it for MVP; add RE2 library as dev-optional if tests diverge.
- ~~**Timestamp/Duration:** Full timestamp arithmetic requires a date library. Implement basic `getFullYear()` etc. via `Date` for MVP; mark timestamp tests as known-deferred.~~ **RESOLVED:** Timestamp/duration arithmetic, comparisons, type conversions, and all accessors (including timezone-aware variants) are fully implemented using native `Date` and `Intl.DateTimeFormat`. No external date library needed. All 12 timezone cel-spec tests pass.
- **`uint64` overflow semantics:** CEL spec wraps on overflow. Requires explicit modulo `2n**64n` in arithmetic ops.
- **Debug info inclusion:** Include debug section by default (useful for error messages) but allow stripping via `compile(src, {debug: false})`.
- **`uint` vs `int` runtime distinction:** Both are stored as `BigInt` — the type difference exists only in the constant pool (`TAG_UINT64` vs `TAG_INT64`). This blocks `-(42u)` error detection and `0u - 1u` underflow. Options: (a) tagged value wrapper `{__celUint: true, value: 42n}`, (b) separate uint `Uint64Array`-backed pool, or (c) accept the spec divergence.
- **CEL commutative error model for `&&`/`||`:** The current `JUMP_IF_FALSE_K → POP → [right]` compilation discards the left-side value. `error && true` returns `true` instead of `error`. Fix requires new opcodes (`OP.LOGICAL_AND`/`OP.LOGICAL_OR`) that combine two values with CEL's error semantics, or restructuring to preserve both values.
- **String `size()` codepoint semantics:** `celSize()` returns `v.length` (UTF-16 code units). CEL spec says `size()` on strings is codepoint count. For SMP characters (emoji, etc.) these differ. Fix: `[...v].length`. Same issue affects `substring()` which uses UTF-16 offsets.
- **Bytes literal escape semantics:** `b'\u00ff'` should produce UTF-8 bytes `[0xC3, 0xBF]` (2 bytes), but the lexer's `scanBytes()` produces `[0xFF]` (1 byte) because it uses `charCodeAt()` after `scanString()`. Fixing requires distinguishing `\u`/`\U` escapes (UTF-8 encode) from `\x`/octal escapes (raw byte value) in bytes context.

---

## 13. Remaining Skipped Tests — Low-Hanging Fruit Analysis

324 tests are currently skipped (down from 342 after Tier 1 work). 15 pre-existing failures remain. Here is a prioritised breakdown of what could be implemented using standard JS (no dependencies).

### Tier 1: Easy Wins — ✅ DONE (48 tests unskipped, 6 pre-existing failures fixed)

Implemented in `feature/tier1-easy-wins` branch. Actual test counts differed from original estimates (original estimates in parentheses).

| Category | Tests | Status |
|----------|-------|--------|
| **`math.greatest` / `math.least`** | 21 (est. 74) | ✅ Done — variable-arity BUILTIN dispatch. Remaining 53 in testdata need cross-type `dyn()` coercion (Tier 2). |
| **String extensions** | 15 (est. 38) | ✅ Done — `charAt` (codepoint-aware), `lastIndexOf`, `strings.quote` (new namespace), `join`, `lowerAscii`/`upperAscii` unskipped. Remaining: `indexOf` with offset, `replace` with limit, `split` with limit, `substring` out-of-range. |
| **Unicode SMP strings** | 5 (est. 9) | ✅ Done — JS handles surrogate pairs natively. No code changes needed. |
| **Error short-circuit** | 7 (est. 1) | ✅ Partial — `JUMP_IF_FALSE_K`/`JUMP_IF_TRUE_K` now convert non-bool to `celError` instead of throwing. Also fixed `INDEX` opcode to reject non-integer indices. |
| ~~**List index coercion**~~ | 0 (est. 18) | ✅ Already passing — `INDEX` opcode already coerces BigInt to Number. Removed from scope. |
| **Integer math errors** | 0 (est. 5) | ⏭️ Deferred — `uint`/`int` both stored as BigInt at runtime, indistinguishable. Needs runtime type tagging. |
| **Bytes escapes** | 0 (est. 4) | ⏭️ Deferred — `scanBytes()` needs different escape semantics for `\u` (UTF-8 encode) vs `\x` (raw byte). Plus bytes comparison operators not implemented. |

**New finding — CEL commutative error model (10+ tests):** `&&`/`||` require that `error && false = false` and `error || true = true` in both orderings. The current compilation pattern (`JUMP → POP → right`) discards the left-side error. Proper fix needs new opcodes (`OP.LOGICAL_AND`/`OP.LOGICAL_OR`) or restructured compilation. Moved to Tier 2.

### Tier 2: Medium Effort — `dyn()` and Type Coercion (remaining ~300 tests)

The single biggest unlock: cross-type numeric coercion and the commutative error model.

| Category | Tests | What's Missing | Complexity |
|----------|-------|----------------|------------|
| **Cross-type comparisons** | 183 | `dyn(1) == 1u`, `dyn(1.0) == 1`, NaN handling | Medium — need coercion in EQ/NEQ/LT/LE/GT/GE |
| **Optional extensions** | 67 | `optional.of()`, `hasValue()`, `orValue()`, `optMap()`, `optFlatMap()`, `or()`, `ofNonZeroValue()` | Medium — new wrapper type + ~7 builtins |
| **Type conversions via dyn** | 55 | `int(dyn("36"))`, `bytes(dyn('\u00ff'))` | Medium — dyn-aware branches in TO_INT etc. |
| **Map key coercion** | 35 | `{1u: 1.0}[1]` — normalize numeric keys | Medium — coercion in INDEX/SELECT for maps |
| **Commutative error model** | 10+ | `error && false = false`, `error || true = true` in both orderings | Medium — new opcodes or restructured `&&`/`||` compilation |
| **Macros with coercion** | 14 | `[1, 'foo'].exists(e, e != '1')` | Medium — depends on dyn support |
| **`cel.bind()` macro** | 8 | `cel.bind(t, true, t)` | Medium — checker macro expansion |

### Tier 3: Blocked on Architecture (22 tests)

| Category | Tests | What's Missing |
|----------|-------|----------------|
| **Protobuf type identity** | ~22 | `type(timestamp(...)) == google.protobuf.Timestamp`, nanosecond precision in string output |

### Recommended Implementation Order

1. ~~**`math.greatest` / `math.least`**~~ ✅ Done
2. ~~**String extensions**~~ ✅ Done (core subset)
3. **`dyn()` + cross-type coercion** — 183+ tests, medium but highest total impact (unlocks ~70% of remaining skips)
4. **Commutative error model for `&&`/`||`** — 10+ tests, unblocks error propagation tests across lists/maps/macros
5. **Optional extensions** — 67 tests, independent of dyn
6. **List/map key coercion** — 53 tests, builds on dyn
7. **Remaining string extensions** — `indexOf` offset, `replace` limit, `split` limit
8. **Remaining small categories** — uint type tagging, bytes escapes
