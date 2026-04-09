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

Register a custom global function callable from CEL expressions.

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

### `env.registerMethod(name, arity, impl)`

Register a custom method callable on any receiver value.

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
  customFunctions: Map<string, {id, impl, arity}>,
  customMethods: Map<string, {id, impl, arity}>,
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

All errors extend `Error` and set `err.name` to their class name. `LexError` and `ParseError` also include `.line` and `.col` properties for source location.
