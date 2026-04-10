import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, TT, LexError } from '../src/lexer.js'

// Helper: tokenize and return all tokens except EOF
function toks(src) {
  const all = tokenize(src)
  return all.slice(0, -1) // drop EOF
}

// Helper: tokenize and return single (non-EOF) token
function tok(src) {
  const ts = toks(src)
  assert.equal(ts.length, 1, `expected 1 token, got ${ts.length}`)
  return ts[0]
}

// Helper: get types only
function types(src) {
  return toks(src).map(t => t.type)
}

describe('EOF', () => {
  it('empty input produces only EOF', () => {
    const ts = tokenize('')
    assert.equal(ts.length, 1)
    assert.equal(ts[0].type, TT.EOF)
  })

  it('whitespace-only produces only EOF', () => {
    const ts = tokenize('   \t\n  ')
    assert.equal(ts.length, 1)
    assert.equal(ts[0].type, TT.EOF)
  })
})

describe('comments', () => {
  it('skips line comment', () => {
    const ts = toks('// this is a comment\n42')
    assert.equal(ts.length, 1)
    assert.equal(ts[0].type, TT.INT)
  })

  it('skips comment at end of file', () => {
    const ts = toks('// comment')
    assert.equal(ts.length, 0)
  })
})

describe('INT literals', () => {
  it('zero', () => {
    const t = tok('0')
    assert.equal(t.type, TT.INT)
    assert.equal(t.value, 0n)
  })

  it('simple decimal', () => {
    const t = tok('42')
    assert.equal(t.type, TT.INT)
    assert.equal(t.value, 42n)
  })

  it('large decimal', () => {
    const t = tok('9223372036854775807')
    assert.equal(t.type, TT.INT)
    assert.equal(t.value, 9223372036854775807n)
  })

  it('hex lowercase', () => {
    const t = tok('0xff')
    assert.equal(t.type, TT.INT)
    assert.equal(t.value, 255n)
  })

  it('hex uppercase prefix', () => {
    const t = tok('0xFF')
    assert.equal(t.type, TT.INT)
    assert.equal(t.value, 255n)
  })

  it('hex 0xDEAD', () => {
    const t = tok('0xDEAD')
    assert.equal(t.type, TT.INT)
    assert.equal(t.value, 0xDEADn)
  })
})

describe('UINT literals', () => {
  it('uint with lowercase u', () => {
    const t = tok('1u')
    assert.equal(t.type, TT.UINT)
    assert.equal(t.value, 1n)
  })

  it('uint with uppercase U', () => {
    const t = tok('42U')
    assert.equal(t.type, TT.UINT)
    assert.equal(t.value, 42n)
  })

  it('hex uint', () => {
    const t = tok('0xFFu')
    assert.equal(t.type, TT.UINT)
    assert.equal(t.value, 255n)
  })
})

describe('FLOAT literals', () => {
  it('decimal float', () => {
    const t = tok('3.14')
    assert.equal(t.type, TT.FLOAT)
    assert.ok(Math.abs(t.value - 3.14) < 1e-10)
  })

  it('float with exponent', () => {
    const t = tok('1e2')
    assert.equal(t.type, TT.FLOAT)
    assert.equal(t.value, 100)
  })

  it('float with negative exponent', () => {
    const t = tok('1e-2')
    assert.equal(t.type, TT.FLOAT)
    assert.ok(Math.abs(t.value - 0.01) < 1e-15)
  })

  it('float starting with dot', () => {
    const t = tok('.5')
    assert.equal(t.type, TT.FLOAT)
    assert.equal(t.value, 0.5)
  })

  it('float with uppercase E', () => {
    const t = tok('2E3')
    assert.equal(t.type, TT.FLOAT)
    assert.equal(t.value, 2000)
  })

  it('float with positive exponent sign', () => {
    const t = tok('1.5e+2')
    assert.equal(t.type, TT.FLOAT)
    assert.equal(t.value, 150)
  })
})

