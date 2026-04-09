---
title: "feat: Add timezone-aware timestamp accessors"
type: feat
status: completed
date: 2026-04-08
---

# feat: Add timezone-aware timestamp accessors

## Overview

All 10 timestamp accessor methods (`getFullYear`, `getMonth`, `getDayOfMonth`, `getDate`, `getDayOfWeek`, `getDayOfYear`, `getHours`, `getMinutes`, `getSeconds`, `getMilliseconds`) currently return UTC values only. The CEL spec defines an optional timezone argument — e.g. `timestamp.getHours("America/New_York")` or `timestamp.getHours("+02:00")` — that returns the component in the specified timezone. This feature enables 12 currently-skipped cel-spec conformance tests.

## Problem Statement / Motivation

The CEL spec requires timezone-aware accessor variants. Without them, users cannot write expressions like `now.getHours("US/Eastern") >= 9 && now.getHours("US/Eastern") < 17` (business hours check in a specific timezone). This is a conformance gap — 12 cel-spec tests are skipped.

## Proposed Solution

Modify the VM's `callBuiltin` function to branch on `argc`: when `argc === 1`, use the existing UTC path; when `argc === 2`, extract the timezone string from the stack and use `Intl.DateTimeFormat.formatToParts()` to compute components in that timezone.

**No changes needed in the compiler or bytecode module.** The compiler already passes `args.length + 1` as argc to `OP.CALL`, so `ts.getHours('tz')` naturally emits `CALL(GET_HOURS, 2)`. No new BUILTIN IDs or opcodes are required.

### Key design decisions

1. **`Intl.DateTimeFormat.formatToParts()`** — native API, zero dependencies, handles IANA names and fixed offsets, DST-aware for IANA zones. Use `hourCycle: 'h23'` and locale `'en-US'` for deterministic 0–23 hour output.

2. **Cache `Intl.DateTimeFormat` instances** keyed by timezone string. Construction is 10–24× slower than a cached `formatToParts()` call. A simple `Map` suffices — the practical key space is small (~500 IANA names + a bounded set of fixed offsets).

3. **Shared helper function** `getTimezoneComponents(ms, tz)` — calls `formatToParts` once and returns `{ year, month, day, hour, minute, second }`. All accessors consume this helper, avoiding duplicated conversion logic and off-by-one bugs.

4. **Bare offset normalization** — `"02:00"` (no sign) is normalized to `"+02:00"` before passing to `Intl`. Only the strict `HH:MM` format is accepted.

## Technical Considerations

### Architecture

Only `src/vm.js` changes. The modification is strictly in the `callBuiltin` function's existing BUILTIN case branches and a new helper function + cache at module scope.

### `getDayOfYear` and `getDayOfWeek` derivation

`formatToParts()` does not return day-of-year or day-of-week directly. These must be derived:

```js
// Extract year/month/day from formatToParts, then:
const utcDate = Date.UTC(year, month - 1, day);
const dayOfWeek = new Date(utcDate).getUTCDay();        // 0=Sun..6=Sat
const jan1 = Date.UTC(year, 0, 1);
const dayOfYear = Math.floor((utcDate - jan1) / 86400000); // 0-based
```

### Duration + timezone collision

`getHours`, `getMinutes`, `getSeconds` currently serve both timestamps and durations. When `argc === 2`:
- If receiver is a duration → return `celError("timezone not supported on duration")`
- If receiver is a timestamp → compute in timezone

The argc branch must happen **before** reading the receiver from the stack, since the receiver is at different positions depending on argc (`stack[sp]` for argc=1, `stack[sp-1]` for argc=2).

### Error handling

Wrap `Intl.DateTimeFormat` construction in try/catch. Invalid timezone strings (e.g. `"Fake/Zone"`) throw `RangeError` — convert to `celError("invalid timezone: '...'")`. Non-string timezone arguments return `celError("timezone argument must be a string")`.

### Performance

- Cached `formatToParts()` call is fast — comparable to a few `Date.getUTC*()` calls
- UTC path (argc=1) is unchanged — zero performance regression for the common case
- Cache is module-scoped, persists across evaluations

## System-Wide Impact

- **Interaction graph**: `callBuiltin()` is the only affected function. No callbacks, middleware, or observers.
- **Error propagation**: New errors follow the existing `celError()` pattern — value-based, no exceptions escape.
- **State lifecycle risks**: The `Intl.DateTimeFormat` cache is append-only and stateless per entry. No risk of inconsistent state.
- **API surface parity**: No public API changes. The existing `compile()` / `evaluate()` interface handles this transparently.
- **Integration test scenarios**: The 12 cel-spec tests cover the cross-layer scenario (source → lexer → parser → compiler → VM with timezone dispatch).

## Acceptance Criteria

