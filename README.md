# cel-vm

High-performance [Common Expression Language](https://github.com/google/cel-spec) evaluator in JavaScript using a bytecode VM. No runtime dependencies.

**~25× faster** than [marcbachmann/cel-js](https://github.com/marcbachmann/cel-js) on repeated evaluation (12–49× depending on expression type).

## Usage

```js
import { compile, evaluate, run } from './src/index.js'

// One-shot
const result = run('x + y * 2', { x: 10n, y: 5n })  // → 20n

// Pre-compile for repeated evaluation (bytecode is cached automatically)
const bytecode = compile('x > 0 && name.startsWith("a")')
evaluate(bytecode, { x: 1n, name: 'alice' })  // → true
evaluate(bytecode, { x: -1n, name: 'bob' })   // → false
```

## Commands

```bash
# Run tests
bun test

# Run a single test file
bun test test/marcbachmann/arithmetic.test.js

# Benchmark vs marcbachmann/cel-js
bun run bench/compare.js
```

## References

- [google/cel-spec](https://github.com/google/cel-spec) — language specification and conformance tests
- [marcbachmann/cel-js](https://github.com/marcbachmann/cel-js) — tree-walking reference implementation
