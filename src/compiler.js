// CEL Compiler — checked AST → bytecode program
//
// Input:  checked AST produced by src/checker.js
// Output: program object suitable for encode() from src/bytecode.js
//
//   {
//     consts:    Array<{tag, value}>   — constant pool
//     varTable:  string[]              — external variable names (alphabetical)
//     instrs:    Array<{op, operands}> — instruction list
//     debugInfo: Array<{line, col}> | null
//   }
//
// Comprehension variables (iterVar, accuVar) use special LOAD_VAR sentinel indices:
//   0xFFFE = load current iterator element (top of stack, non-destructive)
//   0xFFFF = load accumulator (maintained by ACCUM_PUSH / ACCUM_SET)

import { OP, BUILTIN } from './bytecode.js'

// ---------------------------------------------------------------------------
// Const pool tag constants (mirror bytecode.js)
// ---------------------------------------------------------------------------

const TAG_NULL   = 0
const TAG_BOOL   = 1
const TAG_INT64  = 2
const TAG_UINT64 = 3
const TAG_DOUBLE = 4
const TAG_STRING = 5
const TAG_BYTES  = 6

// ---------------------------------------------------------------------------
// Special LOAD_VAR sentinel indices for comprehension variables
// ---------------------------------------------------------------------------

const IDX_ITER_ELEM = 0xFFFE  // current element (pushed by ITER_NEXT, DUP to read)
const IDX_ACCU      = 0xFFFF  // accumulator (managed by ACCUM_PUSH / ACCUM_SET)

// ---------------------------------------------------------------------------
// Map method names to BUILTIN ids
// ---------------------------------------------------------------------------

const METHOD_BUILTINS = {
  contains:   BUILTIN.STRING_CONTAINS,
  startsWith: BUILTIN.STRING_STARTS_WITH,
  endsWith:   BUILTIN.STRING_ENDS_WITH,
  matches:    BUILTIN.STRING_MATCHES,
  substring:  BUILTIN.STRING_SUBSTRING,
  indexOf:    BUILTIN.STRING_INDEX_OF,
  split:      BUILTIN.STRING_SPLIT,
  lowerAscii: BUILTIN.STRING_LOWER_ASCII,
  upperAscii: BUILTIN.STRING_UPPER_ASCII,
  trim:       BUILTIN.STRING_TRIM,
  replace:    BUILTIN.STRING_REPLACE,
  join:       BUILTIN.STRING_JOIN,
  charAt:     BUILTIN.STRING_CHAR_AT,
  lastIndexOf: BUILTIN.STRING_LAST_INDEX_OF,
  // Timestamp / duration methods
  getFullYear:    BUILTIN.GET_FULL_YEAR,
  getMonth:       BUILTIN.GET_MONTH,
  getDayOfMonth:  BUILTIN.GET_DAY,
  getDate:        BUILTIN.GET_DATE,
  getDayOfWeek:   BUILTIN.GET_DAY_OF_WEEK,
  getDayOfYear:   BUILTIN.GET_DAY_OF_YEAR,
  getMilliseconds: BUILTIN.GET_MILLISECONDS,
  getHours:       BUILTIN.GET_HOURS,
  getMinutes:     BUILTIN.GET_MINUTES,
  getSeconds:     BUILTIN.GET_SECONDS,
}

// ---------------------------------------------------------------------------
// Map global function names to BUILTIN ids
// ---------------------------------------------------------------------------

const CALL_BUILTINS = {
  int:       BUILTIN.TO_INT,
  uint:      BUILTIN.TO_UINT,
  double:    BUILTIN.TO_DOUBLE,
  string:    BUILTIN.TO_STRING,
  bool:      BUILTIN.TO_BOOL,
  bytes:     BUILTIN.TO_BYTES,
  type:      BUILTIN.TYPE_OF,
  timestamp: BUILTIN.TIMESTAMP,
  duration:  BUILTIN.DURATION,
  dyn:       BUILTIN.DYN,
}

// String namespace extensions (strings.quote, etc.)
const STRINGS_BUILTINS = {
  strings_quote: BUILTIN.STRINGS_QUOTE,
}

