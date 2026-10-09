---
name: api-contracts
description: Keep workspace/CONTRACTS.md in sync with schemas and REST endpoints, including idempotency and financial invariants. Use when creating or changing any API or data model.
license: MIT
compatibility: opencode
---

## What I do

- Define the exact contract format every backend/architect agent must maintain.

## When to use me

Use when creating or altering a schema, table, endpoint, or response shape.

## Rules

1. **Document immediately** in `workspace/CONTRACTS.md`: route + method, request headers/body schema, response schemas per status code (200/201/400/404/500), validation rules.
2. **Money:** integer minor units + ISO currency; amounts immutable once processing begins.
3. **Idempotency:** `Idempotency-Key` on POST create/confirm paths; effectively-once webhook handling with `(provider_id, provider_event_id)` uniqueness.
4. **Tenancy:** every query tenant-scoped; public IDs (UUIDv4) opaque and non-secret.
5. **Never invent:** frontend and QA build strictly against documented contracts — no guessed paths or params.
6. **Collections:** cursor pagination with capped `limit` (`{ data, nextCursor }`); filtering/sorting via explicit query params, documented per endpoint.
7. **Rate limits:** document quotas and `429` + `Retry-After` behavior for public endpoints.
