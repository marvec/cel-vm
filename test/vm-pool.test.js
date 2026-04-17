// Tests for the module-scoped stack/uintFlags pool in src/vm.js.
// Covers re-entrancy, error-path cleanup, and deep-stack growth.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compile, evaluate } from '../src/index.js'
import { Environment } from '../src/environment.js'

describe('VM stack pool', () => {
  it('sequential evaluations produce correct independent results', () => {
    const a = compile('x + 1')
    const b = compile('x * 2')
    for (let i = 0; i < 100; i++) {
      assert.equal(evaluate(a, { x: BigInt(i) }), BigInt(i + 1))
      assert.equal(evaluate(b, { x: BigInt(i) }), BigInt(i * 2))
    }
  })

  it('re-entrant evaluate from a custom function returns correct results', () => {
    // Outer evaluation calls a custom function that itself compiles
    // and evaluates a CEL expression. Both must produce correct results
    // even though the inner call fires while the outer call's pooled
    // buffer is still in use.
    const innerBytecode = compile('1 + 2')
    const env = new Environment()
      .registerFunction('innerEval', 0, () => evaluate(innerBytecode, {}))
      .registerFunction('innerEvalOf', 1, (n) => evaluate(compile('n * 10'), { n }))

    // Simple re-entry: outer uses inner result.
    assert.equal(env.run('innerEval() + 10'), 13n)

    // Re-entry with argument passed across the boundary.
    assert.equal(env.run('innerEvalOf(5)'), 50n)

    // Multiple re-entries interleaved with outer stack use.
    assert.equal(env.run('innerEval() + innerEval() + innerEval()'), 9n)
  })

  it('deeply nested re-entry works correctly', () => {
    // Each recursive call descends one level. The pool must handle
    // arbitrary depth via fallback allocation on every nested call.
    const env = new Environment()
    env.registerFunction('countdown', 1, (n) => {
      if (n === 0n) return 0n
      return n + env.run('countdown(x)', { x: n - 1n })
    })
    // 5 + 4 + 3 + 2 + 1 + 0 = 15
    assert.equal(env.run('countdown(5)'), 15n)
  })

  it('pool is released after custom function throws', () => {
    // If the finally block doesn't release the pool, subsequent calls
    // would permanently take the fallback-allocation path. Correctness
    // would still hold, but this test asserts that a thrown custom fn
    // does not corrupt VM state.
    const env = new Environment()
      .registerFunction('boom', 0, () => { throw new Error('kaboom') })

    assert.throws(() => env.run('boom()'), /kaboom/)
    // Next evaluate call must still produce correct results.
    assert.equal(env.run('1 + 2'), 3n)
    // Run many times to stress reuse.
    for (let i = 0; i < 50; i++) {
      assert.equal(env.run('x * 2', { x: BigInt(i) }), BigInt(i * 2))
    }
  })

  it('deep stack usage beyond initial pool capacity works', () => {
    // The initial pool capacity is 64. A chain of 80 additions should
    // force the pool to grow on first evaluation, then reuse the grown
    // buffer on subsequent calls.
    let expr = '0'
    for (let i = 1; i <= 80; i++) expr = expr + ' + 1'
    const bc = compile(expr)
    // Run twice — first triggers grow, second reuses grown buffer.
    assert.equal(evaluate(bc), 80n)
    assert.equal(evaluate(bc), 80n)
  })

  it('stack slots do not retain references from prior evaluations', async () => {
    // After evaluate() returns, intermediate object references in the
    // pooled stack must be cleared. Otherwise a large object that briefly
    // passed through a stack slot would stay pinned inside the pool for
    // the rest of the process.
    //
    // To isolate the stack as the only possible holder, the custom fn
    // builds the sentinel fresh on each call (no closure capture) and
    // stores a WeakRef into a module-level slot before returning.
    if (typeof Bun === 'undefined' || typeof Bun.gc !== 'function') {
      return  // deterministic GC is only available on Bun
    }

    let sentinelRef = null
    const env = new Environment()
      .registerFunction('makeList', 0, () => {
        const a = new Array(5000)
        for (let i = 0; i < 5000; i++) a[i] = BigInt(i)
        sentinelRef = new WeakRef(a)
        return a
      })
    // The list passes through the VM stack once (arg to size()), then
    // SIZE overwrites the slot with the integer size. If the pool cleared
    // its slots on exit, the list is unreachable after this call returns.
    assert.equal(env.run('size(makeList())'), 5000n)

    // Run a second evaluation to ensure any residual stack slot is
    // overwritten — belt and suspenders.
    assert.equal(env.run('1 + 2'), 3n)

    Bun.gc(true)
    await new Promise(r => setTimeout(r, 10))
    Bun.gc(true)
    assert.equal(
      sentinelRef.deref(),
      undefined,
      'pooled stack retained a reference past evaluate() — GC pinned'
    )
  })

  it('mixed uint and int arithmetic across sequential evaluations', () => {
    // The uintFlags buffer must be reset between evaluations. Otherwise
    // a uint result from a prior call could incorrectly flag a later
    // non-uint slot as uint, corrupting arithmetic semantics.
    const uintExpr = compile('1u + 2u')   // produces uint
    const intExpr  = compile('1 + 2')     // produces int
    // Interleave — if flags leak, the int sum would be marked uint
    // (or vice versa) leading to wrong overflow semantics later.
    for (let i = 0; i < 20; i++) {
      assert.equal(evaluate(uintExpr), 3n)
      assert.equal(evaluate(intExpr), 3n)
    }
  })
})
