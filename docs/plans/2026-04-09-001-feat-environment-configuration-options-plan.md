---
title: "feat: Environment Configuration Options (cel-js parity)"
type: feat
status: active
date: 2026-04-09
---

# feat: Environment Configuration Options (cel-js parity)

## Overview

Assess whether cel-vm's `Environment` supports the same configuration options as cel-js's `new Environment({...})` constructor, and define what it would take to add them.

## Current State

cel-vm already has an `Environment` class (PR #5, `src/environment.js`) that supports:
- `registerConstant(name, type, value)` — compile-time constant substitution
- `registerFunction(name, arity, impl)` — custom global functions
- `registerMethod(name, arity, impl)` — custom receiver methods
- `registerVariable(name, type)` — strict variable mode (opt-in on first call)
- `compile()` / `evaluate()` / `run()` — self-contained pipeline
- `toConfig()` — plain object for use with standalone `compile`/`evaluate`

**The constructor takes no configuration options.** All current features are builder-method based.

## Gap Analysis: cel-js Options vs cel-vm

### 1. `unlistedVariablesAreDyn: false`

| | cel-js | cel-vm today |
|--|--------|-------------|
| **Strict** (reject undeclared) | `false` | ✅ Supported — call `registerVariable()` once to activate strict mode |
| **Permissive** (all vars allowed) | omit option / don't register | ✅ Supported — default when no `registerVariable()` calls |
| **Hybrid** (declared vars typed, undeclared as `dyn`) | `true` | ❌ Not supported |

**What "hybrid" would require:**
- Compiler change: when `env.declaredVars` is a Map, instead of throwing `CompileError` for undeclared vars, emit a normal `LOAD_VAR` and skip type checking for them.
- New constructor flag: `unlistedVariablesAreDyn: true`.
- Impact: **Trivial at compile-time** (one conditional flip in `src/compiler.js:230`). **Zero run-time impact** — the VM doesn't care about declaration mode.
- But: cel-vm has **no type checker at all**. The `type` param in `registerVariable` is informational only. So the "hybrid" mode would effectively just suppress the `CompileError` — there's no type-checking benefit yet. This option only becomes meaningful when/if a real type-checker is implemented.

**Verdict: Low value today. Trivial to add when type checking is implemented.**

### 2. `homogeneousAggregateLiterals: true`

| | cel-js | cel-vm today |
|--|--------|-------------|
| **Enforce homogeneity** | `true` | ❌ No type checker exists |
| **Allow heterogeneous** | `false` | ✅ Default (no checking at all) |

**What this would require:**
- A type-checking pass in `src/checker.js` that infers element types of list/map literals and rejects mixed types.
- Constructor flag to enable/disable.
- Impact: **Compile-time only** — adds a checker pass that currently doesn't exist. **Zero run-time impact**. But implementing a real type inference system is a large undertaking (the checker currently only does macro expansion + security validation).

**Verdict: Requires a type checker that doesn't exist yet. Not feasible as a standalone feature.**

### 3. `enableOptionalTypes: true`

| | cel-js | cel-vm today |
|--|--------|-------------|
| **Enabled** | `true` | ✅ Always on — `.?field`, `optional.of()`, `optional.none()`, `.orValue()` all work |
| **Disabled** | `false` / default | ❌ Cannot disable |

**What "opt-in" would require:**
- Lexer: gate `?.` / `[?` token recognition behind a flag.
- Checker: gate `optional.of()`, `optional.none()`, `optional.ofNonZeroValue()` macro expansion behind a flag.
- Compiler: gate optional-related opcodes (`OPT_OR_VALUE`, etc.) behind a flag.
- Constructor flag: `enableOptionalTypes: false` (default) or `true`.
- Impact: **Trivial per-flag checks** at compile time. **Zero run-time impact** — disabled features simply don't generate bytecode.
- Note: 67 skipped conformance tests are for optional methods (`optMap`, `optFlatMap`, `.or()`, `.value()`, equality). These are Phase C work and aren't implemented yet.

**Verdict: Easy to gate. Useful for spec compliance (optional types are an extension, not core CEL). But gating something that already works feels backwards — better to add the flag when optional types are feature-complete (after Phase C).**

### 4. `limits: { maxAstNodes, maxDepth, maxListElements, maxMapEntries, maxCallArguments }`

| | cel-js | cel-vm today |
|--|--------|-------------|
| **Parser limits** | Configurable | ❌ No limits at all |

**What this would require:**
- Parser changes (`src/parser.js`):
  - Track node count → reject if `> maxAstNodes`
  - Track recursion depth → reject if `> maxDepth`
  - Count list literal elements → reject if `> maxListElements`
  - Count map literal entries → reject if `> maxMapEntries`
  - Count function call arguments → reject if `> maxCallArguments`
- Constructor option: `limits: { ... }` with sensible defaults.
- Impact: **Minimal compile-time overhead** — integer increments and comparisons. **Zero run-time impact** — limits are checked during parsing only.

**Verdict: Good security/DoS hardening. Independent of type checking. Can be implemented standalone.**

## Summary

| Option | Feasible today? | Blocked by | Value |
|--------|-----------------|------------|-------|
| `unlistedVariablesAreDyn` | Partial (suppress error only) | Type checker | Low — no type checking exists |
| `homogeneousAggregateLiterals` | No | Type checker | Low — requires type inference |
| `enableOptionalTypes` | Yes (gating existing features) | Nothing | Medium — better after Phase C completes |
| `limits` | **Yes** | Nothing | **High — DoS protection, independent** |

## Recommendation

**Only `limits` is worth implementing now.** It's independent, high-value for security, and has zero run-time impact. The other three options all depend on a type checker that doesn't exist — implementing them today would either be a no-op or require building the type checker first.

### Suggested constructor API (if proceeding)

```javascript
const env = new Environment({
  limits: {
    maxAstNodes: 100_000,    // default: Infinity (no limit)
    maxDepth: 250,           // default: Infinity
    maxListElements: 1_000,  // default: Infinity
    maxMapEntries: 1_000,    // default: Infinity
    maxCallArguments: 32     // default: Infinity
  }
})
```

The other options can be added later as the type system matures:

```javascript
// Future (after type checker + Phase C):
const env = new Environment({
  unlistedVariablesAreDyn: false,
  homogeneousAggregateLiterals: true,
  enableOptionalTypes: true,
  limits: { ... }
})
```

## Implementation Sketch (limits only)

### Phase 1: Parser limits

1. **`src/parser.js`** — Add a `limits` parameter to `parse(tokens, limits?)`:
   - Add `nodeCount` counter, increment on each AST node creation
   - Add `depth` counter, increment on recursive descent entry, decrement on exit
   - Check element counts in `parseListLiteral()` and `parseMapLiteral()`
   - Check argument count in `parseCallArguments()`
   - Throw `ParseError` on any exceeded limit

2. **`src/environment.js`** — Accept `limits` in constructor:
   ```javascript
   constructor(options = {}) {
     this._limits = options.limits ?? {}
   }
   ```
   Thread `_limits` through to `parse()` call in `compile()`.

3. **`src/index.js`** — Thread `limits` from `options.env.limits` to `parse()` in standalone `compile()`.

### Performance impact
- **Compile-time**: Negligible — a few integer comparisons per node. Only active when limits are configured.
- **Run-time**: Zero — limits are enforced at parse time only.
- **Benchmark**: Expected no measurable difference in `bun run bench/compare.js`.

## Acceptance Criteria

- [ ] `new Environment({ limits: { maxDepth: 10 } })` rejects deeply nested expressions with `ParseError`
- [ ] `new Environment({ limits: { maxListElements: 5 } })` rejects `[1,2,3,4,5,6]` with `ParseError`
- [ ] `new Environment({ limits: { maxMapEntries: 2 } })` rejects `{"a":1,"b":2,"c":3}` with `ParseError`
- [ ] `new Environment({ limits: { maxCallArguments: 2 } })` rejects `f(1,2,3)` with `ParseError`
- [ ] `new Environment({ limits: { maxAstNodes: 5 } })` rejects complex expressions with `ParseError`
- [ ] No limits by default — existing behavior unchanged
- [ ] `bun test` passes with no regressions
- [ ] `bun run bench/compare.js` shows no performance regression

## Sources

- cel-js Environment API: [marcbachmann/cel-js](https://github.com/marcbachmann/cel-js)
- cel-go EnvOption: [google/cel-go](https://pkg.go.dev/github.com/google/cel-go/cel)
- CEL spec optional types: [proposal-246](https://github.com/google/cel-spec/wiki/proposal-246)
- Existing Environment: `src/environment.js` (PR #5, commit `aec4a80`)
- Gap analysis: `docs/plans/2026-04-08-006-feat-skipped-test-gap-analysis-plan.md`
