---
name: sql-review
description: Transactions, indexes, N+1 queries, and migration discipline for relational schemas. Use when writing or reviewing SQL, schemas, or migrations.
license: MIT
compatibility: opencode
---

## What I do

- Catch the classic relational pitfalls before they reach review.

## When to use me

Use when writing or reviewing SQL, schemas, or migrations.

## Checklist

1. **Transactions:** multi-statement writes run in one transaction with proper isolation; every path commits or rolls back.
2. **Indexes:** foreign keys, filter columns, and sort columns indexed; verify with the query plan, not intuition.
3. **N+1:** loops issuing per-row queries become joins or batched `IN` queries.
4. **Migrations:** forward-only, small, reversible where possible; seed data separated from schema; never edit an applied migration — add a new one.
5. **Constraints:** uniqueness, not-null, and checks enforced in the database, not just in application code.
6. **Types:** money as integer minor units, timestamps UTC, booleans explicit — no floats for exact values.
