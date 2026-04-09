# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CEL-VM is a high-performance Common Expression Language (CEL) evaluator in JavaScript using a bytecode VM. No runtime dependencies. Target: 5–15× faster than tree-walker interpreters on repeated evaluation.

## Rules of Thumb

- If we diverge from cel-spec, document that in README.md
- Any changes in the implementation/architecture must be reflected in IMPLEMENTATION.md
- Any changes to usage must be documented in DOCS.md
- **Performance analysis required:** When planning or implementing changes, always analyse impact on both **compile-time** (lexer → parser → checker → compiler → bytecode encoding) and **run-time** (VM dispatch loop, `evaluate()` hot path). The project's core value proposition is ~24× faster repeated evaluation — changes that degrade the hot path must be justified. Run `bun run bench/compare.js` before and after to verify.

## Workflow

This project uses **git flow**: `main` is release, `develop` is integration, features go in `feature/*` branches.

## Commands

```bash
# Run all tests
bun test

# Run a single test file
bun test test/lexer.test.js

# Run tests matching a pattern
bun test --test-name-pattern "string literals"

# Benchmark vs marcbachmann/cel-js
bun run bench/compare.js
```

Bun is the build system/task runner; the output runs on Node. Check `package.json` for defined scripts.

## Architecture

The pipeline is strictly sequential: source string → Lexer → Parser → Checker → Compiler → VM.

```
src/lexer.js     — hand-written tokeniser; no parser generators
src/parser.js    — recursive-descent, returns plain-object AST nodes
src/checker.js   — type inference + CEL macro expansion
src/compiler.js  — AST → bytecode; constant folding, short-circuit jumps
src/bytecode.js  — binary encode/decode (DataView over ArrayBuffer), Base64 ser/deser
src/vm.js        — plain while/switch dispatch loop (not a class, for V8 JIT)
src/index.js     — public API: compile(src), evaluate(bytecode, activation), load(b64)
```

Tests live in `test/cel-spec/` (ported from google/cel-spec conformance suite) and `test/marcbachmann/` (ported from marcbachmann/cel-js). Use Node's built-in `node:test` — no external test framework.

## Key Design Decisions

**VM is a plain function, not a class** — `while(pc < len) switch(opcode)` — helps V8 JIT.

**Variables are pre-resolved to integer indices** into the activation array at compile time; no string lookups during evaluation.

**Value representation** avoids boxing: flat `Uint32Array` pool with `[type: u8, lo: u32, hi: u32]` per value. Heap-allocate only for lists, maps, and long strings.

**Opcode set is capped at ~30–50 opcodes** to keep V8's branch predictor effective. Short-circuit `&&`/`||` uses `JUMP_IF_FALSE`/`JUMP_IF_TRUE`. Constant folding collapses literals at compile time (e.g. `1 + 2` → `PUSH_CONST 3`).

**Bytecode binary format:** `[magic 2B][version 1B][const pool][instructions][debug info][checksum]`. Each instruction: `opcode (1B)` + up to 2 operands (`u16`/`u32`). Serialised with `DataView`; Base64 via `btoa(String.fromCharCode(...bytes))`.

**Cache:** `Map<string, Uint8Array>` keyed on source expression. Base64 form is designed for JSON/DB/localStorage transport.

## Build Order

Per the project spec, implementation follows this sequence:
1. Port test suites (red-to-green approach)
2. Lexer
3. Parser
4. Checker
5. Compiler
6. VM
7. Bytecode serialiser
8. Public API
9. Benchmark
