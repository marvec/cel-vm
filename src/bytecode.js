/**
 * CEL-VM bytecode binary encode/decode module.
 *
 * Binary format:
 *   [magic u16][version u8][flags u8]
 *   [const pool: count u16, entries...]
 *   [var table: count u16, entries...]
 *   [instructions: count u32, entries...]
 *   [debug info (optional, flag bit 0): count u32, entries...]
 *   [checksum u32 Adler-32]
 */

export class BytecodeError extends Error {
  constructor(msg) {
    super(msg)
    this.name = 'BytecodeError'
  }
}

// ---------------------------------------------------------------------------
// Opcode table
// ---------------------------------------------------------------------------

export const OP = {
  PUSH_CONST: 0, LOAD_VAR: 1, POP: 2, RETURN: 3,
  JUMP: 4, JUMP_IF_FALSE: 5, JUMP_IF_TRUE: 6, JUMP_IF_FALSE_K: 7, JUMP_IF_TRUE_K: 8,
  ADD: 9, SUB: 10, MUL: 11, DIV: 12, MOD: 13, POW: 14, NEG: 15,
  EQ: 16, NEQ: 17, LT: 18, LE: 19, GT: 20, GE: 21,
  NOT: 22, XOR: 23,
  BUILD_LIST: 24, BUILD_MAP: 25, INDEX: 26, IN: 27,
  SELECT: 28, HAS_FIELD: 29, CALL: 30, SIZE: 31,
  ITER_INIT: 32, ITER_NEXT: 33, ITER_POP: 34, ACCUM_PUSH: 35, ACCUM_SET: 36,
  OPT_SELECT: 37, OPT_NONE: 38, OPT_OF: 39, OPT_OR_VALUE: 40, OPT_CHAIN: 41,
  LOGICAL_AND: 42, LOGICAL_OR: 43, OPT_INDEX: 44, OPT_HAS_VALUE: 45, OPT_OF_NON_ZERO: 46,
};

// ---------------------------------------------------------------------------
// Builtin function IDs
// ---------------------------------------------------------------------------

export const BUILTIN = {
  STRING_CONTAINS: 0, STRING_STARTS_WITH: 1,
  STRING_ENDS_WITH: 2, STRING_SUBSTRING: 3,
  STRING_INDEX_OF: 4, STRING_SPLIT: 5,
  STRING_LOWER_ASCII: 6, STRING_UPPER_ASCII: 7,
  STRING_TRIM: 8, STRING_MATCHES: 9,
  STRING_REPLACE: 10, STRING_JOIN: 11,
  TO_INT: 20, TO_UINT: 21, TO_DOUBLE: 22,
  TO_STRING: 23, TO_BOOL: 24, TO_BYTES: 25,
  TYPE_OF: 26,
  TIMESTAMP: 30, DURATION: 31,
  GET_FULL_YEAR: 32, GET_MONTH: 33, GET_DAY: 34,
  GET_HOURS: 35, GET_MINUTES: 36, GET_SECONDS: 37,
  GET_DATE: 38, GET_DAY_OF_WEEK: 39,
  MATH_MAX: 40, MATH_MIN: 41, MATH_ABS: 42,
  GET_DAY_OF_YEAR: 43, GET_MILLISECONDS: 44,
  DYN: 45,
  MATH_GREATEST: 46, MATH_LEAST: 47,
  STRING_CHAR_AT: 48, STRING_LAST_INDEX_OF: 49,
  STRINGS_QUOTE: 50,
  MATH_CEIL: 51, MATH_FLOOR: 52, MATH_ROUND: 53, MATH_TRUNC: 54,
  MATH_SIGN: 55, MATH_IS_NAN: 56, MATH_IS_INF: 57, MATH_IS_FINITE: 58,
  MATH_BIT_AND: 59, MATH_BIT_OR: 60, MATH_BIT_XOR: 61, MATH_BIT_NOT: 62,
  MATH_BIT_SHIFT_LEFT: 63, MATH_BIT_SHIFT_RIGHT: 64,
  STRING_FORMAT: 65,
};

