// CEL-VM dispatch loop
//
// Plain function (not a class) for V8 JIT friendliness.
// Flat while/switch with integer-indexed variable lookups — no dynamic
// property access in the hot path.
//
// Comprehension variable sentinels (from compiler.js):
//   LOAD_VAR 0xFFFE = DUP TOS (current iterator element)
//   LOAD_VAR 0xFFFF = load accumulator register
//
// ACCUM_PUSH operand 0xFFFF = pop TOS and use as initial accumulator.

import { OP, BUILTIN } from './bytecode.js'

// ---------------------------------------------------------------------------
// EvaluationError
// ---------------------------------------------------------------------------

export class EvaluationError extends Error {
  constructor(msg) {
    super(msg)
    this.name = 'EvaluationError'
  }
}

// ---------------------------------------------------------------------------
// Type checking helpers (used in hot path — kept as simple functions)
// ---------------------------------------------------------------------------

function isInt(v)    { return typeof v === 'bigint' }
function isNum(v)    { return typeof v === 'number' }
function isStr(v)    { return typeof v === 'string' }
function isBool(v)   { return typeof v === 'boolean' }
function isList(v)   { return Array.isArray(v) }
function isMap(v)    { return v instanceof Map }
function isBytes(v)  { return v instanceof Uint8Array }
function isOpt(v)    { return v !== null && typeof v === 'object' && v.__celOptional === true }

// ---------------------------------------------------------------------------
// Celtype helpers
// ---------------------------------------------------------------------------

