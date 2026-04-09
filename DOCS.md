# CEL-VM API Reference

## Core API

### `compile(src, options?)`

Compile a CEL source string to bytecode.

```js
import { compile } from 'cel-vm'

const bytecode = compile('x > 0 && y < 100')
```

**Parameters:**
- `src` — CEL expression string
- `options.debugInfo` — include line/column debug info (default: `false`)
- `options.cache` — use compilation cache (default: `true`)
- `options.env` — environment config from `env.toConfig()` (for custom functions/constants)

**Returns:** `Uint8Array` — encoded bytecode

### `evaluate(bytecode, activation?, customFunctionTable?)`

Evaluate compiled bytecode against an activation map.

```js
import { compile, evaluate } from 'cel-vm'

const bytecode = compile('x + y')
evaluate(bytecode, { x: 10n, y: 5n })  // → 15n
```

**Parameters:**
- `bytecode` — output of `compile()`
- `activation` — variable bindings `{ name: value }`
- `customFunctionTable` — array of custom function implementations (from `env.toConfig().functionTable`)

### `run(src, activation?, options?)`

Convenience: compile + evaluate in one call, with caching.

```js
import { run } from 'cel-vm'

run('age >= 18', { age: 25n })  // → true
```

**Parameters:**
- `src` — CEL expression string
- `activation` — variable bindings `{ name: value }`
- `options` — same as `compile()` options (`debugInfo`, `cache`, `env`). When `options.env` is provided, its `functionTable` is automatically passed to evaluate.

### `toB64(bytecode)` / `load(base64)`

Serialise bytecode to Base64 and load it back.

```js
import { compile, toB64, load, evaluate } from 'cel-vm'

const b64 = toB64(compile('x > 10'))
const bytecode = load(b64)
evaluate(bytecode, { x: 42n })  // → true
```

---

## Environment API

The `Environment` class lets you register custom functions, constants, and variable declarations. It provides a fluent builder pattern compatible with the cel-js developer experience.

### Creating an Environment

```js
import { Environment } from 'cel-vm'

const env = new Environment()
```

### Constructor Options

The constructor accepts an optional configuration object:

```js
const env = new Environment({
  limits: {
    maxAstNodes: 100_000,     // max AST nodes (default: no limit)
    maxDepth: 250,            // max nesting depth (default: no limit)
    maxListElements: 1_000,   // max elements in a list literal (default: no limit)
    maxMapEntries: 1_000,     // max entries in a map literal (default: no limit)
    maxCallArguments: 32,     // max function call arguments (default: no limit)
  }
})
```

Limits are enforced at **parse time** — they prevent pathologically large or deeply nested expressions from consuming resources. They have zero run-time overhead. When no limits are configured, behaviour is identical to previous versions.

All limit violations throw `ParseError`.

### `env.registerConstant(name, type, value)`

Register a compile-time constant. Constants are substituted directly into bytecode — zero runtime cost.

```js
env.registerConstant('maxRetries', 'int', 3n)
env.registerConstant('apiUrl', 'string', 'https://api.example.com')
env.registerConstant('debug', 'bool', false)
```

**Supported types:** `int`, `uint`, `double`, `string`, `bool`, `bytes`, `null`

Constants take precedence over activation variables with the same name.

### `env.registerFunction(name, arity, impl)`

Register a custom global function callable from CEL expressions. Functions can be overloaded by arity (same name, different argument count).

```js
env.registerFunction('isAdult', 1, (age) => age >= 18n)
env.registerFunction('clamp', 3, (val, lo, hi) => {
  if (val < lo) return lo
  if (val > hi) return hi
  return val
})
```

**Parameters:**
- `name` — function name as used in CEL expressions
- `arity` — number of arguments
- `impl` — JavaScript implementation function

**Note:** Custom function names must not conflict with built-in functions (`int`, `uint`, `double`, `string`, `bool`, `type`, `size`, `timestamp`, `duration`).

**Overloads:** Register the same name with different arities:

```js
env.registerFunction('format', 1, (s) => String(s))
env.registerFunction('format', 2, (s, fmt) => `${fmt}: ${s}`)
// format("hi") → "[hi]", format("hi", 42) → "[hi:42]"
```

### `env.registerMethod(name, arity, impl)`

Register a custom method callable on any receiver value. Methods can be overloaded by arity.

