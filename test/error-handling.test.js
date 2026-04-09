import { describe, it } from 'node:test'
import { assertCel, assertCelError } from './helpers.js'

describe('CEL error values', () => {
  describe('division by zero', () => {
    it('1 / 0 throws', () => assertCelError('1 / 0'))
    it('1 % 0 throws', () => assertCelError('1 % 0'))
    it('0 / 0 throws', () => assertCelError('0 / 0'))
  })

  describe('index out of bounds', () => {
    it('list OOB positive', () => assertCelError('[1, 2][5]'))
    it('list OOB negative', () => assertCelError('[1, 2][-1]'))
    it('empty list index', () => assertCelError('[][0]'))
  })

  describe('type mismatch', () => {
    it('int + string', () => assertCelError('1 + "hello"'))
    it('bool - int', () => assertCelError('true - 1'))
    it('string * int', () => assertCelError('"abc" * 3'))
  })

  describe('missing field', () => {
    it('select missing field on object', () => assertCelError('a.b', { a: {} }))
    it('select on null', () => assertCelError('a.b', { a: null }))
    it('select missing key on map', () => assertCelError('{"a": 1}["b"]'))
  })

  describe('error propagation through operators', () => {
    it('error + value', () => assertCelError('(1/0) + 5'))
    it('value + error', () => assertCelError('5 + (1/0)'))
    it('error == value', () => assertCelError('(1/0) == 0'))
    it('error < value', () => assertCelError('(1/0) < 0'))
    it('-error', () => assertCelError('-(1/0)'))
    it('!error', () => assertCelError('!(1/0 == 0)'))
    it('size(error)', () => assertCelError('size([1,2][(1/0)])'))
  })

  describe('short-circuit absorbs errors (left-to-right)', () => {
    it('false && error → false', () => assertCel('false && (1/0 == 0)', false))
    it('true || error → true', () => assertCel('true || (1/0 == 0)', true))
  })

  describe('short-circuit absorbs errors (error-first / commutative)', () => {
    it('error && false → false', () => assertCel('(1/0 == 0) && false', false))
    it('error || true → true', () => assertCel('(1/0 == 0) || true', true))
  })

  // NOTE: Full commutative error semantics (error && true → error,
  // error || false → error, error ? a : b → error) require preserving
  // error values across jump-based short-circuit, which is not supported.
  // The right-absorbs-left cases (error && false → false, error || true → true)
  // work because the right side's concrete value becomes the result.

  describe('ternary short-circuit', () => {
    it('true ? value : error → value', () => assertCel('true ? 42 : 1/0', 42n))
    it('false ? error : value → value', () => assertCel('false ? 1/0 : 42', 42n))
  })
})
