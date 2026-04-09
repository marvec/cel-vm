# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-04-09

Initial public release.

### Features

- **Bytecode VM** — compile CEL expressions to bytecode, evaluate ~24x faster on repeated runs
- **Full pipeline** — Lexer, Parser, Checker, Compiler, VM, Bytecode serializer
- **Environment API** — custom functions, constants, variables, and parser limits
- **TypeScript types** — full `.d.ts` declarations with conditional exports
- **Debug mode** — source-mapping debug info via `Environment.debugInfo`
- **CLI** — `cel` command for evaluating expressions from the terminal
- **Base64 serialization** — transport bytecode via JSON, databases, or localStorage
- **Compilation cache** — automatic caching by source string
- **Error classes** — `LexError`, `ParseError`, `CheckError`, `CompileError`, `EvaluationError`, `BytecodeError`, `EnvironmentError`

### CEL Specification Conformance

- 86.9% cel-spec conformance (basic, comparisons, logic, strings, math, timestamps, durations, lists, maps, macros)
- String extensions: `charAt`, `lastIndexOf`, `join`, `lowerAscii`, `upperAscii`, `quote`
- Math extensions: `math.greatest`, `math.least`
- Timezone-aware timestamp accessors
- Unicode code-point semantics for string operations
- `dyn()` identity function and cross-type ordering
- Error short-circuit for `&&`/`||`/`!`