```js
env.registerMethod('reverse', 0, (receiver) => {
  return [...receiver].reverse().join('')
})

env.registerMethod('repeat', 1, (receiver, n) => {
  return receiver.repeat(Number(n))
})
```

**Parameters:**
- `name` — method name as used in CEL expressions
- `arity` — number of arguments **excluding** the receiver
- `impl` — `(receiver, ...args) => result`

Custom methods are checked after built-in methods, so built-ins always take priority.

### `env.registerVariable(name, type)`

Declare a variable. Calling this at least once enables **strict mode**: the compiler will reject references to undeclared variables.

```js
env.registerVariable('user', 'map')
env.registerVariable('request', 'map')

// Now 'env.compile("unknownVar")' will throw CompileError
```

If no variables are declared (permissive mode), any variable name is accepted.

### `env.compile(src, options?)`

Compile a CEL expression within this environment.

```js
const bytecode = env.compile('isAdult(user.age)')
```

**Options:**
- `options.debugInfo` — include line/column debug info (default: `false`)
- `options.cache` — use compilation cache (default: `true`). Cache is invalidated when any registration method is called.

### `env.evaluate(bytecode, activation?)`

Evaluate bytecode compiled within this environment.

```js
const result = env.evaluate(bytecode, { user: { age: 25n } })
```

### `env.run(src, activation?)`

Convenience: compile + evaluate in one call.

```js
env.run('clamp(score, 0, 100)', { score: 150n })  // → 100n
```

### `env.enableDebug()`

Enable debug source mapping. When enabled, `env.compile()` emits source position debug info, and `env.evaluate()` enriches `EvaluationError` instances with `{line, col}` from the original CEL expression. Returns `this` for chaining.

```js
const env = new Environment().enableDebug()

try {
  env.run('a / b + c', { a: 1n, b: 0n, c: 3n })
} catch (e) {
  console.log(e.line)     // 1
  console.log(e.col)      // 3  (position of '/')
  console.log(e.message)  // "division by zero at 1:3"
}
```

Debug mode is off by default with zero runtime cost when disabled. The production `evaluate()` function is not modified — debug evaluation uses a separate code path.

**Cross-flow behavior:**
- Debug bytecode evaluated without debug mode: debug info is ignored, works normally
- Non-debug bytecode evaluated with debug mode: errors have no source positions (graceful fallback)

### `env.toConfig()`

Produce a plain config object for low-level use with `compile()` and `evaluate()`.

```js
const config = env.toConfig()
const bytecode = compile('myFn(x)', { env: config })
const result = evaluate(bytecode, { x: 1n }, config.functionTable)
```

**Returns:**
```js
{
  constants: Map<string, {tag, value}>,
  customFunctions: Map<string, [{id, impl, arity}]>,  // array of overloads
  customMethods: Map<string, [{id, impl, arity}]>,    // array of overloads
  declaredVars: Map<string, string> | null,
  functionTable: Function[],
}
```

### Complete Example

```js
import { Environment } from 'cel-vm'

const env = new Environment()
  .registerVariable('user', 'map')
  .registerConstant('minAge', 'int', 18n)
  .registerFunction('hasRole', 2, (user, role) => {
    return Array.isArray(user.roles) && user.roles.includes(role)
  })
  .registerMethod('titleCase', 0, (s) => {
    return s.replace(/\b\w/g, c => c.toUpperCase())
  })

// Compile once
const policy = env.compile('user.age >= minAge && hasRole(user, "admin")')

// Evaluate many times
env.evaluate(policy, { user: { age: 25n, roles: ['admin'] } })  // → true
env.evaluate(policy, { user: { age: 16n, roles: ['user'] } })   // → false

// Or use run() for one-off evaluation
env.run('"hello world".titleCase()')  // → "Hello World"
```

### Bytecode Portability

Bytecode compiled with custom functions references function IDs that only make sense with the same environment. The bytecode format is unchanged, but evaluation requires passing the matching function table. Use `env.evaluate()` or pass `config.functionTable` to `evaluate()`.

---

## Error Types

