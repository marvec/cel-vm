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
function isTimestamp(v) { return v !== null && typeof v === 'object' && v.__celTimestamp === true }
function isDuration(v)  { return v !== null && typeof v === 'object' && v.__celDuration === true }
function isOpt(v)    { return v !== null && typeof v === 'object' && v.__celOptional === true }
function isError(v)  { return v !== null && typeof v === 'object' && v.__celError === true }

function celError(msg) { return { __celError: true, message: msg } }

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
  if (isTimestamp(v))         return 'google.protobuf.Timestamp'
  if (isDuration(v))          return 'google.protobuf.Duration'
  if (isOpt(v))              return 'optional'
  if (v && v.__celType)      return v.name
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Int64/Uint64 range constants
// ---------------------------------------------------------------------------

const INT64_MIN  = -(2n ** 63n)
const INT64_MAX  = 2n ** 63n - 1n
const UINT64_MAX = 2n ** 64n - 1n

function checkIntOverflow(v) {
  if (v < INT64_MIN || v > INT64_MAX) return celError(`integer overflow: ${v}`)
  return v
}

// ---------------------------------------------------------------------------
// Arithmetic helpers
// ---------------------------------------------------------------------------

function celAdd(a, b) {
  if (isError(a)) return a
  if (isError(b)) return b
  if (isInt(a) && isInt(b)) return checkIntOverflow(a + b)
  if (isNum(a) && isNum(b)) return a + b
  if (isStr(a) && isStr(b)) return a + b
  if (isList(a) && isList(b)) return [...a, ...b]
  if (isTimestamp(a) && isDuration(b)) return { __celTimestamp: true, ms: a.ms + b.ms }
  if (isDuration(a) && isTimestamp(b)) return { __celTimestamp: true, ms: a.ms + b.ms }
  if (isDuration(a) && isDuration(b)) return { __celDuration: true, ms: a.ms + b.ms }
  return celError(`no such overload: ${celTypeName(a)} + ${celTypeName(b)}`)
}

function celSub(a, b) {
  if (isError(a)) return a
  if (isError(b)) return b
  if (isInt(a) && isInt(b)) return checkIntOverflow(a - b)
  if (isNum(a) && isNum(b)) return a - b
  if (isTimestamp(a) && isDuration(b)) return { __celTimestamp: true, ms: a.ms - b.ms }
  if (isTimestamp(a) && isTimestamp(b)) return { __celDuration: true, ms: a.ms - b.ms }
  if (isDuration(a) && isDuration(b)) return { __celDuration: true, ms: a.ms - b.ms }
  return celError(`no such overload: ${celTypeName(a)} - ${celTypeName(b)}`)
}

function celMul(a, b) {
  if (isError(a)) return a
  if (isError(b)) return b
  if (isInt(a) && isInt(b)) return checkIntOverflow(a * b)
  if (isNum(a) && isNum(b)) return a * b
  return celError(`no such overload: ${celTypeName(a)} * ${celTypeName(b)}`)
}

function celDiv(a, b) {
  if (isError(a)) return a
  if (isError(b)) return b
  if (isInt(a) && isInt(b)) {
    if (b === 0n) return celError('division by zero')
    return checkIntOverflow(a / b)
  }
  if (isNum(a) && isNum(b)) return a / b
  return celError(`no such overload: ${celTypeName(a)} / ${celTypeName(b)}`)
}

function celMod(a, b) {
  if (isError(a)) return a
  if (isError(b)) return b
  if (isInt(a) && isInt(b)) {
    if (b === 0n) return celError('modulo by zero')
    return a % b  // mod result is always within int64 range if inputs are
  }
  return celError(`no such overload: ${celTypeName(a)} % ${celTypeName(b)}`)
}

function celPow(a, b) {
  if (isError(a)) return a
  if (isError(b)) return b
  if (isInt(a) && isInt(b)) return checkIntOverflow(a ** b)
  if (isNum(a) && isNum(b)) return Math.pow(a, b)
  return celError(`no such overload: ${celTypeName(a)} ** ${celTypeName(b)}`)
}