describe('STRING literals', () => {
  it('double-quoted simple', () => {
    const t = tok('"hello"')
    assert.equal(t.type, TT.STRING)
    assert.equal(t.value, 'hello')
  })

  it('single-quoted simple', () => {
    const t = tok("'world'")
    assert.equal(t.type, TT.STRING)
    assert.equal(t.value, 'world')
  })

  it('empty string', () => {
    const t = tok('""')
    assert.equal(t.type, TT.STRING)
    assert.equal(t.value, '')
  })

  it('triple double-quoted', () => {
    const t = tok('"""hello world"""')
    assert.equal(t.type, TT.STRING)
    assert.equal(t.value, 'hello world')
  })

  it('triple single-quoted', () => {
    const t = tok("'''hello'''")
    assert.equal(t.type, TT.STRING)
    assert.equal(t.value, 'hello')
  })

  it('triple-quoted with embedded newline', () => {
    const t = tok('"""line1\nline2"""')
    assert.equal(t.type, TT.STRING)
    assert.equal(t.value, 'line1\nline2')
  })

  it('triple-quoted with embedded single quote', () => {
    const t = tok('"""it\'s fine"""')
    assert.equal(t.type, TT.STRING)
    assert.equal(t.value, "it's fine")
  })

  it('escape: \\n', () => {
    const t = tok('"a\\nb"')
    assert.equal(t.value, 'a\nb')
  })

  it('escape: \\r', () => {
    const t = tok('"a\\rb"')
    assert.equal(t.value, 'a\rb')
  })

  it('escape: \\t', () => {
    const t = tok('"a\\tb"')
    assert.equal(t.value, 'a\tb')
  })

  it('escape: \\\\', () => {
    const t = tok('"a\\\\b"')
    assert.equal(t.value, 'a\\b')
  })

  it('escape: \\"', () => {
    const t = tok('"a\\"b"')
    assert.equal(t.value, 'a"b')
  })

  it("escape: \\'", () => {
    const t = tok("'a\\'b'")
    assert.equal(t.value, "a'b")
  })

  it('escape: \\a (bell)', () => {
    const t = tok('"\\a"')
    assert.equal(t.value, '\x07')
  })

  it('escape: \\b (backspace)', () => {
    const t = tok('"\\b"')
    assert.equal(t.value, '\x08')
  })

  it('escape: \\f (form feed)', () => {
    const t = tok('"\\f"')
    assert.equal(t.value, '\x0C')
  })

  it('escape: \\v (vertical tab)', () => {
    const t = tok('"\\v"')
    assert.equal(t.value, '\x0B')
  })

  it('escape: \\0 (null)', () => {
    const t = tok('"\\0"')
    assert.equal(t.value, '\x00')
  })

  it('escape: \\xHH', () => {
    const t = tok('"\\x41"')
    assert.equal(t.value, 'A')
  })

  it('escape: \\uHHHH', () => {
    const t = tok('"\\u0041"')
    assert.equal(t.value, 'A')
  })

  it('escape: \\uHHHH unicode', () => {
    const t = tok('"\\u03B1"')
    assert.equal(t.value, 'α')
  })

  it('escape: \\UHHHHHHHH', () => {
    const t = tok('"\\U00000041"')
    assert.equal(t.value, 'A')
  })

  it('escape: \\UHHHHHHHH emoji', () => {
    const t = tok('"\\U0001F600"')
    assert.equal(t.value, '😀')
  })

  it('escape: octal \\101', () => {
    const t = tok('"\\101"')
    assert.equal(t.value, 'A') // 0101 octal = 65 = 'A'
  })

  it('escape: octal \\012', () => {
    const t = tok('"\\012"')
    assert.equal(t.value, '\n')
  })
})

describe('RAW_STRING literals', () => {
  it('r"no escape"', () => {
    const t = tok('r"no\\n escape"')
    assert.equal(t.type, TT.RAW_STRING)
    assert.equal(t.value, 'no\\n escape')
  })

  it("r'single-quoted'", () => {
    const t = tok("r'raw'")
    assert.equal(t.type, TT.RAW_STRING)
    assert.equal(t.value, 'raw')
  })

  it('R"uppercase prefix"', () => {
    const t = tok('R"hello\\t"')
    assert.equal(t.type, TT.RAW_STRING)
    assert.equal(t.value, 'hello\\t')
  })
})

