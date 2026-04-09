import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Environment, EnvironmentError } from '../src/environment.js'
import { compile, evaluate, CompileError } from '../src/index.js'

describe('Environment', () => {
  it('creates an empty environment', () => {
    const env = new Environment()
    const config = env.toConfig()
    assert.equal(config.constants.size, 0)
    assert.equal(config.customFunctions.size, 0)
    assert.equal(config.customMethods.size, 0)
    assert.equal(config.declaredVars, null)
  })

  it('registers a constant', () => {
    const env = new Environment()
    env.registerConstant('maxAge', 'int', 100n)
    const config = env.toConfig()
    assert.equal(config.constants.size, 1)
    assert.deepStrictEqual(config.constants.get('maxAge'), { tag: 2, value: 100n })
  })

  it('registers a string constant', () => {
    const env = new Environment()
    env.registerConstant('greeting', 'string', 'hello')
    const config = env.toConfig()
    assert.deepStrictEqual(config.constants.get('greeting'), { tag: 5, value: 'hello' })
  })

  it('registers a bool constant', () => {
    const env = new Environment()
    env.registerConstant('debug', 'bool', true)
    const config = env.toConfig()
    assert.deepStrictEqual(config.constants.get('debug'), { tag: 1, value: true })
  })

  it('registers a double constant', () => {
    const env = new Environment()
    env.registerConstant('pi', 'double', 3.14)
    const config = env.toConfig()
    assert.deepStrictEqual(config.constants.get('pi'), { tag: 4, value: 3.14 })
  })

  it('rejects duplicate constant names', () => {
    const env = new Environment()
    env.registerConstant('x', 'int', 1n)
    assert.throws(() => env.registerConstant('x', 'int', 2n), EnvironmentError)
  })

  it('chains register calls fluently', () => {
    const env = new Environment()
      .registerConstant('a', 'int', 1n)
      .registerConstant('b', 'string', 'hi')
    const config = env.toConfig()
    assert.equal(config.constants.size, 2)
  })
})

describe('Custom functions', () => {
  it('registers a global function', () => {
    const env = new Environment()
    env.registerFunction('isAdult', 1, (age) => age >= 18n)
    const config = env.toConfig()
    assert.equal(config.customFunctions.size, 1)
    const fn = config.customFunctions.get('isAdult')
    assert.equal(fn.arity, 1)
    assert.equal(fn.id, 64)
    assert.equal(typeof fn.impl, 'function')
  })

  it('registers multiple functions with sequential IDs', () => {
    const env = new Environment()
      .registerFunction('foo', 1, x => x)
      .registerFunction('bar', 2, (a, b) => a + b)
    const config = env.toConfig()
    assert.equal(config.customFunctions.get('foo').id, 64)
    assert.equal(config.customFunctions.get('bar').id, 65)
  })

  it('rejects duplicate function names', () => {
    const env = new Environment()
    env.registerFunction('foo', 1, x => x)
    assert.throws(() => env.registerFunction('foo', 1, x => x), EnvironmentError)
  })

  it('rejects non-function impl', () => {
    const env = new Environment()
    assert.throws(() => env.registerFunction('foo', 1, 'not-a-function'), EnvironmentError)
  })

  it('builds function table in correct order', () => {
    const impl1 = x => x * 2n
    const impl2 = x => x + 1n
    const env = new Environment()
      .registerFunction('double', 1, impl1)
      .registerFunction('inc', 1, impl2)
    const config = env.toConfig()
    assert.equal(config.functionTable[0], impl1)
    assert.equal(config.functionTable[1], impl2)
  })
})

describe('Custom methods', () => {
  it('registers a method', () => {
    const env = new Environment()
    env.registerMethod('double', 0, (receiver) => receiver + receiver)
    const config = env.toConfig()
    assert.equal(config.customMethods.size, 1)
    const m = config.customMethods.get('double')
    assert.equal(m.arity, 0) // arity excludes receiver
    assert.equal(m.id, 64)
  })

  it('functions and methods share the ID space', () => {
    const env = new Environment()
      .registerFunction('foo', 1, x => x)
      .registerMethod('bar', 0, r => r)
    const config = env.toConfig()
    assert.equal(config.customFunctions.get('foo').id, 64)
    assert.equal(config.customMethods.get('bar').id, 65)
  })

  it('methods appear in function table', () => {
    const impl = r => r
    const env = new Environment()
      .registerMethod('myMethod', 0, impl)
    const config = env.toConfig()
    assert.equal(config.functionTable[0], impl)
  })
})

