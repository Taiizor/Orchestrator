---
name: mobile-essentials
description: Offline-first data, permissions, push notifications, safe on-device storage, and store readiness for mobile apps. Use when building mobile features on any framework.
license: MIT
compatibility: opencode
---

## What I do

- Keep mobile apps usable offline, respectful of permissions, and shippable.

## When to use me

Use when building mobile features on any framework (native or cross-platform).

## Rules

1. **Offline-first:** reads serve cache instantly and sync in background; writes queue locally with conflict resolution; every screen has an offline/empty state.
2. **Permissions:** request in context with a plain-language reason, one at a time; degrade gracefully on denial; never require unrelated permissions.
3. **On-device storage:** no secrets, tokens, or PII in plaintext storage — Keychain/Keystore or encrypted store; tokens short-lived with refresh.
4. **Push:** permission priming before the system prompt; deep-link every notification to its screen; quiet hours respected.
5. **Store readiness:** versioned API contract with the backend, crash-free baseline verified, screenshots/copy finalized, privacy answers prepared.
