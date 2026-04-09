import { describe, it } from 'node:test'
import { assertCel } from '../helpers.js'

describe('macros', () => {
  describe('exists', () => {
    it('exists true', () => assertCel('[1, 2, 3].exists(x, x > 2)', true))
    it('exists false', () => assertCel('[1, 2, 3].exists(x, x > 5)', false))
    it('exists empty list', () => assertCel('[].exists(x, x > 0)', false))
  })

  describe('all', () => {
    it('all true', () => assertCel('[1, 2, 3].all(x, x > 0)', true))
    it('all false', () => assertCel('[1, 2, 3].all(x, x > 1)', false))
    it('all empty list', () => assertCel('[].all(x, x > 0)', true))
  })

  describe('filter', () => {
    it('filter elements', () => assertCel('[1, 2, 3, 4].filter(x, x % 2 == 0)', [2n, 4n]))
    it('filter all', () => assertCel('[1, 2, 3].filter(x, x > 0)', [1n, 2n, 3n]))
    it('filter none', () => assertCel('[1, 2, 3].filter(x, x > 10)', []))
  })

  describe('map', () => {
    it('map double', () => assertCel('[1, 2, 3].map(x, x * 2)', [2n, 4n, 6n]))
    it('map to string', () => assertCel('[1, 2, 3].map(x, string(x))', ['1', '2', '3']))
  })

  describe('exists_one', () => {
    it('exists_one true', () => assertCel('[1, 2, 3].exists_one(x, x == 2)', true))
    it('exists_one false (zero matches)', () => assertCel('[1, 2, 3].exists_one(x, x == 5)', false))
    it('exists_one false (two matches)', () => assertCel('[1, 2, 2].exists_one(x, x == 2)', false))
  })

  describe('cel.bind', () => {
    it('bind simple', () => assertCel('cel.bind(x, 42, x + 1)', 43n))
    it('bind with expression', () => assertCel('cel.bind(y, 2 + 3, y * y)', 25n))
  })
})
