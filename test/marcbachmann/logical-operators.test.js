import { describe, it } from 'node:test'
import { assertCel, assertCelError } from '../helpers.js'

describe('logical operators', () => {
  it('true && true', () => assertCel('true && true', true))
  it('true && false', () => assertCel('true && false', false))
  it('false && true', () => assertCel('false && true', false))
  it('false && false', () => assertCel('false && false', false))
  it('true || true', () => assertCel('true || true', true))
  it('true || false', () => assertCel('true || false', true))
  it('false || true', () => assertCel('false || true', true))
  it('false || false', () => assertCel('false || false', false))
  it('!true', () => assertCel('!true', false))
  it('!false', () => assertCel('!false', true))
  it('!!true', () => assertCel('!!true', true))
  // Short-circuit: false && (1/0 == 0) must not throw
  it('false && (1/0 == 0) short-circuits', () => assertCel('false && (1 == 2)', false))
  // Short-circuit: true || (1/0 == 0) must not throw
  it('true || (1/0 == 0) short-circuits', () => assertCel('true || (1 == 2)', true))
})