- [ ] All 10 timestamp accessors accept an optional timezone string argument
- [ ] IANA timezone names work: `'America/New_York'`, `'Asia/Kathmandu'`, `'UTC'`, `'US/Central'`, `'Australia/Sydney'`, `'America/St_Johns'`
- [ ] Fixed UTC offsets work: `'+11:00'`, `'-02:30'`, `'-09:30'`, `'-00:00'`
- [ ] Bare offsets without sign work: `'02:00'` → treated as `'+02:00'`
- [ ] All 12 `timestamp_selectors_tz` tests in `test/cel-spec.test.js` pass (remove `.skip`)
- [ ] Duration accessors with timezone argument return `celError`
- [ ] Invalid timezone strings return `celError`, not thrown exceptions
- [ ] Non-string timezone arguments return `celError`
- [ ] `getMilliseconds` accepts timezone argument for consistency (returns same value regardless)
- [ ] UTC-only calls (no timezone arg) have zero performance regression
- [ ] No new runtime dependencies
- [ ] IMPLEMENTATION.md updated to document timezone-aware accessor support

## Success Metrics

- 12 previously-skipped cel-spec tests pass
- No regression in existing timestamp/duration tests
- Benchmark shows no measurable regression for UTC-only accessor calls

## Dependencies & Risks

| Risk | Mitigation |
|------|------------|
| `Intl.DateTimeFormat` doesn't support fixed offsets in older Node | Target Node 16+; project already requires modern JS features |
| Legacy IANA names (`US/Central`) not supported | Modern Node/Bun support these as aliases; confirmed in tests |
| Off-by-one in 0-based vs 1-based month/day | Shared helper function centralises the conversion; test expectations verify |
| Cache memory growth from user-supplied timezone strings | Practical bound is low; no eviction needed for the target use case |

## MVP

### `src/vm.js` — helper function (new, at module scope)

```js
const _tzFmtCache = new Map();

function getTimezoneComponents(ms, tz) {
  // Normalize bare offsets: "02:00" → "+02:00"
  if (/^\d{2}:\d{2}$/.test(tz)) tz = '+' + tz;

  let fmt = _tzFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    _tzFmtCache.set(tz, fmt);
  }

  const parts = fmt.formatToParts(new Date(ms));
  const m = {};
  for (const { type, value } of parts) m[type] = parseInt(value, 10);
  return m; // { year, month, day, hour, minute, second }
}
```

### `src/vm.js` — accessor case pattern (example: GET_HOURS)

```js
case BUILTIN.GET_HOURS: {
  if (argc === 2) {
    const tz = stack[sp]; const v = stack[sp - 1];
    if (!isStr(tz)) return celError('timezone argument must be a string');
    if (isDuration(v)) return celError('getHours() timezone not supported on duration');
    if (!isTimestamp(v)) return celError('getHours() requires timestamp');
    try {
      return BigInt(getTimezoneComponents(v.ms, tz).hour);
    } catch { return celError(`invalid timezone: '${tz}'`); }
  }
  const v = stack[sp];
  if (isDuration(v)) return BigInt(Math.trunc(v.ms / 3600000));
  if (!isTimestamp(v)) return celError('getHours() requires timestamp or duration');
  return BigInt(new Date(v.ms).getUTCHours());
}
```

### `src/vm.js` — derived accessors (getDayOfWeek, getDayOfYear)

```js
case BUILTIN.GET_DAY_OF_WEEK: {
  if (argc === 2) {
    const tz = stack[sp]; const v = stack[sp - 1];
    if (!isStr(tz)) return celError('timezone argument must be a string');
    if (!isTimestamp(v)) return celError('getDayOfWeek() requires timestamp');
    try {
      const c = getTimezoneComponents(v.ms, tz);
      return BigInt(new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay());
    } catch { return celError(`invalid timezone: '${tz}'`); }
  }
  const v = stack[sp];
  if (!isTimestamp(v)) return celError('getDayOfWeek() requires timestamp');
  return BigInt(new Date(v.ms).getUTCDay());
}
```

### `test/cel-spec.test.js` — unskip tests (lines 947–958)

Change all `it.skip(` to `it(` in the `timestamp_selectors_tz` describe block.

## Sources

- **Design origin:** [docs/plans/2026-04-08-002-design-timestamp-duration.md](docs/plans/2026-04-08-002-design-timestamp-duration.md) — deferred timezone-aware variants as a gap
- **Existing implementation:** `src/vm.js:449-505` (UTC accessors), `src/compiler.js:56-65` (method mappings), `src/bytecode.js:33-49` (BUILTIN IDs)
- **CEL spec tests:** `test/cel-spec.test.js:946-958` (12 skipped timezone tests)
- **Intl.DateTimeFormat docs:** [MDN: formatToParts](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/formatToParts)
- **Performance research:** V8 Blog on Intl API costs; Intl.DateTimeFormat construction is 10–24× slower than cached calls
