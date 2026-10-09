---
name: api-design
description: REST conventions for status codes, pagination, errors, versioning, and idempotency. Use when designing or reviewing HTTP APIs.
license: MIT
compatibility: opencode
---

## What I do

- Keep every endpoint predictable: same status semantics, same paging, same error shape.

## When to use me

Use when designing or reviewing HTTP APIs.

## Rules

1. **Status codes:** 200 read/update, 201 create (with resource location), 400 validation, 401 unauthenticated, 403 unauthorized, 404 unknown resource, 409 conflict, 422 semantically invalid, 500 server fault. No 200-with-error-body.
2. **Errors:** one shape everywhere — machine-readable `code`, human `message`, per-field `details` for validation failures.
3. **Pagination:** cursor-based with `limit` cap; envelope `{ data, nextCursor }`. Never unbounded lists.
4. **Versioning:** version in path (`/v1/...`) from day one; never break a shipped contract — add, don't alter.
5. **Idempotency:** state-changing POSTs accept `Idempotency-Key`; retries with the same key return the original result.
6. **Methods:** GET never mutates; PUT full replace, PATCH partial; DELETE idempotent.
