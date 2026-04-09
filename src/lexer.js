// CEL Lexer — hand-written tokeniser

export const TT = {
  // Literals
  INT:        'INT',
  UINT:       'UINT',
  FLOAT:      'FLOAT',
  STRING:     'STRING',
  BYTES:      'BYTES',
  RAW_STRING: 'RAW_STRING',
  // Keywords
  TRUE:       'TRUE',
  FALSE:      'FALSE',
  NULL:       'NULL',
  IN:         'IN',
  // Operators
  PLUS:       'PLUS',
  MINUS:      'MINUS',
  STAR:       'STAR',
  SLASH:      'SLASH',
  PERCENT:    'PERCENT',
  AND:        'AND',
  OR:         'OR',
  NOT:        'NOT',
  EQ:         'EQ',
  NEQ:        'NEQ',
  LT:         'LT',
  LE:         'LE',
  GT:         'GT',
  GE:         'GE',
  QUESTION:   'QUESTION',
  DOT:        'DOT',
  OPT_DOT:    'OPT_DOT',
  COMMA:      'COMMA',
  COLON:      'COLON',
  POWER:      'POWER',
  CARET:      'CARET',
  // Delimiters
  LPAREN:     'LPAREN',
  RPAREN:     'RPAREN',
  LBRACKET:   'LBRACKET',
  RBRACKET:   'RBRACKET',
  LBRACE:     'LBRACE',
  RBRACE:     'RBRACE',
  // Special
  IDENT:      'IDENT',
  EOF:        'EOF',
}

export class LexError extends Error {
  constructor(msg, line, col) {
    super(`LexError at ${line}:${col}: ${msg}`)
    this.name = 'LexError'
    this.line = line
    this.col = col
  }
}

/**
 * Tokenise a CEL source string.
 * Returns an array of token objects: { type, value, line, col }
 *   - INT/UINT value is BigInt
 *   - FLOAT value is Number
 *   - STRING/RAW_STRING value is String (escape-decoded)
 *   - BYTES value is Uint8Array
 *   - IDENT/keyword value is String (the lexeme)
 *   - All others: value is undefined
 */