describe('BYTES literals', () => {
  it('b"hello"', () => {
    const t = tok('b"hello"')
    assert.equal(t.type, TT.BYTES)
    assert.ok(t.value instanceof Uint8Array)
    assert.deepEqual(t.value, new Uint8Array([104, 101, 108, 108, 111]))
  })

  it("b'world'", () => {
    const t = tok("b'world'")
    assert.equal(t.type, TT.BYTES)
    assert.ok(t.value instanceof Uint8Array)
  })

  it('B"uppercase prefix"', () => {
    const t = tok('B"hi"')
    assert.equal(t.type, TT.BYTES)
    assert.deepEqual(t.value, new Uint8Array([104, 105]))
  })

  it('b"" empty bytes', () => {
    const t = tok('b""')
    assert.equal(t.type, TT.BYTES)
    assert.equal(t.value.length, 0)
  })

  it('b"\\x41" hex escape in bytes', () => {
    const t = tok('b"\\x41"')
    assert.equal(t.type, TT.BYTES)
    assert.deepEqual(t.value, new Uint8Array([65]))
  })

  it('b"\\u0041" rejects \\u escape in bytes', () => {
    assert.throws(() => tokenize('b"\\u0041"'), /\\u escape not allowed in bytes literal/)
  })

  it('b"\\U00000041" rejects \\U escape in bytes', () => {
    assert.throws(() => tokenize('b"\\U00000041"'), /\\U escape not allowed in bytes literal/)
  })
})

describe('keyword tokens', () => {
  it('true', () => {
    const t = tok('true')
    assert.equal(t.type, TT.TRUE)
    assert.equal(t.value, true)
  })

  it('false', () => {
    const t = tok('false')
    assert.equal(t.type, TT.FALSE)
    assert.equal(t.value, false)
  })

  it('null', () => {
    const t = tok('null')
    assert.equal(t.type, TT.NULL)
    assert.equal(t.value, null)
  })

  it('in', () => {
    const t = tok('in')
    assert.equal(t.type, TT.IN)
  })
})

describe('identifiers', () => {
  it('simple ident', () => {
    const t = tok('foo')
    assert.equal(t.type, TT.IDENT)
    assert.equal(t.value, 'foo')
  })

  it('underscore prefix', () => {
    const t = tok('_foo')
    assert.equal(t.type, TT.IDENT)
    assert.equal(t.value, '_foo')
  })

  it('with numbers', () => {
    const t = tok('foo123')
    assert.equal(t.type, TT.IDENT)
    assert.equal(t.value, 'foo123')
  })

  it('mixed case', () => {
    const t = tok('FooBar')
    assert.equal(t.type, TT.IDENT)
    assert.equal(t.value, 'FooBar')
  })

  it('keyword prefix ident: trueness is ident', () => {
    const t = tok('trueness')
    assert.equal(t.type, TT.IDENT)
    assert.equal(t.value, 'trueness')
  })
})

describe('operators', () => {
  const OPS = [
    ['+', TT.PLUS],
    ['-', TT.MINUS],
    ['*', TT.STAR],
    ['/', TT.SLASH],
    ['%', TT.PERCENT],
    ['&&', TT.AND],
    ['||', TT.OR],
    ['!', TT.NOT],
    ['==', TT.EQ],
    ['!=', TT.NEQ],
    ['<', TT.LT],
    ['<=', TT.LE],
    ['>', TT.GT],
    ['>=', TT.GE],
    ['?', TT.QUESTION],
    ['.', TT.DOT],
    ['?.', TT.OPT_DOT],
    [',', TT.COMMA],
    [':', TT.COLON],
    ['**', TT.POWER],
    ['^', TT.CARET],
  ]

  for (const [lexeme, type] of OPS) {
    it(`${lexeme}`, () => {
      const t = tok(lexeme)
      assert.equal(t.type, type)
    })
  }
})

