// CEL Checker — macro expansion and validation pass
//
// Input:  plain-object AST produced by src/parser.js
// Output: transformed AST with macros expanded (or throws CheckError)

export class CheckError extends Error {
  constructor(msg) {
    super(msg)
    this.name = 'CheckError'
  }
}

// ---------------------------------------------------------------------------
// Reserved identifiers — rejected in expression position
// (The parser already rejects these; the checker re-validates post-expansion
//  in case a macro result introduces one, and for defence-in-depth.)
// ---------------------------------------------------------------------------

const RESERVED = new Set(['if', 'else', 'for', 'var', 'package', 'as', 'import'])

// ---------------------------------------------------------------------------
// Dangerous field names — rejected in Select / OptSelect / HasField
// ---------------------------------------------------------------------------

const DANGEROUS_FIELDS = new Set(['__proto__', 'constructor', 'prototype'])

// ---------------------------------------------------------------------------
// AST node helpers (produce plain objects matching the shapes from parser.js)
// ---------------------------------------------------------------------------

function BoolLit(value)   { return { type: 'BoolLit', value } }
function IntLit(value)    { return { type: 'IntLit', value } }         // value is BigInt
function List(elements)   { return { type: 'List', elements } }
function Ident(name)      { return { type: 'Ident', name } }
function Binary(op, left, right) { return { type: 'Binary', op, left, right } }
function Unary(op, operand)      { return { type: 'Unary', op, operand } }
function Ternary(cond, thenNode, elseNode) {
  return { type: 'Ternary', cond, then: thenNode, else: elseNode }
}

// ---------------------------------------------------------------------------
// Comprehension builders
// ---------------------------------------------------------------------------

function makeComprehension(iterVar, iterRange, accuVar, accuInit, loopCondition, loopStep, result) {
  return {
    type: 'Comprehension',
    iterVar,
    iterRange,
    accuVar,
    accuInit,
    loopCondition,
    loopStep,
    result,
  }
}

// ---------------------------------------------------------------------------
// Macro expansion helpers
// ---------------------------------------------------------------------------

function expandExists(iterRange, iterVar, pred) {
  return makeComprehension(
    iterVar,
    iterRange,
    '__result__',
    BoolLit(false),
    Unary('!', Ident('__result__')),              // keep looping while not found
    Binary('||', Ident('__result__'), pred),       // OR into accumulator
    Ident('__result__'),
  )
}

function expandAll(iterRange, iterVar, pred) {
  return makeComprehension(
    iterVar,
    iterRange,
    '__result__',
    BoolLit(true),
    Ident('__result__'),                          // keep looping while all true
    Binary('&&', Ident('__result__'), pred),      // AND into accumulator
    Ident('__result__'),
  )
}

function expandFilter(iterRange, iterVar, pred) {
  return makeComprehension(
    iterVar,
    iterRange,
    '__result__',
    List([]),
    BoolLit(true),                               // never early-exit
    Ternary(
      pred,
      Binary('+', Ident('__result__'), List([Ident(iterVar)])),
      Ident('__result__'),
    ),
    Ident('__result__'),
  )
}

function expandMap(iterRange, iterVar, f) {
  return makeComprehension(
    iterVar,
    iterRange,
    '__result__',
    List([]),
    BoolLit(true),                               // never early-exit
    Binary('+', Ident('__result__'), List([f])),
    Ident('__result__'),
  )
}

function expandExistsOne(iterRange, iterVar, pred) {
  return makeComprehension(
    iterVar,
    iterRange,
    '__result__',
    IntLit(0n),
    BoolLit(true),                               // never early-exit
    Ternary(
      pred,
      Binary('+', Ident('__result__'), IntLit(1n)),
      Ident('__result__'),
    ),
    Binary('==', Ident('__result__'), IntLit(1n)),
  )
}

function expandBind(iterVar, val, body) {
  return makeComprehension(
    iterVar,
    List([val]),
    '__unused__',
    BoolLit(false),
    BoolLit(false),                              // exit immediately
    BoolLit(false),
    body,
  )
}

// ---------------------------------------------------------------------------
// Macro detection
// ---------------------------------------------------------------------------

