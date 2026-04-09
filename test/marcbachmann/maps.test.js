import { describe, it } from 'node:test'
import { assertCel, assertCelError } from '../helpers.js'

describe('maps', () => {
  it('empty map', () => assertCel('{}', new Map()))
  it('map literal', () => assertCel('{"a": 1, "b": 2}', new Map([['a', 1n], ['b', 2n]])))
  it('map dot access', () => assertCel('{"a": 1}.a', 1n))
  it('map bracket access', () => assertCel('{"a": 1}["a"]', 1n))
  it('size', () => assertCel('size({"a": 1, "b": 2})', 2n))
  it('map.size() method', () => assertCel('{"a": 1}.size()', 1n))
  it('in operator (key)', () => assertCel('"a" in {"a": 1, "b": 2}', true))
  it('not in operator', () => assertCel('"c" in {"a": 1, "b": 2}', false))
  it('missing key throws', () => assertCelError('{"a": 1}.b'))
  it('has() field check', () => assertCel('has({"a": 1}.a)', true))
  it('has() missing field', () => assertCel('has({"a": 1}.b)', false))
  it('nested map', () => assertCel('{"x": {"y": 42}}.x.y', 42n))
})
