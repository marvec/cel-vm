#!/usr/bin/env bun
// Benchmark: cel-vm vs marcbachmann/cel-js (if installed)
//
// Usage:
//   bun run bench/compare.js
//
// The benchmark measures hot-path evaluation (repeated evaluation of
// pre-compiled bytecode) since that's the core value proposition of
// the bytecode VM approach over tree-walking interpreters.

import { compile, evaluate } from '../src/index.js'

// ---------------------------------------------------------------------------
// Benchmark infrastructure
// ---------------------------------------------------------------------------

function bench(name, fn, iterations = 100_000) {
  // Warm up V8 JIT
  for (let i = 0; i < 1000; i++) fn()

  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const elapsed = performance.now() - start

  const opsPerSec = Math.round(iterations / (elapsed / 1000))
  console.log(`  ${name.padEnd(50)} ${(opsPerSec / 1000).toFixed(0).padStart(8)} K ops/s  (${elapsed.toFixed(1)}ms)`)
  return opsPerSec
}

// ---------------------------------------------------------------------------
// Benchmark cases
// ---------------------------------------------------------------------------

console.log('\n=== cel-vm benchmark ===\n')
console.log('All timings are for the EVALUATION phase only (bytecode pre-compiled).\n')

const cases = [
  { name: 'arithmetic: 1 + 2 * 3',           expr: '1 + 2 * 3',            vars: {} },
  { name: 'arithmetic: (x + y) * z',          expr: '(x + y) * z',          vars: { x: 10n, y: 5n, z: 3n } },
  { name: 'comparison: x > 100 && y < 50',    expr: 'x > 100 && y < 50',    vars: { x: 200n, y: 30n } },
  { name: 'string: s.contains("world")',       expr: 's.contains("world")',   vars: { s: 'hello world' } },
  { name: 'ternary: x > 0 ? "pos" : "neg"',   expr: 'x > 0 ? "pos" : "neg"', vars: { x: 5n } },
  { name: 'list literal: [1,2,3,4,5]',        expr: '[1, 2, 3, 4, 5]',      vars: {} },
  { name: 'index: list[2]',                   expr: 'list[2]',               vars: { list: [1n, 2n, 3n] } },
  { name: 'map access: m.x',                  expr: 'm.x',                   vars: { m: new Map([['x', 42n]]) } },
  { name: 'exists macro: l.exists(v,v>3)',     expr: 'l.exists(v, v > 3)',    vars: { l: [1n, 2n, 3n, 4n, 5n] } },
  { name: 'filter macro: l.filter(v,v%2==0)', expr: 'l.filter(v, v % 2 == 0)', vars: { l: [1n, 2n, 3n, 4n, 5n] } },
  { name: 'map macro: l.map(v, v*2)',         expr: 'l.map(v, v * 2)',        vars: { l: [1n, 2n, 3n, 4n, 5n] } },
  { name: 'complex: nested && + comparison',  expr: 'x > 0 && y > 0 && x + y < 100', vars: { x: 10n, y: 20n } },
]

console.log('CEL-VM (bytecode evaluate):')
const celVmResults = {}
for (const { name, expr, vars } of cases) {
  const bytecode = compile(expr)  // pre-compile once
  const opsPerSec = bench(name, () => evaluate(bytecode, vars))
  celVmResults[name] = opsPerSec
}

// ---------------------------------------------------------------------------
// Try to benchmark marcbachmann/cel-js if installed
// ---------------------------------------------------------------------------

let celJsAvailable = false
let celJsEvaluate

try {
  const mod = await import('cel-js')
  celJsEvaluate = mod.evaluate
  celJsAvailable = true
} catch {
  // Not installed
}

if (celJsAvailable) {
  console.log('\nmarcbachmann/cel-js (tree-walker, no pre-compilation):')
  const ratios = []
  for (const { name, expr, vars } of cases) {
    // cel-js uses JS numbers (not BigInt) and plain objects/arrays
    const jsVars = {}
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === 'bigint') jsVars[k] = Number(v)
      else if (Array.isArray(v)) jsVars[k] = v.map(x => typeof x === 'bigint' ? Number(x) : x)
      else if (v instanceof Map) {
        const obj = {}
        for (const [mk, mv] of v) obj[mk] = typeof mv === 'bigint' ? Number(mv) : mv
        jsVars[k] = obj
      }
      else jsVars[k] = v
    }
    try {
      // Verify the expression works with cel-js
      celJsEvaluate(expr, jsVars)
      const opsPerSec = bench(name, () => celJsEvaluate(expr, jsVars), 100_000)
      const ratio = celVmResults[name] / opsPerSec
      ratios.push(ratio)
      console.log(`    → cel-vm is ${ratio.toFixed(1)}× faster`)
    } catch {
      console.log(`    → skipped (incompatible with cel-js)`)
    }
  }

  if (ratios.length > 0) {
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length
    const min = Math.min(...ratios)
    const max = Math.max(...ratios)
    console.log(`\n  Average speedup: ${avg.toFixed(1)}× (min ${min.toFixed(1)}×, max ${max.toFixed(1)}×)`)

    if (avg >= 3) {
      console.log(`  ✓ Target of ≥3× achieved!`)
    } else {
      console.log(`  ✗ Target of ≥3× NOT met (${avg.toFixed(1)}×). Optimisation needed.`)
    }
  }
} else {
  console.log('\nmarcbachmann/cel-js not installed — skipping comparison.')
  console.log('Install with: npm install cel-js')
}

// ---------------------------------------------------------------------------
// Cache efficiency benchmark
// ---------------------------------------------------------------------------

console.log('\n--- Compile + Evaluate vs Evaluate-only ---')
const cacheExpr = '(x + y) * z - 1'
const cacheVars = { x: 10n, y: 5n, z: 3n }
const preBytecode = compile(cacheExpr)

const evalOnly = bench('Evaluate only (bytecode pre-compiled)', () => evaluate(preBytecode, cacheVars))
const compileEval = bench('Compile + Evaluate (cache miss)', () => {
  const b = compile(cacheExpr, { cache: false })
  return evaluate(b, cacheVars)
})

console.log(`\n  Cache benefit: ${(evalOnly / compileEval).toFixed(1)}× faster when bytecode is cached`)
console.log()
