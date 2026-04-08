import { describe, it } from 'node:test'
import { assertCel, assertCelError } from '../helpers.js'

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
  it('string concat', () => assertCel('"hello" + " " + "world"', 'hello world'))
  it('int + float is type error', () => assertCelError('1 + 1.0'))
  it('division by zero throws', () => assertCelError('1 / 0'))
})
