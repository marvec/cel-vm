import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encode, decode, BytecodeError } from '../src/bytecode.js'

describe('BytecodeError — decode error paths', () => {
  it('rejects bytecode that is too short', () => {
    assert.throws(
      () => decode(new Uint8Array(2)),
      (err) => err instanceof BytecodeError && err.message.includes('too short')
    )
  })

  it('rejects invalid magic bytes', () => {
    // 8 bytes: 2 magic + 1 version + 1 flags + 4 checksum = minimum viable
    const buf = new Uint8Array(8)
    const view = new DataView(buf.buffer)
    view.setUint16(0, 0xDEAD, false) // wrong magic
    view.setUint8(2, 1)              // version
    view.setUint8(3, 0)              // flags
    // write a valid checksum for the first 4 bytes
    view.setUint32(4, adler32(buf.subarray(0, 4)), false)
    assert.throws(
      () => decode(buf),
      (err) => err instanceof BytecodeError && err.message.includes('Invalid CEL magic')
    )
  })

  it('rejects unsupported bytecode version', () => {
    const buf = new Uint8Array(8)
    const view = new DataView(buf.buffer)
    view.setUint16(0, 0x4345, false) // correct magic "CE"
    view.setUint8(2, 99)             // unsupported version
    view.setUint8(3, 0)              // flags
    view.setUint32(4, adler32(buf.subarray(0, 4)), false)
    assert.throws(
      () => decode(buf),
      (err) => err instanceof BytecodeError && err.message.includes('Unsupported CEL bytecode version')
    )
  })

  it('rejects checksum mismatch', () => {
    // Build valid bytecode then corrupt the body
    const program = {
      consts: [],
      varTable: [],
      instrs: [{ op: 3, operands: [] }], // RETURN
      debugInfo: null,
    }
    const valid = encode(program)
    // Corrupt one byte in the body (not the checksum)
    const corrupted = new Uint8Array(valid)
    corrupted[4] ^= 0xFF
    assert.throws(
      () => decode(corrupted),
      (err) => err instanceof BytecodeError && err.message.includes('checksum mismatch')
    )
  })

  it('rejects unknown const tag during decode', () => {
    // Build a valid bytecode, then patch a const tag to an unknown value
    const program = {
      consts: [{ tag: 0, value: null }], // TAG_NULL
      varTable: [],
      instrs: [{ op: 0, operands: [0] }, { op: 3, operands: [] }], // PUSH_CONST 0, RETURN
      debugInfo: null,
    }
    const valid = encode(program)

    // Patch: const pool starts at byte 6 (2 magic + 1 ver + 1 flags + 2 count)
    // First entry tag is at byte 6
    const patched = new Uint8Array(valid)
    patched[6] = 0xFF // unknown tag

    // Recompute checksum
    const bodyLen = patched.length - 4
    const body = patched.subarray(0, bodyLen)
    const view = new DataView(patched.buffer)
    view.setUint32(bodyLen, adler32(body), false)

    assert.throws(
      () => decode(patched),
      (err) => err instanceof BytecodeError && err.message.includes('Unknown const tag')
    )
  })

  it('encode and decode round-trip succeeds', () => {
    const program = {
      consts: [
        { tag: 0, value: null },
        { tag: 1, value: true },
        { tag: 2, value: 42n },
        { tag: 5, value: 'hello' },
      ],
      varTable: ['x', 'y'],
      instrs: [{ op: 0, operands: [0] }, { op: 3, operands: [] }],
      debugInfo: null,
    }
    const bytes = encode(program)
    const decoded = decode(bytes)
    assert.equal(decoded.consts.length, 4)
    assert.equal(decoded.varTable.length, 2)
    assert.equal(decoded.instrs.length, 2)
  })
})

// Inline Adler-32 for test bytecode construction (matches src/bytecode.js)
function adler32(bytes) {
  const MOD_ADLER = 65521
  let a = 1, b = 0
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % MOD_ADLER
    b = (b + a) % MOD_ADLER
  }
  return ((b << 16) | a) >>> 0
}