describe('Variable declarations', () => {
  it('defaults to permissive mode (null declaredVars)', () => {
    const env = new Environment()
    const config = env.toConfig()
    assert.equal(config.declaredVars, null)
  })

  it('declares a variable', () => {
    const env = new Environment()
    env.registerVariable('user', 'map')
    const config = env.toConfig()
    assert.equal(config.declaredVars.size, 1)
    assert.equal(config.declaredVars.get('user'), 'map')
  })

  it('declares multiple variables', () => {
    const env = new Environment()
      .registerVariable('name', 'string')
      .registerVariable('age', 'int')
    const config = env.toConfig()
    assert.equal(config.declaredVars.size, 2)
    assert.equal(config.declaredVars.get('name'), 'string')
    assert.equal(config.declaredVars.get('age'), 'int')
  })

  it('rejects duplicate variable names', () => {
    const env = new Environment()
    env.registerVariable('x', 'int')
    assert.throws(() => env.registerVariable('x', 'string'), EnvironmentError)
  })

  it('constants do not count as declared vars', () => {
    const env = new Environment()
      .registerConstant('pi', 'double', 3.14)
    const config = env.toConfig()
    // No declared vars (still permissive for non-constant variables)
    assert.equal(config.declaredVars, null)
  })
})

describe('Environment integration — constants', () => {
  it('compiles and evaluates an expression with a constant', () => {
    const env = new Environment()
      .registerConstant('maxAge', 'int', 100n)

    const bytecode = compile('maxAge + 1', { env: env.toConfig() })
    const result = evaluate(bytecode, {})
    assert.equal(result, 101n)
  })

  it('constant takes precedence over activation variable', () => {
    const env = new Environment()
      .registerConstant('x', 'int', 42n)

    const bytecode = compile('x', { env: env.toConfig() })
    // Even if activation provides x, the constant wins (it's baked into bytecode)
    const result = evaluate(bytecode, { x: 999n })
    assert.equal(result, 42n)
  })

  it('mixes constants and variables', () => {
    const env = new Environment()
      .registerConstant('threshold', 'int', 10n)

    const bytecode = compile('score > threshold', { env: env.toConfig() })
    assert.equal(evaluate(bytecode, { score: 15n }), true)
    assert.equal(evaluate(bytecode, { score: 5n }), false)
  })
})

describe('Environment integration — custom functions', () => {
  it('calls a custom global function', () => {
    const env = new Environment()
      .registerFunction('twice', 1, (x) => {
        if (typeof x === 'bigint') return x * 2n
        return x * 2
      })

    const config = env.toConfig()
    const bytecode = compile('twice(21)', { env: config })
    const result = evaluate(bytecode, {}, config.functionTable)
    assert.equal(result, 42n)
  })

  it('calls a custom function with multiple args', () => {
    const env = new Environment()
      .registerFunction('add3', 3, (a, b, c) => a + b + c)

    const config = env.toConfig()
    const bytecode = compile('add3(1, 2, 3)', { env: config })
    const result = evaluate(bytecode, {}, config.functionTable)
    assert.equal(result, 6n)
  })

  it('custom function can access activation variables', () => {
    const env = new Environment()
      .registerFunction('negate', 1, (x) => -x)

    const config = env.toConfig()
    const bytecode = compile('negate(val)', { env: config })
    assert.equal(evaluate(bytecode, { val: 5n }, config.functionTable), -5n)
  })

  it('custom function combined with built-in operators', () => {
    const env = new Environment()
      .registerFunction('square', 1, (x) => x * x)

    const config = env.toConfig()
    const bytecode = compile('square(3) + square(4)', { env: config })
    assert.equal(evaluate(bytecode, {}, config.functionTable), 25n)
  })

  it('unknown function still throws CompileError', () => {
    assert.throws(() => compile('unknown(1)'), /Unknown function/)
  })
})

describe('Environment integration — custom methods', () => {
  it('calls a custom method on a string', () => {
    const env = new Environment()
      .registerMethod('reverse', 0, (receiver) => {
        if (typeof receiver !== 'string') throw new Error('reverse requires string')
        return [...receiver].reverse().join('')
      })

    const config = env.toConfig()
    const bytecode = compile('"hello".reverse()', { env: config })
    const result = evaluate(bytecode, {}, config.functionTable)
    assert.equal(result, 'olleh')
  })

  it('calls a custom method with arguments', () => {
    const env = new Environment()
      .registerMethod('repeat', 1, (receiver, n) => {
        return receiver.repeat(Number(n))
      })

    const config = env.toConfig()
    const bytecode = compile('"ab".repeat(3)', { env: config })
    const result = evaluate(bytecode, {}, config.functionTable)
    assert.equal(result, 'ababab')
  })

  it('custom method on a variable', () => {
    const env = new Environment()
      .registerMethod('twice', 0, (receiver) => receiver * 2n)

    const config = env.toConfig()
    const bytecode = compile('x.twice()', { env: config })
    assert.equal(evaluate(bytecode, { x: 21n }, config.functionTable), 42n)
  })

  it('built-in methods still work alongside custom methods', () => {
    const env = new Environment()
      .registerMethod('reverse', 0, (r) => [...r].reverse().join(''))

    const config = env.toConfig()
    // Built-in: contains; Custom: reverse
    const bytecode = compile('"hello".reverse().contains("oll")', { env: config })
    assert.equal(evaluate(bytecode, {}, config.functionTable), true)
  })
})

