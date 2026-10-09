---
name: documentation-discipline
description: README, runbook, and decision-record habits that keep docs alive. Use when finishing features or handing work over.
license: MIT
compatibility: opencode
---

## What I do

- Leave every deliverable runnable and explainable by a stranger.

## When to use me

Use when finishing features, closing tasks, or handing work over.

## Rules

1. **README:** setup (prereqs, install, env), run, test, and deploy in copy-pasteable commands — verified by following them cold.
2. **Runbook:** for anything operable — how to tell it is healthy, common failures with symptoms and fixes, rollback steps.
3. **Decision records:** any non-obvious choice (library, schema shape, tradeoff) gets a dated paragraph: context, options, decision, consequences.
4. **Living, not dumped:** update the docs touched by the change in the same branch; no separate "docs later" tasks.