function celNeg(a) {
  if (isError(a)) return a
  if (isInt(a)) return checkIntOverflow(-a)
  if (isNum(a)) return -a
  return celError(`no such overload: -${celTypeName(a)}`)
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function celEq(a, b) {
  if (isError(a)) return a
  if (isError(b)) return b
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
  if (isTimestamp(a) && isTimestamp(b)) return a.ms === b.ms
  if (isDuration(a) && isDuration(b)) return a.ms === b.ms
  // Cross-type numeric: int == double
  if (isInt(a) && isNum(b)) return Number(a) === b
  if (isNum(a) && isInt(b)) return a === Number(b)
  return false
}

function celLt(a, b) {
  if (isError(a)) return a
  if (isError(b)) return b
  if (isInt(a) && isInt(b)) return a < b
  if (isNum(a) && isNum(b)) return a < b
  if (isStr(a) && isStr(b)) return a < b
  if (isBool(a) && isBool(b)) return (a ? 1 : 0) < (b ? 1 : 0)
  if (isTimestamp(a) && isTimestamp(b)) return a.ms < b.ms
  if (isDuration(a) && isDuration(b)) return a.ms < b.ms
  if (isInt(a) && isNum(b)) return Number(a) < b
  if (isNum(a) && isInt(b)) return a < Number(b)
  return celError(`no such overload: ${celTypeName(a)} < ${celTypeName(b)}`)
}

function celLe(a, b) {
  if (isError(a)) return a
  if (isError(b)) return b
  if (isInt(a) && isInt(b)) return a <= b
  if (isNum(a) && isNum(b)) return a <= b
  if (isStr(a) && isStr(b)) return a <= b
  if (isBool(a) && isBool(b)) return (a ? 1 : 0) <= (b ? 1 : 0)
  if (isTimestamp(a) && isTimestamp(b)) return a.ms <= b.ms
  if (isDuration(a) && isDuration(b)) return a.ms <= b.ms
  if (isInt(a) && isNum(b)) return Number(a) <= b
  if (isNum(a) && isInt(b)) return a <= Number(b)
  return celError(`no such overload: ${celTypeName(a)} <= ${celTypeName(b)}`)
}

// ---------------------------------------------------------------------------
// `in` operator
// ---------------------------------------------------------------------------

function celIn(val, container) {
  if (isError(val)) return val
  if (isError(container)) return container
  if (isList(container)) return container.some(x => celEq(x, val) === true)
  if (isMap(container)) {
    for (const k of container.keys()) {
      if (celEq(k, val) === true) return true
    }
    return false
  }
  return celError(`'in' requires list or map, got ${celTypeName(container)}`)
}

// ---------------------------------------------------------------------------
// Unicode code-point helpers (cel-spec defines string ops in code points)
// ---------------------------------------------------------------------------

function codePointLen(s) {
  let count = 0
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)
    i += cp > 0xFFFF ? 2 : 1
    count++
  }
  return count
}

function codePointCharAt(s, idx) {
  let count = 0
  for (let i = 0; i < s.length; ) {
    if (count === idx) return String.fromCodePoint(s.codePointAt(i))
    const cp = s.codePointAt(i)
    i += cp > 0xFFFF ? 2 : 1
    count++
  }
  return undefined
}

function codePointSubstring(s, start, end) {
  const pts = [...s]
  return pts.slice(start, end).join('')
}

function utf16OffsetToCodePoint(s, utf16Offset) {
  if (utf16Offset < 0) return -1n
  let cpIdx = 0
  for (let i = 0; i < utf16Offset; ) {
    const cp = s.codePointAt(i)
    i += cp > 0xFFFF ? 2 : 1
    cpIdx++
  }
  return BigInt(cpIdx)
}

// ---------------------------------------------------------------------------
// size()
// ---------------------------------------------------------------------------

function celSize(v) {
  if (isError(v)) return v
  if (isStr(v))   return BigInt(codePointLen(v))
  if (isList(v))  return BigInt(v.length)
  if (isMap(v))   return BigInt(v.size)
  if (isBytes(v)) return BigInt(v.length)
  return celError(`size() not supported on ${celTypeName(v)}`)
}

// ---------------------------------------------------------------------------
// SELECT and HAS_FIELD
// ---------------------------------------------------------------------------

const DANGEROUS_FIELDS = new Set(['__proto__', 'constructor', 'prototype'])

function celSelect(obj, field) {
  if (isError(obj)) return obj
  if (DANGEROUS_FIELDS.has(field)) return celError(`forbidden field: ${field}`)
  if (isMap(obj)) {
    if (obj.has(field)) return obj.get(field)
    return celError(`no such key: '${field}'`)
  }
  if (obj !== null && typeof obj === 'object') {
    if (!(field in obj)) return celError(`no such field: '${field}'`)
    return obj[field]
  }
  return celError(`cannot select field '${field}' from ${celTypeName(obj)}`)
}

