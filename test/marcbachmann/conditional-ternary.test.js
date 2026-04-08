import { describe, it } from 'node:test'
import { assertCel } from '../helpers.js'

describe('conditional ternary', () => {
  it('true ? 1 : 2', () => assertCel('true ? 1 : 2', 1n))
  it('false ? 1 : 2', () => assertCel('false ? 1 : 2', 2n))
  it('1 < 2 ? "yes" : "no"', () => assertCel('1 < 2 ? "yes" : "no"', 'yes'))
  it('1 > 2 ? "yes" : "no"', () => assertCel('1 > 2 ? "yes" : "no"', 'no'))
  it('nested: true ? (false ? 1 : 2) : 3', () => assertCel('true ? (false ? 1 : 2) : 3', 2n))
  it('with variables', () => assertCel('x > 0 ? "positive" : "non-positive"', 'positive', { x: 5n }))
})