// Comprehension macros that look like: receiver.method(iterVar, expr)
const COMPREHENSION_MACROS = new Set(['exists', 'all', 'filter', 'map', 'exists_one'])

/**
 * Try to expand an RCall node as a macro.
 * Returns the expanded node, or null if it is not a macro.
 */
function tryExpandRCallMacro(node) {
  const { receiver, method, args } = node

  // cel.bind(x, val, body)
  if (
    method === 'bind' &&
    receiver.type === 'Ident' && receiver.name === 'cel' &&
    args.length === 3 &&
    args[0].type === 'Ident'
  ) {
    const [iterVarNode, val, body] = args
    return expandBind(iterVarNode.name, val, body)
  }

  // list.exists(x, pred) / all / filter / map / exists_one
  if (COMPREHENSION_MACROS.has(method)) {
    if (args.length < 2) {
      throw new CheckError(
        `macro '${method}' requires at least 2 arguments (iterVar, expr)`
      )
    }
    const iterVarNode = args[0]
    if (iterVarNode.type !== 'Ident') {
      throw new CheckError(
        `first argument to macro '${method}' must be an identifier (loop variable)`
      )
    }
    const iterVar = iterVarNode.name
    const iterRange = receiver
    const expr = args[1]

    switch (method) {
      case 'exists':     return expandExists(iterRange, iterVar, expr)
      case 'all':        return expandAll(iterRange, iterVar, expr)
      case 'filter':     return expandFilter(iterRange, iterVar, expr)
      case 'map':        return expandMap(iterRange, iterVar, expr)
      case 'exists_one': return expandExistsOne(iterRange, iterVar, expr)
    }
  }

  return null
}

/**
 * Try to expand a Call node as a macro.
 * Returns the expanded node, or null if it is not a macro.
 */
function tryExpandCallMacro(node) {
  const { name, args } = node

  // has(obj.field)
  if (name === 'has') {
    if (args.length !== 1) {
      throw new CheckError(`'has' macro requires exactly 1 argument, got ${args.length}`)
    }
    const arg = args[0]
    if (arg.type !== 'Select') {
      throw new CheckError(
        `argument to 'has' must be a field selection expression (e.g. has(obj.field))`
      )
    }
    // Check the field name for security
    if (DANGEROUS_FIELDS.has(arg.field)) {
      throw new CheckError(`field name '${arg.field}' is not allowed`)
    }
    return { type: 'HasMacro', expr: arg }
  }

  return null
}

// ---------------------------------------------------------------------------
// Security check for field names in Select / OptSelect
// ---------------------------------------------------------------------------

function checkFieldName(field) {
  if (DANGEROUS_FIELDS.has(field)) {
    throw new CheckError(`field name '${field}' is not allowed`)
  }
}

// ---------------------------------------------------------------------------
// Main recursive walk
// ---------------------------------------------------------------------------

/**
 * Walk the AST, expand macros, and validate.
 * Returns a new (or mutated) AST node.
 *
 * @param {object} node  - AST node from parser
 * @returns {object}     - transformed AST node
 */
