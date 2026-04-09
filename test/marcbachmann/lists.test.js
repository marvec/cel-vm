import { describe, it } from 'node:test'
import { assertCel, assertCelError } from '../helpers.js'

describe('lists', () => {
  it('empty list', () => assertCel('[]', []))
  it('list literal', () => assertCel('[1, 2, 3]', [1n, 2n, 3n]))
  it('index access', () => assertCel('[1, 2, 3][0]', 1n))
  it('index last', () => assertCel('[1, 2, 3][2]', 3n))
  it('out of bounds throws', () => assertCelError('[1, 2][5]'))
  it('list concat', () => assertCel('[1, 2] + [3, 4]', [1n, 2n, 3n, 4n]))
  it('size', () => assertCel('size([1, 2, 3])', 3n))
  it('list.size() method', () => assertCel('[1, 2, 3].size()', 3n))
  it('in operator', () => assertCel('2 in [1, 2, 3]', true))
  it('not in operator', () => assertCel('5 in [1, 2, 3]', false))
  it('nested list', () => assertCel('[[1, 2], [3, 4]][0][1]', 2n))
  it('list with variable', () => assertCel('[1, 2, x][2]', 5n, { x: 5n }))
})
