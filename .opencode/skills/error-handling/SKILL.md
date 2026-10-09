---
name: error-handling
description: Error envelopes, boundaries, and never-swallow rules for APIs and UI. Use when writing fallible logic on either side.
license: MIT
compatibility: opencode
---

## What I do

- Make every failure explicit, typed, and safe to show.

## When to use me

Use when writing fallible logic — API handlers, services, data fetching, forms.

## Rules

1. **Backend envelope:** errors return the shared shape (`code`, `message`, per-field `details`); 4xx for caller faults, 5xx for ours; never stack traces or SQL text to clients — log those server-side with a correlation id.
2. **Never swallow:** no empty `catch`, no ignored rejections; each layer either handles, enriches-and-rethrows, or declares.
3. **UI boundaries:** every async flow renders loading → success | friendly-error-with-retry; forms show field-level errors plus a summary.
4. **Fail fast:** validate at system boundaries (request schemas, function preconditions) and reject with clear messages before side effects.
