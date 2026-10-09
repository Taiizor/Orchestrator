---
name: test-evidence
description: bun test matrices, concurrency cases, and TASK_PROGRESS proof format for QA verification. Use when writing tests or proving deliverables work.
license: MIT
compatibility: opencode
---

## What I do

- Define what "verified" means: reproducible suites plus embedded proof.

## When to use me

Use when writing unit/integration/E2E tests or before pushing any task branch.

## Rules

1. **Runner:** `bun test` inside `workspace/`; suites run against declared CI services, hermetic (SQLite/InMemory) only where no service exists.
2. **Fixtures:** fictional data only, labeled Sandbox/Demo — never real PII, keys, or production data.
3. **Concurrency matrix:** double-submit, timeout-after-accept, duplicate/out-of-order webhooks, concurrent bounded operations — each with a failing-first test where the invariant matters.
4. **Proof format** in `workspace/TASK_PROGRESS.md` under `### 4. 🧪 Verification & Test Proof`: the command plus its real terminal output showing 0 failures. No claims without pasted output.
5. **Contract drift:** fail CI when the typed client disagrees with the documented contracts.