describe('Environment integration — strict variable mode', () => {
  it('allows declared variables', () => {
    const env = new Environment()
      .registerVariable('x', 'int')

    const config = env.toConfig()
    const bytecode = compile('x + 1', { env: config })
    assert.equal(evaluate(bytecode, { x: 5n }), 6n)
  })

  it('rejects undeclared variables in strict mode', () => {
    const env = new Environment()
      .registerVariable('x', 'int')

    const config = env.toConfig()
    assert.throws(
      () => compile('x + y', { env: config }),
      (err) => err instanceof CompileError && err.message.includes('y')
    )
  })

  it('permissive mode (no registerVariable calls) allows anything', () => {
    const env = new Environment()
      .registerConstant('c', 'int', 1n)

    const config = env.toConfig()
    // declaredVars is null → no checking
    const bytecode = compile('x + c', { env: config })
    assert.equal(evaluate(bytecode, { x: 2n }), 3n)
  })

  it('constants are allowed even when not declared as variables', () => {
    const env = new Environment()
      .registerVariable('x', 'int')
      .registerConstant('limit', 'int', 100n)

    const config = env.toConfig()
    // 'limit' is a constant, not a variable — should still work
    const bytecode = compile('x < limit', { env: config })
    assert.equal(evaluate(bytecode, { x: 50n }), true)
  })
})

describe('Environment convenience API', () => {
  it('env.compile() + env.evaluate()', () => {
    const env = new Environment()
      .registerConstant('bonus', 'int', 10n)
      .registerFunction('twice', 1, x => x * 2n)

    const bytecode = env.compile('twice(score) + bonus')
    const result = env.evaluate(bytecode, { score: 5n })
    assert.equal(result, 20n)
  })

  it('env.run() convenience method', () => {
    const env = new Environment()
      .registerFunction('greet', 1, name => `Hello, ${name}!`)

    const result = env.run('greet(name)', { name: 'World' })
    assert.equal(result, 'Hello, World!')
  })

  it('env.run() with no activation', () => {
    const env = new Environment()
      .registerConstant('answer', 'int', 42n)

    assert.equal(env.run('answer'), 42n)
  })
})

describe('Environment — end-to-end', () => {
  it('real-world use case: authorization policy', () => {
    const env = new Environment()
      .registerVariable('user', 'map')
      .registerVariable('resource', 'map')
      .registerConstant('minAge', 'int', 18n)
      .registerFunction('hasRole', 2, (user, role) => {
        if (!user || !Array.isArray(user.roles)) return false
        return user.roles.includes(role)
      })

    const policy = 'user.age >= minAge && hasRole(user, "admin")'
    const bytecode = env.compile(policy)

    const allowed = env.evaluate(bytecode, {
      user: { age: 25n, roles: ['admin', 'user'] },
      resource: { type: 'document' },
    })
    assert.equal(allowed, true)

    const denied = env.evaluate(bytecode, {
      user: { age: 16n, roles: ['user'] },
      resource: { type: 'document' },
    })
    assert.equal(denied, false)
  })

  it('real-world use case: string formatting with custom methods', () => {
    const env = new Environment()
      .registerMethod('titleCase', 0, (s) => {
        return s.replace(/\b\w/g, c => c.toUpperCase())
      })

    assert.equal(
      env.run('"hello world".titleCase()', {}),
      'Hello World'
    )
  })

  it('real-world use case: math extensions', () => {
    const env = new Environment()
      .registerFunction('clamp', 3, (val, lo, hi) => {
        if (val < lo) return lo
        if (val > hi) return hi
        return val
      })

    assert.equal(env.run('clamp(x, 0, 100)', { x: 150n }), 100n)
    assert.equal(env.run('clamp(x, 0, 100)', { x: -5n }), 0n)
    assert.equal(env.run('clamp(x, 0, 100)', { x: 50n }), 50n)
  })

  it('bytecode portability: same bytecode, different activations', () => {
    const env = new Environment()
      .registerFunction('prefix', 2, (s, p) => p + s)

    const bytecode = env.compile('prefix(name, "Dr. ")')
    assert.equal(env.evaluate(bytecode, { name: 'Smith' }), 'Dr. Smith')
    assert.equal(env.evaluate(bytecode, { name: 'Jones' }), 'Dr. Jones')
  })
})
