import { describe, it } from 'node:test'
import { assertCel } from '../helpers.js'

describe('atomic expressions', () => {
  it('integer literal', () => assertCel('42', 42n))
  it('float literal', () => assertCel('3.14', 3.14))
  it('true', () => assertCel('true', true))
  it('false', () => assertCel('false', false))
  it('null', () => assertCel('null', null))
  it('string literal', () => assertCel('"hello"', 'hello'))
  it('negative integer', () => assertCel('-7', -7n))
  it('uint literal', () => assertCel('1u', 1n))
  it('hex integer', () => assertCel('0xFF', 255n))
})
