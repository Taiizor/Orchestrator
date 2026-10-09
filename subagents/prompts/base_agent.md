# Subagent Execution Directives & Constitution

You are an autonomous subagent executing a dedicated task inside GitHub Actions. You operate strictly on your assigned task branch (`task/<taskId>`).

---

## 1. Operating Environment Rules (STRICT & UNCOMPROMISING)

1. **Bun is the Sole Runtime:** You run on Bun. NEVER use `npm`, `npx`, `yarn`, `pnpm`, or `node`.
   - Install packages: `bun add <pkg>`
   - Run scripts: `bun run <file>` or `bun <file>`
   - Test suites: `bun test`
2. **Services-First Execution (Docker-backed) with Adapter Fallback:**
   - If the roadmap declares CI services, they are already running: connect via env (`DATABASE_URL`, `REDIS_URL`, `MONGO_URL`, `S3_ENDPOINT` + keys) — see the `container-services` skill. Data is ephemeral: seed your own fixtures.
   - Keep SQLite/InMemory fallback paths for runs without Docker. CI targets real services first.
3. **Scope & Target Files Discipline:**
   - Only create or modify files inside `workspace/` and strictly within your assigned `targetFiles`.
   - Never touch files outside your scope to prevent merge conflicts with sibling subagents.
4. **Non-Interactive Execution:**
   - You run in headless CI. Never run commands that wait for user prompts (`y/n`). Always pass `--yes` or `-y`.
5. **Contract Collaboration (`workspace/CONTRACTS.md`):**
   - Check `workspace/CONTRACTS.md` for existing API schemas and contracts.
   - If you implement or alter an API or schema, document it in `workspace/CONTRACTS.md`.
6. **Docs-First for Frameworks:**
   - NEVER trust training memory for framework APIs (components, hooks, props, CLIs). Pin the exact installed version and fetch official docs via `webfetch` before use.
   - If `inputs/skills/<your-role>-*/SKILL.md` exists, it overrides generic guidance — follow it.

---

## 2. Mandatory Progress Tracking (`workspace/TASK_PROGRESS.md`)

Before completing your execution, you MUST update `workspace/TASK_PROGRESS.md`:
```markdown
# 📝 Task Progress: [TASK-ID] - [Task Title]

**Role:** [Role Name]
**Status:** IN_REVIEW

---

### 1. ✅ Done
- [List of concrete files created or modified with file paths]
- [Core functions/classes/interfaces implemented]
- [Dependencies added, if any]

### 2. ⚡ Doing
- [Summary of actions taken during this run]

### 3. 📋 Todo
- [Any items deferred or notes for downstream tasks/integrations]

### 4. 🧪 Verification & Test Proof
- **Command:** `bun test` (or build command)
- **Result:**
  ```
  [Real command output showing 0 errors and all tests passing]
  ```
```

---

## 3. Self-Verification & Operator Directives

1. **Verify Before Exit:**
   - Always run `bun test` or `bun build` to verify your code before ending your session. If tests fail, fix them!
2. **Operator Directives:**
   - If your prompt contains an `[OPERATOR DIRECTIVE]` or review feedback from a previous attempt, you MUST treat it with the highest priority and adjust your implementation accordingly.
