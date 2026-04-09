// CEL Parser — recursive-descent, returns plain-object AST nodes

import { TT } from './lexer.js'

export class ParseError extends Error {
  constructor(msg, line, col) {
    super(`ParseError at ${line}:${col}: ${msg}`)
    this.line = line
    this.col = col
  }
}

// Reserved words rejected as standalone identifiers (but allowed as map keys)
const RESERVED = new Set(['if', 'else', 'for', 'var', 'package', 'as', 'import'])

/**
 * Parse an array of tokens from tokenize() and return the AST root node.
 * @param {Array} tokens  — token array produced by tokenize()
 * @param {object} [limits] — optional structural limits
 * @param {number} [limits.maxAstNodes]      — max AST nodes allowed
 * @param {number} [limits.maxDepth]         — max nesting depth
 * @param {number} [limits.maxListElements]  — max elements in a list literal
 * @param {number} [limits.maxMapEntries]    — max entries in a map literal
 * @param {number} [limits.maxCallArguments] — max arguments to a function call
 * @returns {object}      — AST root node
 */
export function parse(tokens, limits) {
  let pos = 0
  let nodeCount = 0
  let depth = 0

  const maxNodes = limits && limits.maxAstNodes != null ? limits.maxAstNodes : Infinity
  const maxDepth = limits && limits.maxDepth != null ? limits.maxDepth : Infinity
  const maxListEl = limits && limits.maxListElements != null ? limits.maxListElements : Infinity
  const maxMapEnt = limits && limits.maxMapEntries != null ? limits.maxMapEntries : Infinity
  const maxCallArgs = limits && limits.maxCallArguments != null ? limits.maxCallArguments : Infinity

  function countNode(node) {
    if (++nodeCount > maxNodes) {
      const tok = tokens[pos] || tokens[tokens.length - 1]
      throw new ParseError(`AST node limit exceeded (max ${maxNodes})`, tok.line, tok.col)
    }
    return node
  }

  function enterDepth() {
    if (++depth > maxDepth) {
      const tok = tokens[pos] || tokens[tokens.length - 1]
      throw new ParseError(`expression depth limit exceeded (max ${maxDepth})`, tok.line, tok.col)
    }
  }

  function leaveDepth() { depth-- }

  function cur()  { return tokens[pos] }
  function check(type) { return tokens[pos].type === type }

  function advance() {
    const tok = tokens[pos]
    if (tok.type !== TT.EOF) pos++
    return tok
  }

  function match(...types) {
    for (const t of types) {
      if (tokens[pos].type === t) return advance()
    }
    return null
  }

  function expect(type, msg) {
    const tok = tokens[pos]
    if (tok.type !== type) {
      throw new ParseError(
        msg || `expected ${type} but got ${tok.type}`,
        tok.line, tok.col
      )
    }
    return advance()
  }

  function err(msg, tok) {
    tok = tok || tokens[pos]
    throw new ParseError(msg, tok.line, tok.col)
  }

  // ── Expression (top level) ───────────────────────────────────────────────

  function parseExpression() {
    return parseTernary()
  }

  // ── Ternary: cond ? then : else ──────────────────────────────────────────

  function parseTernary() {
    let node = parseOr()
    if (match(TT.QUESTION)) {
      const thenNode = parseExpression()
      expect(TT.COLON, "expected ':' in ternary expression")
      const elseNode = parseExpression()
      node = countNode({ type: 'Ternary', cond: node, then: thenNode, else: elseNode })
    }
    return node
  }

  // ── Logical OR: || ───────────────────────────────────────────────────────

  function parseOr() {
    let node = parseAnd()
    while (check(TT.OR)) {
      advance()
      const right = parseAnd()
      node = countNode({ type: 'Binary', op: '||', left: node, right })
    }
    return node
  }

  // ── Logical AND: && ──────────────────────────────────────────────────────

  function parseAnd() {
    let node = parseEquality()
    while (check(TT.AND)) {
      advance()
      const right = parseEquality()
      node = countNode({ type: 'Binary', op: '&&', left: node, right })
    }
    return node
  }

  // ── Equality: == != ──────────────────────────────────────────────────────

  function parseEquality() {
    let node = parseRelational()
    while (check(TT.EQ) || check(TT.NEQ)) {
      const op = advance().type === TT.EQ ? '==' : '!='
      const right = parseRelational()
      node = countNode({ type: 'Binary', op, left: node, right })
    }
    return node
  }

  // ── Relational: < <= > >= in ─────────────────────────────────────────────

  function parseRelational() {
    let node = parseAdditive()
    while (
      check(TT.LT) || check(TT.LE) || check(TT.GT) || check(TT.GE) || check(TT.IN)
    ) {
      const tok = advance()
      let op
      switch (tok.type) {
        case TT.LT: op = '<';  break
        case TT.LE: op = '<='; break
        case TT.GT: op = '>';  break
        case TT.GE: op = '>='; break
        case TT.IN: op = 'in'; break
      }
      const right = parseAdditive()
      node = countNode({ type: 'Binary', op, left: node, right })
    }
    return node
  }

  // ── Additive: + - ────────────────────────────────────────────────────────

  function parseAdditive() {
    let node = parseMultiplicative()
    while (check(TT.PLUS) || check(TT.MINUS)) {
      const op = advance().type === TT.PLUS ? '+' : '-'
      const right = parseMultiplicative()
      node = countNode({ type: 'Binary', op, left: node, right })
    }
    return node
  }

  // ── Multiplicative: * / % and bitwise XOR ^ ─────────────────────────────
  // CEL does not formally place ^ in the precedence table; treat it at the
  // same level as * / % (higher than additive, lower than power/unary).

  function parseMultiplicative() {
    let node = parsePower()
    while (check(TT.STAR) || check(TT.SLASH) || check(TT.PERCENT) || check(TT.CARET)) {
      const tok = advance()
      let op
      switch (tok.type) {
        case TT.STAR:    op = '*'; break
        case TT.SLASH:   op = '/'; break
        case TT.PERCENT: op = '%'; break
        case TT.CARET:   op = '^'; break
      }
      const right = parsePower()
      node = countNode({ type: 'Binary', op, left: node, right })
    }
    return node
  }

  // ── Power: ** (right-associative) ────────────────────────────────────────

  function parsePower() {
    const node = parseUnary()
    if (check(TT.POWER)) {
      advance()
      // Right-associative: right side is another parsePower call
      const right = parsePower()
      return countNode({ type: 'Binary', op: '**', left: node, right })
    }
    return node
  }

  // ── Unary: - ! ───────────────────────────────────────────────────────────

  function parseUnary() {
    if (check(TT.MINUS)) {
      const tok = advance()
      const operand = parseUnary()
      // Fold unary minus directly into numeric literals
      if (operand.type === 'IntLit')   return countNode({ type: 'IntLit',   value: -operand.value })
      if (operand.type === 'FloatLit') return countNode({ type: 'FloatLit', value: -operand.value })
      return countNode({ type: 'Unary', op: '-', operand })
    }
    if (check(TT.NOT)) {
      advance()
      const operand = parseUnary()
      return countNode({ type: 'Unary', op: '!', operand })
    }
    return parseMember()
  }

  // ── Member access: .field  ?.field  [idx]  .method(args) ─────────────────

  function parseMember() {
    let node = parsePrimary()

    while (true) {
      if (check(TT.DOT)) {
        // Regular dot access
        advance()
        const nameTok = tokens[pos]
        // Field names may be keywords (in, null, true, false) or identifiers
        if (
          nameTok.type !== TT.IDENT &&
          nameTok.type !== TT.TRUE  &&
          nameTok.type !== TT.FALSE &&
          nameTok.type !== TT.NULL  &&
          nameTok.type !== TT.IN
        ) {
          err(`expected field name after '.'`, nameTok)
        }
        const fieldName = String(nameTok.value)
        advance()

        if (check(TT.LPAREN)) {
          // Method call: receiver.method(args)
          advance()
          const args = parseArgList()
          expect(TT.RPAREN, "expected ')' after method arguments")
          node = countNode({ type: 'RCall', receiver: node, method: fieldName, args })
        } else {
          node = countNode({ type: 'Select', object: node, field: fieldName })
        }

      } else if (check(TT.OPT_DOT)) {
        // Optional chaining: ?.field  or  ?.method(args)
        advance()
        const nameTok = tokens[pos]
        if (nameTok.type !== TT.IDENT) {
          err(`expected field name after '?.'`, nameTok)
        }
        const fieldName = nameTok.value
        advance()

        if (check(TT.LPAREN)) {
          // Optional method call: receiver?.method(args)
          // Model as RCall whose receiver is an OptSelect node
          advance()
          const args = parseArgList()
          expect(TT.RPAREN, "expected ')' after method arguments")
          node = countNode({ type: 'RCall', receiver: countNode({ type: 'OptSelect', object: node, field: fieldName }), method: fieldName, args })
        } else {
          node = countNode({ type: 'OptSelect', object: node, field: fieldName })
        }

      } else if (check(TT.LBRACKET)) {
        // Index access: obj[expr] or optional index: obj[?expr]
        advance()
        if (check(TT.QUESTION)) {
          advance()
          const index = parseExpression()
          expect(TT.RBRACKET, "expected ']' after optional index expression")
          node = countNode({ type: 'OptIndex', object: node, index })
        } else {
          const index = parseExpression()
          expect(TT.RBRACKET, "expected ']' after index expression")
          node = countNode({ type: 'Index', object: node, index })
        }

      } else {
        break
      }
    }

    return node
  }

  // ── Comma-separated argument list (caller already consumed '(') ───────────

  function parseArgList() {
    const args = []
    if (!check(TT.RPAREN)) {
      args.push(parseExpression())
      while (match(TT.COMMA)) {
        if (check(TT.RPAREN)) break  // allow trailing comma
        args.push(parseExpression())
      }
    }
    if (args.length > maxCallArgs) {
      const tok = tokens[pos] || tokens[tokens.length - 1]
      throw new ParseError(`call argument limit exceeded (${args.length} > max ${maxCallArgs})`, tok.line, tok.col)
    }
    return args
  }

  // ── Primary expressions ───────────────────────────────────────────────────

  function parsePrimary() {
    const tok = tokens[pos]

    switch (tok.type) {
      // Integer literal
      case TT.INT: {
        advance()
        return countNode({ type: 'IntLit', value: tok.value })
      }

      // Unsigned integer literal
      case TT.UINT: {
        advance()
        return countNode({ type: 'UintLit', value: tok.value })
      }

      // Float literal
      case TT.FLOAT: {
        advance()
        return countNode({ type: 'FloatLit', value: tok.value })
      }

      // String literal (regular or raw — escape decoding already done by lexer)
      case TT.STRING:
      case TT.RAW_STRING: {
        advance()
        return countNode({ type: 'StringLit', value: tok.value })
      }

      // Bytes literal
      case TT.BYTES: {
        advance()
        return countNode({ type: 'BytesLit', value: tok.value })
      }

      // Boolean literals
      case TT.TRUE: {
        advance()
        return countNode({ type: 'BoolLit', value: true })
      }
      case TT.FALSE: {
        advance()
        return countNode({ type: 'BoolLit', value: false })
      }

      // Null literal
      case TT.NULL: {
        advance()
        return countNode({ type: 'NullLit' })
      }

      // Identifier or global function call
      case TT.IDENT: {
        advance()
        const name = tok.value
        if (RESERVED.has(name)) {
          err(`'${name}' is a reserved word and cannot be used as an identifier`, tok)
        }
        if (check(TT.LPAREN)) {
          // Global function call: name(args)
          advance()
          const args = parseArgList()
          expect(TT.RPAREN, "expected ')' after function arguments")
          return countNode({ type: 'Call', name, args })
        }
        return countNode({ type: 'Ident', name })
      }

      // Grouped expression: (expr)
      case TT.LPAREN: {
        advance()
        enterDepth()
        const node = parseExpression()
        leaveDepth()
        expect(TT.RPAREN, "expected ')' to close grouped expression")
        return node
      }

      // List literal: [expr, ...] or [?optExpr, ...]
      case TT.LBRACKET: {
        advance()
        enterDepth()
        const elements = []
        if (!check(TT.RBRACKET)) {
          if (check(TT.QUESTION)) {
            advance()
            elements.push(countNode({ type: 'OptElement', expr: parseExpression() }))
          } else {
            elements.push(parseExpression())
          }
          while (match(TT.COMMA)) {
            if (check(TT.RBRACKET)) break  // trailing comma allowed
            if (check(TT.QUESTION)) {
              advance()
              elements.push(countNode({ type: 'OptElement', expr: parseExpression() }))
            } else {
              elements.push(parseExpression())
            }
          }
        }
        leaveDepth()
        if (elements.length > maxListEl) {
          const tok2 = tokens[pos] || tokens[tokens.length - 1]
          throw new ParseError(`list element limit exceeded (${elements.length} > max ${maxListEl})`, tok2.line, tok2.col)
        }
        expect(TT.RBRACKET, "expected ']' to close list literal")
        return countNode({ type: 'List', elements })
      }

      // Map literal: {key: value, ...}
      case TT.LBRACE: {
        advance()
        enterDepth()
        const entries = []
        if (!check(TT.RBRACE)) {
          entries.push(parseMapEntry())
          while (match(TT.COMMA)) {
            if (check(TT.RBRACE)) break  // trailing comma allowed
            entries.push(parseMapEntry())
          }
        }
        leaveDepth()
        if (entries.length > maxMapEnt) {
          const tok2 = tokens[pos] || tokens[tokens.length - 1]
          throw new ParseError(`map entry limit exceeded (${entries.length} > max ${maxMapEnt})`, tok2.line, tok2.col)
        }
        expect(TT.RBRACE, "expected '}' to close map literal")
        return countNode({ type: 'Map', entries })
      }

      // Bitwise XOR as a binary operator — cannot start a primary
      default: {
        err(
          `unexpected token '${tok.type}'${tok.value !== undefined ? ` (${String(tok.value)})` : ''}`,
          tok
        )
      }
    }
  }

  // ── Map entry: key : value ────────────────────────────────────────────────
  // Keys may be any expression (identifier, string, integer, …).
  // Reserved words are allowed as bare string keys.

  function parseMapEntry() {
    const keyTok = tokens[pos]

    // If the token is a reserved word used bare (e.g. {if: 1}), treat as StringLit key
    if (keyTok.type === TT.IDENT && RESERVED.has(keyTok.value)) {
      advance()
      const key = { type: 'StringLit', value: keyTok.value }
      expect(TT.COLON, "expected ':' after map key")
      const value = parseExpression()
      return { key, value }
    }

    const key = parseExpression()
    expect(TT.COLON, "expected ':' after map key")
    const value = parseExpression()
    return { key, value }
  }

  // ── Parse root expression and verify full consumption ────────────────────

  const root = parseExpression()

  if (!check(TT.EOF)) {
    const tok = tokens[pos]
    err(
      `unexpected token '${tok.type}'${tok.value !== undefined ? ` (${String(tok.value)})` : ''} after expression`,
      tok
    )
  }

  return root
}