describe('delimiters', () => {
  it('LPAREN', () => { assert.equal(tok('(').type, TT.LPAREN) })
  it('RPAREN', () => { assert.equal(tok(')').type, TT.RPAREN) })
  it('LBRACKET', () => { assert.equal(tok('[').type, TT.LBRACKET) })
  it('RBRACKET', () => { assert.equal(tok(']').type, TT.RBRACKET) })
  it('LBRACE', () => { assert.equal(tok('{').type, TT.LBRACE) })
  it('RBRACE', () => { assert.equal(tok('}').type, TT.RBRACE) })
})

describe('token positions', () => {
  it('tracks line and col', () => {
    const ts = toks('1 + 2')
    assert.equal(ts[0].line, 1); assert.equal(ts[0].col, 1)
    assert.equal(ts[1].line, 1); assert.equal(ts[1].col, 3)
    assert.equal(ts[2].line, 1); assert.equal(ts[2].col, 5)
  })

  it('tracks line after newline', () => {
    const ts = toks('1\n2')
    assert.equal(ts[0].line, 1)
    assert.equal(ts[1].line, 2)
  })
})

describe('multi-token expressions', () => {
  it('1 + 2', () => {
    assert.deepEqual(types('1 + 2'), [TT.INT, TT.PLUS, TT.INT])
  })

  it('a.b.c', () => {
    assert.deepEqual(types('a.b.c'), [TT.IDENT, TT.DOT, TT.IDENT, TT.DOT, TT.IDENT])
  })

  it('x?.y', () => {
    assert.deepEqual(types('x?.y'), [TT.IDENT, TT.OPT_DOT, TT.IDENT])
  })

  it('arr[0]', () => {
    assert.deepEqual(types('arr[0]'), [TT.IDENT, TT.LBRACKET, TT.INT, TT.RBRACKET])
  })

  it('x in [1, 2, 3]', () => {
    assert.deepEqual(types('x in [1, 2, 3]'), [
      TT.IDENT, TT.IN,
      TT.LBRACKET, TT.INT, TT.COMMA, TT.INT, TT.COMMA, TT.INT, TT.RBRACKET
    ])
  })

  it('true && false || null', () => {
    assert.deepEqual(types('true && false || null'), [
      TT.TRUE, TT.AND, TT.FALSE, TT.OR, TT.NULL
    ])
  })

  it('a ? b : c', () => {
    assert.deepEqual(types('a ? b : c'), [
      TT.IDENT, TT.QUESTION, TT.IDENT, TT.COLON, TT.IDENT
    ])
  })

  it('2 ** 10', () => {
    assert.deepEqual(types('2 ** 10'), [TT.INT, TT.POWER, TT.INT])
  })

  it('map literal {key: val}', () => {
    assert.deepEqual(types('{key: val}'), [
      TT.LBRACE, TT.IDENT, TT.COLON, TT.IDENT, TT.RBRACE
    ])
  })
})

describe('error cases', () => {
  it('throws on unexpected character @', () => {
    assert.throws(() => tokenize('@'), LexError)
  })

  it('throws on single &', () => {
    assert.throws(() => tokenize('&'), LexError)
  })

  it('throws on single |', () => {
    assert.throws(() => tokenize('|'), LexError)
  })

  it('throws on unterminated string', () => {
    assert.throws(() => tokenize('"hello'), LexError)
  })

  it('throws on unterminated single-quoted string', () => {
    assert.throws(() => tokenize("'hello"), LexError)
  })

  it('throws on single = (not ==)', () => {
    assert.throws(() => tokenize('='), LexError)
  })

  it('throws on invalid hex literal 0x', () => {
    assert.throws(() => tokenize('0x'), LexError)
  })

  it('throws on invalid \\x escape', () => {
    assert.throws(() => tokenize('"\\xGG"'), LexError)
  })
})
