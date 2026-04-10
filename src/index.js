// CEL-VM public API
//
//   compile(src, options?)                        → Uint8Array  (or throws LexError | ParseError | CheckError | CompileError)
//   evaluate(bytecode, activation?, fnTable?)     → value       (or throws BytecodeError | EvaluationError)
//   program(src, options?)                        → (activation?) => value
//   run(src, activation?, options?)               → value       (convenience: compile + evaluate, with caching)
//   fromBase64(b64)                                → Uint8Array  (decode Base64 → bytecode; throws BytecodeError)
//   toBase64(bytecode)                             → string      (encode bytecode → Base64)

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
 * @param {object}  [options.env]             - environment config from env.toConfig()
 * @returns {Uint8Array} encoded bytecode
 */
export function compile(src, options = {}) {
  const useCache = options.cache !== false
  if (useCache && !options.env && cache.has(src)) return cache.get(src)

  const tokens  = tokenize(src)
  const limits  = options.env && options.env.limits ? options.env.limits : undefined
  const ast     = parse(tokens, limits)
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
 * @param {Uint8Array} bytecode              - output of compile()
 * @param {object}     [activation]          - variable bindings { name: value }
 * @param {Function[]} [customFunctionTable] - @internal function table from env.toConfig().functionTable
 * @returns {*} result value
 */
export function evaluate(bytecode, activation, customFunctionTable) {
  const program = decode(bytecode)
  return evalProgram(program, activation || {}, customFunctionTable)
}

export { fromBase64, toBase64 }

/**
 * Compile a CEL expression and return a callable function.
 * The returned function accepts an activation object and evaluates the expression.
 *
 * @param {string} src         - CEL expression
 * @param {object} [options]   - same options as compile()
 * @returns {(activation?: object) => *} callable that evaluates the expression
 */
export function program(src, options = {}) {
  const bytecode = compile(src, options)
  const functionTable = options.env ? options.env.functionTable : undefined
  return (activation) => evaluate(bytecode, activation || {}, functionTable)
}

/**
 * Convenience function: compile + evaluate in one call, with caching.
 *
 * @param {string} src         - CEL expression
 * @param {object} [activation] - variable bindings
 * @param {object} [options]   - same options as compile()
 * @returns {*} result value
 */
export function run(src, activation, options) {
  const bytecode = compile(src, options)
  const functionTable = options && options.env ? options.env.functionTable : undefined
  return evaluate(bytecode, activation || {}, functionTable)
}
