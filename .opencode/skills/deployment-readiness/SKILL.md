---
name: deployment-readiness
description: Twelve-factor config, health checks, migration-safe boot, and rollback plans for shippable services. Use before any release or environment change.
license: MIT
compatibility: opencode
---

## What I do

- Make every release boring: configured, observable, reversible.

## When to use me

Use before any release, environment change, or handoff to production.

## Checklist

1. **Config:** everything environment-specific comes from env vars with validated defaults; no hardcoded URLs, keys, or paths; example file documents every variable.
2. **Boot:** migrations run automatically and idempotently on startup; the service refuses traffic until ready (readiness probe distinct from liveness).
3. **Rollback:** every release notes how to revert (previous image/tag, migration downgrade or forward-fix); database changes are backward-compatible with the previous app version.
4. **CI gates:** build, tests, and security scan green before merge; tags immutable once released.
