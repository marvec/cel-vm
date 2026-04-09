// Type definitions for cel-vm

/** CEL value type names used for constant and variable declarations. */
export type CelTypeName = 'int' | 'uint' | 'double' | 'string' | 'bool' | 'bytes' | 'null' | 'map' | 'list';

/** Options for `compile()`. */
export interface CompileOptions {
  /** Include line/column debug info in bytecode (default: `false`). */
  debugInfo?: boolean;
  /** Use compilation cache (default: `true`). */
  cache?: boolean;
  /** Environment config from `env.toConfig()`. Prefer `Environment.compile()` instead. */
  env?: EnvironmentConfig;
}

/** A single function or method overload entry. */
export interface FunctionOverload {
  id: number;
  impl: Function;
  arity: number;
}

/** Parser limits for DoS protection. */
export interface ParserLimits {
  maxAstNodes?: number;
  maxDepth?: number;
  maxListElements?: number;
  maxMapEntries?: number;
  maxCallArguments?: number;
}

/** Internal config produced by `Environment.toConfig()`. */
export interface EnvironmentConfig {
  constants: Map<string, { tag: number; value: unknown }>;
  customFunctions: Map<string, FunctionOverload[]>;
  customMethods: Map<string, FunctionOverload[]>;
  declaredVars: Map<string, string> | null;
  functionTable: Function[];
  limits: ParserLimits | null;
}

/**
 * Compile a CEL source string to bytecode.
 *
 * @param src - CEL expression
 * @param options - compilation options
 * @returns encoded bytecode
 * @throws {LexError | ParseError | CheckError | CompileError}
 */
export function compile(src: string, options?: CompileOptions): Uint8Array;

/**
 * Evaluate compiled bytecode against an activation map.
 *
 * @param bytecode - output of `compile()`
 * @param activation - variable bindings
 * @returns evaluation result
 * @throws {EvaluationError}
 */
export function evaluate(bytecode: Uint8Array, activation?: Record<string, unknown>): unknown;

/**
 * Load bytecode from a Base64 string.
 *
 * @param b64 - Base64-encoded bytecode
 * @returns decoded bytecode
 */
export function load(b64: string): Uint8Array;

/**
 * Serialise bytecode to Base64.
 *
 * @param bytecode - output of `compile()`
 * @returns Base64 string
 */
export function toB64(bytecode: Uint8Array): string;

/**
 * Convenience: compile + evaluate in one call, with caching.
 *
 * @param src - CEL expression
 * @param activation - variable bindings
 * @returns evaluation result
 * @throws {LexError | ParseError | CheckError | CompileError | EvaluationError}
 */
export function run(src: string, activation?: Record<string, unknown>): unknown;

/**
 * Declaration builder for CEL-VM environments.
 *
 * Register custom functions, constants, methods, and variable declarations.
 * Provides compile/evaluate/run methods that automatically inject the environment.
 */
export class Environment {
  constructor(options?: { limits?: ParserLimits });

  /**
   * Enable debug mode: compile emits source positions, evaluate enriches errors.
   */
  enableDebug(): this;

  /**
   * Register a compile-time constant.
   * Constants are substituted directly into bytecode — zero runtime cost.
   *
   * @param name - constant name
   * @param type - CEL type
   * @param value - constant value
   */
  registerConstant(name: string, type: CelTypeName, value: unknown): this;

  /**
   * Register a custom global function.
   *
   * @param name - function name as used in CEL expressions
   * @param arity - number of arguments
   * @param impl - JavaScript implementation
   */
  registerFunction(name: string, arity: number, impl: (...args: unknown[]) => unknown): this;

  /**
   * Register a custom method callable on a receiver value.
   *
   * @param name - method name as used in CEL expressions
   * @param arity - number of arguments excluding the receiver
   * @param impl - `(receiver, ...args) => result`
   */
  registerMethod(name: string, arity: number, impl: (receiver: unknown, ...args: unknown[]) => unknown): this;

  /**
   * Declare a variable. Calling this at least once enables strict mode:
   * the compiler will reject references to undeclared variables.
   *
   * @param name - variable name
   * @param type - CEL type name (informational)
   */
  registerVariable(name: string, type: string): this;

  /**
   * Compile a CEL expression within this environment.
   *
   * @param src - CEL expression
   * @param options - compilation options (debugInfo only)
   * @throws {LexError | ParseError | CheckError | CompileError}
   */
  compile(src: string, options?: { debugInfo?: boolean }): Uint8Array;

  /**
   * Evaluate bytecode compiled within this environment.
   *
   * @param bytecode - output of `env.compile()`
   * @param activation - variable bindings
   * @throws {EvaluationError}
   */
  evaluate(bytecode: Uint8Array, activation?: Record<string, unknown>): unknown;

  /**
   * Convenience: compile + evaluate in one call.
   *
   * @param src - CEL expression
   * @param activation - variable bindings
   * @throws {LexError | ParseError | CheckError | CompileError | EvaluationError}
   */
  run(src: string, activation?: Record<string, unknown>): unknown;

  /**
   * Produce a plain config object for low-level use with `compile()` and `evaluate()`.
   */
  toConfig(): EnvironmentConfig;
}

/** Tokenisation error with source location. */
export class LexError extends Error {
  line: number;
  col: number;
  constructor(msg: string, line: number, col: number);
}

/** Parse error with source location. */
export class ParseError extends Error {
  line: number;
  col: number;
  constructor(msg: string, line: number, col: number);
}

/** Type-checking / macro expansion error. */
export class CheckError extends Error {
  constructor(msg: string);
}

/** Compilation error (e.g. undeclared variable in strict mode). */
export class CompileError extends Error {
  constructor(msg: string);
}

/** Runtime evaluation error. */
export class EvaluationError extends Error {
  constructor(msg: string);
}

/** Environment configuration error. */
export class EnvironmentError extends Error {
  constructor(msg: string);
}

/** Bytecode decode/encode error. */
export class BytecodeError extends Error {
  constructor(msg: string);
}
