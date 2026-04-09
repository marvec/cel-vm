# cel-vm

High-performance [Common Expression Language](https://github.com/google/cel-spec) (CEL) evaluator in JavaScript using a bytecode VM. No runtime dependencies.

**~24× faster** than [marcbachmann/cel-js](https://github.com/marcbachmann/cel-js) on repeated evaluation (12–47× depending on expression complexity).

## Why

CEL is Google's expression language for policy evaluation, access control, and data validation. Existing JavaScript implementations use tree-walking interpreters — they re-traverse the AST every time an expression is evaluated. That's fine for one-off use, but expensive when the same expression runs millions of times against different inputs (policy engines, rule engines, analytics pipelines).

cel-vm compiles CEL to bytecode once and evaluates it in a tight dispatch loop. The bytecode can be serialised to Base64, stored in a database, and loaded without re-parsing.

### Prior Art

- [google/cel-spec](https://github.com/google/cel-spec) — the reference specification
- [marcbachmann/cel-js](https://github.com/marcbachmann/cel-js) — the fastest previous JavaScript implementation (tree-walker)

## Install

```bash
npm install cel-vm
```

## API

### `run(expr, activation?)` — evaluate in one call

```js
import { run } from 'cel-vm'

run('1 + 2 * 3')                              // → 7n
run('age >= 18', { age: 25n })                 // → true
run('name.startsWith("J")', { name: 'Jane' }) // → true
```

`run()` compiles the expression, caches the bytecode, and evaluates it. On repeated calls with the same expression, compilation is skipped.

### `compile(expr)` — compile to bytecode

```js
import { compile } from 'cel-vm'

const bytecode = compile('x > 0 && y < 100')
// bytecode is a Uint8Array — the compiled program
```

### `evaluate(bytecode, activation?)` — run bytecode

```js
import { compile, evaluate } from 'cel-vm'

const bytecode = compile('x + y')
evaluate(bytecode, { x: 10n, y: 5n })  // → 15n
evaluate(bytecode, { x: 1n, y: 2n })   // → 3n
```

This is the hot path. Pre-compile once, evaluate many times.

### `toB64(bytecode)` / `fromB64(base64)` — serialise and deserialise

```js
import { compile, evaluate, toB64, fromB64 } from 'cel-vm'

// Compile and serialise to Base64 for storage
const bytecode = compile('score > 90')
const b64 = toB64(bytecode)
// → "Q0UBAAABAgAAAA..." — store this in a database, config file, etc.

// Later: deserialise from Base64 and evaluate (no re-compilation)
const loaded = fromB64(b64)
evaluate(loaded, { score: 95n })  // → true
```

### Activation values

Pass variables as a plain object. Use the correct JavaScript types:

| CEL type | JavaScript type | Example |
|----------|----------------|---------|
| `int` / `uint` | `BigInt` | `42n` |
| `double` | `number` | `3.14` |
| `string` | `string` | `'hello'` |
| `bool` | `boolean` | `true` |
| `null` | `null` | `null` |
| `list` | `Array` | `[1n, 2n, 3n]` |
| `map` | `Map` or plain object | `new Map([['a', 1n]])` |
| `bytes` | `Uint8Array` | `new Uint8Array([0x48])` |

### Error types

```js
import { LexError, ParseError, CheckError, CompileError, EvaluationError } from 'cel-vm'
```

All errors include descriptive messages with source location when available.

### `Environment` — custom functions, constants, and variable declarations

```js
import { Environment } from 'cel-vm'

const env = new Environment()
  .registerConstant('minAge', 'int', 18n)
  .registerFunction('hasRole', 2, (user, role) =>
    Array.isArray(user.roles) && user.roles.includes(role)
  )
  .registerMethod('titleCase', 0, (s) =>
    s.replace(/\b\w/g, c => c.toUpperCase())
  )

// Compile once, evaluate many times
const policy = env.compile('user.age >= minAge && hasRole(user, "admin")')
env.evaluate(policy, { user: { age: 25n, roles: ['admin'] } })  // → true

// Or one-shot
env.run('"hello world".titleCase()')  // → "Hello World"
```

See [DOCS.md](DOCS.md) for the full Environment API reference.

## CLI

```bash
# Evaluate an expression
cel '1 + 2'
# → 3

# With variables (JSON — integers auto-convert to BigInt)
cel 'name.startsWith("J") && age >= 18' --vars '{"name": "Jane", "age": 25}'
# → true

# Compile to Base64 bytecode
cel compile 'x > 10'
# → Q0UBAAABAgAAAA...

# Evaluate Base64 bytecode
cel eval 'Q0UBAAABAgAAAA...' --vars '{"x": 42}'
# → true
```

## Supported Features

### Types

`int` (64-bit via BigInt), `uint`, `double`, `bool`, `string`, `bytes` (`b"..."`), `null`, `list`, `map`, `optional`, `timestamp`, `duration`

### Operators

| Category | Operators |
|----------|-----------|
| Arithmetic | `+` `-` `*` `/` `%` `**` (unary `-`) |
| Comparison | `==` `!=` `<` `<=` `>` `>=` |
| Logical | `&&` `\|\|` `!` |
| Membership | `in` |
| Ternary | `? :` |
| Field access | `.` `?.` `[]` |
| Optional | `?.field` `[?index]` |

### String methods

`contains()`, `startsWith()`, `endsWith()`, `matches()`, `size()`, `toLowerCase()` / `lowerAscii()`, `toUpperCase()` / `upperAscii()`, `trim()`, `split()`, `substring()`, `indexOf()`, `replace()`

### Built-in functions

`size()`, `type()`, `int()`, `uint()`, `double()`, `string()`, `bool()`, `timestamp()`, `duration()`

### Macros

`exists()`, `all()`, `exists_one()`, `filter()`, `map()`, `has()`, `cel.bind()`

### Optional types

`optional.of()`, `optional.none()`, `.hasValue()`, `.value()`, `.orValue()`, `.or()`

### Timestamp methods

`getFullYear()`, `getMonth()`, `getDayOfMonth()`, `getDayOfWeek()`, `getDayOfYear()`, `getHours()`, `getMinutes()`, `getSeconds()`, `getMilliseconds()`

### Duration methods

`getHours()`, `getMinutes()`, `getSeconds()`, `getMilliseconds()`

### String literals

Double-quoted, single-quoted, triple-quoted (multiline), raw strings (`r"..."`), byte strings (`b"..."`), full escape sequences (`\n`, `\t`, `\xHH`, `\uHHHH`, `\UHHHHHHHH`, octal)

## Benchmarks

Measured on Apple M1 Pro, Bun 1.3.11, 100K iterations per case. All cel-vm timings are for bytecode evaluation only (pre-compiled).

| Expression | cel-vm | cel-js | Speedup |
|------------|--------|--------|---------|
| `1 + 2 * 3` | 1,861K ops/s | 96K ops/s | **19×** |
| `(x + y) * z` | 1,600K ops/s | 52K ops/s | **31×** |
| `x > 100 && y < 50` | 1,335K ops/s | 56K ops/s | **24×** |
| `x > 0 ? "pos" : "neg"` | 1,266K ops/s | 50K ops/s | **25×** |
| `[1, 2, 3, 4, 5]` | 1,443K ops/s | 31K ops/s | **47×** |
| `list[2]` | 1,694K ops/s | 74K ops/s | **23×** |
| `m.x` | 1,738K ops/s | 123K ops/s | **14×** |
| `l.exists(v, v > 3)` | 598K ops/s | 37K ops/s | **16×** |
| `l.filter(v, v % 2 == 0)` | 395K ops/s | 33K ops/s | **12×** |
| `l.map(v, v * 2)` | 735K ops/s | 38K ops/s | **19×** |
| `x > 0 && y > 0 && x + y < 100` | 1,116K ops/s | 34K ops/s | **33×** |

**Average: 24× faster.** Pre-compiled bytecode is an additional 5.6× faster than compile-and-evaluate.

```bash
# Run the benchmark yourself
bun run bench/compare.js
```

## cel-spec Conformance

**1434 / 1583 tests passing (90.6%)**. 911 / 1060 cel-spec conformance tests (86.0%). All 315 marcbachmann/cel-js compatibility tests pass (100%).

149 cel-spec tests are skipped — see `docs/plans/2026-04-08-006-feat-skipped-test-gap-analysis-plan.md` for the full breakdown and implementation roadmap.

### Divergences

| Area | cel-vm | cel-spec | Reason |
|------|--------|----------|--------|
| **Proto messages** | Plain JS objects only | Proto schema types | No protobuf schema in JS runtimes |
| **int64 precision** | Full 64-bit via `BigInt` | Full 64-bit | cel-vm matches spec; cel-js uses `Number` (silent precision loss above 2^53) |
| **int64 overflow** | Detected (returns error) | Detected | cel-vm checks `[-2^63, 2^63-1]` after arithmetic |
| **uint negation/underflow** | Not detected | Error | `uint` and `int` are both `BigInt` at runtime — type distinction lost after compilation. `-(42u)` and `0u - 1u` silently produce negative BigInts |
| **Commutative errors** | Partial — `error && false → false` ✓, `error && true → true` ✗ | `error && false → false`, `error && true → error` | Left-side errors are discarded by POP in `&&`/`\|\|` compilation. Needs `OP.LOGICAL_AND`/`OP.LOGICAL_OR` opcodes |
| **Regex** | JS `RegExp` | RE2 | No native RE2 in JS; minor semantic differences possible |
| **Timestamps** | Parse, accessors (inc. timezone-aware), arithmetic, comparisons | Full support | Millisecond precision; nanosecond precision not yet implemented |
| **Duration** | Parse, accessors, arithmetic, comparisons | Full support | Duration accessors return total values per spec (e.g. `getMinutes()` = total minutes) |
| **Bytes literals** | `b"..."` → `Uint8Array` | Full support | `\u`/`\U` escapes in bytes produce raw `charCodeAt` instead of UTF-8 encoding |
| **Bytes comparison** | Not supported | `<`, `>`, `<=`, `>=` | Bytes ordering operators not implemented |
| **Enums** | Not supported | Proto schema enums | No proto schema to resolve enum names |
| **Type identifiers** | `type()` returns string | First-class type values | `bool`, `int`, etc. are not resolvable as identifiers |

### Resolved (previously divergent)

- **String `size()`** — now uses Unicode code-point semantics for `size()`, `charAt()`, `indexOf()`, `lastIndexOf()`, `substring()`, and string indexing
- **Commutative errors** — `LOGICAL_AND`/`LOGICAL_OR` opcodes implement proper CEL error semantics (`error && false = false`, `error || true = true`)
- **Duration** — full support including total-value accessors per spec

## Architecture

The pipeline is strictly sequential: source → Lexer → Parser → Checker → Compiler → Bytecode → VM.

```
src/lexer.js       — hand-written tokeniser
src/parser.js      — recursive-descent, plain-object AST
src/checker.js     — macro expansion + security validation
src/compiler.js    — AST → bytecode; constant folding, variable pre-resolution
src/bytecode.js    — binary encode/decode, Base64 serialisation
src/vm.js          — while/switch dispatch loop (plain function, not a class)
src/environment.js — Environment class (custom functions, constants, variable declarations)
src/index.js       — public API
```

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for detailed design decisions.

## Contributing

```bash
# Run all tests
bun test

# Run a single test file
bun test test/marcbachmann/arithmetic.test.js

# Run tests matching a pattern
bun test --test-name-pattern "string literals"

# Benchmark
bun run bench/compare.js
```

Tests are written with Node's built-in `node:test`. No test framework dependencies.

## License

GNU GPLv3
