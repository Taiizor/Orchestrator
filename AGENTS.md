# 🤖 Agent Operational Constitution & Directives (`AGENTS.md`)

This document defines the rules, roles, constraints, quality gates, and inter-agent communication protocols for the autonomous software engineering team operating within GitHub Actions and OpenCode.

---

## 1. Agent Ecosystem & Responsibilities Matrix

| Role | Name | Primary Mission | Key Deliverables | Scope Boundaries |
| :--- | :--- | :--- | :--- | :--- |
| **Orchestrator** | `orchestrator` | Plans roadmap DAG, decomposes tasks, monitors execution, reviews diffs, merges branches. | `state/roadmap.json`, `state/PROGRESS.md`, PR Merges, Releases | Does not write application code; oversees subagents. |
| **System Architect** | `architect` | Initializes project foundation, sets up SQLite schemas, shared TypeScript contracts. | `workspace/package.json`, `workspace/src/db/schema.ts`, `workspace/CONTRACTS.md` | Focuses on foundation, types, and database initialization. |
| **Backend Developer** | `backend` | Implements API endpoints, controllers, business services, and database queries. | `workspace/src/api/**`, `workspace/src/services/**`, unit tests | Strictly adheres to SQLite & updates `CONTRACTS.md`. |
| **Frontend Developer**| `frontend` | Builds responsive UI, components, styling, and client-side state. | `workspace/src/ui/**`, client bundler configs, assets | Connects exclusively to documented backend contracts. |
| **QA Engineer** | `qa` | Writes automated unit and integration tests using `bun test`. | `workspace/tests/**`, test execution logs | Focuses on test coverage, edge cases, and verification. |
| **Security Auditor** | `security` | Audits SQL injection (SQLite), secret leaks, path traversal, payload size limits. | `workspace/SECURITY_AUDIT.md` | Does not introduce new features; audits and hardens. |
| **Code Reviewer** | `reviewer` | Evaluates clean code standards, error boundaries, edge cases, regression risks. | Review evaluation JSON & comments | Evaluates PR branches before merge approval. |
| **Progress Tracker** | `tracker` | Audits `TASK_PROGRESS.md` claims against actual git diffs to eliminate hallucinations. | Progress audit reports | Validates claims against raw git diffs. |

---

## 2. Universal CI/CD Constraints (STRICT & UNCOMPROMISING)

Every subagent MUST adhere to these environmental rules:
1. **Runtime & Package Manager:** **Bun is the sole runtime and package manager.**
   - NEVER invoke `node`, `npm`, `npx`, `pnpm`, or `yarn`.
   - Always run commands via `bun run`, `bun test`, `bun add`, or `bunx`.
2. **Zero-Infrastructure CI Execution & Production-Ready Migration Strategy:**
   - **No Live External Daemons in CI:** GitHub Actions runners cannot connect to external live production databases (PostgreSQL, MySQL, Redis, MongoDB). Code executed in CI must run with **zero external infrastructure dependencies**.
   - **Database Architecture (Universal ORMs & Migration Parity):** If the target project requires PostgreSQL or MySQL, architects and developers MUST use a multi-dialect ORM (e.g. **Drizzle ORM**, **Prisma**, or **Kysely**):
     - **In CI / Development:** Configured to run on local SQLite (`bun:sqlite` or SQLite driver) with WAL mode enabled (`PRAGMA journal_mode = WAL;`). All unit/integration tests and database operations execute cleanly out-of-the-box in GitHub Actions.
     - **In Production:** Provide modular migration scripts and environment variables (e.g. `DATABASE_URL=postgres://...`). The schema models and business queries must be written using ORM abstraction so deploying to production PostgreSQL is seamless and requires zero code refactoring.
   - **Cache & Message Brokers (Adapter Fallback Pattern):**
     - If Redis or message queues are required by the project specifications, design them using the **Adapter Pattern** (`CacheService`).
     - In CI runners (where `process.env.REDIS_URL` is unset), the service MUST transparently fall back to an `InMemoryCache` / local Map without crashing or hanging.
     - In production, setting `REDIS_URL` activates the real Redis client.
   - **Object Storage:** Use local directory storage (`workspace/data/uploads`) during CI; support S3/R2 via environment variables in production.
3. **Timeouts & Execution:** Every subagent workflow has a strict **35-minute timeout**.
   - Tasks must be atomic, focused, and completed well within this window.
4. **Non-Interactive Execution:** You are running in a headless CI/CD runner.
   - Never run commands that prompt for user confirmation (`y/n`, input prompts). Always use `--yes`, `-y`, or non-interactive flags.
5. **Isolated Task Branches & Target Files Discipline:**
   - Never commit directly to `main` or `develop`. All work must occur on `task/<taskId>` branches.
   - Only modify files assigned in `targetFiles`. Do not modify unrelated modules to avoid merge conflicts with sibling subagents.
6. **Dual-Repo Data Discipline (when `DATA_REPO` is set):**
   - `inputs/`, `workspace/` and `state/` are private: they arrive via data-remote sync and are `.gitignore`d here. NEVER force-push them to the public origin; content goes to the data remote only (`publishTaskBranch`, `persistRoadmapToData`).
   - Content-branch reads/diffs/merges/PRs/discussions always target the data remote. `main` on public origin carries engine code only (humans).
   - Issues, board cards and dashboard stay public: keep them free of secrets — bodies render redacted automatically, but prefer generic task titles.

---

## 3. GitHub Projects (v2) Kanban Lifecycle

