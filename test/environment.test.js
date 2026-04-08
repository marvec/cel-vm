import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Environment } from '../src/environment.js'

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
    assert.throws(() => env.registerConstant('x', 'int', 2n), /already registered/)
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
    assert.throws(() => env.registerFunction('foo', 1, x => x), /already registered/)
  })

  it('rejects non-function impl', () => {
    const env = new Environment()
    assert.throws(() => env.registerFunction('foo', 1, 'not-a-function'), /must be a function/)
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
    assert.throws(() => env.registerVariable('x', 'string'), /already registered/)
  })

  it('constants do not count as declared vars', () => {
    const env = new Environment()
      .registerConstant('pi', 'double', 3.14)
    const config = env.toConfig()
    // No declared vars (still permissive for non-constant variables)
    assert.equal(config.declaredVars, null)
  })
})
