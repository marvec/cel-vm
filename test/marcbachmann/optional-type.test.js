import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertCel, cel } from '../helpers.js'

describe('optional types', () => {
  it('optional.none()', () => {
    const r = cel('optional.none()')
    assert.ok(r.__celOptional && r.value === undefined, 'expected none')
  })

  it('optional.of(v)', () => {
    const r = cel('optional.of(42)')
    assert.ok(r.__celOptional && r.value === 42n, 'expected some(42)')
  })

  it('orValue on some', () => assertCel('optional.of(42).orValue(0)', 42n))
  it('orValue on none', () => assertCel('optional.none().orValue(0)', 0n))

  it('?.field on map with key', () => {
    const r = cel('{"a": 1}?.a')
    assert.ok(r.__celOptional && r.value === 1n)
  })

  it('?.field on map without key', () => {
    const r = cel('{"a": 1}?.b')
    assert.ok(r.__celOptional && r.value === undefined)
  })

  it('?.field chain with orValue', () => assertCel('{"a": 1}?.a.orValue(0)', 1n))
  it('?.field chain missing with orValue', () => assertCel('{"a": 1}?.b.orValue(0)', 0n))
})