Every task transitions through standard Kanban board states tracked via GitHub Issues and `gh project`:
1. 📋 **`Todo`**: Task is queued, awaiting dependency completion.
2. ⚡ **`In Progress`**: Subagent workflow dispatched and actively executing on dedicated branch.
3. 🔍 **`In Review`**: Subagent finished execution, tests passed, deliverables pushed; awaiting Orchestrator quality review.
4. ✅ **`Done`**: Quality gate passed, merged into `develop`, linked GitHub Issue closed.
5. 🔄 **`Rework (Todo)`**: If review fails, task status reverts to `Todo` with specific reviewer feedback in `reviewNotes`.

---

## 4. Cross-Agent Contract Protocol (`workspace/CONTRACTS.md`)

To eliminate integration friction between parallel subagents:
- **Architect & Backend Agents:** Whenever a schema, data model, or API endpoint is created or altered, the agent **MUST** update `workspace/CONTRACTS.md` with:
  - Exact endpoint paths and HTTP verbs (e.g. `POST /api/tasks`).
  - Request body schemas and query parameters.
  - Expected JSON response structures and HTTP status codes.
- **Frontend & QA Agents:** **MUST** read `workspace/CONTRACTS.md` and build UI calls / tests adhering strictly to these documented contracts without guessing.

---

## 5. Progress Tracking Protocol (Done, Doing, Todo & Test Proof)

Every subagent MUST create and maintain `workspace/TASK_PROGRESS.md` before concluding execution:
- **1. ✅ Done:** Concrete list of created/modified files, functions, and interfaces.
- **2. ⚡ Doing:** Current operational status and summary of actions taken.
- **3. 📋 Todo:** Deferred items or instructions for downstream dependencies.
- **4. 🧪 Verification & Test Proof:** **Actual terminal output of tests (`bun test`) proving 0 failures.**
  - *No claims without proof.* Subagents must run tests before pushing. The runner embeds the actual terminal output into this section.

---

## 6. ChatOps & Human Operator Steering Protocol

Human operators can steer, pause, or direct the autonomous team via GitHub Issue comments on the Master Dashboard Issue:
- `/pause`: Halts dispatching of new tasks. Active subagents safely complete their current task.
- `/resume`: Resumes scheduling and task dispatching.
- `/directive <TASK-ID> "instruction"`: Injects an urgent directive into a task. If active, the Orchestrator cancels the workflow run (`gh run cancel`), applies the directive to `reviewNotes`, and re-dispatches the subagent.
- `/retry <TASK-ID>`: Resets retry counter to 0 and re-queues a failed or stuck task.
- `/status`: Generates an immediate real-time progress snapshot comment.
- `/discuss <TASK-ID> "message"`: Relays a message to the task's agent discussion thread (`DiscussionManager`); the agent reads recent replies on its next attempt.
- `/setup [public|data|all]`: Audits & repairs repo features (issues/wiki/projects/discussions) on the public and/or data repo.
- `/ask <question>`: Answers from live roadmap state (one LLM call, cited task IDs).
- `/add <role> "title" -- "description" [deps:A,B] [milestone:M]`: Queues a DAG-validated PENDING task (issue/board sync next tick; no targetFiles scoping — planner normally assigns it).
- `/log <TASK-ID>`: Tails recent subagent run logs for that task.
- `/revise <TASK-ID> "change"`: Reworks a finished task — reopens it plus transitive dependents (cascade rebuild), resets attempts, reopens issues.

Subagents encountering an `[OPERATOR DIRECTIVE]` in their prompt MUST prioritize it above all default assumptions.

ChatOps notes: command words are typo-tolerant (edit distance ≤ 2, e.g. `/staus` → `/status`); unknown `/commands` get a help reply. Slash comments are handled by a dedicated fast-lane job (`chatops` singleton, ~1 min) in parallel to the main tick; rocket-reaction idempotency prevents double-processing.

---

## 7. Phased Quality Gate & Merge Conflict Resolution

Before any task branch is merged into `develop`:
1. **Phased Quality Gate:**
   - **Deterministic Gate (`orchestrator/review_gate.ts`):** Empty diff, missing `TASK_PROGRESS.md` sections, out-of-scope files, and secret patterns fail fast with no LLM cost. API/schema changes without `CONTRACTS.md` update warn.
   - **Functional Review:** Code Reviewer verifies deliverables match requirements. Unparseable reviewer output counts as rejection, never silent approval.
   - **Security Audit:** Security subagent verifies SQLite parameterization and zero secrets.
   - **Test Evidence:** QA verification confirms 0 failed unit/integration tests.
2. **PR Integration (`orchestrator/pr_manager.ts`):**
   - Approved work opens (or reuses) a PR `task/<id>` → `develop`; the review summary is posted as a PR comment.
   - `gh pr merge` is tried first; unmergable PRs fall back to local merge + AI conflict resolution (verified with `bun test` in `workspace/`).
   - Rejections are mirrored onto the open PR for traceability.
3. **Autonomous Conflict Resolution:**
   - If git merge produces conflict markers (`<<<<<<< HEAD`), `ConflictResolver` invokes OpenCode to reconcile both changes, validates with `bun test`, and commits the resolved merge.
   - If tests fail after conflict resolution, merge is aborted and flagged for safety.
4. **GitHub Hygiene:**
   - Task issues are deduplicated by `[TASK-ID]` title prefix (`ProjectManager.findTaskIssue` adopts the canonical issue; duplicates are closed as `--duplicate-of`).
   - Closed milestones with unfinished tasks are reopened by `ensureMilestones`; completed ones are closed only when all their tasks are `COMPLETED`.
   - Agent coordination happens in per-task discussion threads (`DiscussionManager`); operators can relay via `/discuss`.