function walkNode(node) {
  if (node === null || node === undefined) return node

  switch (node.type) {
    // ── Literals — no children, pass through ───────────────────────────────
    case 'IntLit':
    case 'UintLit':
    case 'FloatLit':
    case 'StringLit':
    case 'BytesLit':
    case 'BoolLit':
    case 'NullLit':
      return node

    // ── Identifier — check for reserved words ──────────────────────────────
    case 'Ident': {
      if (RESERVED.has(node.name)) {
        throw new CheckError(`'${node.name}' is a reserved word and cannot be used as an identifier`)
      }
      return node
    }

    // ── Unary ──────────────────────────────────────────────────────────────
    case 'Unary': {
      const operand = walkNode(node.operand)
      return operand === node.operand ? node : { ...node, operand }
    }

    // ── Binary ─────────────────────────────────────────────────────────────
    case 'Binary': {
      const left = walkNode(node.left)
      const right = walkNode(node.right)
      if (left === node.left && right === node.right) return node
      return { ...node, left, right }
    }

    // ── Ternary ────────────────────────────────────────────────────────────
    case 'Ternary': {
      const cond = walkNode(node.cond)
      const then = walkNode(node.then)
      const else_ = walkNode(node.else)
      if (cond === node.cond && then === node.then && else_ === node.else) return node
      return { ...node, cond, then, else: else_ }
    }

    // ── Select — security check + recurse ──────────────────────────────────
    case 'Select': {
      checkFieldName(node.field)
      const object = walkNode(node.object)
      return object === node.object ? node : { ...node, object }
    }

    // ── OptSelect — security check + recurse ───────────────────────────────
    case 'OptSelect': {
      checkFieldName(node.field)
      const object = walkNode(node.object)
      return object === node.object ? node : { ...node, object }
    }

    // ── Index ──────────────────────────────────────────────────────────────
    case 'Index': {
      const object = walkNode(node.object)
      const index = walkNode(node.index)
      if (object === node.object && index === node.index) return node
      return { ...node, object, index }
    }

    // ── Call (global function) — check for has() macro ─────────────────────
    case 'Call': {
      const expanded = tryExpandCallMacro(node)
      if (expanded !== null) {
        // Re-walk the expansion in case it contains nested macros
        return walkNode(expanded)
      }
      // Regular function call — walk arguments
      const args = walkNodeArray(node.args)
      return args === node.args ? node : { ...node, args }
    }

    // ── RCall (method call) — check for comprehension macros ───────────────
    case 'RCall': {
      // First expand receiver so nested macros are resolved before we check method
      const receiver = walkNode(node.receiver)

      const nodeWithWalkedReceiver = receiver === node.receiver
        ? node
        : { ...node, receiver }

      const expanded = tryExpandRCallMacro(nodeWithWalkedReceiver)
      if (expanded !== null) {
        // Re-walk the expansion in case it contains nested macros or sub-expressions
        // that were already expanded. Arguments in the macro template are fresh
        // synthetic nodes but the user-supplied sub-expressions (pred / f / val / body)
        // still need to be walked.
        return walkNode(expanded)
      }

      // Not a macro — walk arguments
      const args = walkNodeArray(nodeWithWalkedReceiver.args)
      return args === nodeWithWalkedReceiver.args
        ? nodeWithWalkedReceiver
        : { ...nodeWithWalkedReceiver, args }
    }

    // ── List ───────────────────────────────────────────────────────────────
    case 'List': {
      const elements = walkNodeArray(node.elements)
      return elements === node.elements ? node : { ...node, elements }
    }

    // ── Map ────────────────────────────────────────────────────────────────
    case 'Map': {
      const entries = node.entries.map(entry => {
        const key = walkNode(entry.key)
        const value = walkNode(entry.value)
        if (key === entry.key && value === entry.value) return entry
        return { key, value }
      })
      const changed = entries.some((e, i) => e !== node.entries[i])
      return changed ? { ...node, entries } : node
    }

    // ── HasMacro — walk the inner Select expr ──────────────────────────────
    case 'HasMacro': {
      const expr = walkNode(node.expr)
      return expr === node.expr ? node : { ...node, expr }
    }

    // ── Comprehension — walk all sub-nodes ─────────────────────────────────
    case 'Comprehension': {
      const iterRange    = walkNode(node.iterRange)
      const accuInit     = walkNode(node.accuInit)
      const loopCondition = walkNode(node.loopCondition)
      const loopStep     = walkNode(node.loopStep)
      const result       = walkNode(node.result)
      if (
        iterRange    === node.iterRange &&
        accuInit     === node.accuInit &&
        loopCondition === node.loopCondition &&
        loopStep     === node.loopStep &&
        result       === node.result
      ) return node
      return { ...node, iterRange, accuInit, loopCondition, loopStep, result }
    }

    default:
      throw new CheckError(`Unknown AST node type: '${node.type}'`)
  }
}

/**
 * Walk an array of AST nodes, returning the same array reference if unchanged.
 */
function walkNodeArray(nodes) {
  let changed = false
  const result = nodes.map(n => {
    const walked = walkNode(n)
    if (walked !== n) changed = true
    return walked
  })
  return changed ? result : nodes
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the checker/macro-expansion pass on an AST.
 *
 * @param {object} ast  - root AST node from parse()
 * @returns {object}    - transformed AST (macros expanded, validated)
 * @throws {CheckError} - on invalid usage
 */
export function check(ast) {
  return walkNode(ast)
}
