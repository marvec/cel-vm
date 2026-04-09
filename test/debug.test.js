// Debug source-mapping tests
//
// Tests for Environment.enableDebug() — source position mapping on errors.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Environment } from '../src/environment.js'
import { EvaluationError } from '../src/vm.js'

// ---------------------------------------------------------------------------
// enableDebug() API
// ---------------------------------------------------------------------------

describe('Environment.enableDebug()', () => {
  it('returns this for chaining', () => {
    const env = new Environment()
    const result = env.enableDebug()
    assert.equal(result, env)
  })

  it('does not affect non-error evaluation', () => {
    const env = new Environment().enableDebug()
    assert.equal(env.run('1 + 2'), 3n)
  })

  it('does not affect evaluation when no error occurs', () => {
    const env = new Environment().enableDebug()
    const bytecode = env.compile('x + y')
    assert.equal(env.evaluate(bytecode, { x: 10n, y: 20n }), 30n)
  })
})

// ---------------------------------------------------------------------------
// Error position mapping — division by zero
// ---------------------------------------------------------------------------

describe('Debug source mapping — division by zero', () => {
  it('maps error to / operator position in "1 / 0"', () => {
    const env = new Environment().enableDebug()
    try {
      env.run('1 / 0')
      assert.fail('expected EvaluationError')
    } catch (e) {
      assert.ok(e instanceof EvaluationError)
      assert.equal(e.line, 1)
      assert.equal(e.col, 3) // '/' is at col 3
    }
  })

  it('maps error to / operator in "a / b" with variables', () => {
    const env = new Environment().enableDebug()
    try {
      env.run('a / b', { a: 10n, b: 0n })
      assert.fail('expected EvaluationError')
    } catch (e) {
      assert.ok(e instanceof EvaluationError)
      assert.equal(e.line, 1)
      assert.equal(e.col, 3) // 'a / b' -> '/' at col 3
    }
  })

  it('maps error in compound expression "a + b / c"', () => {
    const env = new Environment().enableDebug()
    try {
      env.run('a + b / c', { a: 1n, b: 2n, c: 0n })
      assert.fail('expected EvaluationError')
    } catch (e) {
      assert.ok(e instanceof EvaluationError)
      assert.equal(e.line, 1)
      assert.equal(e.col, 7) // 'a + b / c' -> '/' at col 7
    }
  })
})

// ---------------------------------------------------------------------------
// Error position mapping — modulo by zero
// ---------------------------------------------------------------------------

describe('Debug source mapping — modulo by zero', () => {
  it('maps error to % operator position', () => {
    const env = new Environment().enableDebug()
    try {
      env.run('10 % 0')
      assert.fail('expected EvaluationError')
    } catch (e) {
      assert.ok(e instanceof EvaluationError)
      assert.equal(e.line, 1)
      assert.equal(e.col, 4) // '%' at col 4
    }
  })
})

// ---------------------------------------------------------------------------
// Error message includes position
// ---------------------------------------------------------------------------

describe('Debug error message formatting', () => {
  it('includes "at line:col" in error message', () => {
    const env = new Environment().enableDebug()
    try {
      env.run('1 / 0')
      assert.fail('expected EvaluationError')
    } catch (e) {
      assert.ok(e.message.includes('at 1:3'), `expected "at 1:3" in: ${e.message}`)
    }
  })
})

// ---------------------------------------------------------------------------
// Cross-flow: debug bytecode with non-debug dispatch
// ---------------------------------------------------------------------------

describe('Debug cross-flow behavior', () => {
  it('debug bytecode works with non-debug evaluate', () => {
    const debugEnv = new Environment().enableDebug()
    const bytecode = debugEnv.compile('1 + 2')
    // Evaluate with a non-debug environment
    const plainEnv = new Environment()
    assert.equal(plainEnv.evaluate(bytecode), 3n)
  })

  it('non-debug bytecode with debug evaluate falls back gracefully', () => {
    const plainEnv = new Environment()
    const bytecode = plainEnv.compile('1 / 0')
    // Now evaluate with debug — no debug info in bytecode
    const debugEnv = new Environment().enableDebug()
    try {
      debugEnv.evaluate(bytecode)
      assert.fail('expected EvaluationError')
    } catch (e) {
      assert.ok(e instanceof EvaluationError)
      // No debug position info because bytecode was compiled without debug
      // (.line is set by Bun/V8 to JS source line — only check .col)
      assert.equal(e.col, undefined)
    }
  })
})

// ---------------------------------------------------------------------------
// env.run() inherits debug behavior
// ---------------------------------------------------------------------------

describe('Debug via env.run()', () => {
  it('run() produces debug-enriched errors', () => {
    const env = new Environment().enableDebug()
    try {
      env.run('x / 0', { x: 5n })
      assert.fail('expected EvaluationError')
    } catch (e) {
      assert.ok(e instanceof EvaluationError)
      assert.equal(e.line, 1)
      assert.equal(e.col, 3) // '/' at col 3
    }
  })
})

// ---------------------------------------------------------------------------
// Production evaluate is unchanged (no position on errors without debug)
// ---------------------------------------------------------------------------

describe('Non-debug mode has no source positions', () => {
  it('EvaluationError has no col without enableDebug()', () => {
    const env = new Environment()
    try {
      env.run('1 / 0')
      assert.fail('expected EvaluationError')
    } catch (e) {
      assert.ok(e instanceof EvaluationError)
      // .line is set by Bun/V8 to the JS source line — don't check it
      // .col is our custom property and should not be set without debug
      assert.equal(e.col, undefined)
    }
  })
})