function celHasField(obj, field) {
  if (isError(obj)) return obj
  if (DANGEROUS_FIELDS.has(field)) return false
  if (isMap(obj)) return obj.has(field)
  if (obj !== null && typeof obj === 'object') return field in obj
  return false
}

// ---------------------------------------------------------------------------
// Builtin function dispatch
// ---------------------------------------------------------------------------

function callBuiltin(id, argc, stack, sp) {
  // Propagate error values from any argument
  for (let i = 0; i < argc; i++) {
    if (isError(stack[sp - i])) return stack[sp - i]
  }

  switch (id) {
    // --- String methods (receiver is args[argc-1] at deepest) ---
    // Convention: receiver is first pushed, then args.
    // Stack at call: [receiver, arg1, arg2, ...] where argc includes receiver.

    case BUILTIN.STRING_CONTAINS: {
      // argc=2: stack[sp-1]=receiver, stack[sp]=substr
      const sub = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(sub)) return celError('contains() requires strings')
      return recv.includes(sub)
    }
    case BUILTIN.STRING_STARTS_WITH: {
      const sub = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(sub)) return celError('startsWith() requires strings')
      return recv.startsWith(sub)
    }
    case BUILTIN.STRING_ENDS_WITH: {
      const sub = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(sub)) return celError('endsWith() requires strings')
      return recv.endsWith(sub)
    }
    case BUILTIN.STRING_MATCHES: {
      const pat = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(pat)) return celError('matches() requires strings')
      return new RegExp(pat).test(recv)
    }
    case BUILTIN.STRING_SUBSTRING: {
      if (argc === 2) {
        const start = stack[sp]; const recv = stack[sp - 1]
        if (!isStr(recv)) return celError('substring() requires string receiver')
        return codePointSubstring(recv, Number(start))
      } else {
        const end = stack[sp]; const start = stack[sp - 1]; const recv = stack[sp - 2]
        if (!isStr(recv)) return celError('substring() requires string receiver')
        return codePointSubstring(recv, Number(start), Number(end))
      }
    }
    case BUILTIN.STRING_INDEX_OF: {
      const sub = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(sub)) return celError('indexOf() requires strings')
      return utf16OffsetToCodePoint(recv, recv.indexOf(sub))
    }
    case BUILTIN.STRING_SPLIT: {
      const sep = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(sep)) return celError('split() requires strings')
      return recv.split(sep)
    }
    case BUILTIN.STRING_LOWER_ASCII: {
      const recv = stack[sp]
      if (!isStr(recv)) return celError('lowerAscii() requires string')
      return recv.toLowerCase()
    }
    case BUILTIN.STRING_UPPER_ASCII: {
      const recv = stack[sp]
      if (!isStr(recv)) return celError('upperAscii() requires string')
      return recv.toUpperCase()
    }
    case BUILTIN.STRING_TRIM: {
      const recv = stack[sp]
      if (!isStr(recv)) return celError('trim() requires string')
      return recv.trim()
    }
    case BUILTIN.STRING_REPLACE: {
      const newStr = stack[sp]; const oldStr = stack[sp - 1]; const recv = stack[sp - 2]
      if (!isStr(recv)) return celError('replace() requires string receiver')
      return recv.split(oldStr).join(newStr)
    }
    case BUILTIN.STRING_JOIN: {
      if (argc === 2) {
        const sep = stack[sp]; const list = stack[sp - 1]
        if (!isList(list)) return celError('join() requires list receiver')
        return list.join(isStr(sep) ? sep : String(sep))
      } else {
        const list = stack[sp]
        if (!isList(list)) return celError('join() requires list receiver')
        return list.join('')
      }
    }

    case BUILTIN.STRING_CHAR_AT: {
      const idx = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv)) return celError('charAt() requires string receiver')
      const i = typeof idx === 'bigint' ? Number(idx) : idx
      const codepoints = [...recv]
      if (i < 0 || i > codepoints.length) return celError(`charAt: index ${i} out of range for string of length ${codepoints.length}`)
      if (i === codepoints.length) return ''
      return codepoints[i]
    }
    case BUILTIN.STRING_LAST_INDEX_OF: {
      const sub = stack[sp]; const recv = stack[sp - 1]
      if (!isStr(recv) || !isStr(sub)) return celError('lastIndexOf() requires strings')
      return utf16OffsetToCodePoint(recv, recv.lastIndexOf(sub))
    }
    case BUILTIN.STRINGS_QUOTE: {
      const v = stack[sp]
      if (!isStr(v)) return celError('strings.quote() requires string')
      return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    }

    // --- Type conversions ---
    case BUILTIN.TO_INT: {
      const v = stack[sp]
      if (isInt(v)) return v
      if (isNum(v)) return BigInt(Math.trunc(v))
      if (isStr(v)) {
        try { return BigInt(v) } catch { return celError(`int() cannot parse: '${v}'`) }
      }
      if (isBool(v)) return v ? 1n : 0n
      if (isTimestamp(v)) return BigInt(Math.trunc(v.ms / 1000))
      return celError(`int() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TO_UINT: {
      const v = stack[sp]
      if (isInt(v)) {
        if (v < 0n) return celError('uint() cannot convert negative int')
        return v
      }
      if (isNum(v)) return BigInt(Math.trunc(Math.abs(v)))
      if (isStr(v)) {
        try {
          const n = BigInt(v)
          if (n < 0n) return celError('uint() cannot convert negative value')
          return n
        } catch {
          return celError(`uint() cannot parse: '${v}'`)
        }
      }
      if (isBool(v)) return v ? 1n : 0n
      return celError(`uint() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TO_DOUBLE: {
      const v = stack[sp]
      if (isNum(v)) return v
      if (isInt(v)) return Number(v)
      if (isStr(v)) {
        const n = parseFloat(v)
        if (isNaN(n)) return celError(`double() cannot parse: '${v}'`)
        return n
      }
      if (isBool(v)) return v ? 1.0 : 0.0
      return celError(`double() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TO_STRING: {
      const v = stack[sp]
      if (isStr(v)) return v
      if (isInt(v)) return String(v)
      if (isNum(v)) return String(v)
      if (isBool(v)) return String(v)
      if (v === null) return 'null'
      if (isBytes(v)) return new TextDecoder().decode(v)
      if (isTimestamp(v)) return new Date(v.ms).toISOString().replace('.000Z', 'Z')
      if (isDuration(v)) return Math.trunc(v.ms / 1000) + 's'
      return celError(`string() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TO_BOOL: {
      const v = stack[sp]
      if (isBool(v)) return v
      if (isStr(v)) {
        if (v === 'true') return true
        if (v === 'false') return false
        return celError(`bool() cannot parse: '${v}'`)
      }
      return celError(`bool() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TO_BYTES: {
      const v = stack[sp]
      if (isBytes(v)) return v
      if (isStr(v)) return new TextEncoder().encode(v)
      return celError(`bytes() not supported on ${celTypeName(v)}`)
    }
    case BUILTIN.TYPE_OF: {
      return { __celType: true, name: celTypeName(stack[sp]) }
    }

    // --- Timestamp / Duration ---
    case BUILTIN.TIMESTAMP: {
      const v = stack[sp]
      if (!isStr(v)) return celError('timestamp() requires string')
      const d = new Date(v)
      if (isNaN(d.getTime())) return celError(`timestamp() cannot parse: '${v}'`)
      return { __celTimestamp: true, ms: d.getTime() }
    }
    case BUILTIN.DURATION: {
      const v = stack[sp]
      if (!isStr(v)) return celError('duration() requires string')
      try {
        return { __celDuration: true, ms: parseDuration(v) }
      } catch { return celError(`duration() cannot parse: '${v}'`) }
    }
    case BUILTIN.GET_FULL_YEAR: {
      if (argc === 2) {
        const tz = stack[sp]; const v = stack[sp - 1]
        if (!isStr(tz)) return celError('timezone argument must be a string')
        if (!isTimestamp(v)) return celError('getFullYear() requires timestamp')
        try { return BigInt(getTimezoneComponents(v.ms, tz).year) }
        catch { return celError(`invalid timezone: '${tz}'`) }
      }
      const v = stack[sp]
      if (!isTimestamp(v)) return celError('getFullYear() requires timestamp')
      return BigInt(new Date(v.ms).getUTCFullYear())
    }
    case BUILTIN.GET_MONTH: {
      if (argc === 2) {
        const tz = stack[sp]; const v = stack[sp - 1]
        if (!isStr(tz)) return celError('timezone argument must be a string')
        if (!isTimestamp(v)) return celError('getMonth() requires timestamp')
        try { return BigInt(getTimezoneComponents(v.ms, tz).month - 1) }
        catch { return celError(`invalid timezone: '${tz}'`) }
      }
      const v = stack[sp]
      if (!isTimestamp(v)) return celError('getMonth() requires timestamp')
      return BigInt(new Date(v.ms).getUTCMonth())
    }
    case BUILTIN.GET_DAY: {
      // getDayOfMonth(): 0-based day-of-month (CEL spec: getDate() - 1)
      if (argc === 2) {
        const tz = stack[sp]; const v = stack[sp - 1]
        if (!isStr(tz)) return celError('timezone argument must be a string')
        if (!isTimestamp(v)) return celError('getDayOfMonth() requires timestamp')
        try { return BigInt(getTimezoneComponents(v.ms, tz).day - 1) }
        catch { return celError(`invalid timezone: '${tz}'`) }
      }
      const v = stack[sp]
      if (!isTimestamp(v)) return celError('getDayOfMonth() requires timestamp')
      return BigInt(new Date(v.ms).getUTCDate() - 1)
    }
    case BUILTIN.GET_DATE: {
      // getDate(): 1-based day-of-month
      if (argc === 2) {
        const tz = stack[sp]; const v = stack[sp - 1]
        if (!isStr(tz)) return celError('timezone argument must be a string')
        if (!isTimestamp(v)) return celError('getDate() requires timestamp')
        try { return BigInt(getTimezoneComponents(v.ms, tz).day) }
        catch { return celError(`invalid timezone: '${tz}'`) }
      }
      const v = stack[sp]
      if (!isTimestamp(v)) return celError('getDate() requires timestamp')
      return BigInt(new Date(v.ms).getUTCDate())
    }
    case BUILTIN.GET_DAY_OF_WEEK: {
      if (argc === 2) {
        const tz = stack[sp]; const v = stack[sp - 1]
        if (!isStr(tz)) return celError('timezone argument must be a string')
        if (!isTimestamp(v)) return celError('getDayOfWeek() requires timestamp')
        try {
          const c = getTimezoneComponents(v.ms, tz)
          return BigInt(new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay())
        } catch { return celError(`invalid timezone: '${tz}'`) }
      }
      const v = stack[sp]
      if (!isTimestamp(v)) return celError('getDayOfWeek() requires timestamp')
      return BigInt(new Date(v.ms).getUTCDay())
    }
    case BUILTIN.GET_DAY_OF_YEAR: {
      if (argc === 2) {
        const tz = stack[sp]; const v = stack[sp - 1]
        if (!isStr(tz)) return celError('timezone argument must be a string')
        if (!isTimestamp(v)) return celError('getDayOfYear() requires timestamp')
        try {
          const c = getTimezoneComponents(v.ms, tz)
          const utcDate = Date.UTC(c.year, c.month - 1, c.day)
          const jan1 = Date.UTC(c.year, 0, 1)
          return BigInt(Math.floor((utcDate - jan1) / 86400000))
        } catch { return celError(`invalid timezone: '${tz}'`) }
      }
      const v = stack[sp]
      if (!isTimestamp(v)) return celError('getDayOfYear() requires timestamp')
      const d = new Date(v.ms)
      const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
      return BigInt(Math.floor((d - start) / 86400000))
    }
    case BUILTIN.GET_MILLISECONDS: {
      if (argc === 2) {
        const tz = stack[sp]; const v = stack[sp - 1]
        if (!isStr(tz)) return celError('timezone argument must be a string')
        if (!isTimestamp(v)) return celError('getMilliseconds() requires timestamp')
        // Milliseconds are timezone-independent, accept tz arg for consistency
        return BigInt(new Date(v.ms).getUTCMilliseconds())
      }
      const v = stack[sp]
      if (!isTimestamp(v)) return celError('getMilliseconds() requires timestamp')
      return BigInt(new Date(v.ms).getUTCMilliseconds())
    }
    case BUILTIN.GET_HOURS: {
      if (argc === 2) {
        const tz = stack[sp]; const v = stack[sp - 1]
        if (!isStr(tz)) return celError('timezone argument must be a string')
        if (isDuration(v)) return celError('getHours() timezone not supported on duration')
        if (!isTimestamp(v)) return celError('getHours() requires timestamp')
        try { return BigInt(getTimezoneComponents(v.ms, tz).hour) }
        catch { return celError(`invalid timezone: '${tz}'`) }
      }
      const v = stack[sp]
      if (isDuration(v)) return BigInt(Math.trunc(v.ms / 3600000))
      if (!isTimestamp(v)) return celError('getHours() requires timestamp or duration')
      return BigInt(new Date(v.ms).getUTCHours())
    }
    case BUILTIN.GET_MINUTES: {
      if (argc === 2) {
        const tz = stack[sp]; const v = stack[sp - 1]
        if (!isStr(tz)) return celError('timezone argument must be a string')
        if (isDuration(v)) return celError('getMinutes() timezone not supported on duration')
        if (!isTimestamp(v)) return celError('getMinutes() requires timestamp')
        try { return BigInt(getTimezoneComponents(v.ms, tz).minute) }
        catch { return celError(`invalid timezone: '${tz}'`) }
      }
      const v = stack[sp]
      if (isDuration(v)) return BigInt(Math.trunc(v.ms / 60000))
      if (!isTimestamp(v)) return celError('getMinutes() requires timestamp or duration')
      return BigInt(new Date(v.ms).getUTCMinutes())
    }
    case BUILTIN.GET_SECONDS: {
      if (argc === 2) {
        const tz = stack[sp]; const v = stack[sp - 1]
        if (!isStr(tz)) return celError('timezone argument must be a string')
        if (isDuration(v)) return celError('getSeconds() timezone not supported on duration')
        if (!isTimestamp(v)) return celError('getSeconds() requires timestamp')
        try { return BigInt(getTimezoneComponents(v.ms, tz).second) }
        catch { return celError(`invalid timezone: '${tz}'`) }
      }
      const v = stack[sp]
      if (isDuration(v)) return BigInt(Math.trunc(v.ms / 1000))
      if (!isTimestamp(v)) return celError('getSeconds() requires timestamp or duration')
      return BigInt(new Date(v.ms).getUTCSeconds())
    }

    // --- dyn() identity ---
    case BUILTIN.DYN: {
      return stack[sp]
    }

    // --- Math extensions ---
    case BUILTIN.MATH_MAX: {
      if (argc === 1) {
        const list = stack[sp]
        if (!isList(list)) return celError('math.max() requires list or two args')
        if (list.length === 0) return celError('math.max() called on empty list')
        return list.reduce((a, b) => (isInt(a) ? a > b : a > b) ? a : b)
      }
      const b = stack[sp]; const a = stack[sp - 1]
      if (isInt(a) && isInt(b)) return a > b ? a : b
      if (isNum(a) && isNum(b)) return Math.max(a, b)
      return celError('math.max() requires numeric args')
    }
    case BUILTIN.MATH_MIN: {
      if (argc === 1) {
        const list = stack[sp]
        if (!isList(list)) return celError('math.min() requires list or two args')
        if (list.length === 0) return celError('math.min() called on empty list')
        return list.reduce((a, b) => (isInt(a) ? a < b : a < b) ? a : b)
      }
      const b = stack[sp]; const a = stack[sp - 1]
      if (isInt(a) && isInt(b)) return a < b ? a : b
      if (isNum(a) && isNum(b)) return Math.min(a, b)
      return celError('math.min() requires numeric args')
    }
    case BUILTIN.MATH_ABS: {
      const v = stack[sp]
      if (isInt(v)) return v < 0n ? -v : v
      if (isNum(v)) return Math.abs(v)
      return celError('math.abs() requires numeric arg')
    }

    case BUILTIN.MATH_GREATEST: {
      if (argc === 1) {
        const v = stack[sp]
        if (isList(v)) {
          if (v.length === 0) return celError('math.greatest() requires at least one arg')
          return v.reduce((a, b) => celLt(b, a) === true ? a : b)
        }
        return v
      }
      let best = stack[sp - (argc - 1)]
      for (let i = 1; i < argc; i++) {
        const v = stack[sp - (argc - 1) + i]
        if (celLt(best, v) === true) best = v
      }
      return best
    }
    case BUILTIN.MATH_LEAST: {
      if (argc === 1) {
        const v = stack[sp]
        if (isList(v)) {
          if (v.length === 0) return celError('math.least() requires at least one arg')
          return v.reduce((a, b) => celLt(a, b) === true ? a : b)
        }
        return v
      }
      let best = stack[sp - (argc - 1)]
      for (let i = 1; i < argc; i++) {
        const v = stack[sp - (argc - 1) + i]
        if (celLt(v, best) === true) best = v
      }
      return best
    }

    default:
      return celError(`unknown builtin id: ${id}`)
  }
}

// ---------------------------------------------------------------------------
// Timezone helper
// ---------------------------------------------------------------------------

const _tzFmtCache = new Map()

function getTimezoneComponents(ms, tz) {
  // Normalize bare offsets: "02:00" → "+02:00"
  if (/^\d{2}:\d{2}$/.test(tz)) tz = '+' + tz

  let fmt = _tzFmtCache.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    })
    _tzFmtCache.set(tz, fmt)
  }

  const parts = fmt.formatToParts(new Date(ms))
  const m = {}
  for (const { type, value } of parts) m[type] = parseInt(value, 10)
  return m // { year, month, day, hour, minute, second }
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
        const result = stack[sp]
        if (isError(result)) throw new EvaluationError(result.message)
        return result
      }

      // ── Jumps ─────────────────────────────────────────────────────────────
      case OP.JUMP: {
        pc += operands[0]
        break
      }

      case OP.JUMP_IF_FALSE: {
        const cond = stack[sp--]
        // Errors and non-bool: don't jump (fall through to evaluate other branch)
        if (cond === false) pc += operands[0]
        else if (!isBool(cond) && !isError(cond)) throw new EvaluationError(`JUMP_IF_FALSE requires bool, got ${celTypeName(cond)}`)
        break
      }

      case OP.JUMP_IF_TRUE: {
        const cond = stack[sp--]
        if (cond === true) pc += operands[0]
        else if (!isBool(cond) && !isError(cond)) throw new EvaluationError(`JUMP_IF_TRUE requires bool, got ${celTypeName(cond)}`)
        break
      }

      case OP.JUMP_IF_FALSE_K: {
        // Peek (keep on stack)
        const cond = stack[sp]
        // false → jump (short-circuit); error/non-bool → fall through (evaluate right)
        if (cond === false) pc += operands[0]
        else if (!isBool(cond) && !isError(cond)) stack[sp] = celError(`no such overload`)
        break
      }

      case OP.JUMP_IF_TRUE_K: {
        // Peek (keep on stack)
        const cond = stack[sp]
        // true → jump (short-circuit); error/non-bool → fall through (evaluate right)
        if (cond === true) pc += operands[0]
        else if (!isBool(cond) && !isError(cond)) stack[sp] = celError(`no such overload`)
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
        if (isError(v)) break  // propagate error
        if (!isBool(v)) { stack[sp] = celError(`! requires bool, got ${celTypeName(v)}`); break }
        stack[sp] = !v
        break
      }
      case OP.XOR: {
        const b = stack[sp--]; const a = stack[sp]
        if (isError(a)) break
        if (isError(b)) { stack[sp] = b; break }
        if (!isInt(a) || !isInt(b)) { stack[sp] = celError(`^ requires int, got ${celTypeName(a)} ^ ${celTypeName(b)}`); break }
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
        if (isError(obj)) { break }
        if (isError(idx)) { stack[sp] = idx; break }
        if (isList(obj)) {
          const i = typeof idx === 'bigint' ? Number(idx) : idx
          if (typeof i !== 'number' || !Number.isInteger(i)) { stack[sp] = celError(`invalid index type: ${celTypeName(idx)}`); break }
          if (i < 0 || i >= obj.length) { stack[sp] = celError(`index out of bounds: ${i}`); break }
          stack[sp] = obj[i]
        } else if (isMap(obj)) {
          let found = false
          for (const [k, v] of obj) {
            if (celEq(k, idx) === true) { stack[sp] = v; found = true; break }
          }
          if (!found) stack[sp] = celError(`no such key: '${idx}'`)
        } else if (isStr(obj)) {
          const i = typeof idx === 'bigint' ? Number(idx) : idx
          const len = codePointLen(obj)
          if (i < 0 || i >= len) { stack[sp] = celError(`index out of bounds: ${i}`); break }
          stack[sp] = codePointCharAt(obj, i)
        } else {
          stack[sp] = celError(`cannot index ${celTypeName(obj)}`)
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
        if (isError(list)) break  // propagate error
        if (!isList(list) && !isMap(list)) {
          stack[sp] = celError(`cannot iterate over ${celTypeName(list)}`); break
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
  const result = stack[sp]
  if (isError(result)) throw new EvaluationError(result.message)
  return result
}
