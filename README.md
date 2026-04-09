# cel-vm

High-performance [Common Expression Language](https://github.com/google/cel-spec) (CEL) evaluator in JavaScript using a bytecode VM. No runtime dependencies.

**~24× faster** than [marcbachmann/cel-js](https://github.com/marcbachmann/cel-js) on repeated evaluation (12–47× depending on expression complexity).

[API Reference](DOCS.md) · [Architecture](IMPLEMENTATION.md) · [License](LICENSE) · [Notices](NOTICES)

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

`run()` compiles the expression, caches the bytecode, and evaluates it. On repeated calls with the same expression, compilation is skipped. See [DOCS.md](DOCS.md#runsrc-activation-options) for full parameter details.

### `program(expr, options?)` — compile to a callable

```js
import { program } from 'cel-vm'

const check = program('x > 0 && y < 100')
check({ x: 10n, y: 5n })   // → true
check({ x: -1n, y: 50n })  // → false
```

Compiles once, returns a function. This is the recommended API for repeated evaluation — same performance as `compile()` + `evaluate()`, less boilerplate. See [DOCS.md](DOCS.md#programsrc-options) for full parameter details.

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

This is the hot path. Pre-compile once, evaluate many times. Use `program()` for a more ergonomic wrapper around this pattern. See [DOCS.md](DOCS.md#compilesrc-options) for compile/evaluate parameter details.

### `toB64(bytecode)` / `load(base64)` — serialise and load

```js
import { compile, evaluate, toB64, load } from 'cel-vm'

// Compile and serialise to Base64 for storage
const bytecode = compile('score > 90')
const b64 = toB64(bytecode)
// → "Q0UBAAABAgAAAA..." — store this in a database, config file, etc.

// Later: load from Base64 and evaluate (no re-compilation)
const loaded = load(b64)
evaluate(loaded, { score: 95n })  // → true
```

See [DOCS.md](DOCS.md#tob64bytecode--loadbase64) for full parameter details.

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

All errors include descriptive messages with source location when available. See [DOCS.md](DOCS.md#error-types) for the full list of error classes.

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

// Compile to a callable — recommended for repeated evaluation
const policy = env.program('user.age >= minAge && hasRole(user, "admin")')
policy({ user: { age: 25n, roles: ['admin'] } })  // → true
policy({ user: { age: 16n, roles: [] } })          // → false

// Or one-shot
env.run('"hello world".titleCase()')  // → "Hello World"

// Enable debug mode for source-mapped error locations
const debug = new Environment().enableDebug()
try {
  debug.run('a / b', { a: 1n, b: 0n })
} catch (e) {
  console.log(e.message)  // "division by zero at 1:3"
}
```

See [DOCS.md](DOCS.md#environment-api) for the full Environment API reference.

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

**1406 / 1610 tests passing (87.3%)**. All 315 marcbachmann/cel-js compatibility tests pass (100%).

202 cel-spec tests are skipped (proto messages, enums, and other features that require protobuf schema support). See `docs/plans/2026-04-08-006-feat-skipped-test-gap-analysis-plan.md` for the full breakdown and implementation roadmap.

### Divergences

| Area | cel-vm | cel-spec | Reason |
|------|--------|----------|--------|
| **Proto messages / enums** | Plain JS objects only | Proto schema types | No protobuf schema in JS runtimes |
| **uint negation/underflow** | Not detected | Error | `uint` and `int` are both `BigInt` at runtime — type distinction lost after compilation. `-(42u)` and `0u - 1u` silently produce negative BigInts |
| **Regex** | JS `RegExp` | RE2 | No native RE2 in JS; minor semantic differences possible |
| **Timestamps** | Full support | Full support | Millisecond precision; nanosecond precision not yet implemented |
| **Bytes literals** | `b"..."` → `Uint8Array` | Full support | `\u`/`\U` escapes in bytes produce raw `charCodeAt` instead of UTF-8 encoding |
| **Bytes comparison** | Not supported | `<`, `>`, `<=`, `>=` | Bytes ordering operators not implemented |
| **Type identifiers** | `type()` returns string | First-class type values | `bool`, `int`, etc. are not resolvable as identifiers |

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
