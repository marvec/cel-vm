// Environment — declaration builder for CEL-VM
//
// Collects custom function, constant, and variable declarations.
// Produces a plain config object consumed by compiler and VM.

export class EnvironmentError extends Error {
  constructor(msg) {
    super(msg)
    this.name = 'EnvironmentError'
  }
}

import { tokenize } from './lexer.js'
import { parse } from './parser.js'
import { check } from './checker.js'
import { compile as compileAst } from './compiler.js'
import { encode, decode } from './bytecode.js'
import { evaluate as evalProgram } from './vm.js'

// Const pool tags (must match bytecode.js / compiler.js)
const TAG_NULL   = 0
const TAG_BOOL   = 1
const TAG_INT64  = 2
const TAG_UINT64 = 3
const TAG_DOUBLE = 4
const TAG_STRING = 5
const TAG_BYTES  = 6

// First custom function BUILTIN ID (0–53 reserved for builtins)
const CUSTOM_ID_BASE = 64

const TYPE_TAGS = {
  int:    TAG_INT64,
  uint:   TAG_UINT64,
  double: TAG_DOUBLE,
  string: TAG_STRING,
  bool:   TAG_BOOL,
  bytes:  TAG_BYTES,
  null:   TAG_NULL,
}

export class Environment {
  constructor() {
    this._constants = new Map()       // name → {tag, value}
    this._functions = new Map()       // name → {id, impl, arity}
    this._methods = new Map()         // name → {id, impl, arity}
    this._declaredVars = null         // null = permissive; Map = strict
    this._nextCustomId = CUSTOM_ID_BASE
  }

  /**
   * Register a compile-time constant.
   * @param {string} name
   * @param {string} type - one of: int, uint, double, string, bool, bytes, null
   * @param {*} value
   * @returns {this}
   */
  registerConstant(name, type, value) {
    if (this._constants.has(name) || this._functions.has(name)) {
      throw new EnvironmentError(`'${name}' is already registered`)
    }
    const tag = TYPE_TAGS[type]
    if (tag === undefined) throw new EnvironmentError(`Unknown constant type: '${type}'`)
    this._constants.set(name, { tag, value })
    return this
  }

  /**
   * Register a custom global function.
   * @param {string} name     - function name as used in expressions
   * @param {number} arity    - number of arguments
   * @param {Function} impl   - JavaScript implementation
   * @returns {this}
   */
  registerFunction(name, arity, impl) {
    if (typeof impl !== 'function') throw new EnvironmentError(`impl for '${name}' must be a function`)
    if (this._functions.has(name) || this._constants.has(name)) {
      throw new EnvironmentError(`'${name}' is already registered`)
    }
    const id = this._nextCustomId++
    this._functions.set(name, { id, impl, arity })
    return this
  }

  /**
   * Register a custom method (called on a receiver).
   * @param {string} name     - method name as used in expressions (e.g. 'double')
   * @param {number} arity    - number of arguments EXCLUDING the receiver
   * @param {Function} impl   - (receiver, ...args) => result
   * @returns {this}
   */
  registerMethod(name, arity, impl) {
    if (typeof impl !== 'function') throw new EnvironmentError(`impl for '${name}' must be a function`)
    if (this._methods.has(name)) {
      throw new EnvironmentError(`method '${name}' is already registered`)
    }
    const id = this._nextCustomId++
    this._methods.set(name, { id, impl, arity })
    return this
  }

  /**
   * Declare a variable that must exist in the activation at evaluation time.
   * Calling this at least once enables "strict mode": the compiler will reject
   * references to undeclared variables.
   * @param {string} name
   * @param {string} type - CEL type name (informational; no runtime enforcement yet)
   * @returns {this}
   */
  registerVariable(name, type) {
    if (this._declaredVars === null) this._declaredVars = new Map()
    if (this._declaredVars.has(name)) {
      throw new EnvironmentError(`variable '${name}' is already registered`)
    }
    this._declaredVars.set(name, type)
    return this
  }

  /**
   * Produce a plain config object for compiler and VM consumption.
   * @returns {{ constants, customFunctions, customMethods, declaredVars, functionTable }}
   */
  /**
   * Compile a CEL expression within this environment.
   * @param {string} src
   * @param {object} [options]
   * @returns {Uint8Array}
   */
  compile(src, options = {}) {
    const config = this.toConfig()
    const tokens  = tokenize(src)
    const ast     = parse(tokens)
    const checked = check(ast)
    const program = compileAst(checked, {
      debugInfo: options.debugInfo || false,
      env: config,
    })
    return encode(program)
  }

  /**
   * Evaluate bytecode compiled within this environment.
   * @param {Uint8Array} bytecode
   * @param {object} [activation]
   * @returns {*}
   */
  evaluate(bytecode, activation) {
    const program = decode(bytecode)
    const config = this.toConfig()
    return evalProgram(program, activation || {}, config.functionTable)
  }

  /**
   * Convenience: compile + evaluate in one call.
   * @param {string} src
   * @param {object} [activation]
   * @returns {*}
   */
  run(src, activation) {
    const bytecode = this.compile(src)
    return this.evaluate(bytecode, activation)
  }

  toConfig() {
    // Build ordered function table (array indexed by id - CUSTOM_ID_BASE)
    const functionTable = new Array(this._nextCustomId - CUSTOM_ID_BASE)
    for (const { id, impl } of this._functions.values()) {
      functionTable[id - CUSTOM_ID_BASE] = impl
    }
    for (const { id, impl } of this._methods.values()) {
      functionTable[id - CUSTOM_ID_BASE] = impl
    }

    return {
      constants: new Map(this._constants),
      customFunctions: new Map(this._functions),
      customMethods: new Map(this._methods),
      declaredVars: this._declaredVars ? new Map(this._declaredVars) : null,
      functionTable,
    }
  }
}
