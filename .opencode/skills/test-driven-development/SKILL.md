---
name: test-driven-development
description: RED-GREEN-REFACTOR cycle for new behavior. Use when implementing any feature, fix, or endpoint before writing production code.
license: MIT
compatibility: opencode
---

## What I do

- Force the failing-first discipline so tests prove behavior instead of decorating it.

## When to use me

Use when implementing any feature, fix, or endpoint — before writing production code.

## Cycle

1. **RED:** write one failing test that captures the required behavior. Run it, watch it fail for the right reason.
2. **GREEN:** write the minimal production code that makes it pass. No extra generality.
3. **REFACTOR:** clean up duplication while the suite stays green.
4. Repeat per behavior, not per file. Delete production code that was written before its test.
