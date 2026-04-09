// CEL-VM public API
//
//   compile(src, options?)   → Uint8Array  (or throws LexError | ParseError | CheckError | CompileError)
//   evaluate(bytecode, activation?)  → value  (or throws BytecodeError | EvaluationError)
//   load(b64)                → Uint8Array  (decode Base64 → bytecode; throws BytecodeError)
//   run(src, activation?)    → value  (convenience: compile + evaluate, with caching)

import { tokenize } from './lexer.js'
import { parse }    from './parser.js'
import { check }    from './checker.js'
import { compile as compileAst } from './compiler.js'
import { encode, decode, toBase64, fromBase64 } from './bytecode.js'
import { evaluate as evalProgram } from './vm.js'

// Re-export error types for user convenience
export { LexError }          from './lexer.js'
export { ParseError }        from './parser.js'
export { CheckError }        from './checker.js'
export { CompileError }      from './compiler.js'
export { EvaluationError }   from './vm.js'
export { EnvironmentError }  from './environment.js'
export { BytecodeError }     from './bytecode.js'
export { Environment } from './environment.js'

// Compiled bytecode cache: source string → Uint8Array
const cache = new Map()

/**
 * Compile a CEL source string to bytecode (Uint8Array).
 * Results are cached by source string.
 *
 * @param {string} src         - CEL expression
 * @param {object} [options]
 * @param {boolean} [options.debugInfo=false] - include line/col debug info
 * @param {boolean} [options.cache=true]      - use compilation cache
 * @returns {Uint8Array} encoded bytecode
 */
export function compile(src, options = {}) {
  const useCache = options.cache !== false
  if (useCache && !options.env && cache.has(src)) return cache.get(src)

  const tokens  = tokenize(src)
  const ast     = parse(tokens)
  const checked = check(ast)
  const program = compileAst(checked, {
    debugInfo: options.debugInfo || false,
    env: options.env || null,
  })
  const bytes   = encode(program)

  if (useCache && !options.env) cache.set(src, bytes)
  return bytes
}

/**
 * Evaluate encoded bytecode (Uint8Array) against an activation map.
 *
 * @param {Uint8Array} bytecode   - output of compile()
 * @param {object}     [activation] - variable bindings { name: value }
 * @returns {*} result value
 */
export function evaluate(bytecode, activation, customFunctionTable) {
  const program = decode(bytecode)
  return evalProgram(program, activation || {}, customFunctionTable)
}

/**
 * Load bytecode from a Base64 string (for transport via JSON/DB/localStorage).
 *
 * @param {string} b64 - Base64-encoded bytecode
 * @returns {Uint8Array}
 */
export function load(b64) {
  return fromBase64(b64)
}

/**
 * Serialise bytecode to Base64.
 *
 * @param {Uint8Array} bytecode
 * @returns {string} Base64 string
 */
export function toB64(bytecode) {
  return toBase64(bytecode)
}

/**
 * Convenience function: compile + evaluate in one call, with caching.
 *
 * @param {string} src         - CEL expression
 * @param {object} [activation] - variable bindings
 * @returns {*} result value
 */
export function run(src, activation, options) {
  const bytecode = compile(src, options)
  const functionTable = options && options.env ? options.env.functionTable : undefined
  return evaluate(bytecode, activation || {}, functionTable)
}
