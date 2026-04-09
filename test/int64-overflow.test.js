import { describe, it } from 'node:test'
import { assertCel, assertCelError } from './helpers.js'

describe('int64 overflow detection', () => {
  describe('addition overflow', () => {
    it('INT64_MAX + 1 overflows', () => assertCelError('9223372036854775807 + 1'))
    it('INT64_MAX + INT64_MAX overflows', () => assertCelError('9223372036854775807 + 9223372036854775807'))
    it('just under max is fine', () => assertCel('9223372036854775806 + 1', 9223372036854775807n))
  })

  describe('subtraction overflow', () => {
    it('INT64_MIN - 1 overflows', () => assertCelError('-9223372036854775808 - 1'))
    it('just above min is fine', () => assertCel('-9223372036854775807 - 1', -9223372036854775808n))
  })

  describe('multiplication overflow', () => {
    it('INT64_MAX * 2 overflows', () => assertCelError('9223372036854775807 * 2'))
    it('large * large overflows', () => assertCelError('4611686018427387904 * 4'))
  })

  describe('exponentiation overflow', () => {
    it('2 ** 63 overflows', () => assertCelError('2 ** 63'))
    it('2 ** 62 is fine', () => assertCel('2 ** 62', 4611686018427387904n))
  })

  describe('negation overflow', () => {
    // -INT64_MIN = 2^63 which exceeds INT64_MAX
    it('-(INT64_MIN) overflows', () => assertCelError('x * -1', { x: -9223372036854775808n }))
  })

  describe('overflow absorbed by short-circuit', () => {
    it('false && overflow → false', () => assertCel('false && (9223372036854775807 + 1 == 0)', false))
    it('true || overflow → true', () => assertCel('true || (9223372036854775807 + 1 == 0)', true))
  })

  describe('normal int64 values', () => {
    it('max int64', () => assertCel('9223372036854775807', 9223372036854775807n))
    it('min int64', () => assertCel('-9223372036854775808', -9223372036854775808n))
    it('zero', () => assertCel('0', 0n))
    it('large multiplication within range', () => assertCel('1000000000 * 1000000000', 1000000000000000000n))
  })
})
