---
name: backend-structure
description: Layered service architecture with repository abstraction and thin handlers. Use when scaffolding or extending backend code.
license: MIT
compatibility: opencode
---

## What I do

- Keep handlers thin, logic testable, and storage swappable.

## When to use me

Use when scaffolding or extending backend code (routes, services, data access).

## Rules

1. **Layers:** route handler (parse/validate/respond) → service (business rules, transactions) → repository (storage only). No SQL in handlers, no HTTP in repositories.
2. **Dependency direction:** services depend on repository interfaces, never on concrete drivers — this is what makes SQLite-in-CI / Postgres-in-prod a config change.
3. **Small units:** functions under ~50 lines, one job each; shared helpers live in services, not copy-pasted across routes.
4. **Boundaries validate:** request schemas at the edge; services assert invariants (tenancy, amounts, state transitions) before mutating.
