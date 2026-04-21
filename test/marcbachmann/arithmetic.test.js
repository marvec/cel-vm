import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertCel, assertCelError, cel } from '../helpers.js'
import { compile } from '../../src/index.js'
import { decode, OP } from '../../src/bytecode.js'

describe('arithmetic', () => {
  it('1 + 1', () => assertCel('1 + 1', 2n))
  it('2 * 3', () => assertCel('2 * 3', 6n))
  it('10 - 3', () => assertCel('10 - 3', 7n))
  it('8 / 2', () => assertCel('8 / 2', 4n))
  it('7 % 3', () => assertCel('7 % 3', 1n))
  it('2 + 3 * 4', () => assertCel('2 + 3 * 4', 14n))
  it('(2 + 3) * 4', () => assertCel('(2 + 3) * 4', 20n))
  it('-5', () => assertCel('-5', -5n))
  it('-5 + 3', () => assertCel('-5 + 3', -2n))
  it('1.5 + 2.5', () => assertCel('1.5 + 2.5', 4.0))
  it('2.0 * 3.0', () => assertCel('2.0 * 3.0', 6.0))
  it('10.0 / 4.0', () => assertCel('10.0 / 4.0', 2.5))
  it('2 ** 10', () => assertCel('2 ** 10', 1024n))
  it('1 + 1 + 1', () => assertCel('1 + 1 + 1', 3n))
  it('1 + 1 - 1', () => assertCel('1 + 1 - 1', 1n))
  it('0.333 + 0.333', () => assertCel('0.333 + 0.333', 0.666))
  it('10 - 3 + 2', () => assertCel('10 - 3 + 2', 9n))
  it('-(1 + 2)', () => assertCel('-(1 + 2)', -3n))
  it('string concat', () => assertCel('"hello" + " " + "world"', 'hello world'))
  it('string concat two', () => assertCel('"a" + "b"', 'ab'))
  it('int + float is type error', () => assertCelError('1 + 1.0'))
  it('division by zero throws', () => assertCelError('1 / 0'))
})

// Decode compiled bytecode and return the list of opcodes emitted.
function opcodesOf(src, vars) {
  const bytes = compile(src, { cache: false })
  const { opcodes } = decode(bytes)
  return Array.from(opcodes)
}

describe('typed arithmetic opcodes (specialization)', () => {
  describe('compile-time emission', () => {
    it('double + double (non-foldable) → ADD_DOUBLE', () => {
      // Outer '+' cannot fold (right is a Binary); inner '*' folds to 7.5.
      // Both operands reach the outer emit as 'double' kind via resultKind
      // cache → ADD_DOUBLE emitted.
      const ops = opcodesOf('1.5 + 2.5 * 3.0')
      assert.ok(ops.includes(OP.ADD_DOUBLE), `expected ADD_DOUBLE, got ${ops}`)
      assert.ok(!ops.includes(OP.ADD), 'no generic ADD when types known')
    })

    it('double * double (non-foldable) → MUL_DOUBLE', () => {
      // Both children are foldable Binaries; outer '*' does not fold because
      // neither child is a literal at the outer tryFoldBinary check.
      const ops = opcodesOf('(1.5 + 2.5) * (3.0 + 4.0)')
      assert.ok(ops.includes(OP.MUL_DOUBLE), `expected MUL_DOUBLE, got ${ops}`)
      assert.ok(!ops.includes(OP.MUL), 'no generic MUL when types known')
    })

    it('int + int (overflow) → ADD_INT', () => {
      // `9223372036854775807 + 1` cannot be folded (overflow defers to runtime);
      // both literals are IntLit → ADD_INT emitted.
      const ops = opcodesOf('9223372036854775807 + 1')
      assert.ok(ops.includes(OP.ADD_INT), `expected ADD_INT, got ${ops}`)
      assert.ok(!ops.includes(OP.ADD), 'no generic ADD')
    })

    it('non-foldable int chain emits ADD_INT through folded sub-expression', () => {
      // `9223372036854775807 + (1 + 2)` — outer '+' not foldable (right is
      // Binary), inner folds to 3n with resultKind='int'. Outer emits ADD_INT.
      const ops = opcodesOf('9223372036854775807 + (1 + 2)')
      assert.ok(ops.includes(OP.ADD_INT), `expected ADD_INT, got ${ops}`)
    })

    it('dyn + dyn still emits generic ADD', () => {
      const ops = opcodesOf('x + y')
      assert.ok(ops.includes(OP.ADD), 'generic ADD for untyped operands')
      assert.ok(!ops.includes(OP.ADD_DOUBLE))
      assert.ok(!ops.includes(OP.ADD_INT))
    })

    it('Ident + FloatLit uses generic (one side untyped)', () => {
      const ops = opcodesOf('x + 1.0')
      assert.ok(ops.includes(OP.ADD))
      assert.ok(!ops.includes(OP.ADD_DOUBLE))
    })
  })

  describe('runtime behavior matches generic ops', () => {
    it('ADD_DOUBLE computes correctly', () => {
      assert.strictEqual(cel('1.5 + 2.5 * 3.0'), 9.0)
    })

    it('MUL_DOUBLE computes correctly', () => {
      assert.strictEqual(cel('(1.5 + 2.5) * (3.0 + 4.0)'), 28.0)
    })

    it('ADD_INT computes correctly on non-foldable input', () => {
      // Uses ADD_INT at runtime; overflow still detected.
      assert.throws(() => cel('9223372036854775807 + 1'))
      assert.strictEqual(cel('9223372036854775806 + (1 + 0)'), 9223372036854775807n)
    })

    it('uintFlags normalized through specialized → generic chain', () => {
      // `(1.5 + 2.5 * 3.0) + x` — outer Ident load must observe uintFlag=0
      // from preceding ADD_DOUBLE. A stale uint flag would misroute the
      // generic ADD into the uint fastpath and emit wrong type errors.
      assert.strictEqual(cel('(1.5 + 2.5 * 3.0) + x', { x: 1.0 }), 10.0)
    })
  })
})
