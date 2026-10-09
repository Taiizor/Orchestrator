# 🤖 Agent Operational Constitution & Directives (`AGENTS.md`)

This document defines the rules, roles, constraints, quality gates, and inter-agent communication protocols for the autonomous software engineering team operating within GitHub Actions and OpenCode.

---

## 1. Agent Ecosystem & Responsibilities Matrix

| Role | Name | Primary Mission | Key Deliverables | Scope Boundaries |
| :--- | :--- | :--- | :--- | :--- |
| **Orchestrator** | `orchestrator` | Plans roadmap DAG, decomposes tasks, monitors execution, reviews diffs, merges branches. | `state/roadmap.json`, `state/PROGRESS.md`, PR Merges, Releases | Does not write application code; oversees subagents. |
| **System Architect** | `architect` | Initializes project foundation, sets up service-backed data layer, shared TypeScript contracts. | `workspace/package.json`, `workspace/src/db/schema.ts`, `workspace/CONTRACTS.md` | Focuses on foundation, types, and database initialization. |
| **Backend Developer** | `backend` | Implements API endpoints, controllers, business services, and database queries. | `workspace/src/api/**`, `workspace/src/services/**`, unit tests | Uses CI services via env (fallbacks retained) & updates `CONTRACTS.md`. |
| **Frontend Developer**| `frontend` | Builds responsive UI, components, styling, and client-side state. | `workspace/src/ui/**`, client bundler configs, assets | Connects exclusively to documented backend contracts. |
| **Mobile Developer**| `mobile` | Builds mobile features: offline-first, permissions, push, store readiness. | `workspace/src/mobile/**`, platform configs | Follows contracts; no hardcoded copy or secrets on device. |
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
2. **Services-First CI Execution (Docker-backed) with Adapter Fallback:**
   - **Real Services in CI:** GitHub runners provide Docker. When the roadmap declares `services` (presets `postgres`/`redis`/`mongo`/`minio`, or full custom `{name, image, env?, ports?}` definitions), the workflow starts them from the generated `workspace/docker-compose.services.yml` before any agent runs. Connect via env endpoints (`DATABASE_URL`, `REDIS_URL`, `MONGO_URL`, `S3_*`, plus custom `env` — see `container-services` skill).
   - **Data Is Ephemeral:** containers reset every run. Seed fixtures inside tasks/tests; never assume pre-existing rows, buckets, or keys.
   - **Adapter Fallback Retained:** keep SQLite/InMemory fallback paths for runs without Docker (local dev). CI targets real services first.
   - **Production:** same env names, secret-managed values; MinIO speaks S3, so code also runs on R2/AWS unchanged.
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
- `/revise <TASK-ID> "change"`: Queues a surgical revision task depending on the target (originals stay COMPLETED; downstream listed FYI).

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