// ---------------------------------------------------------------------------
// Const tag values
// ---------------------------------------------------------------------------

const TAG_NULL   = 0;
const TAG_BOOL   = 1;
const TAG_INT64  = 2;
const TAG_UINT64 = 3;
const TAG_DOUBLE = 4;
const TAG_STRING = 5;
const TAG_BYTES  = 6;

// ---------------------------------------------------------------------------
// Opcode operand widths (bytes)
//   0 = no operands
//   2 = one u16 or i16 operand
//   3 = u16 + u8 (CALL only)
// ---------------------------------------------------------------------------

const OPERAND_WIDTH = new Uint8Array(48);
// 2-byte unsigned operands
for (const op of [
  OP.PUSH_CONST, OP.LOAD_VAR, OP.SELECT, OP.HAS_FIELD,
  OP.OPT_SELECT, OP.ACCUM_PUSH, OP.BUILD_LIST, OP.BUILD_MAP,
]) {
  OPERAND_WIDTH[op] = 2;
}
// 2-byte signed operands
for (const op of [
  OP.JUMP, OP.JUMP_IF_FALSE, OP.JUMP_IF_TRUE,
  OP.JUMP_IF_FALSE_K, OP.JUMP_IF_TRUE_K,
  OP.ITER_NEXT, OP.OPT_CHAIN,
]) {
  OPERAND_WIDTH[op] = 2;
}
// 3-byte: CALL (u16 builtin_id + u8 argc)
OPERAND_WIDTH[OP.CALL] = 3;

// ---------------------------------------------------------------------------
// Signed vs unsigned: which 2-byte operands are signed i16
// ---------------------------------------------------------------------------

const SIGNED_OPERAND = new Uint8Array(48);
for (const op of [
  OP.JUMP, OP.JUMP_IF_FALSE, OP.JUMP_IF_TRUE,
  OP.JUMP_IF_FALSE_K, OP.JUMP_IF_TRUE_K,
  OP.ITER_NEXT, OP.OPT_CHAIN,
]) {
  SIGNED_OPERAND[op] = 1;
}

// ---------------------------------------------------------------------------
// Magic / version constants
// ---------------------------------------------------------------------------

const MAGIC   = 0x4345; // "CE"
const VERSION = 1;
const FLAG_DEBUG = 0x01;

// ---------------------------------------------------------------------------
// Adler-32 checksum
// ---------------------------------------------------------------------------

