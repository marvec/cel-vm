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
import { evaluate as evalProgram, evaluateDebug as evalProgramDebug } from './vm.js'

// Const pool tags (must match bytecode.js / compiler.js)
const TAG_NULL   = 0
const TAG_BOOL   = 1
const TAG_INT64  = 2
const TAG_UINT64 = 3
const TAG_DOUBLE = 4
const TAG_STRING = 5
const TAG_BYTES  = 6

// First custom function BUILTIN ID (0–127 reserved for builtins)
const CUSTOM_ID_BASE = 128

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
  /**
   * @param {object} [options]
   * @param {object} [options.limits] — parser limits for DoS protection
   * @param {number} [options.limits.maxAstNodes]      — max AST nodes
   * @param {number} [options.limits.maxDepth]          — max nesting depth
   * @param {number} [options.limits.maxListElements]   — max list literal elements
   * @param {number} [options.limits.maxMapEntries]     — max map literal entries
   * @param {number} [options.limits.maxCallArguments]  — max function call arguments
   */
  constructor(options = {}) {
    this._constants = new Map()       // name → {tag, value}
    this._functions = new Map()       // name → [{id, impl, arity}]  (overloads)
    this._methods = new Map()         // name → [{id, impl, arity}]  (overloads)
    this._declaredVars = null         // null = permissive; Map = strict
    this._nextCustomId = CUSTOM_ID_BASE
    this._debug = false
    this._limits = options.limits || null
    this._cache = new Map()           // source string → Uint8Array
    this._configDirty = true          // invalidate cache on registration
    this._cachedConfig = null
  }

  /**
   * Enable debug mode: compile emits source positions, evaluate enriches errors.
   * @returns {this}
   */
  enableDebug() {
    this._debug = true
    return this
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
    this._invalidate()
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
    if (this._constants.has(name)) {
      throw new EnvironmentError(`'${name}' is already registered as a constant`)
    }
    const overloads = this._functions.get(name) || []
    if (overloads.some(o => o.arity === arity)) {
      throw new EnvironmentError(`'${name}' with arity ${arity} is already registered`)
    }
    const id = this._nextCustomId++
    overloads.push({ id, impl, arity })
    this._functions.set(name, overloads)
    this._invalidate()
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
    const overloads = this._methods.get(name) || []
    if (overloads.some(o => o.arity === arity)) {
      throw new EnvironmentError(`method '${name}' with arity ${arity} is already registered`)
    }
    const id = this._nextCustomId++
    overloads.push({ id, impl, arity })
    this._methods.set(name, overloads)
    this._invalidate()
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
    this._invalidate()
    return this
  }

  /** @private Invalidate caches when declarations change. */
  _invalidate() {
    this._cache.clear()
    this._configDirty = true
    this._cachedConfig = null
  }

  /**
   * Compile a CEL expression within this environment.
   * @param {string} src
   * @param {object} [options]
   * @returns {Uint8Array}
   */
  compile(src, options = {}) {
    const useCache = options.cache !== false
    if (useCache && this._cache.has(src)) return this._cache.get(src)

    const config = this.toConfig()
    const tokens  = tokenize(src)
    const ast     = parse(tokens, this._limits)
    const checked = check(ast)
    const program = compileAst(checked, {
      debugInfo: this._debug || options.debugInfo || false,
      env: config,
    })
    const bytes = encode(program)

    if (useCache) this._cache.set(src, bytes)
    return bytes
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
    const evalFn = this._debug ? evalProgramDebug : evalProgram
    return evalFn(program, activation || {}, config.functionTable)
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
    if (!this._configDirty && this._cachedConfig) return this._cachedConfig

    // Build ordered function table (array indexed by id - CUSTOM_ID_BASE)
    const functionTable = new Array(this._nextCustomId - CUSTOM_ID_BASE)
    for (const overloads of this._functions.values()) {
      for (const { id, impl } of overloads) {
        functionTable[id - CUSTOM_ID_BASE] = impl
      }
    }
    for (const overloads of this._methods.values()) {
      for (const { id, impl } of overloads) {
        functionTable[id - CUSTOM_ID_BASE] = impl
      }
    }

    this._cachedConfig = {
      constants: new Map(this._constants),
      customFunctions: new Map(this._functions),
      customMethods: new Map(this._methods),
      declaredVars: this._declaredVars ? new Map(this._declaredVars) : null,
      functionTable,
      limits: this._limits,
    }
    this._configDirty = false
    return this._cachedConfig
  }
}