export function tokenize(src) {
  const tokens = []
  let pos = 0
  let line = 1
  let col = 1

  function peek(offset = 0) { return src[pos + offset] }
  function advance() {
    const ch = src[pos++]
    if (ch === '\n') { line++; col = 1 } else { col++ }
    return ch
  }
  function cur() { return src[pos] }
  function rest() { return src.slice(pos) }

  function addToken(type, value, tokenLine, tokenCol) {
    tokens.push({ type, value, line: tokenLine, col: tokenCol })
  }

  function err(msg) { throw new LexError(msg, line, col) }

  // Decode a single escape sequence starting after the backslash.
  // Returns the decoded character string and advances pos.
  function decodeEscape() {
    const ch = src[pos]
    pos++; col++
    switch (ch) {
      case 'n':  return '\n'
      case 'r':  return '\r'
      case 't':  return '\t'
      case '\\': return '\\'
      case '"':  return '"'
      case "'":  return "'"
      case 'a':  return '\x07'
      case 'b':  return '\x08'
      case 'f':  return '\x0C'
      case 'v':  return '\x0B'
      case 'x': {
        // \xHH
        const h1 = src[pos]; const h2 = src[pos + 1]
        if (!isHex(h1) || !isHex(h2)) err('invalid \\x escape')
        pos += 2; col += 2
        return String.fromCharCode(parseInt(h1 + h2, 16))
      }
      case 'u': {
        // \uHHHH
        const hex = src.slice(pos, pos + 4)
        if (hex.length < 4 || !isHexStr(hex)) err('invalid \\u escape')
        pos += 4; col += 4
        return String.fromCodePoint(parseInt(hex, 16))
      }
      case 'U': {
        // \UHHHHHHHH
        const hex = src.slice(pos, pos + 8)
        if (hex.length < 8 || !isHexStr(hex)) err('invalid \\U escape')
        pos += 8; col += 8
        const cp = parseInt(hex, 16)
        if (cp > 0x10FFFF) err('code point out of range in \\U escape')
        return String.fromCodePoint(cp)
      }
      default: {
        // Octal \NNN (1-3 digits, 0-377); also handles \0
        if (isOctal(ch)) {
          let oct = ch
          if (isOctal(src[pos])) { oct += src[pos++]; col++ }
          if (isOctal(src[pos])) { oct += src[pos++]; col++ }
          const val = parseInt(oct, 8)
          if (val > 255) err('octal escape out of range')
          return String.fromCharCode(val)
        }
        err(`invalid escape sequence \\${ch}`)
      }
    }
  }

  function isHex(c)    { return c !== undefined && /[0-9a-fA-F]/.test(c) }
  function isHexStr(s) { return /^[0-9a-fA-F]+$/.test(s) }
  function isOctal(c)  { return c !== undefined && c >= '0' && c <= '7' }
  function isDigit(c)  { return c !== undefined && c >= '0' && c <= '9' }
  function isAlpha(c)  { return c !== undefined && /[a-zA-Z_]/.test(c) }
  function isAlNum(c)  { return c !== undefined && /[a-zA-Z0-9_]/.test(c) }

  // Scan a quoted string. `quote` is `"` or `'`, `triple` is bool, `raw` is bool.
  // Returns the decoded string value.
  function scanString(quote, triple, raw) {
    let result = ''
    while (pos < src.length) {
      if (triple) {
        if (src[pos] === quote && src[pos+1] === quote && src[pos+2] === quote) {
          pos += 3; col += 3
          return result
        }
      } else {
        if (src[pos] === quote) {
          pos++; col++
          return result
        }
        if (src[pos] === '\n') err('unterminated string literal')
      }

      if (src[pos] === '\\' && !raw) {
        pos++; col++
        result += decodeEscape()
      } else {
        const ch = src[pos]
        if (ch === '\n') { line++; col = 1; pos++ } else { col++; pos++ }
        result += ch
      }
    }
    err('unterminated string literal')
  }

  // Scan a quoted bytes literal. Returns Uint8Array.
  // In byte literals, \xHH and octal escapes produce raw bytes,
  // while \uHHHH, \UHHHHHHHH, and literal source characters are UTF-8 encoded.
  function scanBytes(quote, triple, raw) {
    const parts = [] // each element: number (raw byte) or string (to UTF-8 encode)
    while (pos < src.length) {
      if (triple) {
        if (src[pos] === quote && src[pos+1] === quote && src[pos+2] === quote) {
          pos += 3; col += 3
          break
        }
      } else {
        if (src[pos] === quote) {
          pos++; col++
          break
        }
        if (src[pos] === '\n') err('unterminated string literal')
      }

      if (src[pos] === '\\' && !raw) {
        pos++; col++
        const ch = src[pos]; pos++; col++
        switch (ch) {
          case '\\': parts.push(0x5C); break
          case quote: parts.push(quote.charCodeAt(0)); break
          case '"':  parts.push(0x22); break
          case "'":  parts.push(0x27); break
          case 'n':  parts.push(0x0A); break
          case 'r':  parts.push(0x0D); break
          case 't':  parts.push(0x09); break
          case 'a':  parts.push(0x07); break
          case 'b':  parts.push(0x08); break
          case 'f':  parts.push(0x0C); break
          case 'v':  parts.push(0x0B); break
          case 'x': {
            const h1 = src[pos]; const h2 = src[pos + 1]
            if (!isHex(h1) || !isHex(h2)) err('invalid \\x escape')
            pos += 2; col += 2
            parts.push(parseInt(h1 + h2, 16))
            break
          }
          case 'u': {
            const hex = src.slice(pos, pos + 4)
            if (hex.length < 4 || !isHexStr(hex)) err('invalid \\u escape')
            pos += 4; col += 4
            parts.push(String.fromCodePoint(parseInt(hex, 16)))
            break
          }
          case 'U': {
            const hex = src.slice(pos, pos + 8)
            if (hex.length < 8 || !isHexStr(hex)) err('invalid \\U escape')
            pos += 8; col += 8
            const cp = parseInt(hex, 16)
            if (cp > 0x10FFFF) err('code point out of range in \\U escape')
            parts.push(String.fromCodePoint(cp))
            break
          }
          default: {
            if (isOctal(ch)) {
              let oct = ch
              if (isOctal(src[pos])) { oct += src[pos++]; col++ }
              if (isOctal(src[pos])) { oct += src[pos++]; col++ }
              const val = parseInt(oct, 8)
              if (val > 255) err('octal escape out of range')
              parts.push(val)
            } else {
              err(`invalid escape sequence \\${ch}`)
            }
          }
        }
      } else {
        const ch = src[pos]
        if (ch === '\n') { line++; col = 1; pos++ } else { col++; pos++ }
        parts.push(ch) // literal source char — will be UTF-8 encoded
      }
    }

    // Build the Uint8Array: numbers are raw bytes, strings are UTF-8 encoded
    const encoder = new TextEncoder()
    const chunks = []
    let totalLen = 0
    for (const p of parts) {
      if (typeof p === 'number') {
        chunks.push(new Uint8Array([p]))
        totalLen += 1
      } else {
        const encoded = encoder.encode(p)
        chunks.push(encoded)
        totalLen += encoded.length
      }
    }
    const result = new Uint8Array(totalLen)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }

  while (pos < src.length) {
    // Skip whitespace
    const c = src[pos]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      advance()
      continue
    }

    // Skip line comments
    if (c === '/' && src[pos+1] === '/') {
      while (pos < src.length && src[pos] !== '\n') { pos++; col++ }
      continue
    }

    const tokLine = line
    const tokCol  = col

    // String/bytes/raw prefixes
    const cl = c.toLowerCase()
    if ((cl === 'r' || cl === 'b') && (src[pos+1] === '"' || src[pos+1] === "'")) {
      pos++; col++
      const isRaw   = cl === 'r'
      const isBytes = cl === 'b'
      const quote   = src[pos]; pos++; col++
      const triple  = src[pos] === quote && src[pos+1] === quote
      if (triple) { pos += 2; col += 2 }
      if (isRaw) {
        const val = scanString(quote, triple, true)
        addToken(TT.RAW_STRING, val, tokLine, tokCol)
      } else {
        const val = scanBytes(quote, triple, false)
        addToken(TT.BYTES, val, tokLine, tokCol)
      }
      continue
    }

    // rb"..." or br"..." — raw bytes (treat like raw string but yield Uint8Array)
    if ((c === 'r' || c === 'R') && (src[pos+1] === 'b' || src[pos+1] === 'B') &&
        (src[pos+2] === '"' || src[pos+2] === "'")) {
      pos += 2; col += 2
      const quote = src[pos]; pos++; col++
      const triple = src[pos] === quote && src[pos+1] === quote
      if (triple) { pos += 2; col += 2 }
      const val = scanBytes(quote, triple, true)
      addToken(TT.BYTES, val, tokLine, tokCol)
      continue
    }

    // Strings
    if (c === '"' || c === "'") {
      pos++; col++
      const quote  = c
      const triple = src[pos] === quote && src[pos+1] === quote
      if (triple) { pos += 2; col += 2 }
      const val = scanString(quote, triple, false)
      addToken(TT.STRING, val, tokLine, tokCol)
      continue
    }

    // Numbers
    if (isDigit(c) || (c === '.' && isDigit(src[pos+1]))) {
      let numStr = ''
      let isFloat = false
      let isHexNum = false

      if (c === '0' && (src[pos+1] === 'x' || src[pos+1] === 'X')) {
        // Hex integer
        pos += 2; col += 2
        numStr = '0x'
        while (isHex(src[pos])) { numStr += src[pos++]; col++ }
        if (numStr.length === 2) err('invalid hex literal')
        // UINT suffix?
        if (src[pos] === 'u' || src[pos] === 'U') {
          pos++; col++
          addToken(TT.UINT, BigInt(numStr), tokLine, tokCol)
        } else {
          addToken(TT.INT, BigInt(numStr), tokLine, tokCol)
        }
        continue
      }

      // Decimal / float
      if (c === '.') {
        // .5 form
        isFloat = true
        numStr += '.'
        pos++; col++
        while (isDigit(src[pos])) { numStr += src[pos++]; col++ }
      } else {
        while (isDigit(src[pos])) { numStr += src[pos++]; col++ }
        if (src[pos] === '.') {
          isFloat = true
          numStr += '.'
          pos++; col++
          while (isDigit(src[pos])) { numStr += src[pos++]; col++ }
        }
      }

      // Exponent
      if (src[pos] === 'e' || src[pos] === 'E') {
        isFloat = true
        numStr += src[pos++]; col++
        if (src[pos] === '+' || src[pos] === '-') { numStr += src[pos++]; col++ }
        if (!isDigit(src[pos])) err('invalid float exponent')
        while (isDigit(src[pos])) { numStr += src[pos++]; col++ }
      }

      if (isFloat) {
        addToken(TT.FLOAT, parseFloat(numStr), tokLine, tokCol)
        continue
      }

      // UINT suffix?
      if (src[pos] === 'u' || src[pos] === 'U') {
        pos++; col++
        addToken(TT.UINT, BigInt(numStr), tokLine, tokCol)
        continue
      }

      addToken(TT.INT, BigInt(numStr), tokLine, tokCol)
      continue
    }

    // Identifiers and keywords
    if (isAlpha(c)) {
      let ident = ''
      while (isAlNum(src[pos])) { ident += src[pos++]; col++ }
      switch (ident) {
        case 'true':  addToken(TT.TRUE,  true,  tokLine, tokCol); break
        case 'false': addToken(TT.FALSE, false, tokLine, tokCol); break
        case 'null':  addToken(TT.NULL,  null,  tokLine, tokCol); break
        case 'in':    addToken(TT.IN,    'in',  tokLine, tokCol); break
        default:      addToken(TT.IDENT, ident, tokLine, tokCol); break
      }
      continue
    }

    // Operators and delimiters
    pos++; col++
    switch (c) {
      case '+': addToken(TT.PLUS,     undefined, tokLine, tokCol); break
      case '-': addToken(TT.MINUS,    undefined, tokLine, tokCol); break
      case '%': addToken(TT.PERCENT,  undefined, tokLine, tokCol); break
      case '^': addToken(TT.CARET,    undefined, tokLine, tokCol); break
      case ',': addToken(TT.COMMA,    undefined, tokLine, tokCol); break
      case ':': addToken(TT.COLON,    undefined, tokLine, tokCol); break
      case '(': addToken(TT.LPAREN,   undefined, tokLine, tokCol); break
      case ')': addToken(TT.RPAREN,   undefined, tokLine, tokCol); break
      case '[': addToken(TT.LBRACKET, undefined, tokLine, tokCol); break
      case ']': addToken(TT.RBRACKET, undefined, tokLine, tokCol); break
      case '{': addToken(TT.LBRACE,   undefined, tokLine, tokCol); break
      case '}': addToken(TT.RBRACE,   undefined, tokLine, tokCol); break
      case '?':
        if (src[pos] === '.') { pos++; col++; addToken(TT.OPT_DOT, undefined, tokLine, tokCol) }
        else { addToken(TT.QUESTION, undefined, tokLine, tokCol) }
        break
      case '.':
        if (src[pos] === '?') { pos++; col++; addToken(TT.OPT_DOT, undefined, tokLine, tokCol) }
        else { addToken(TT.DOT, undefined, tokLine, tokCol) }
        break
      case '*':
        if (src[pos] === '*') { pos++; col++; addToken(TT.POWER, undefined, tokLine, tokCol) }
        else { addToken(TT.STAR, undefined, tokLine, tokCol) }
        break
      case '/':
        addToken(TT.SLASH, undefined, tokLine, tokCol)
        break
      case '!':
        if (src[pos] === '=') { pos++; col++; addToken(TT.NEQ, undefined, tokLine, tokCol) }
        else { addToken(TT.NOT, undefined, tokLine, tokCol) }
        break
      case '=':
        if (src[pos] === '=') { pos++; col++; addToken(TT.EQ, undefined, tokLine, tokCol) }
        else err(`unexpected character '='`)
        break
      case '<':
        if (src[pos] === '=') { pos++; col++; addToken(TT.LE, undefined, tokLine, tokCol) }
        else { addToken(TT.LT, undefined, tokLine, tokCol) }
        break
      case '>':
        if (src[pos] === '=') { pos++; col++; addToken(TT.GE, undefined, tokLine, tokCol) }
        else { addToken(TT.GT, undefined, tokLine, tokCol) }
        break
      case '&':
        if (src[pos] === '&') { pos++; col++; addToken(TT.AND, undefined, tokLine, tokCol) }
        else err(`unexpected character '&'`)
        break
      case '|':
        if (src[pos] === '|') { pos++; col++; addToken(TT.OR, undefined, tokLine, tokCol) }
        else err(`unexpected character '|'`)
        break
      default:
        err(`unexpected character '${c}'`)
    }
  }

  tokens.push({ type: TT.EOF, value: undefined, line, col })
  return tokens
}