function adler32(bytes) {
  const MOD_ADLER = 65521;
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % MOD_ADLER;
    b = (b + a)        % MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// Dynamic buffer for encoding
// ---------------------------------------------------------------------------

class ByteWriter {
  constructor() {
    this._chunks = [];
    this._len = 0;
  }

  _reserve(n) {
    const buf = new Uint8Array(n);
    this._chunks.push(buf);
    this._len += n;
    return buf;
  }

  writeU8(v) {
    const b = this._reserve(1);
    b[0] = v & 0xff;
  }

  writeU16(v) {
    const b = this._reserve(2);
    const view = new DataView(b.buffer);
    view.setUint16(0, v, false); // big-endian
  }

  writeI16(v) {
    const b = this._reserve(2);
    const view = new DataView(b.buffer);
    view.setInt16(0, v, false); // big-endian
  }

  writeU32(v) {
    const b = this._reserve(4);
    const view = new DataView(b.buffer);
    view.setUint32(0, v >>> 0, false);
  }

  writeBigInt64(v) {
    const b = this._reserve(8);
    const view = new DataView(b.buffer);
    view.setBigInt64(0, BigInt(v), false);
  }

  writeBigUint64(v) {
    const b = this._reserve(8);
    const view = new DataView(b.buffer);
    view.setBigUint64(0, BigInt(v), false);
  }

  writeF64(v) {
    const b = this._reserve(8);
    const view = new DataView(b.buffer);
    view.setFloat64(0, v, false);
  }

  writeBytes(arr) {
    const b = this._reserve(arr.length);
    b.set(arr);
  }

  toUint8Array() {
    const out = new Uint8Array(this._len);
    let offset = 0;
    for (const chunk of this._chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// encode(program) → Uint8Array
// ---------------------------------------------------------------------------

/**
 * Encode a compiled CEL program to a Uint8Array.
 *
 * @param {object} program
 * @param {Array<{tag: number, value: *}>} program.consts  - constant pool entries
 * @param {string[]}                       program.varTable - variable names in activation order
 * @param {Array<{op: number, operands: number[]}>} program.instrs - instructions
 * @param {Array<{line: number, col: number}>|null} program.debugInfo - optional debug info
 * @returns {Uint8Array}
 */
export function encode(program) {
  const { consts, varTable, instrs, debugInfo } = program;
  const hasDebug = Array.isArray(debugInfo) && debugInfo.length > 0;

  const w = new ByteWriter();

  // --- Header ---
  w.writeU16(MAGIC);
  w.writeU8(VERSION);
  w.writeU8(hasDebug ? FLAG_DEBUG : 0x00);

  // --- Const pool ---
  w.writeU16(consts.length);
  for (const c of consts) {
    w.writeU8(c.tag);
    switch (c.tag) {
      case TAG_NULL:
        // no payload
        break;
      case TAG_BOOL:
        w.writeU8(c.value ? 1 : 0);
        break;
      case TAG_INT64:
        w.writeBigInt64(c.value);
        break;
      case TAG_UINT64:
        w.writeBigUint64(c.value);
        break;
      case TAG_DOUBLE:
        w.writeF64(c.value);
        break;
      case TAG_STRING: {
        const encoded = new TextEncoder().encode(c.value);
        w.writeU32(encoded.length);
        w.writeBytes(encoded);
        break;
      }
      case TAG_BYTES: {
        const bytes = c.value instanceof Uint8Array ? c.value : new Uint8Array(c.value);
        w.writeU32(bytes.length);
        w.writeBytes(bytes);
        break;
      }
      default:
        throw new BytecodeError(`Unknown const tag: ${c.tag}`);
    }
  }

  // --- Var table ---
  w.writeU16(varTable.length);
  for (const name of varTable) {
    const encoded = new TextEncoder().encode(name);
    w.writeU32(encoded.length);
    w.writeBytes(encoded);
  }

  // --- Instructions ---
  w.writeU32(instrs.length);
  for (const instr of instrs) {
    const { op, operands } = instr;
    w.writeU8(op);
    const width = OPERAND_WIDTH[op] ?? 0;
    if (width === 0) {
      // no operands
    } else if (width === 2) {
      if (SIGNED_OPERAND[op]) {
        w.writeI16(operands[0]);
      } else {
        w.writeU16(operands[0]);
      }
    } else if (width === 3) {
      // CALL: u16 builtin_id + u8 argc
      w.writeU16(operands[0]);
      w.writeU8(operands[1]);
    }
  }

  // --- Debug info ---
  if (hasDebug) {
    w.writeU32(debugInfo.length);
    for (const { line, col } of debugInfo) {
      w.writeU16(line);
      w.writeU16(col);
    }
  }

  // --- Checksum ---
  const body = w.toUint8Array();
  const checksum = adler32(body);

  // Append checksum as 4 bytes
  const final = new Uint8Array(body.length + 4);
  final.set(body);
  const view = new DataView(final.buffer);
  view.setUint32(body.length, checksum, false);

  return final;
}

// ---------------------------------------------------------------------------
// decode(bytes) → program
// ---------------------------------------------------------------------------

/**
 * Decode a Uint8Array back to a program object.
 *
 * @param {Uint8Array} bytes
 * @returns {{ consts: Array, varTable: string[], instrs: Array, debugInfo: Array|null }}
 */
export function decode(bytes) {
  // Verify checksum
  const bodyLen = bytes.length - 4;
  if (bodyLen < 4) throw new BytecodeError('CEL bytecode too short');

  const storedChecksum = new DataView(bytes.buffer, bytes.byteOffset + bodyLen, 4).getUint32(0, false);
  const bodyBytes = bytes.subarray(0, bodyLen);
  const computedChecksum = adler32(bodyBytes);
  if (storedChecksum !== computedChecksum) {
    throw new BytecodeError(`CEL bytecode checksum mismatch: expected 0x${computedChecksum.toString(16)}, got 0x${storedChecksum.toString(16)}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  function readU8()  { return view.getUint8(pos++); }
  function readU16() { const v = view.getUint16(pos, false); pos += 2; return v; }
  function readI16() { const v = view.getInt16(pos, false);  pos += 2; return v; }
  function readU32() { const v = view.getUint32(pos, false); pos += 4; return v; }
  function readBigInt64()  { const v = view.getBigInt64(pos, false);  pos += 8; return v; }
  function readBigUint64() { const v = view.getBigUint64(pos, false); pos += 8; return v; }
  function readF64() { const v = view.getFloat64(pos, false); pos += 8; return v; }
  function readBytes(n) {
    const slice = bytes.subarray(pos, pos + n);
    pos += n;
    return slice;
  }

  // --- Header ---
  const magic = readU16();
  if (magic !== MAGIC) throw new BytecodeError(`Invalid CEL magic: 0x${magic.toString(16)}`);
  const version = readU8();
  if (version !== VERSION) throw new BytecodeError(`Unsupported CEL bytecode version: ${version}`);
  const flags = readU8();
  const hasDebug = (flags & FLAG_DEBUG) !== 0;

  // --- Const pool ---
  const constCount = readU16();
  const consts = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < constCount; i++) {
    const tag = readU8();
    switch (tag) {
      case TAG_NULL:
        consts.push({ tag, value: null });
        break;
      case TAG_BOOL:
        consts.push({ tag, value: readU8() !== 0 });
        break;
      case TAG_INT64:
        consts.push({ tag, value: readBigInt64() });
        break;
      case TAG_UINT64:
        consts.push({ tag, value: readBigUint64() });
        break;
      case TAG_DOUBLE:
        consts.push({ tag, value: readF64() });
        break;
      case TAG_STRING: {
        const len = readU32();
        const raw = readBytes(len);
        consts.push({ tag, value: decoder.decode(raw) });
        break;
      }
      case TAG_BYTES: {
        const len = readU32();
        const raw = readBytes(len);
        consts.push({ tag, value: new Uint8Array(raw) });
        break;
      }
      default:
        throw new BytecodeError(`Unknown const tag: ${tag} at byte ${pos}`);
    }
  }

  // --- Var table ---
  const varCount = readU16();
  const varTable = [];
  for (let i = 0; i < varCount; i++) {
    const len = readU32();
    const raw = readBytes(len);
    varTable.push(decoder.decode(raw));
  }

  // --- Instructions ---
  const instrCount = readU32();
  const instrs = [];
  for (let i = 0; i < instrCount; i++) {
    const op = readU8();
    const width = OPERAND_WIDTH[op] ?? 0;
    let operands;
    if (width === 0) {
      operands = [];
    } else if (width === 2) {
      operands = [SIGNED_OPERAND[op] ? readI16() : readU16()];
    } else if (width === 3) {
      operands = [readU16(), readU8()];
    } else {
      throw new BytecodeError(`Unknown operand width ${width} for opcode ${op}`);
    }
    instrs.push({ op, operands });
  }

  // --- Debug info ---
  let debugInfo = null;
  if (hasDebug) {
    const debugCount = readU32();
    debugInfo = [];
    for (let i = 0; i < debugCount; i++) {
      const line = readU16();
      const col  = readU16();
      debugInfo.push({ line, col });
    }
  }

  return { consts, varTable, instrs, debugInfo };
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

/**
 * Encode a Uint8Array to a Base64 string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  // Handle large arrays in chunks to avoid stack overflow from spread
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode a Base64 string to a Uint8Array.
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function fromBase64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
