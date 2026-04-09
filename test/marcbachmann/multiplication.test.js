import { describe, it } from 'node:test'
import { assertCel, assertCelError } from '../helpers.js'

describe('multiplication and division', () => {
  it('should multiply two numbers', () => assertCel('2 * 3', 6n))
  it('should divide two numbers', () => assertCel('6 / 2', 3n))
  it('should handle modulo operation', () => assertCel('7 % 3', 1n))
  it('should handle complex multiplication', () => assertCel('2 * 3 * 4', 24n))
  it('should respect operator precedence', () => assertCel('2 + 3 * 4', 14n))
  it('should handle parentheses', () => assertCel('(2 + 3) * 4', 20n))
  it('should handle float multiplication', () => assertCel('2.5 * 2.0', 5))
  it('should handle float division', () => assertCel('5.5 / 2.0', 2.75))

  it('rejects int and double combinations', () => {
    assertCelError('2.5 * 2')
  })

  it('rejects double modulo', () => {
    assertCelError('5.5 % 2.0')
    assertCelError('2 % 2.0')
  })
})
