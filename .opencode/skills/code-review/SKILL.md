---
name: code-review
description: Functional correctness, edge cases, test quality, and regression rubric for PR and task-branch reviews. Use when evaluating completed work.
license: MIT
compatibility: opencode
---

## What I do

- Judge deliverables against the task description and the actual git diff — never against claims alone.

## When to use me

Use when reviewing pull requests or evaluating subagent task completion.

## Review dimensions

1. **Functional correctness:** does the change do what the task description says?
2. **Scope:** only assigned `targetFiles` touched (plus `TASK_PROGRESS.md`)?
3. **Edge cases:** empty strings, nulls, malformed inputs, missing IDs handled?
4. **Tests:** deterministic, hermetic except declared Docker services (seeded Docker fixtures allowed; no third-party network), actually covering the new behavior — with stack-toolchain test proof present?
5. **Cleanliness:** no dead code, no debug leftovers, no unrelated refactors?
6. **No regressions:** existing suites still green?
7. **Verdict format:** `APPROVE` or `REQUEST_CHANGES` with file-cited findings.
