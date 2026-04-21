// Tests for the lazy stack clear + narrowed uintFlags reset in src/vm.js.
// These target the watermark-bounded cleanup path: a prior deep-sp call
// followed by a shallow call must not leave references pinned above the
// shallow call's watermark.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compile, evaluate } from '../src/index.js'
import { Environment } from '../src/environment.js'

describe('VM lazy pool clear', () => {
  it('references pushed at deep sp by a prior call are cleared before GC observation', async () => {
    // The lazy clear only touches slots [0..maxSp] of the current call.
    // A sentinel left at a deep sp by a prior call must still be unreachable
    // after that call returns — otherwise reducing the clear range leaks.
    if (typeof Bun === 'undefined' || typeof Bun.gc !== 'function') return

    let sentinelRef = null
    const env = new Environment()
      .registerFunction('makeList', 0, () => {
        const a = new Array(5000)
        for (let i = 0; i < 5000; i++) a[i] = BigInt(i)
        sentinelRef = new WeakRef(a)
        return a
      })

    // Push the sentinel deep: size([makeList(), makeList(), ..]) lives a few
    // slots down the stack before BUILD_LIST and SIZE collapse it.
    assert.equal(env.run('size([makeList(), makeList(), makeList()])'), 3n)

    // Run a shallow call that cannot reach the deep slots. With the lazy
    // clear, only sp ≤ ~2 are cleared on this call — but the prior call's
    // own finally must have already cleared up to its own watermark.
    assert.equal(evaluate(compile('1 + 2')), 3n)

    Bun.gc(true)
    await new Promise(r => setTimeout(r, 10))
    Bun.gc(true)
    assert.equal(
      sentinelRef.deref(),
      undefined,
      'pool retained deep-sp reference across call boundaries',
    )
  })

  it('narrowed uintFlags reset preserves correctness across depth transitions', () => {
    // After a deep uint-heavy call, a shallow non-uint call uses a narrow
    // reset window. Slots outside that window must still read as 0 flags.
    // Then a third deep call must see clean flags above the shallow call's
    // watermark — this catches any off-by-one in the narrowed reset.
    const deepUint = compile('1u + 2u + 3u + 4u + 5u + 6u + 7u + 8u')
    const shallowInt = compile('10 + 20')
    const deepMixed = compile('(1 + 2) + (3u + 4u) + 5')

    for (let i = 0; i < 30; i++) {
      assert.equal(evaluate(deepUint), 36n)
      assert.equal(evaluate(shallowInt), 30n)
      assert.equal(evaluate(deepMixed), 15n)
    }
  })

  it('re-entrant call with its own carrier clears its own frame', () => {
    // The re-entrant branch allocates a fresh Int32Array carrier so its
    // watermark is independent of the pooled call's carrier. Verify both
    // frames clean up properly through many cycles.
    const env = new Environment()
      .registerFunction('inner', 1, (n) => evaluate(compile('n + n + n'), { n }))

    for (let i = 0; i < 100; i++) {
      assert.equal(env.run('inner(x) + inner(x)', { x: BigInt(i) }), BigInt(i * 6))
    }
  })
})