```js
import {
  LexError,           // tokenization failures
  ParseError,         // syntax errors
  CheckError,         // type/semantic errors
  CompileError,       // compilation errors (undeclared vars, unknown functions)
  EvaluationError,    // runtime errors
  EnvironmentError,   // environment configuration errors (duplicate registrations, invalid types)
  BytecodeError,      // bytecode encode/decode errors (corrupt data, bad magic, checksum mismatch)
} from 'cel-vm'
```

All errors extend `Error` and set `err.name` to their class name. `LexError` and `ParseError` also include `.line` and `.col` properties for source location. `EvaluationError` includes `.instrIndex` (internal) and, when debug mode is enabled, `.line` and `.col`.

---

## Activation Values

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

---

## Built-in Functions

### Type Conversions

| Function | Description |
|----------|-------------|
| `int(x)` | Convert to int (from uint, double, string, timestamp → Unix seconds) |
| `uint(x)` | Convert to uint |
| `double(x)` | Convert to double |
| `string(x)` | Convert to string (timestamp → ISO 8601, duration → Go format) |
| `bool(x)` | Convert to bool (from string `"true"`/`"false"`) |
| `bytes(x)` | Convert to bytes (from string → UTF-8 encoded) |
| `type(x)` | Returns the type name as a string |
| `dyn(x)` | Dynamic type wrapper — passes value through unchanged |

### Constructors

| Function | Description |
|----------|-------------|
| `timestamp(s)` | Parse an ISO 8601 string to a timestamp |
| `duration(s)` | Parse a Go-style duration string (`"1h30m"`, `"300s"`) |
| `size(x)` | Returns length of string (code points), bytes, list, or map |

### Optional Types

| Function/Method | Description |
|----------------|-------------|
| `optional.of(x)` | Wrap a value in an optional |
| `optional.none()` | Create an empty optional |
| `optional.ofNonZero(x)` / `optional.ofNonZeroValue(x)` | Wrap value if non-zero/non-empty, else `optional.none()` |
| `.hasValue()` | Returns `true` if the optional contains a value |
| `.orValue(default)` | Returns the value if present, otherwise `default` |

---

## String Methods

| Method | Description |
|--------|-------------|
| `s.contains(sub)` | Returns `true` if `s` contains `sub` |
| `s.startsWith(prefix)` | Returns `true` if `s` starts with `prefix` |
| `s.endsWith(suffix)` | Returns `true` if `s` ends with `suffix` |
| `s.matches(regex)` | Returns `true` if `s` matches the regex |
| `s.size()` | Returns string length in Unicode code points |
| `s.toLowerCase()` / `s.lowerAscii()` | Returns lowercase string |
| `s.toUpperCase()` / `s.upperAscii()` | Returns uppercase string |
| `s.trim()` | Returns string with leading/trailing whitespace removed |
| `s.split(sep)` | Splits `s` by `sep`, returns a list. `split(sep, limit)` limits result count |
| `s.substring(start)` / `s.substring(start, end)` | Returns substring by code-point indices |
| `s.indexOf(sub)` / `s.indexOf(sub, offset)` | Returns first code-point index of `sub`, or `-1` |
| `s.lastIndexOf(sub)` | Returns last code-point index of `sub`, or `-1` |
| `s.charAt(i)` | Returns the character at code-point index `i` |
| `s.replace(old, new)` / `s.replace(old, new, limit)` | Replaces occurrences. `limit`: `-1` = all (default), `0` = none, `n` = first n |
| `list.join()` / `list.join(sep)` | Joins list elements into a string. Without separator, uses empty string |
| `s.format(args...)` | String formatting with `%s` (string), `%d` (integer), `%%` (literal `%`) |

All string indexing uses Unicode code-point semantics per cel-spec (not UTF-16 code units).

---

## Macros

| Macro | Description |
|-------|-------------|
| `list.exists(x, pred)` | Returns `true` if any element satisfies `pred` (short-circuits) |
| `list.all(x, pred)` | Returns `true` if all elements satisfy `pred` (short-circuits) |
| `list.filter(x, pred)` | Returns a new list with elements satisfying `pred` |
| `list.map(x, expr)` | Returns a new list with `expr` applied to each element |
| `list.exists_one(x, pred)` | Returns `true` if exactly one element satisfies `pred` |
| `has(obj.field)` | Returns `true` if the field exists (no error on missing) |
| `cel.bind(x, val, body)` | Binds `x` to `val` and evaluates `body` |

---

## Timestamp Methods