// Math extensions
const MATH_BUILTINS = {
  math_max: BUILTIN.MATH_MAX,
  math_min: BUILTIN.MATH_MIN,
  math_abs: BUILTIN.MATH_ABS,
  math_greatest: BUILTIN.MATH_GREATEST,
  math_least: BUILTIN.MATH_LEAST,
}

// ---------------------------------------------------------------------------
// CompileError
// ---------------------------------------------------------------------------

export class CompileError extends Error {
  constructor(msg) {
    super(msg)
    this.name = 'CompileError'
  }
}

// ---------------------------------------------------------------------------
// Compiler state helpers
// ---------------------------------------------------------------------------

/**
 * Collect all external variable names referenced in an AST, excluding
 * comprehension-bound variable names in `boundNames`.
 */
function collectVarNames(node, boundNames, out) {
  if (!node) return
  switch (node.type) {
    case 'Ident': {
      const { name } = node
      if (!boundNames.has(name) && name !== '__result__' && name !== '__unused__') {
        out.add(name)
      }
      break
    }
    case 'Comprehension': {
      // Collect vars from iterRange (uses outer scope)
      collectVarNames(node.iterRange, boundNames, out)
      // The iterVar and accuVar are bound inside the comprehension body
      const inner = new Set(boundNames)
      inner.add(node.iterVar)
      inner.add(node.accuVar)
      collectVarNames(node.accuInit,      inner, out)
      collectVarNames(node.loopCondition, inner, out)
      collectVarNames(node.loopStep,      inner, out)
      collectVarNames(node.result,        inner, out)
      break
    }
    case 'Binary':
      collectVarNames(node.left,  boundNames, out)
      collectVarNames(node.right, boundNames, out)
      break
    case 'Unary':
      collectVarNames(node.operand, boundNames, out)
      break
    case 'Ternary':
      collectVarNames(node.cond,  boundNames, out)
      collectVarNames(node.then,  boundNames, out)
      collectVarNames(node.else,  boundNames, out)
      break
    case 'Select':
    case 'OptSelect':
      collectVarNames(node.object, boundNames, out)
      break
    case 'Index':
      collectVarNames(node.object, boundNames, out)
      collectVarNames(node.index,  boundNames, out)
      break
    case 'Call':
      for (const a of node.args) collectVarNames(a, boundNames, out)
      break
    case 'RCall':
      collectVarNames(node.receiver, boundNames, out)
      for (const a of node.args) collectVarNames(a, boundNames, out)
      break
    case 'List':
      for (const e of node.elements) collectVarNames(e, boundNames, out)
      break
    case 'Map':
      for (const { key, value } of node.entries) {
        collectVarNames(key,   boundNames, out)
        collectVarNames(value, boundNames, out)
      }
      break
    case 'HasMacro':
      collectVarNames(node.expr, boundNames, out)
      break
    // Literals have no vars
    default: break
  }
}

// ---------------------------------------------------------------------------
// Main compile() function
// ---------------------------------------------------------------------------

/**
 * Compile a checked AST to a program object.
 *
 * @param {object} ast        - root node from check()
 * @param {object} [options]
 * @param {boolean} [options.debugInfo=false] - include source positions
 * @returns {{ consts, varTable, instrs, debugInfo }}
 */
