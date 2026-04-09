import { describe, it } from 'node:test'
import { assertCel, assertCelError } from '../helpers.js'

describe('unary operators', () => {
  it('-5', () => assertCel('-5', -5n))
  it('-0', () => assertCel('-0', 0n))
  it('- -5', () => assertCel('- -5', 5n))
  it('-1.5', () => assertCel('-1.5', -1.5))
  it('!true', () => assertCel('!true', false))
  it('!false', () => assertCel('!false', true))
  it('!!false', () => assertCel('!!false', false))
  it('! on non-bool throws', () => assertCelError('!1'))
})
