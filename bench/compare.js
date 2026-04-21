#!/usr/bin/env bun
// Benchmark: cel-vm vs marcbachmann/cel-js (if installed)
//
// Usage:
//   bun run bench/compare.js
//
// The benchmark measures hot-path evaluation (repeated evaluation of
// pre-compiled bytecode) since that's the core value proposition of
// the bytecode VM approach over tree-walking interpreters.
//
// Methodology (upgraded 2026-04-21 per perf plan):
//   - process.hrtime.bigint() for nanosecond-precision timing
//   - 1,000,000 iterations per run for cel-vm (resolves ~9 ns deltas above noise)
//   - 5 independent runs per case; report median ops/s and IQR
//   - cel-js comparison kept at 100k iterations (interpreter is much slower)

import { compile, evaluate } from '../src/index.js'

// ---------------------------------------------------------------------------
// Benchmark infrastructure
// ---------------------------------------------------------------------------

const RUNS = 5
const CEL_VM_ITERS = 1_000_000
const CEL_JS_ITERS = 100_000
const WARMUP_ITERS = 1_000

function runOnce(fn, iterations) {
  const start = process.hrtime.bigint()
  for (let i = 0; i < iterations; i++) fn()
  const elapsedNs = Number(process.hrtime.bigint() - start)
  return iterations / (elapsedNs / 1e9) // ops/sec
}

function median(sorted) {
  const n = sorted.length
  return n % 2 ? sorted[(n - 1) >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

function quartile(sorted, q) {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function bench(name, fn, iterations = CEL_VM_ITERS, runs = RUNS) {
  // Warm up V8 JIT
  for (let i = 0; i < WARMUP_ITERS; i++) fn()

  const samples = []
  for (let r = 0; r < runs; r++) samples.push(runOnce(fn, iterations))
  samples.sort((a, b) => a - b)

  const med = median(samples)
  const q1 = quartile(samples, 0.25)
  const q3 = quartile(samples, 0.75)
  const iqr = q3 - q1
  const nsPerOp = 1e9 / med
  const nsIqr = (1e9 / q1) - (1e9 / q3) // ns IQR (q1 ops/s ↔ slowest)

  console.log(
    `  ${name.padEnd(50)} ${(med / 1000).toFixed(0).padStart(8)} K ops/s` +
    `  (${nsPerOp.toFixed(2)} ns/op, IQR ±${(nsIqr / 2).toFixed(2)})`
  )
  return { median: med, iqr, nsPerOp, samples }
}

// ---------------------------------------------------------------------------
// Benchmark cases
// ---------------------------------------------------------------------------

console.log('\n=== cel-vm benchmark ===\n')
console.log(`Iterations: ${CEL_VM_ITERS.toLocaleString()} × ${RUNS} runs (median + IQR reported)`)
console.log('Timer: process.hrtime.bigint()')
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
  { name: 'uint arithmetic: 5u + 3u',         expr: '5u + 3u',               vars: {} },
]

console.log('CEL-VM (bytecode evaluate):')
const celVmResults = {}
for (const { name, expr, vars } of cases) {
  const bytecode = compile(expr)  // pre-compile once
  celVmResults[name] = bench(name, () => evaluate(bytecode, vars))
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
      const result = bench(name, () => celJsEvaluate(expr, jsVars), CEL_JS_ITERS, 3)
      const ratio = celVmResults[name].median / result.median
      ratios.push(ratio)
      console.log(`    → cel-vm is ${ratio.toFixed(1)}× faster`)
    } catch {
      console.log(`  ${name.padEnd(50)} skipped (incompatible with cel-js)`)
    }
  }

  if (ratios.length > 0) {
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length
    const min = Math.min(...ratios)
    const max = Math.max(...ratios)
    console.log(`\n  Average speedup: ${avg.toFixed(1)}× (min ${min.toFixed(1)}×, max ${max.toFixed(1)}×)`)
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
}, 100_000)

console.log(`\n  Cache benefit: ${(evalOnly.median / compileEval.median).toFixed(1)}× faster when bytecode is cached`)
console.log()