export function compile(ast, options = {}) {
  const { debugInfo: emitDebug = false } = options

  // ── 1. Collect external variables ─────────────────────────────────────────
  const varNameSet = new Set()
  collectVarNames(ast, new Set(), varNameSet)
  const varTable = Array.from(varNameSet).sort()
  const varIndex = new Map(varTable.map((n, i) => [n, i]))

  // ── 2. Constant pool ───────────────────────────────────────────────────────
  const consts = []
  const constIndex = new Map()   // key → index (deduplication)

  function constKey(tag, value) {
    // Unique key for deduplication
    if (tag === TAG_NULL) return 'null'
    if (tag === TAG_BOOL) return `b:${value ? 1 : 0}`
    if (tag === TAG_INT64)  return `i:${value}`
    if (tag === TAG_UINT64) return `u:${value}`
    if (tag === TAG_DOUBLE) return `d:${value}`
    if (tag === TAG_STRING) return `s:${value}`
    if (tag === TAG_BYTES)  return null  // bytes are not deduplicated (rare)
    return null
  }

  function addConst(tag, value) {
    const k = constKey(tag, value)
    if (k !== null && constIndex.has(k)) return constIndex.get(k)
    const idx = consts.length
    consts.push({ tag, value })
    if (k !== null) constIndex.set(k, idx)
    return idx
  }

  // ── 3. Instruction list ────────────────────────────────────────────────────
  const instrs = []
  const debugEntries = []

  function emit(op, ...operands) {
    instrs.push({ op, operands })
    if (emitDebug) debugEntries.push({ line: 0, col: 0 })
    return instrs.length - 1  // instruction index
  }

  // Emit a placeholder jump and return its index for later patching
  function emitJump(op) {
    return emit(op, 0)
  }

  // Patch the operand of instruction at idx to be (targetIdx - (idx + 1))
  // i.e., relative to the instruction AFTER the jump
  function patchJump(idx, targetIdx) {
    instrs[idx].operands[0] = targetIdx - (idx + 1)
  }

  // ── 4. Compilation scope for comprehension variables ──────────────────────
  // compScope is a stack of Maps: name → {kind: 'iter'|'accu'}
  // When inside a comprehension, iterVar references use IDX_ITER_ELEM
  // and accuVar references use IDX_ACCU.
  const compScopeStack = []

  function lookupCompVar(name) {
    for (let i = compScopeStack.length - 1; i >= 0; i--) {
      const scope = compScopeStack[i]
      if (scope.has(name)) return scope.get(name)
    }
    return null
  }

  // ── 5. Core compile dispatcher ────────────────────────────────────────────

  function compileNode(node) {
    switch (node.type) {
      case 'NullLit': {
        const idx = addConst(TAG_NULL, null)
        emit(OP.PUSH_CONST, idx)
        break
      }

      case 'BoolLit': {
        const idx = addConst(TAG_BOOL, node.value)
        emit(OP.PUSH_CONST, idx)
        break
      }

      case 'IntLit': {
        const idx = addConst(TAG_INT64, node.value)
        emit(OP.PUSH_CONST, idx)
        break
      }

      case 'UintLit': {
        const idx = addConst(TAG_UINT64, node.value)
        emit(OP.PUSH_CONST, idx)
        break
      }

      case 'FloatLit': {
        const idx = addConst(TAG_DOUBLE, node.value)
        emit(OP.PUSH_CONST, idx)
        break
      }

      case 'StringLit': {
        const idx = addConst(TAG_STRING, node.value)
        emit(OP.PUSH_CONST, idx)
        break
      }

      case 'BytesLit': {
        const idx = addConst(TAG_BYTES, node.value)
        emit(OP.PUSH_CONST, idx)
        break
      }

      case 'Ident': {
        const { name } = node
        // Check comprehension scope first
        const comp = lookupCompVar(name)
        if (comp !== null) {
          if (comp.kind === 'iter') {
            emit(OP.LOAD_VAR, IDX_ITER_ELEM)
          } else {
            emit(OP.LOAD_VAR, IDX_ACCU)
          }
        } else {
          const idx = varIndex.get(name)
          if (idx === undefined) {
            throw new CompileError(`Unknown variable: '${name}'`)
          }
          emit(OP.LOAD_VAR, idx)
        }
        break
      }

      case 'Unary': {
        const { op, operand } = node
        if (op === '!') {
          // Constant fold: !BoolLit
          if (operand.type === 'BoolLit') {
            const idx = addConst(TAG_BOOL, !operand.value)
            emit(OP.PUSH_CONST, idx)
            break
          }
          compileNode(operand)
          emit(OP.NOT)
        } else if (op === '-') {
          // Constant fold: unary minus on literal (should be handled by parser, but just in case)
          if (operand.type === 'IntLit') {
            const idx = addConst(TAG_INT64, -operand.value)
            emit(OP.PUSH_CONST, idx)
            break
          }
          if (operand.type === 'FloatLit') {
            const idx = addConst(TAG_DOUBLE, -operand.value)
            emit(OP.PUSH_CONST, idx)
            break
          }
          compileNode(operand)
          emit(OP.NEG)
        } else {
          throw new CompileError(`Unknown unary op: '${op}'`)
        }
        break
      }

      case 'Binary': {
        compileBinary(node)
        break
      }

      case 'Ternary': {
        compileTernary(node)
        break
      }

      case 'Select': {
        compileNode(node.object)
        const nameIdx = addConst(TAG_STRING, node.field)
        emit(OP.SELECT, nameIdx)
        break
      }

      case 'OptSelect': {
        compileNode(node.object)
        const nameIdx = addConst(TAG_STRING, node.field)
        emit(OP.OPT_SELECT, nameIdx)
        break
      }

      case 'Index': {
        compileNode(node.object)
        compileNode(node.index)
        emit(OP.INDEX)
        break
      }

      case 'List': {
        const n = node.elements.length
        for (const elem of node.elements) compileNode(elem)
        emit(OP.BUILD_LIST, n)
        break
      }

      case 'Map': {
        const n = node.entries.length
        for (const { key, value } of node.entries) {
          compileNode(key)
          compileNode(value)
        }
        emit(OP.BUILD_MAP, n)
        break
      }

      case 'Call': {
        compileCall(node)
        break
      }

      case 'RCall': {
        compileRCall(node)
        break
      }

      case 'HasMacro': {
        // has(obj.field) — check field existence
        const select = node.expr  // Select node
        compileNode(select.object)
        const nameIdx = addConst(TAG_STRING, select.field)
        emit(OP.HAS_FIELD, nameIdx)
        break
      }

      case 'Comprehension': {
        compileComprehension(node)
        break
      }

      default:
        throw new CompileError(`Unknown AST node type: '${node.type}'`)
    }
  }

  // ── Binary expression compilation ─────────────────────────────────────────

  function compileBinary(node) {
    const { op, left, right } = node

    // Short-circuit: &&
    // Use JUMP_IF_FALSE_K (peek/keep) so 'false' stays on stack as result when jumping
    if (op === '&&') {
      compileNode(left)
      const jumpFalse = emitJump(OP.JUMP_IF_FALSE_K)
      // left was true (kept on stack by K variant), pop it and evaluate right
      emit(OP.POP)
      compileNode(right)
      patchJump(jumpFalse, instrs.length)
      return
    }

    // Short-circuit: ||
    // Use JUMP_IF_TRUE_K (peek/keep) so 'true' stays on stack as result when jumping
    if (op === '||') {
      compileNode(left)
      const jumpTrue = emitJump(OP.JUMP_IF_TRUE_K)
      // left was false (kept on stack by K variant), pop it and evaluate right
      emit(OP.POP)
      compileNode(right)
      patchJump(jumpTrue, instrs.length)
      return
    }

    // Constant folding for two numeric or bool literals
    const folded = tryFoldBinary(op, left, right)
    if (folded !== null) {
      emitFoldedConst(folded)
      return
    }

    // General binary: compile both operands then emit opcode
    compileNode(left)
    compileNode(right)
    emitBinaryOp(op)
  }

  function emitBinaryOp(op) {
    switch (op) {
      case '+':  emit(OP.ADD); break
      case '-':  emit(OP.SUB); break
      case '*':  emit(OP.MUL); break
      case '/':  emit(OP.DIV); break
      case '%':  emit(OP.MOD); break
      case '**': emit(OP.POW); break
      case '==': emit(OP.EQ);  break
      case '!=': emit(OP.NEQ); break
      case '<':  emit(OP.LT);  break
      case '<=': emit(OP.LE);  break
      case '>':  emit(OP.GT);  break
      case '>=': emit(OP.GE);  break
      case '^':  emit(OP.XOR); break
      case 'in': emit(OP.IN);  break
      default:
        throw new CompileError(`Unknown binary op: '${op}'`)
    }
  }

  // Try to fold two literal operands at compile time.
  // Returns a const-pool entry {tag, value} or null if not foldable.
  function tryFoldBinary(op, left, right) {
    // Both must be literals of compatible types
    const lv = litValue(left)
    const rv = litValue(right)
    if (lv === null || rv === null) return null

    // Only fold same-typed numerics (int op int, float op float) and comparisons/equality
    const lk = lv.tag
    const rk = rv.tag

    // Bool ops (== != only)
    if (lk === TAG_BOOL && rk === TAG_BOOL) {
      if (op === '==') return { tag: TAG_BOOL, value: lv.value === rv.value }
      if (op === '!=') return { tag: TAG_BOOL, value: lv.value !== rv.value }
      return null
    }

    // Null ops
    if (lk === TAG_NULL && rk === TAG_NULL) {
      if (op === '==') return { tag: TAG_BOOL, value: true }
      if (op === '!=') return { tag: TAG_BOOL, value: false }
      return null
    }

    // Int64 ops — defer to runtime if result overflows int64 range
    const INT64_MIN = -(2n ** 63n)
    const INT64_MAX = 2n ** 63n - 1n
    function foldInt(v) {
      if (v < INT64_MIN || v > INT64_MAX) return null  // overflow → defer to runtime
      return { tag: TAG_INT64, value: v }
    }

    if (lk === TAG_INT64 && rk === TAG_INT64) {
      const l = lv.value, r = rv.value
      switch (op) {
        case '+':  return foldInt(l + r)
        case '-':  return foldInt(l - r)
        case '*':  return foldInt(l * r)
        case '/': {
          if (r === 0n) return null // division by zero - let runtime handle
          return foldInt(l / r)
        }
        case '%': {
          if (r === 0n) return null
          return { tag: TAG_INT64, value: l % r }  // mod can't overflow if inputs are in range
        }
        case '**': return foldInt(l ** r)
        case '==': return { tag: TAG_BOOL, value: l === r }
        case '!=': return { tag: TAG_BOOL, value: l !== r }
        case '<':  return { tag: TAG_BOOL, value: l < r }
        case '<=': return { tag: TAG_BOOL, value: l <= r }
        case '>':  return { tag: TAG_BOOL, value: l > r }
        case '>=': return { tag: TAG_BOOL, value: l >= r }
        case '^':  return { tag: TAG_INT64, value: l ^ r }
        default:   return null
      }
    }

    // Double ops
    if (lk === TAG_DOUBLE && rk === TAG_DOUBLE) {
      const l = lv.value, r = rv.value
      switch (op) {
        case '+':  return { tag: TAG_DOUBLE, value: l + r }
        case '-':  return { tag: TAG_DOUBLE, value: l - r }
        case '*':  return { tag: TAG_DOUBLE, value: l * r }
        case '/':  return { tag: TAG_DOUBLE, value: l / r }
        case '**': return { tag: TAG_DOUBLE, value: Math.pow(l, r) }
        case '==': return { tag: TAG_BOOL, value: l === r }
        case '!=': return { tag: TAG_BOOL, value: l !== r }
        case '<':  return { tag: TAG_BOOL, value: l < r }
        case '<=': return { tag: TAG_BOOL, value: l <= r }
        case '>':  return { tag: TAG_BOOL, value: l > r }
        case '>=': return { tag: TAG_BOOL, value: l >= r }
        default:   return null
      }
    }

    // String equality
    if (lk === TAG_STRING && rk === TAG_STRING) {
      if (op === '==') return { tag: TAG_BOOL, value: lv.value === rv.value }
      if (op === '!=') return { tag: TAG_BOOL, value: lv.value !== rv.value }
      if (op === '<')  return { tag: TAG_BOOL, value: lv.value < rv.value }
      if (op === '<=') return { tag: TAG_BOOL, value: lv.value <= rv.value }
      if (op === '>')  return { tag: TAG_BOOL, value: lv.value > rv.value }
      if (op === '>=') return { tag: TAG_BOOL, value: lv.value >= rv.value }
      return null
    }

    return null
  }

  // Extract literal value from AST node (returns {tag, value} or null)
  function litValue(node) {
    switch (node.type) {
      case 'NullLit':   return { tag: TAG_NULL,   value: null }
      case 'BoolLit':   return { tag: TAG_BOOL,   value: node.value }
      case 'IntLit':    return { tag: TAG_INT64,  value: node.value }
      case 'UintLit':   return { tag: TAG_UINT64, value: node.value }
      case 'FloatLit':  return { tag: TAG_DOUBLE, value: node.value }
      case 'StringLit': return { tag: TAG_STRING, value: node.value }
      default:          return null
    }
  }

  function emitFoldedConst({ tag, value }) {
    const idx = addConst(tag, value)
    emit(OP.PUSH_CONST, idx)
  }

  // ── Ternary expression compilation ────────────────────────────────────────

  function compileTernary(node) {
    compileNode(node.cond)
    const jumpFalse = emitJump(OP.JUMP_IF_FALSE)
    compileNode(node.then)
    const jumpEnd = emitJump(OP.JUMP)
    patchJump(jumpFalse, instrs.length)
    compileNode(node.else)
    patchJump(jumpEnd, instrs.length)
  }

  // ── Global function call compilation ──────────────────────────────────────

  function compileCall(node) {
    const { name, args } = node

    // size(x) → SIZE opcode
    if (name === 'size' && args.length === 1) {
      compileNode(args[0])
      emit(OP.SIZE)
      return
    }

    // Built-in type conversions / type() / timestamp() / duration()
    const builtinId = CALL_BUILTINS[name]
    if (builtinId !== undefined) {
      for (const a of args) compileNode(a)
      emit(OP.CALL, builtinId, args.length)
      return
    }

    // Math extensions: math.max(), math.min(), math.abs()
    const mathId = MATH_BUILTINS[name]
    if (mathId !== undefined) {
      for (const a of args) compileNode(a)
      emit(OP.CALL, mathId, args.length)
      return
    }

    throw new CompileError(`Unknown function: '${name}'`)
  }

  // ── Method call compilation ────────────────────────────────────────────────

  function compileRCall(node) {
    const { receiver, method, args } = node

    // size() as method: list.size() / string.size() / map.size()
    if (method === 'size' && args.length === 0) {
      compileNode(receiver)
      emit(OP.SIZE)
      return
    }

    // optional.none() — push OPT_NONE
    if (
      method === 'none' &&
      args.length === 0 &&
      receiver.type === 'Ident' &&
      receiver.name === 'optional'
    ) {
      emit(OP.OPT_NONE)
      return
    }

    // optional.of(v)
    if (
      method === 'of' &&
      args.length === 1 &&
      receiver.type === 'Ident' &&
      receiver.name === 'optional'
    ) {
      compileNode(args[0])
      emit(OP.OPT_OF)
      return
    }

    // optional.ofNonZero(v) — same as optional.of for our purposes
    if (
      method === 'ofNonZero' &&
      args.length === 1 &&
      receiver.type === 'Ident' &&
      receiver.name === 'optional'
    ) {
      compileNode(args[0])
      emit(OP.OPT_OF)
      return
    }

    // x.orValue(default) — optional unwrap
    if (method === 'orValue' && args.length === 1) {
      compileNode(receiver)
      compileNode(args[0])
      emit(OP.OPT_OR_VALUE)
      return
    }

    // math.max(a, b) / math.min(a, b) / math.abs(x) as method calls on math namespace
    if (receiver.type === 'Ident' && receiver.name === 'math') {
      const mathId = MATH_BUILTINS[`math_${method}`]
      if (mathId !== undefined) {
        for (const a of args) compileNode(a)
        emit(OP.CALL, mathId, args.length)
        return
      }
    }

    // strings.quote(x) as method call on strings namespace
    if (receiver.type === 'Ident' && receiver.name === 'strings') {
      const strId = STRINGS_BUILTINS[`strings_${method}`]
      if (strId !== undefined) {
        for (const a of args) compileNode(a)
        emit(OP.CALL, strId, args.length)
        return
      }
    }

    // String methods and others
    const builtinId = METHOD_BUILTINS[method]
    if (builtinId !== undefined) {
      compileNode(receiver)
      for (const a of args) compileNode(a)
      emit(OP.CALL, builtinId, args.length + 1)
      return
    }

    throw new CompileError(`Unknown method: '${method}'`)
  }

  // ── Comprehension compilation ──────────────────────────────────────────────
  //
  // Stack layout during iteration:
  //   [ ... | iterator | accumulator ]  ← accuVar = IDX_ACCU (managed by ACCUM_PUSH/ACCUM_SET)
  //   After ITER_NEXT pushes element:
  //   [ ... | iterator | accumulator | element ]  ← iterVar = IDX_ITER_ELEM (TOS)
  //
  // IDX_ITER_ELEM compiles as DUP (non-destructive peek at TOS)
  // IDX_ACCU compiles as "load accumulator" in VM (separate register)
  //
  // Loop pattern:
  //   compile(iterRange)
  //   ITER_INIT
  //   ACCUM_PUSH  accuInit_const   OR  compile(accuInit) + ACCUM_PUSH_STACK variant
  //   loop_start:
  //   ITER_NEXT   done_offset
  //   compile(loopCondition)   [iterVar = TOS-1 via DUP, accuVar = ACCU]
  //   JUMP_IF_FALSE  exit_loop  [early-exit if condition false]
  //   POP                       [discard loopCondition result]
  //   compile(loopStep)         [push new accumulator value]
  //   ACCUM_SET                 [update accumulator, pop new value and element]
  //   POP                       [discard element from ITER_NEXT]
  //   JUMP   loop_start
  //   exit_loop:
  //   POP                       [discard element]
  //   done:
  //   ITER_POP                  [discard iterator]
  //   compile(result)           [accuVar = ACCU]
  //
  // Note: ACCUM_PUSH takes a const index operand OR we can compile accuInit
  //       and use a special form. For non-const accuInit (e.g. List([])),
  //       we need an ACCUM_PUSH_STACK variant. Since ACCUM_PUSH only takes
  //       a const index, we add the accuInit to consts if it's a list/map.
  //       For simple cases (BoolLit, IntLit), it IS a const.
  //       For List([]) → we add a const entry for empty list? Not supported
  //       in the const pool (no list tag).
  //
  //       Solution: if accuInit is not a simple const-pool-able literal,
  //       compile it first, then the VM's ACCUM_PUSH handles TOS as the
  //       initial value. We use ACCUM_PUSH with operand 0xFFFF to mean
  //       "pop TOS and use as initial accumulator".
  //
  //       Wait — bytecode.js says ACCUM_PUSH has u16 operand = init_idx.
  //       Let's use 0xFFFF as sentinel meaning "use TOS".

  const ACCUM_PUSH_FROM_STACK = 0xFFFF

  // Check if an AST subtree directly references a given identifier name
  // (only at the top level of Ident nodes that are bound to this comprehension scope).
  function subtreeReferencesIdent(node, name) {
    if (!node) return false
    switch (node.type) {
      case 'Ident': return node.name === name
      case 'Binary': return subtreeReferencesIdent(node.left, name) || subtreeReferencesIdent(node.right, name)
      case 'Unary': return subtreeReferencesIdent(node.operand, name)
      case 'Ternary':
        return subtreeReferencesIdent(node.cond, name) ||
               subtreeReferencesIdent(node.then, name) ||
               subtreeReferencesIdent(node.else, name)
      case 'Select':
      case 'OptSelect': return subtreeReferencesIdent(node.object, name)
      case 'Index': return subtreeReferencesIdent(node.object, name) || subtreeReferencesIdent(node.index, name)
      case 'Call': return node.args.some(a => subtreeReferencesIdent(a, name))
      case 'RCall':
        return subtreeReferencesIdent(node.receiver, name) ||
               node.args.some(a => subtreeReferencesIdent(a, name))
      case 'List': return node.elements.some(e => subtreeReferencesIdent(e, name))
      case 'Map': return node.entries.some(({key, value}) =>
        subtreeReferencesIdent(key, name) || subtreeReferencesIdent(value, name))
      case 'HasMacro': return subtreeReferencesIdent(node.expr, name)
      case 'Comprehension':
        // Don't descend into nested comprehensions that rebind the same name
        if (node.iterVar === name || node.accuVar === name) return false
        return subtreeReferencesIdent(node.result, name) ||
               subtreeReferencesIdent(node.loopCondition, name) ||
               subtreeReferencesIdent(node.loopStep, name) ||
               subtreeReferencesIdent(node.iterRange, name) ||
               subtreeReferencesIdent(node.accuInit, name)
      default: return false
    }
  }

  function compileComprehension(node) {
    const { iterVar, iterRange, accuVar, accuInit, loopCondition, loopStep, result } = node

    // Detect if iterVar is used in the result expression.
    // If so, we must save the element to the accumulator on early exit and when
    // the loop completes normally, so that result can access it via IDX_ACCU.
    // This is needed for cel.bind(x, val, body) where body references x.
    const iterVarInResult = iterVar !== accuVar && subtreeReferencesIdent(result, iterVar)

    // Push comprehension scope
    const scope = new Map()
    // iterVar binds first (as 'iter' kind = IDX_ITER_ELEM during loop body)
    scope.set(iterVar, { kind: 'iter' })
    // accuVar binds second (as 'accu' kind = IDX_ACCU)
    // If iterVar === accuVar, this overwrites to 'accu' which is fine
    // (same name, same VM slot effectively)
    scope.set(accuVar, { kind: 'accu' })
    compScopeStack.push(scope)

    // 1. Compile the range
    compileNode(iterRange)
    emit(OP.ITER_INIT)

    // 2. Set up accumulator
    const accuConstIdx = tryGetConstIdx(accuInit)
    if (accuConstIdx !== null) {
      emit(OP.ACCUM_PUSH, accuConstIdx)
    } else {
      // Compile accuInit (e.g. List([])), then use ACCUM_PUSH with sentinel
      compileNode(accuInit)
      emit(OP.ACCUM_PUSH, ACCUM_PUSH_FROM_STACK)
    }

    // 3. Loop start
    const loopStart = instrs.length

    // 4. ITER_NEXT — jump to done if exhausted
    const iterNext = emitJump(OP.ITER_NEXT)  // operand will be patched

    // 5. Compile loop condition
    // Use JUMP_IF_FALSE_K (peek/keep): keeps condition on stack so the fall-through
    // POP can discard it cleanly, and the early-exit path knows to pop it too.
    compileNode(loopCondition)
    const jumpExitEarly = emitJump(OP.JUMP_IF_FALSE_K)
    // condition was true — K variant kept it on stack; discard it now
    emit(OP.POP)
    // stack is now: [iter, elem]

    // 6. Compile loop step (produces new accumulator value)
    compileNode(loopStep)
    // stack: [iter, elem, new_accu]

    // 7. Update accumulator and pop element
    emit(OP.ACCUM_SET)  // pops new_accu into accu register; stack: [iter, elem]
    emit(OP.POP)        // discard elem; stack: [iter]

    // 8. Jump back to loop start
    const jumpBack = emitJump(OP.JUMP)
    patchJump(jumpBack, loopStart)

    // 9. Exit early path: condition was false
    //    K variant kept 'false' on stack: [iter, elem, false]
    patchJump(jumpExitEarly, instrs.length)
    emit(OP.POP)  // discard the kept 'false'; stack: [iter, elem]
    if (iterVarInResult) {
      // Save element to accumulator so result can access it via IDX_ACCU
      emit(OP.ACCUM_SET)  // pops elem, saves to accumulator; stack: [iter]
    } else {
      emit(OP.POP)  // discard elem; stack: [iter]
    }

    // 10. Done label — patch ITER_NEXT jump here (iterator exhausted)
    patchJump(iterNext, instrs.length)

    // 11. Pop iterator
    emit(OP.ITER_POP)

    // 12. For result, if iterVar is used there, remap it to 'accu'
    if (iterVarInResult) {
      scope.set(iterVar, { kind: 'accu' })
    }

    // 13. Compile result expression
    compileNode(result)

    // Pop comprehension scope
    compScopeStack.pop()
  }

  // Try to get a const pool index for a simple literal node.
  // Returns index or null if not directly const-pool-able.
  function tryGetConstIdx(node) {
    switch (node.type) {
      case 'NullLit':   return addConst(TAG_NULL,   null)
      case 'BoolLit':   return addConst(TAG_BOOL,   node.value)
      case 'IntLit':    return addConst(TAG_INT64,  node.value)
      case 'UintLit':   return addConst(TAG_UINT64, node.value)
      case 'FloatLit':  return addConst(TAG_DOUBLE, node.value)
      case 'StringLit': return addConst(TAG_STRING, node.value)
      default:          return null
    }
  }

  // ── 6. Compile root node + emit RETURN ────────────────────────────────────

  compileNode(ast)
  emit(OP.RETURN)

  return {
    consts,
    varTable,
    instrs,
    debugInfo: emitDebug ? debugEntries : null,
  }
}
