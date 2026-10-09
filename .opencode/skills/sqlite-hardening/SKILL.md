---
name: sqlite-hardening
description: SQLite WAL mode, busy timeouts, foreign keys, and parameterized queries for Bun CI runners. Use when configuring or querying SQLite.
license: MIT
compatibility: opencode
---

## What I do

- Enforce CI-safe SQLite: WAL mode, 5000ms busy timeout, foreign keys on.
- Enforce parameterized queries; reject string-interpolated SQL.

## When to use me

Use when creating schemas, writing queries, or debugging locking in GitHub Actions.

## Rules

1. **WAL mode at startup:**
   ```sql
   PRAGMA journal_mode = WAL;
   PRAGMA synchronous = NORMAL;
   PRAGMA busy_timeout = 5000;
   ```
2. **Foreign keys:** `PRAGMA foreign_keys = ON;` (SQLite defaults them off).
3. **Location:** database file under a dedicated folder, e.g. `workspace/data/app.db`; create the parent folder first.
4. **Queries:** always prepared statements with placeholders:
   - ✅ `db.query("SELECT * FROM tasks WHERE id = ?").get(taskId)`
   - ❌ NEVER: `` db.run(`DELETE FROM tasks WHERE id = '${taskId}'`) ``
5. **Production parity:** schema code must run on SQLite in CI and migrate cleanly to PostgreSQL via the ORM (Drizzle/Prisma) — no raw dialect lock-in.