All timestamp methods accept an optional timezone string argument. Without it, they return UTC values.

```js
run('ts.getHours()', { ts: { __celTimestamp: true, ms: Date.now() } })
run('ts.getHours("America/New_York")', { ts: { __celTimestamp: true, ms: Date.now() } })
```

| Method | Description |
|--------|-------------|
| `ts.getFullYear(tz?)` | 4-digit year |
| `ts.getMonth(tz?)` | Month (0–11) |
| `ts.getDayOfMonth(tz?)` / `ts.getDate(tz?)` | Day of month (1–31) |
| `ts.getDayOfWeek(tz?)` | Day of week (0 = Sunday, 6 = Saturday) |
| `ts.getDayOfYear(tz?)` | Day of year (1–366) |
| `ts.getHours(tz?)` | Hours (0–23) |
| `ts.getMinutes(tz?)` | Minutes (0–59) |
| `ts.getSeconds(tz?)` | Seconds (0–59) |
| `ts.getMilliseconds(tz?)` | Milliseconds (0–999) |

**Supported timezone formats:** IANA names (`"America/New_York"`), fixed UTC offsets (`"+05:30"`, `"-02:30"`), and bare offsets (`"02:00"` normalised to `"+02:00"`).

**Type conversions:** `int(timestamp)` → Unix seconds, `string(timestamp)` → ISO 8601.

---

## Duration Methods

Duration accessors return **total** values per cel-spec (not modular). For example, `duration("3730s").getMinutes()` returns `62`, not `2`.

| Method | Description |
|--------|-------------|
| `d.getHours()` | Total hours |
| `d.getMinutes()` | Total minutes |
| `d.getSeconds()` | Total seconds |
| `d.getMilliseconds()` | Total milliseconds |

Duration accessors do not accept timezone arguments.

**Type conversion:** `string(duration)` → Go format (e.g. `"1h2m10s"`).

---

## Math Extensions

All `math.*` functions are namespace-qualified. They are resolved at compile time.

### Aggregation

| Function | Description |
|----------|-------------|
| `math.greatest(a, b, ...)` | Returns the maximum value. Accepts 1–N args or a single list |
| `math.least(a, b, ...)` | Returns the minimum value. Accepts 1–N args or a single list |
| `math.max(a, b)` | Returns the maximum of two values |
| `math.min(a, b)` | Returns the minimum of two values |

### Rounding

| Function | Description |
|----------|-------------|
| `math.ceil(x)` | Ceiling (double → double) |
| `math.floor(x)` | Floor (double → double) |
| `math.round(x)` | Round to nearest (double → double) |
| `math.trunc(x)` | Truncate toward zero (double → double) |

### Numeric

| Function | Description |
|----------|-------------|
| `math.abs(x)` | Absolute value (int/uint/double). Note: `math.abs(-2^63)` returns an overflow error |
| `math.sign(x)` | Returns -1, 0, or 1 (same type as input) |

### Testing

| Function | Description |
|----------|-------------|
| `math.isNaN(x)` | Returns `true` if `x` is NaN (double → bool) |
| `math.isInf(x)` | Returns `true` if `x` is ±Infinity (double → bool) |
| `math.isFinite(x)` | Returns `true` if `x` is finite (double → bool) |

### Bitwise

| Function | Description |
|----------|-------------|
| `math.bitAnd(a, b)` | Bitwise AND (BigInt operands) |
| `math.bitOr(a, b)` | Bitwise OR |
| `math.bitXor(a, b)` | Bitwise XOR |
| `math.bitNot(a)` | Bitwise NOT. Note: on uint values, returns a signed result |
| `math.bitShiftLeft(a, n)` | Left shift |
| `math.bitShiftRight(a, n)` | Right shift |

---

## String Extensions

| Function | Description |
|----------|-------------|
| `strings.quote(s)` | Returns the string with special characters escaped and wrapped in quotes |

---

## CLI

The `cel` command-line tool is included when you install the package.

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

**Commands:**
- `cel <expression> [--vars '<json>']` — evaluate a CEL expression
- `cel compile <expression>` — compile to Base64 bytecode
- `cel eval <base64> [--vars '<json>']` — evaluate Base64 bytecode
- `cel --help` — show usage

**Note:** Integer values in `--vars` JSON are automatically coerced to `BigInt`.
