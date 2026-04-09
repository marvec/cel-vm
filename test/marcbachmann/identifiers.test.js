import { describe, it } from 'node:test'
import { assertCel } from '../helpers.js'

describe('identifiers', () => {
  it('variable x', () => assertCel('x', 42n, { x: 42n }))
  it('variable x + 1', () => assertCel('x + 1', 2n, { x: 1n }))
  it('string variable', () => assertCel('name', 'alice', { name: 'alice' }))
  it('two variables', () => assertCel('a + b', 3n, { a: 1n, b: 2n }))
  it('variable in condition', () => assertCel('x > 0', true, { x: 5n }))
})
