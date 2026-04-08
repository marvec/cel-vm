import { describe, it } from 'node:test'
import { assertCel } from '../helpers.js'

describe('in operator', () => {
  it('value in list', () => assertCel('1 in [1, 2, 3]', true))
  it('value not in list', () => assertCel('5 in [1, 2, 3]', false))
  it('string in list', () => assertCel('"b" in ["a", "b", "c"]', true))
  it('key in map', () => assertCel('"x" in {"x": 1, "y": 2}', true))
  it('key not in map', () => assertCel('"z" in {"x": 1, "y": 2}', false))
  it('variable in list', () => assertCel('x in [1, 2, 3]', true, { x: 2n }))
})
