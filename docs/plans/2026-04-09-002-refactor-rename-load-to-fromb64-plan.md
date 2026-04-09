---
title: "refactor: Rename load() to fromB64() for API symmetry"
type: refactor
status: completed
date: 2026-04-09
---

# refactor: Rename `load()` to `fromB64()` for API symmetry

## Overview

The public API has an asymmetric naming pair: `toB64(bytecode)` serializes to Base64, but `load(b64)` deserializes from Base64. The internal `bytecode.js` module already uses the symmetric pattern (`toBase64` / `fromBase64`). Renaming `load` to `fromB64` restores symmetry, improves discoverability, and makes the API self-documenting.

## Problem Statement

`load` is ambiguous -- load from where? A file? A URL? `fromB64` immediately communicates what format is being decoded, matching the `toB64` counterpart. This is a pre-1.0 project with no published npm package, so now is the right time for a clean rename with no deprecation shim.

## Proposed Solution

Straight rename: `load` -> `fromB64` across all code, types, and living documentation. No deprecation alias (pre-release, no external consumers). Historical planning docs (`PLAN.md`, `brief.md`, `docs/plans/*.md`) are left as-is since they reflect intent at the time of writing.

## Acceptance Criteria

### Code changes

- [ ] `src/index.js` -- rename function declaration and update header comment (lines 5, 74)
- [ ] `src/index.d.ts` -- rename TypeScript declaration (lines 62-68)
- [ ] `bin/cel.js` -- update import and usage (lines 3, 69)
- [ ] `test/types.check.ts` -- update import and usage (lines 5, 17)

### Documentation changes

- [ ] `README.md` -- update section heading, import, and usage examples (lines 59, 62, 69-70)
- [ ] `DOCS.md` -- update section heading, description, import, and usage (lines 49, 51, 54, 57)
- [ ] `IMPLEMENTATION.md` -- update import and usage (lines 283, 298)
- [ ] `CLAUDE.md` -- update architecture summary (line 49)

### Verification

- [ ] `bun test` passes
- [ ] `bun run bench/compare.js` shows no performance regression (expected: zero impact, this is a pure rename)
- [ ] TypeScript type check passes: `npx tsc --noEmit test/types.check.ts`

## Technical Considerations

- **Performance impact:** Zero. This is a pure rename with no runtime behavior change. The function body remains a one-line delegation to `fromBase64` in `bytecode.js`.
- **Backwards compatibility:** Not needed. Project is v0.1.0, pre-release, not published to npm. Clean break is appropriate.
- **Internal naming:** `bytecode.js` keeps its `toBase64`/`fromBase64` names unchanged -- the public API abbreviates to `toB64`/`fromB64`.

## Files NOT changed (by design)

| File | Reason |
|------|--------|
| `src/bytecode.js` | Internal names already symmetric (`toBase64`/`fromBase64`) |
| `PLAN.md` | Historical planning doc, reflects original intent |
| `brief.md` | Historical project brief |
| `docs/plans/*.md` | Past plans, frozen at time of writing |
| `bench/*.js` | Benchmarks don't use `load`/`toB64` |

## MVP

### src/index.js

```javascript
// Header comment update
//   fromB64(b64)             -> Uint8Array  (decode Base64 -> bytecode; throws BytecodeError)

// Function rename
export function fromB64(b64) {
  return fromBase64(b64);
}
```

### src/index.d.ts

```typescript
export function fromB64(b64: string): Uint8Array;
```

### bin/cel.js

```javascript
import { compile, evaluate, fromB64, toB64 } from '../src/index.js';
// ...
const bytecode = fromB64(args[1]);
```

### README.md

```markdown
### toB64(bytecode) / fromB64(base64)
import { fromB64 } from 'cel-vm';
const bytecode = fromB64(b64);
```
