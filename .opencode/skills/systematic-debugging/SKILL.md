---
name: systematic-debugging
description: Reproduce-isolate-fix-verify loop for defects and flaky behavior. Use when facing a bug, test failure, or unexpected behavior.
license: MIT
compatibility: opencode
---

## What I do

- Replace guessing with a 4-phase loop that ends in proof.

## When to use me

Use when facing a bug, a failing test, or behavior you cannot explain yet.

## Loop

1. **Reproduce:** write the smallest deterministic reproduction (script or test). If it is flaky, loop it until it fails on demand. No reproduction — no fix yet.
2. **Isolate:** narrow the suspect surface by halves (bisect inputs, disable layers, add tracing at boundaries). State the hypothesis before each probe.
3. **Fix:** change one thing, the minimal thing. Explain why the old behavior produced the symptom, not just that the symptom is gone.
4. **Verify:** re-run the reproduction plus the surrounding suite (`bun test`). A fix without a regression test is a draft.