function celTypeName(v) {
  if (v === null)            return 'null_type'
  if (isBool(v))             return 'bool'
  if (isInt(v))              return 'int'
  if (isNum(v))              return 'double'
  if (isStr(v))              return 'string'
  if (isBytes(v))            return 'bytes'
  if (isList(v))             return 'list'
  if (isMap(v))              return 'map'
  if (isOpt(v))              return 'optional'
  if (v && v.__celType)      return v.name
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Arithmetic helpers
// ---------------------------------------------------------------------------

function celAdd(a, b) {
  if (isInt(a) && isInt(b)) return a + b
  if (isNum(a) && isNum(b)) return a + b
  if (isStr(a) && isStr(b)) return a + b
  if (isList(a) && isList(b)) return [...a, ...b]
  throw new EvaluationError(`no such overload: ${celTypeName(a)} + ${celTypeName(b)}`)
}

function celSub(a, b) {
  if (isInt(a) && isInt(b)) return a - b
  if (isNum(a) && isNum(b)) return a - b
  throw new EvaluationError(`no such overload: ${celTypeName(a)} - ${celTypeName(b)}`)
}

function celMul(a, b) {
  if (isInt(a) && isInt(b)) return a * b
  if (isNum(a) && isNum(b)) return a * b
  throw new EvaluationError(`no such overload: ${celTypeName(a)} * ${celTypeName(b)}`)
}

function celDiv(a, b) {
  if (isInt(a) && isInt(b)) {
    if (b === 0n) throw new EvaluationError('division by zero')
    return a / b
  }
  if (isNum(a) && isNum(b)) return a / b
  throw new EvaluationError(`no such overload: ${celTypeName(a)} / ${celTypeName(b)}`)
}

function celMod(a, b) {
  if (isInt(a) && isInt(b)) {
    if (b === 0n) throw new EvaluationError('modulo by zero')
    return a % b
  }
  throw new EvaluationError(`no such overload: ${celTypeName(a)} % ${celTypeName(b)}`)
}

function celPow(a, b) {
  if (isInt(a) && isInt(b)) return a ** b
  if (isNum(a) && isNum(b)) return Math.pow(a, b)
  throw new EvaluationError(`no such overload: ${celTypeName(a)} ** ${celTypeName(b)}`)
}

function celNeg(a) {
  if (isInt(a)) return -a
  if (isNum(a)) return -a
  throw new EvaluationError(`no such overload: -${celTypeName(a)}`)
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function celEq(a, b) {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  if (isInt(a) && isInt(b)) return a === b
  if (isNum(a) && isNum(b)) return a === b
  if (isStr(a) && isStr(b)) return a === b
  if (isBool(a) && isBool(b)) return a === b
  if (isBytes(a) && isBytes(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  if (isList(a) && isList(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!celEq(a[i], b[i])) return false
    return true
  }
  if (isMap(a) && isMap(b)) {
    if (a.size !== b.size) return false
    for (const [k, v] of a) {
      if (!b.has(k)) return false
      if (!celEq(v, b.get(k))) return false
    }
    return true
  }
  // Cross-type numeric: int == double
  if (isInt(a) && isNum(b)) return Number(a) === b
  if (isNum(a) && isInt(b)) return a === Number(b)
  return false
}

function celLt(a, b) {
  if (isInt(a) && isInt(b)) return a < b
  if (isNum(a) && isNum(b)) return a < b
  if (isStr(a) && isStr(b)) return a < b
  if (isBool(a) && isBool(b)) return (a ? 1 : 0) < (b ? 1 : 0)
  throw new EvaluationError(`no such overload: ${celTypeName(a)} < ${celTypeName(b)}`)
}

function celLe(a, b) {
  if (isInt(a) && isInt(b)) return a <= b
  if (isNum(a) && isNum(b)) return a <= b
  if (isStr(a) && isStr(b)) return a <= b
  if (isBool(a) && isBool(b)) return (a ? 1 : 0) <= (b ? 1 : 0)
  throw new EvaluationError(`no such overload: ${celTypeName(a)} <= ${celTypeName(b)}`)
}

// ---------------------------------------------------------------------------
// `in` operator
// ---------------------------------------------------------------------------

function celIn(val, container) {
  if (isList(container)) return container.some(x => celEq(x, val))
  if (isMap(container)) {
    for (const k of container.keys()) {
      if (celEq(k, val)) return true
    }
    return false
  }
  throw new EvaluationError(`'in' requires list or map, got ${celTypeName(container)}`)
}

// ---------------------------------------------------------------------------
// size()
// ---------------------------------------------------------------------------

function celSize(v) {
  if (isStr(v))   return BigInt(v.length)
  if (isList(v))  return BigInt(v.length)
  if (isMap(v))   return BigInt(v.size)
  if (isBytes(v)) return BigInt(v.length)
  throw new EvaluationError(`size() not supported on ${celTypeName(v)}`)
}

// ---------------------------------------------------------------------------
// SELECT and HAS_FIELD
// ---------------------------------------------------------------------------

const DANGEROUS_FIELDS = new Set(['__proto__', 'constructor', 'prototype'])

function celSelect(obj, field) {
  if (DANGEROUS_FIELDS.has(field)) throw new EvaluationError(`forbidden field: ${field}`)
  if (isMap(obj)) {
    // Try string key first, then see if key exists at all
    if (obj.has(field)) return obj.get(field)
    throw new EvaluationError(`no such key: '${field}'`)
  }
  if (obj !== null && typeof obj === 'object') {
    if (!(field in obj)) throw new EvaluationError(`no such field: '${field}'`)
    return obj[field]
  }
  throw new EvaluationError(`cannot select field '${field}' from ${celTypeName(obj)}`)
}

function celHasField(obj, field) {
  if (DANGEROUS_FIELDS.has(field)) return false
  if (isMap(obj)) return obj.has(field)
  if (obj !== null && typeof obj === 'object') return field in obj
  return false
}

// ---------------------------------------------------------------------------
// Builtin function dispatch
// ---------------------------------------------------------------------------

function callBuiltin(id, argc, stack, sp) {
  switch (id) {
    // --- String methods (receiver is args[argc-1] at deepest) ---
    // Convention: receiver is first pushed, then args.
    // Stack at call: [receiver, arg1, arg2, ...] where argc includes receiver.

    case BUILTIN.STRING_CONTAINS: {
      // argc=2: stack[sp-1]=receiver, stack[sp]=substr
      const sub = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(sub)) throw new EvaluationError('contains() requires strings')
      return recv.includes(sub)
    }
    case BUILTIN.STRING_STARTS_WITH: {
      const sub = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(sub)) throw new EvaluationError('startsWith() requires strings')
      return recv.startsWith(sub)
    }
    case BUILTIN.STRING_ENDS_WITH: {
      const sub = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(sub)) throw new EvaluationError('endsWith() requires strings')
      return recv.endsWith(sub)
    }
    case BUILTIN.STRING_MATCHES: {
      const pat = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(pat)) throw new EvaluationError('matches() requires strings')
      return new RegExp(pat).test(recv)
    }
    case BUILTIN.STRING_SUBSTRING: {
      // argc=2 (recv, start) or argc=3 (recv, start, end)
      if (argc === 2) {
        const start = stack[sp]; const recv = stack[sp - 1]
        if (!isStr(recv)) throw new EvaluationError('substring() requires string receiver')
        const s = Number(start)
        return recv.substring(s)
      } else {
        const end = stack[sp]; const start = stack[sp - 1]; const recv = stack[sp - 2]
        if (!isStr(recv)) throw new EvaluationError('substring() requires string receiver')
        return recv.substring(Number(start), Number(end))
      }
    }
    case BUILTIN.STRING_INDEX_OF: {
      const sub = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(sub)) throw new EvaluationError('indexOf() requires strings')
      return BigInt(recv.indexOf(sub))
    }
    case BUILTIN.STRING_SPLIT: {
      const sep = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(sep)) throw new EvaluationError('split() requires strings')
      return recv.split(sep)
    }
    case BUILTIN.STRING_LOWER_ASCII: {
      const recv = stack[sp]
      if (!isStr(recv)) throw new EvaluationError('lowerAscii() requires string')
      return recv.toLowerCase()
    }
    case BUILTIN.STRING_UPPER_ASCII: {
      const recv = stack[sp]
      if (!isStr(recv)) throw new EvaluationError('upperAscii() requires string')
      return recv.toUpperCase()
    }
    case BUILTIN.STRING_TRIM: {
      const recv = stack[sp]
      if (!isStr(recv)) throw new EvaluationError('trim() requires string')
      return recv.trim()
    }
    case BUILTIN.STRING_REPLACE: {
      // recv.replace(old, new)
      const newStr = stack[sp]; const oldStr = stack[sp - 1]; const recv = stack[sp - 2]
      if (!isStr(recv)) throw new EvaluationError('replace() requires string receiver')
      return recv.split(oldStr).join(newStr)
    }
    case BUILTIN.STRING_JOIN: {
      // list.join(sep) — argc=2, stack[sp-1]=list, stack[sp]=sep
      if (argc === 2) {
        const sep = stack[sp]; const list = stack[sp - 1]
        if (!isList(list)) throw new EvaluationError('join() requires list receiver')
        return list.join(isStr(sep) ? sep : String(sep))
      } else {
        // argc=1: list.join() with no sep
        const list = stack[sp]
        if (!isList(list)) throw new EvaluationError('join() requires list receiver')
        return list.join('')
      }
    }

    // --- Type conversions ---
    case BUILTIN.TO_INT: {
      const v = stack[sp]
      if (isInt(v)) return v
      if (isNum(v)) return BigInt(Math.trunc(v))
      if (isStr(v)) {
        try { return BigInt(v) } catch { throw new EvaluationError(`int() cannot parse: '${v}'`) }
      }
      if (isBool(v)) return v ? 1n : 0n
      throw new EvaluationError(`int() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TO_UINT: {
      const v = stack[sp]
      if (isInt(v)) {
        if (v < 0n) throw new EvaluationError('uint() cannot convert negative int')
        return v
      }
      if (isNum(v)) return BigInt(Math.trunc(Math.abs(v)))
      if (isStr(v)) {
        try {
          const n = BigInt(v)
          if (n < 0n) throw new EvaluationError('uint() cannot convert negative value')
          return n
        } catch (e) {
          if (e instanceof EvaluationError) throw e
          throw new EvaluationError(`uint() cannot parse: '${v}'`)
        }
      }
      if (isBool(v)) return v ? 1n : 0n
      throw new EvaluationError(`uint() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TO_DOUBLE: {
      const v = stack[sp]
      if (isNum(v)) return v
      if (isInt(v)) return Number(v)
      if (isStr(v)) {
        const n = parseFloat(v)
        if (isNaN(n)) throw new EvaluationError(`double() cannot parse: '${v}'`)
        return n
      }
      if (isBool(v)) return v ? 1.0 : 0.0
      throw new EvaluationError(`double() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TO_STRING: {
      const v = stack[sp]
      if (isStr(v)) return v
      if (isInt(v)) return String(v)
      if (isNum(v)) return String(v)
      if (isBool(v)) return String(v)
      if (v === null) return 'null'
      if (isBytes(v)) return new TextDecoder().decode(v)
      throw new EvaluationError(`string() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TO_BOOL: {
      const v = stack[sp]
      if (isBool(v)) return v
      if (isStr(v)) {
        if (v === 'true') return true
        if (v === 'false') return false
        throw new EvaluationError(`bool() cannot parse: '${v}'`)
      }
      throw new EvaluationError(`bool() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TO_BYTES: {
      const v = stack[sp]
      if (isBytes(v)) return v
      if (isStr(v)) return new TextEncoder().encode(v)
      throw new EvaluationError(`bytes() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TYPE_OF: {
      return { __celType: true, name: celTypeName(stack[sp]) }
    }

    // --- Timestamp / Duration ---
    case BUILTIN.TIMESTAMP: {
      const v = stack[sp]
      if (!isStr(v)) throw new EvaluationError('timestamp() requires string')
      const d = new Date(v)
      if (isNaN(d.getTime())) throw new EvaluationError(`timestamp() cannot parse: '${v}'`)
      return { __celTimestamp: true, ms: d.getTime() }
    }
    case BUILTIN.DURATION: {
      const v = stack[sp]
      if (!isStr(v)) throw new EvaluationError('duration() requires string')
      // Parse simple duration: e.g. "1s", "1m30s", "1h", "500ms"
      return { __celDuration: true, ms: parseDuration(v) }
    }
    case BUILTIN.GET_FULL_YEAR: {
      const v = stack[sp]
      if (!v || !v.__celTimestamp) throw new EvaluationError('getFullYear() requires timestamp')
      return BigInt(new Date(v.ms).getUTCFullYear())
    }
    case BUILTIN.GET_MONTH: {
      const v = stack[sp]
      if (!v || !v.__celTimestamp) throw new EvaluationError('getMonth() requires timestamp')
      return BigInt(new Date(v.ms).getUTCMonth())
    }
    case BUILTIN.GET_DAY: {
      const v = stack[sp]
      if (!v || !v.__celTimestamp) throw new EvaluationError('getDay() requires timestamp')
      return BigInt(new Date(v.ms).getUTCDate())
    }
    case BUILTIN.GET_HOURS: {
      const v = stack[sp]
      if (!v || !v.__celTimestamp) throw new EvaluationError('getHours() requires timestamp')
      return BigInt(new Date(v.ms).getUTCHours())
    }
    case BUILTIN.GET_MINUTES: {
      const v = stack[sp]
      if (!v || !v.__celTimestamp) throw new EvaluationError('getMinutes() requires timestamp')
      return BigInt(new Date(v.ms).getUTCMinutes())
    }
    case BUILTIN.GET_SECONDS: {
      const v = stack[sp]
      if (!v || !v.__celTimestamp) throw new EvaluationError('getSeconds() requires timestamp')
      return BigInt(new Date(v.ms).getUTCSeconds())
    }

    // --- Math extensions ---
    case BUILTIN.MATH_MAX: {
      if (argc === 1) {
        const list = stack[sp]
        if (!isList(list)) throw new EvaluationError('math.max() requires list or two args')
        if (list.length === 0) throw new EvaluationError('math.max() called on empty list')
        return list.reduce((a, b) => (isInt(a) ? a > b : a > b) ? a : b)
      }
      const b = stack[sp]; const a = stack[sp - 1]
      if (isInt(a) && isInt(b)) return a > b ? a : b
      if (isNum(a) && isNum(b)) return Math.max(a, b)
      throw new EvaluationError('math.max() requires numeric args')
    }
    case BUILTIN.MATH_MIN: {
      if (argc === 1) {
        const list = stack[sp]
        if (!isList(list)) throw new EvaluationError('math.min() requires list or two args')
        if (list.length === 0) throw new EvaluationError('math.min() called on empty list')
        return list.reduce((a, b) => (isInt(a) ? a < b : a < b) ? a : b)
      }
      const b = stack[sp]; const a = stack[sp - 1]
      if (isInt(a) && isInt(b)) return a < b ? a : b
      if (isNum(a) && isNum(b)) return Math.min(a, b)
      throw new EvaluationError('math.min() requires numeric args')
    }
    case BUILTIN.MATH_ABS: {
      const v = stack[sp]
      if (isInt(v)) return v < 0n ? -v : v
      if (isNum(v)) return Math.abs(v)
      throw new EvaluationError('math.abs() requires numeric arg')
    }

    default:
      throw new EvaluationError(`unknown builtin id: ${id}`)
  }
}

// ---------------------------------------------------------------------------
// Duration parser helper
// ---------------------------------------------------------------------------

function parseDuration(s) {
  // Parses Go-style duration strings: "300ms", "1.5h", "2h45m", "1s", "-1h"
  let total = 0
  let sign = 1
  let i = 0
  if (s[0] === '-') { sign = -1; i++ }
  if (s[0] === '+') i++
  if (s === '0') return 0
  const re = /(\d+\.?\d*)(ns|us|µs|ms|s|m|h)/g
  let match
  re.lastIndex = i
  let matched = false
  while ((match = re.exec(s)) !== null) {
    matched = true
    const val = parseFloat(match[1])
    switch (match[2]) {
      case 'h':  total += val * 3600000; break
      case 'm':  total += val * 60000;   break
      case 's':  total += val * 1000;    break
      case 'ms': total += val;           break
      case 'us':
      case 'µs': total += val / 1000;    break
      case 'ns': total += val / 1000000; break
    }
  }
  if (!matched) throw new EvaluationError(`duration() cannot parse: '${s}'`)
  return sign * total
}

// ---------------------------------------------------------------------------
// Main evaluate() function — V8-optimised dispatch loop
// ---------------------------------------------------------------------------

const IDX_ITER_ELEM = 0xFFFE
const IDX_ACCU      = 0xFFFF

/**
 * Evaluate encoded bytecode against an activation object.
 *
 * @param {object} program   - decoded program: { consts, varTable, instrs }
 * @param {object} activation - map of variable name → value
 * @returns {*} the result value
 */
export function evaluate(program, activation) {
  const { consts, varTable, instrs } = program

  // Build activation array (string → index resolved at compile time)
  const vars = new Array(varTable.length)
  for (let i = 0; i < varTable.length; i++) {
    vars[i] = activation != null ? activation[varTable[i]] : undefined
  }

  // Stack
  const stack = new Array(256)
  let sp = -1

  // Program counter
  let pc = 0
  const len = instrs.length

  // Accumulator and iterator element registers (for comprehensions)
  let accu = null
  let iterElem = undefined

  while (pc < len) {
    const { op, operands } = instrs[pc++]

    switch (op) {
      // ── Push / Load ───────────────────────────────────────────────────────
      case OP.PUSH_CONST: {
        const entry = consts[operands[0]]
        stack[++sp] = entry.value
        break
      }

      case OP.LOAD_VAR: {
        const idx = operands[0]
        if (idx === IDX_ITER_ELEM) {
          // Load from iterElem register (set by ITER_NEXT)
          stack[++sp] = iterElem
        } else if (idx === IDX_ACCU) {
          stack[++sp] = accu
        } else {
          stack[++sp] = vars[idx]
        }
        break
      }

      case OP.POP: {
        sp--
        break
      }

      case OP.RETURN: {
        return stack[sp]
      }

      // ── Jumps ─────────────────────────────────────────────────────────────
      case OP.JUMP: {
        pc += operands[0]
        break
      }

      case OP.JUMP_IF_FALSE: {
        const cond = stack[sp--]
        if (!isBool(cond)) throw new EvaluationError(`JUMP_IF_FALSE requires bool, got ${celTypeName(cond)}`)
        if (!cond) pc += operands[0]
        break
      }

      case OP.JUMP_IF_TRUE: {
        const cond = stack[sp--]
        if (!isBool(cond)) throw new EvaluationError(`JUMP_IF_TRUE requires bool, got ${celTypeName(cond)}`)
        if (cond) pc += operands[0]
        break
      }

      case OP.JUMP_IF_FALSE_K: {
        // Peek (keep on stack)
        const cond = stack[sp]
        if (!isBool(cond)) throw new EvaluationError(`JUMP_IF_FALSE_K requires bool, got ${celTypeName(cond)}`)
        if (!cond) pc += operands[0]
        break
      }

      case OP.JUMP_IF_TRUE_K: {
        // Peek (keep on stack)
        const cond = stack[sp]
        if (!isBool(cond)) throw new EvaluationError(`JUMP_IF_TRUE_K requires bool, got ${celTypeName(cond)}`)
        if (cond) pc += operands[0]
        break
      }

      // ── Arithmetic ────────────────────────────────────────────────────────
      case OP.ADD: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = celAdd(a, b)
        break
      }
      case OP.SUB: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = celSub(a, b)
        break
      }
      case OP.MUL: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = celMul(a, b)
        break
      }
      case OP.DIV: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = celDiv(a, b)
        break
      }
      case OP.MOD: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = celMod(a, b)
        break
      }
      case OP.POW: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = celPow(a, b)
        break
      }
      case OP.NEG: {
        stack[sp] = celNeg(stack[sp])
        break
      }

      // ── Comparison ────────────────────────────────────────────────────────
      case OP.EQ: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = celEq(a, b)
        break
      }
      case OP.NEQ: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = !celEq(a, b)
        break
      }
      case OP.LT: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = celLt(a, b)
        break
      }
      case OP.LE: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = celLe(a, b)
        break
      }
      case OP.GT: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = celLt(b, a)
        break
      }
      case OP.GE: {
        const b = stack[sp--]; const a = stack[sp]
        stack[sp] = celLe(b, a)
        break
      }

      // ── Logic ─────────────────────────────────────────────────────────────
      case OP.NOT: {
        const v = stack[sp]
        if (!isBool(v)) throw new EvaluationError(`! requires bool, got ${celTypeName(v)}`)
        stack[sp] = !v
        break
      }
      case OP.XOR: {
        const b = stack[sp--]; const a = stack[sp]
        if (!isInt(a) || !isInt(b)) throw new EvaluationError(`^ requires int, got ${celTypeName(a)} ^ ${celTypeName(b)}`)
        stack[sp] = a ^ b
        break
      }

      // ── Collections ───────────────────────────────────────────────────────
      case OP.BUILD_LIST: {
        const n = operands[0]
        const list = new Array(n)
        for (let i = n - 1; i >= 0; i--) list[i] = stack[sp--]
        stack[++sp] = list
        break
      }
      case OP.BUILD_MAP: {
        const n = operands[0]
        const map = new Map()
        // Stack has k0,v0,k1,v1,...,kn-1,vn-1 (pushed in order, bottom to top)
        const base = sp - n * 2 + 1
        for (let i = 0; i < n; i++) {
          map.set(stack[base + i * 2], stack[base + i * 2 + 1])
        }
        sp = base
        stack[sp] = map
        break
      }
      case OP.INDEX: {
        const idx = stack[sp--]; const obj = stack[sp]
        if (isList(obj)) {
          const i = typeof idx === 'bigint' ? Number(idx) : idx
          if (i < 0 || i >= obj.length) throw new EvaluationError(`index out of bounds: ${i}`)
          stack[sp] = obj[i]
        } else if (isMap(obj)) {
          // Try to find key — handle BigInt/number cross-matching
          let found = false
          for (const [k, v] of obj) {
            if (celEq(k, idx)) { stack[sp] = v; found = true; break }
          }
          if (!found) throw new EvaluationError(`no such key: '${idx}'`)
        } else if (isStr(obj)) {
          const i = typeof idx === 'bigint' ? Number(idx) : idx
          if (i < 0 || i >= obj.length) throw new EvaluationError(`index out of bounds: ${i}`)
          stack[sp] = obj[i]
        } else {
          throw new EvaluationError(`cannot index ${celTypeName(obj)}`)
        }
        break
      }
      case OP.IN: {
        const container = stack[sp--]; const val = stack[sp]
        stack[sp] = celIn(val, container)
        break
      }

      // ── Field access ──────────────────────────────────────────────────────
      case OP.SELECT: {
        const nameIdx = operands[0]
        const field = consts[nameIdx].value
        stack[sp] = celSelect(stack[sp], field)
        break
      }
      case OP.HAS_FIELD: {
        const nameIdx = operands[0]
        const field = consts[nameIdx].value
        stack[sp] = celHasField(stack[sp], field)
        break
      }

      // ── Function call ─────────────────────────────────────────────────────
      case OP.CALL: {
        const builtinId = operands[0]
        const argc = operands[1]
        const result = callBuiltin(builtinId, argc, stack, sp)
        sp -= argc - 1
        stack[sp] = result
        break
      }

      case OP.SIZE: {
        stack[sp] = celSize(stack[sp])
        break
      }

      // ── Comprehension ─────────────────────────────────────────────────────
      case OP.ITER_INIT: {
        const list = stack[sp]
        if (!isList(list) && !isMap(list)) {
          throw new EvaluationError(`cannot iterate over ${celTypeName(list)}`)
        }
        const items = isMap(list) ? [...list.keys()] : list
        stack[sp] = { __iter: true, items, idx: 0 }
        break
      }

      case OP.ITER_NEXT: {
        const offset = operands[0]
        const iter = stack[sp]
        if (iter.idx >= iter.items.length) {
          pc += offset
        } else {
          iterElem = iter.items[iter.idx++]
          stack[++sp] = iterElem  // also on stack so POP can remove it
        }
        break
      }

      case OP.ITER_POP: {
        sp--
        break
      }

      case OP.ACCUM_PUSH: {
        const constIdx = operands[0]
        if (constIdx === 0xFFFF) {
          // Pop TOS and use as initial accumulator
          accu = stack[sp--]
        } else {
          accu = consts[constIdx].value
          // For mutable values (list/map), we need a fresh copy
          if (isList(accu)) accu = [...accu]
          else if (isMap(accu)) accu = new Map(accu)
        }
        break
      }

      case OP.ACCUM_SET: {
        accu = stack[sp--]
        break
      }

      // ── Optional types ────────────────────────────────────────────────────
      case OP.OPT_NONE: {
        stack[++sp] = { __celOptional: true, value: undefined }
        break
      }
      case OP.OPT_OF: {
        const v = stack[sp]
        stack[sp] = { __celOptional: true, value: v }
        break
      }
      case OP.OPT_OR_VALUE: {
        const def = stack[sp--]
        const opt = stack[sp]
        if (isOpt(opt)) {
          stack[sp] = opt.value === undefined ? def : opt.value
        } else {
          // Not an optional — just return as-is (already a concrete value)
          stack[sp] = opt
        }
        break
      }
      case OP.OPT_SELECT: {
        const nameIdx = operands[0]
        const field = consts[nameIdx].value
        const obj = stack[sp]
        if (isOpt(obj) && obj.value === undefined) {
          // none stays none
        } else {
          const target = isOpt(obj) ? obj.value : obj
          if (DANGEROUS_FIELDS.has(field)) {
            stack[sp] = { __celOptional: true, value: undefined }
          } else if (isMap(target) && target.has(field)) {
            stack[sp] = { __celOptional: true, value: target.get(field) }
          } else if (target !== null && typeof target === 'object' && field in target) {
            stack[sp] = { __celOptional: true, value: target[field] }
          } else {
            stack[sp] = { __celOptional: true, value: undefined }
          }
        }
        break
      }
      case OP.OPT_CHAIN: {
        const offset = operands[0]
        const top = stack[sp]
        if (isOpt(top) && top.value === undefined) {
          pc += offset
        }
        break
      }

      default:
        throw new EvaluationError(`unknown opcode: ${op}`)
    }
  }

  // Should not reach here if bytecode ends with RETURN
  return stack[sp]
}
