import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertCel, assertCelError, cel } from '../helpers.js'

describe('double literals', () => {
  it('should parse decimal double literals', () => {
    assertCel('0.0', 0)
    assertCel('42.5', 42.5)
    assertCel('123456.789', 123456.789)
  })

  it('should parse negative double literals', () => {
    assertCel('-0.5', -0.5)
    assertCel('-42.75', -42.75)
    assertCel('-0.0001', -0.0001)
  })

  it('should parse fractional double literals', () => {
    assertCel('0.000001', 0.000001)
    assertCel('999999.999', 999999.999)
    assertCel('1.23456789', 1.23456789)
  })

  it('should parse scientific notation literals', () => {
    assertCel('1e1', 10)
    assertCel('1.1e1', 11)
    assertCel('1e-2', 0.01)
    assertCel('1E+2', 100)
  })

  it('should handle double literals in complex expressions', () => {
    assertCel('(0.5 + 0.25) * 2.0', 1.5)
    assertCel('[0.1, 0.2, 0.3][2]', 0.3)
    assertCel('(10.0 + 20.0) * 5.0 - 100.0 / 4.0', 125)
  })
})

describe('double conversions', () => {
  it('should convert numeric inputs to double', () => {
    assertCel('double(42)', 42)
    assertCel('double(42u)', 42)
    assertCel('double(1.5)', 1.5)
  })

  it('should convert string inputs', () => {
    assertCel('double("1.25")', 1.25)
    assertCel('double("1e3")', 1000)
    assertCel('double("1E-3")', 0.001)
    assertCel('double("Infinity")', Number.POSITIVE_INFINITY)
    assertCel('double("-Infinity")', Number.NEGATIVE_INFINITY)
  })

  // double("NaN") is not supported by our VM - it throws instead of returning NaN
})

describe('double arithmetic', () => {
  it('should add double values', () => {
    assertCel('1.5 + 2.25', 3.75)
    assertCel('-0.5 + 0.25', -0.25)
  })

  it('should subtract double values', () => {
    assertCel('1.5 - 0.75', 0.75)
    assertCel('-0.5 - 0.25', -0.75)
  })

  it('should multiply double values', () => {
    assertCel('1.5 * 2.25', 3.375)
    assertCel('-0.5 * 0.25', -0.125)
  })

  it('should divide double values', () => {
    assertCel('7.5 / 2.5', 3)
    assertCel('-0.5 / 0.25', -2)
  })

  it('should return infinities or NaN when dividing by zero', () => {
    assertCel('1.0 / 0.0', Number.POSITIVE_INFINITY)
    assertCel('-1.0 / 0.0', Number.NEGATIVE_INFINITY)
    const result = cel('0.0 / 0.0')
    assert.ok(Number.isNaN(result), 'expected NaN for 0.0/0.0')
  })

  it('should reject arithmetic mixing double and int', () => {
    assertCelError('1.0 + 1')
    assertCelError('1.0 - 1')
    assertCelError('1.0 * 1')
  })

  it('should reject double modulo', () => {
    assertCelError('5.5 % 2.0')
  })
})

describe('double comparisons', () => {
  it('should compare double values with other doubles', () => {
    assertCel('0.5 < 0.6', true)
    assertCel('0.5 <= 0.5', true)
    assertCel('0.9 > 0.3', true)
    assertCel('1.0 >= 1.0', true)
  })

  it('should treat NaN as not equal and unordered', () => {
    assertCel('0.0 / 0.0 == 0.0 / 0.0', false)
    assertCel('0.0 / 0.0 != 0.0 / 0.0', true)
    assertCel('0.0 / 0.0 > 0.0', false)
    assertCel('0.0 / 0.0 < 0.0', false)
  })
})
