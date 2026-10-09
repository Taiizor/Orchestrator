---
name: external-integrations
description: Safe consumption of third-party APIs with versioning, retries, timeouts, and webhook verification. Use when integrating any external service.
license: MIT
compatibility: opencode
---

## What I do

- Keep third-party dependencies versioned, bounded, and mockable.

## When to use me

Use when integrating any external service (payments, email, maps, AI, storage).

## Rules

1. **Isolate:** one adapter module per provider behind an internal interface; business code never imports the vendor SDK directly — enables mocks and provider swaps.
2. **Bound every call:** explicit timeouts, retries with exponential backoff + jitter (max 3), circuit breaking on repeated failure.
3. **Webhooks:** verify signatures on raw bytes; enforce timestamp/replay windows; persist provider event ids for effectively-once handling.
4. **Keys:** sandbox vs production separation; keys from env only; version-pin the API you code against and handle deprecation headers.
