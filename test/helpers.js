// Test helpers for CEL-VM test suites

import assert from 'node:assert/strict'
import { run } from '../src/index.js'

/**
 * Evaluate a CEL expression with optional variable bindings.
 * Returns the result value.
 */
export function cel(expr, vars) {
  return run(expr, vars)
}

/**
 * Assert that a CEL expression evaluates to the expected value.
 * Handles BigInt comparison automatically.
 */
export function assertCel(expr, expected, vars) {
  const result = cel(expr, vars)
  assert.deepStrictEqual(result, expected,
    `CEL: ${expr}\n  expected: ${JSON.stringify(expected, bigIntReplacer)}\n  got:      ${JSON.stringify(result, bigIntReplacer)}`)
}

/**
 * Assert that evaluating a CEL expression throws an error.
 */
export function assertCelError(expr, vars) {
  assert.throws(() => cel(expr, vars), `Expected error for: ${expr}`)
}

function bigIntReplacer(_, v) {
  return typeof v === 'bigint' ? `${v}n` : v
}
