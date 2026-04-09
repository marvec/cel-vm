import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertCel } from '../helpers.js'
import { cel } from '../helpers.js'

describe('string literals', () => {
  it('double-quoted string', () => assertCel('"hello"', 'hello'))
  it('single-quoted string', () => assertCel("'hello'", 'hello'))
  it('escape \\n', () => assertCel('"a\\nb"', 'a\nb'))
  it('escape \\t', () => assertCel('"a\\tb"', 'a\tb'))
  it('escape \\\\', () => assertCel('"a\\\\b"', 'a\\b'))
  it('escape \\"', () => assertCel('"a\\"b"', 'a"b'))
  it('triple-double-quoted', () => assertCel('"""hello world"""', 'hello world'))
  it('triple-single-quoted', () => assertCel("'''hello world'''", 'hello world'))
  it('raw string r"no\\n"', () => assertCel('r"no\\\\n"', 'no\\\\n'))
  it('bytes b"hello"', () => {
    const result = cel('b"hello"')
    assert.ok(result instanceof Uint8Array)
    assert.deepStrictEqual(result, new Uint8Array([104, 101, 108, 108, 111]))
  })
})
