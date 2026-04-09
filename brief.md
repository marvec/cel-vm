## CEL-VM — Claude Code brief

**Goal:** Build a high-performance CEL (Common Expression Language) evaluator in JavaScript using a bytecode VM. No runtime dependencies.

---

### Architecture

Source string → **Lexer** → **Parser** (AST) → **Checker** (type inference) → **Compiler** (bytecode) → **VM** (register-based executor)

Bytecode is binary (`Uint8Array`), serialised to/from Base64 for JSON transport. Cache compiled bytecode in a `Map<source, Uint8Array>`.

---

### Project structure

```
cel-vm/
├── src/
│   ├── lexer.js       # tokeniser
│   ├── parser.js      # recursive-descent → AST
│   ├── checker.js     # type inference + macro expansion
│   ├── compiler.js    # AST → opcodes
│   ├── bytecode.js    # binary encode/decode, Base64 ser/deser
│   ├── vm.js          # dispatch loop
│   └── index.js       # public API: compile(), evaluate(), load()
├── test/
│   ├── cel-spec/      # conformance tests from google/cel-spec
│   └── marcbachmann/  # tests from marcbachmann/cel-js
└── bench/
    └── compare.js     # benchmark vs marcbachmann/cel-js
```

---

### Implementation rules

**Lexer** — hand-written, no parser-generators. Tokens: identifiers, int, float, string, bool, null, operators (`+ - * / % == != < <= > >= && || ! ?: . [] ()`), keywords (`true false null in`).

**Parser** — recursive-descent, returns plain-object AST nodes.

**Compiler** — ~30–50 opcodes max (keeps V8's branch predictor happy). Short-circuit `&&`/`||` via `JUMP_IF_FALSE`/`JUMP_IF_TRUE`. Apply constant folding (`1 + 2` → `PUSH_CONST 3`).

**Opcode layout:**
```js
const OP = {
  PUSH_CONST: 0,    // push constants[operand]
  LOAD_VAR:   1,    // push activation[operand] (index, not string)
  CALL:       2,    // pop N args, call builtin[operand]
  JUMP:       3,
  JUMP_IF_FALSE: 4,
  JUMP_IF_TRUE:  5,
  RETURN:     6,
  // + arithmetic, comparison, list/map ops
}
```

**VM** — plain `while(pc < len) switch(opcode)` function (not a class — helps V8 JIT). Variables are pre-resolved to integer indices into the activation array (no string lookups at eval time).

**Value representation** — avoid boxing. Flat `Uint32Array` pool: `[type: u8, lo: u32, hi: u32]` per value. Heap-allocate only for lists, maps, long strings.

**Bytecode binary format:**
```
[magic 2B][version 1B][const pool][instructions][debug info][checksum]
```
Each instruction: `opcode (1B)` + up to 2 operands (`u16`/`u32`). Serialise with `DataView` over `ArrayBuffer`, Base64 via `btoa(String.fromCharCode(...bytes))`.

**Cache:** `Map<string, Uint8Array>` keyed on source expression. Base64 form can be stored in JSON, DB, localStorage, etc.

---

### Test sources to port

- `google/cel-spec` — conformance test suite (Go repo, extract the test cases)
- `marcbachmann/cel-js` — existing JS test suite (all expressions must pass)

Use Node's built-in `node:test` runner — no external test framework.

---

### Build order

1. Port both test suites first (drive everything red-to-green)
2. Lexer + lexer tests
3. Parser + parser tests
4. Checker (type inference, macro expansion)
5. Compiler (emit opcodes, constant folding, short-circuit jumps)
6. VM (dispatch loop)
7. Bytecode serialiser (encode/decode/Base64)
8. Public API (`compile(src)`, `evaluate(bytecode, activation)`, `load(b64)`)
9. Benchmark against `marcbachmann/cel-js`

---

### Performance targets

Expected gains over the marcbachmann tree-walker: **5–15× faster** on repeated expression evaluation, due to: no AST traversal at eval time, short-circuit via jumps, constant folding, and integer-indexed variable lookup.
