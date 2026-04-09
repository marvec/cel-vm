// Type-level smoke test — verifies .d.ts accuracy.
// Run: bun x tsc --noEmit --strict --moduleResolution nodenext --module nodenext --target esnext test/types.test.ts

import {
  compile, evaluate, run, load, toB64,
  Environment,
  LexError, ParseError, CheckError, CompileError, EvaluationError,
  EnvironmentError, BytecodeError,
} from '../src/index.js'

// --- Core API ---

const bytecode: Uint8Array = compile('1 + 2')
const bytecode2: Uint8Array = compile('x > 0', { debugInfo: true, cache: false })
const result: unknown = evaluate(bytecode, { x: 10n })
const b64: string = toB64(bytecode)
const loaded: Uint8Array = load(b64)
const quick: unknown = run('1 + 2', { x: 1n })

// --- Environment API ---

const env = new Environment({ limits: { maxDepth: 32 } })
  .enableDebug()
  .registerConstant('MAX', 'int', 100n)
  .registerFunction('double', 1, (x) => (x as bigint) * 2n)
  .registerMethod('upper', 0, (s) => (s as string).toUpperCase())
  .registerVariable('x', 'int')

const envBytecode: Uint8Array = env.compile('double(x) + MAX')
const envResult: unknown = env.evaluate(envBytecode, { x: 5n })
const envQuick: unknown = env.run('double(x)', { x: 3n })

// toConfig returns the right shape
const config = env.toConfig()
const _constants: Map<string, { tag: number; value: unknown }> = config.constants
const _fns: Map<string, Array<{ id: number; impl: Function; arity: number }>> = config.customFunctions
const _ft: Function[] = config.functionTable

// --- Error types ---

const lexErr = new LexError('bad', 1, 1)
const _line: number = lexErr.line
const _col: number = lexErr.col

const parseErr = new ParseError('bad', 1, 1)
const _pline: number = parseErr.line
const _pcol: number = parseErr.col

const _checkErr: CheckError = new CheckError('bad')
const _compErr: CompileError = new CompileError('bad')
const _evalErr: EvaluationError = new EvaluationError('bad')

const _envErr: EnvironmentError = new EnvironmentError('bad')
const _bcErr: BytecodeError = new BytecodeError('bad')

// All errors extend Error
const errors: Error[] = [lexErr, parseErr, _checkErr, _compErr, _evalErr, _envErr, _bcErr]
