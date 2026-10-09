---
name: performance-budgets
description: Bundle, latency, and query budgets with measure-first optimization. Use when setting performance targets or fixing slowness.
license: MIT
compatibility: opencode
---

## What I do

- Replace "make it fast" with numbers, then spend effort only where measured.

## When to use me

Use when setting performance targets or diagnosing slowness.

## Rules

1. **Budgets first:** client bundle size, p95 API latency, and per-screen query counts get explicit numbers before optimization begins.
2. **Measure, then cut:** profile (bundle analyzer, query plans, flame/path timing) before changing code; re-measure after.
3. **Usual suspects:** N+1 queries, unbounded lists, render loops, unindexed filters, oversized images/assets, blocking startup work.
4. **Guardrails:** budgets enforced in CI (bundle check, slow-test threshold) so regressions fail the build, not the user.
