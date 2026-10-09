# Skill: SQLite Performance, Concurrency & CI Hardening

Use this skill when configuring or querying SQLite inside GitHub Actions.

## Best Practices:
1. **WAL Mode (Write-Ahead Logging):**
   Execute at database startup:
   ```sql
   PRAGMA journal_mode = WAL;
   PRAGMA synchronous = NORMAL;
   PRAGMA busy_timeout = 5000;
   ```
   This prevents database locking issues when multiple concurrent connections read and write.
2. **Foreign Keys:**
   Always enable foreign keys explicitly (SQLite disables them by default):
   ```sql
   PRAGMA foreign_keys = ON;
   ```
3. **Database Location:**
   Store database file inside a dedicated folder, e.g., `workspace/data/app.db`. Ensure the parent folder exists before instantiating the database.
