#!/usr/bin/env node

import { compile, evaluate, fromBase64, toBase64, run } from '../src/index.js'

const args = process.argv.slice(2)

function printUsage() {
  console.log(`Usage:
  cel <expression> [--vars '<json>']       Evaluate a CEL expression
  cel compile <expression>                 Compile to Base64 bytecode
  cel eval <base64> [--vars '<json>']      Evaluate Base64 bytecode
  cel --help                               Show this help

Examples:
  cel "1 + 2"
  cel "name.startsWith('J')" --vars '{"name": "Jane"}'
  cel compile "x > 10"
  cel eval "AAIB..." --vars '{"x": 42}'`)
}

function coerceValues(obj) {
  if (obj === null || typeof obj !== 'object') {
    if (typeof obj === 'number' && Number.isInteger(obj)) return BigInt(obj)
    return obj
  }
  if (Array.isArray(obj)) return obj.map(coerceValues)
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k] = coerceValues(v)
  return out
}

function parseVars(args) {
  const idx = args.indexOf('--vars')
  if (idx === -1 || idx + 1 >= args.length) return {}
  try {
    return coerceValues(JSON.parse(args[idx + 1]))
  } catch {
    console.error('Error: --vars must be valid JSON')
    process.exit(1)
  }
}

function formatValue(val) {
  if (typeof val === 'bigint') return String(val)
  if (val instanceof Uint8Array) return `bytes(${Buffer.from(val).toString('hex')})`
  if (val === null) return 'null'
  if (typeof val === 'object') return JSON.stringify(val, (_, v) => typeof v === 'bigint' ? Number(v) : v, 2)
  return String(val)
}

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  printUsage()
  process.exit(0)
}

try {
  if (args[0] === 'compile') {
    if (args.length < 2) {
      console.error('Error: compile requires an expression')
      process.exit(1)
    }
    const bytecode = compile(args[1])
    console.log(toBase64(bytecode))
  } else if (args[0] === 'eval') {
    if (args.length < 2) {
      console.error('Error: eval requires a Base64 bytecode string')
      process.exit(1)
    }
    const bytecode = fromBase64(args[1])
    const vars = parseVars(args.slice(1))
    const result = evaluate(bytecode, vars)
    console.log(formatValue(result))
  } else {
    const expr = args[0]
    const vars = parseVars(args)
    const result = run(expr, vars)
    console.log(formatValue(result))
  }
} catch (err) {
  console.error(`Error: ${err.message}`)
  process.exit(1)
}
