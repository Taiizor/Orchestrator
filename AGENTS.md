# 🤖 Agent Operational Constitution & Directives (`AGENTS.md`)

This document defines the rules, roles, constraints, quality gates, and inter-agent communication protocols for the autonomous software engineering team operating within GitHub Actions and OpenCode.

---

## 1. Agent Ecosystem & Responsibilities Matrix

| Role | Name | Primary Mission | Key Deliverables | Scope Boundaries |
| :--- | :--- | :--- | :--- | :--- |
| **Orchestrator** | `orchestrator` | Plans roadmap DAG, decomposes tasks, monitors execution, reviews diffs, merges branches. | `state/roadmap.json`, `state/PROGRESS.md`, PR Merges, Releases | Does not write application code; oversees subagents. |
| **System Architect** | `architect` | Initializes project foundation, sets up Docker-backed data layer, shared contracts. | `workspace/` scaffolding per stack, `workspace/src/db/**`, `workspace/CONTRACTS.md` | Focuses on foundation, types, and database initialization. |
| **Backend Developer** | `backend` | Implements API endpoints, controllers, business services, and database queries. | `workspace/src/api/**`, `workspace/src/services/**`, unit tests | Uses Docker services via env & updates `CONTRACTS.md`. |
| **Frontend Developer**| `frontend` | Builds responsive UI, components, styling, and client-side state. | `workspace/src/ui/**`, client bundler configs, assets | Connects exclusively to documented backend contracts. |
| **Mobile Developer**| `mobile` | Builds mobile features: offline-first, permissions, push, store readiness. | `workspace/src/mobile/**`, platform configs | Follows contracts; no hardcoded copy or secrets on device. |
| **QA Engineer** | `qa` | Writes automated unit and integration tests with the product stack's runner. | `workspace/tests/**`, test execution logs | Focuses on test coverage, edge cases, and verification. |
| **Security Auditor** | `security` | Audits SQL injection (parameterized queries), secret leaks, path traversal, payload size limits. | `workspace/SECURITY_AUDIT.md` | Does not introduce new features; audits and hardens. |
| **Code Reviewer** | `reviewer` | Evaluates clean code standards, error boundaries, edge cases, regression risks. | Review evaluation JSON & comments | Evaluates PR branches before merge approval. Read-only auditor: may read the full repo/diffs, writes only to `TASK_PROGRESS.md` (review section) or PR comments. |
| **Progress Tracker** | `tracker` | Audits `TASK_PROGRESS.md` claims against actual git diffs to eliminate hallucinations. | Progress audit reports | Validates claims against raw git diffs. Read-only auditor: may read `state/`, `inputs/`, all branches; writes verdict to `TASK_PROGRESS.md` (`### 6.`) only. |
| **Fullstack Developer** | `fullstack` | Owns vertical slices end-to-end (API + services + UI + tests) in one branch. | Slice across `workspace/src/api/**`, `services/**`, `ui/**`, tests | Contract-first across the boundary; both backend and frontend disciplines apply, stricter wins. |
| **Launch Verification** | `launch` | Boots the composed app with real services and proves tak-çalıştır (Playwright where HTML is served, HTTP smoke otherwise). | Boot proof + probe results + machine-readable verdict block | Reports `pass`/`fail`/`skipped`; infra failures are `skipped`, never `fail`. Fail verdicts auto-spawn ONE bounded fix task. |

---

## 2. Universal CI/CD Constraints (STRICT & UNCOMPROMISING)

Every subagent MUST adhere to these environmental rules:
1. **Engine vs product runtimes:** the orchestrator ENGINE always runs on **Bun** (`bun run orchestrator/engine.ts`, `bun run subagents/runner.ts`). The PRODUCT in `workspace/` uses the roadmap-declared `stack` (`bun | go | rust | dotnet | python | php`, default `bun`) — product build/test commands use that toolchain (`bun test` | `go test ./...` | `cargo test` | `dotnet test` | `python -m pytest -q` | `php vendor/bin/phpunit`). NEVER invoke `node`, `npm`, `npx`, `pnpm`, or `yarn` for JS/TS work.
2. **Docker-Always Execution (no fallback paths):**
   - **Real Services Everywhere:** Docker runs locally AND on CI runners. When the roadmap declares `services` (presets `postgres`/`redis`/`mongo`/`s3`, or ANY custom `{name, image, env?, ports?}` image), the orchestrator renders `workspace/docker-compose.services.yml` and the workflow starts it (`--wait`) before any agent runs. Need a broker, search engine, or vector DB? Declare the image — it will exist. Connect via env endpoints (`DATABASE_URL`, `REDIS_URL`, `MONGO_URL`, `S3_*`, plus custom `env` — see `container-services` skill).
   - **Data Is Ephemeral:** containers reset every run. Seed fixtures inside tasks/tests; never assume pre-existing rows, buckets, or keys.
   - **No Fallbacks:** SQLite/InMemory adapter paths are forbidden. A missing service fails fast with a clear error.
   - **Auto-adopt:** an agent needing an undeclared container starts it for its own run and appends `{name, image, env?, ports?}` to `workspace/services.request.json`; the next tick validates (pinned image required) and merges it into `roadmap.services` — durable from run #2, reported on the dashboard.
   - **Production:** same env names, secret-managed values; S3 speaks S3 everywhere (Adobe S3Mock in CI, R2/AWS in production), so code runs unchanged.
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
7. **Engine Kill Switch:** the `ORCHESTRATOR_ENABLED` repo variable (`0`/`false`/`no`/`off`) stands down all engine actions with exit 0 — no auth, no dispatch, no review. Unset/anything-else = on. The workflow `if:` mirrors it so scheduled runs never start. Use it on repos with no project to run (e.g. this template itself).

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
- **4. 🧪 Verification & Test Proof:** **Actual terminal output of the product stack's tests proving 0 failures.**
  - *No claims without proof.* Subagents must run tests before pushing. The runner embeds the actual terminal output into this section.
- **Task anatomy (planner contract):** every task carries `description` (min ~80 words, exact file paths), `deliverables` (min 2 concrete items — the acceptance criteria), and `verificationCommand` (exact proof command). Thin plans are flagged by the roadmap validator; subagents treat `deliverables` as binding.

---

## 6. ChatOps & Human Operator Steering Protocol

Human operators can steer, pause, or direct the autonomous team via GitHub Issue comments on the Master Dashboard Issue:
- `/pause`: Halts dispatching of new tasks. Active subagents safely complete their current task.
- `/resume`: Resumes scheduling and task dispatching.
- `/tick`: Triggers an immediate orchestration cycle (same as the 15-min cron).
- `/directive <TASK-ID> "instruction"`: Injects an urgent directive into a task. If active, the Orchestrator cancels the workflow run (`gh run cancel`), applies the directive to `reviewNotes`, and re-dispatches the subagent.
- `/retry <TASK-ID>`: Resets retry counter to 0 and re-queues a failed or stuck task.
- `/status`: Generates an immediate real-time progress snapshot comment.
- `/discuss <TASK-ID> "message"`: Relays a message to the task's agent discussion thread (`DiscussionManager`); the agent reads recent replies on its next attempt.
- `/setup [public|data|all]`: Audits & repairs repo features (issues/wiki/projects/discussions/pull-requests) on the public and/or data repo.
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
   - **Functional Review:** Code Reviewer verifies deliverables match requirements. Unparseable reviewer output counts as rejection, never silent approval. Reviewer output MUST be JSON-only; `notes` must cover all checklist areas; truncated diffs are judged conservatively (visible scope only).
   - **Security Audit:** Security subagent verifies parameterized queries and zero secrets.
   - **Test Evidence:** QA verification confirms 0 failed unit/integration tests.
2. **PR Integration (`orchestrator/pr_manager.ts`):**
   - Approved work opens (or reuses) a PR `task/<id>` → `develop`; the review summary is posted as a PR comment.
   - `gh pr merge` is tried first; unmergable PRs fall back to local merge + AI conflict resolution (verified with the product stack's tests in `workspace/`).
   - Rejections are mirrored onto the open PR for traceability.
3. **Autonomous Conflict Resolution:**
   - If git merge produces conflict markers (`<<<<<<< HEAD`), `ConflictResolver` invokes OpenCode to reconcile both changes, validates with the product stack's tests, and commits the resolved merge.
   - If tests fail after conflict resolution, merge is aborted and flagged for safety.
4. **GitHub Hygiene:**
   - Task issues are deduplicated by `[TASK-ID]` title prefix (`ProjectManager.findTaskIssue` adopts the canonical issue; duplicates are closed as `--duplicate-of`).
   - Closed milestones with unfinished tasks are reopened by `ensureMilestones`; completed ones are closed only when all their tasks are `COMPLETED`.
   - Agent coordination happens in per-task discussion threads (`DiscussionManager`); operators can relay via `/discuss`.

---

## 8. GitHub App Authentication (preferred over PATs)

Workflows mint a short-lived installation token via `actions/create-github-app-token@v3` (`client-id` input — the legacy `app-id` input is NOT used). The token carries the installation's permissions (contents/PRs/issues/discussions/actions/projects) with a ~5-6k/hr budget, and covers the private `DATA_REPO` without a separate PAT:
- **Org-level (shared):** `GH_CLIENT_ID` (variable, non-secret), `GH_APP_PRIVATE_KEY` (secret), `DOCKERHUB_POOL` (secret). On Free-plan orgs these reach public repos only.
- **Repo-level (per product repo):** `DATA_REPO` (secret holding the private data repo slug, e.g. `<owner>/<name>-data`).
- **Installation scope:** the App must be installed with **All repositories** (or explicitly include every engine + data repo), or data access silently 404s.
- **Engine parity:** `orchestrator/github_app.ts` mints the same token locally when `GH_CLIENT_ID` + private key are present (`initializeGitHubAppAuth()` at startup, `CONFIG` refreshed after mint). All auth paths fall back to `GITHUB_TOKEN`/PATs when App credentials are absent — never hard-fail.
- **Dual-repo push mechanics:** state persists run in an isolated linked worktree — never `checkout` data branches in the main worktree (a dirty checkout aborts the switch and every push is then rejected as non-fast-forward forever).

---

## 9. Product Stack Directives (default per roadmap, override per task)

The ENGINE always runs on Bun. The PRODUCT defaults to one roadmap stack (`roadmap.stack`, default `bun`), but layers MAY differ per task (`task.stack` override — e.g. go API + bun UI). Every subagent gets its task's EFFECTIVE stack skill injected (see `STACK_ESSENTIAL_SKILLS` in `orchestrator/stacks.ts`); role skills still apply on top. Split stacks MUST meet at `workspace/CONTRACTS.md` with generated typed clients.

| Stack | Test (proof) | Build / gate | Lint / format | Skill |
| :--- | :--- | :--- | :--- | :--- |
| `bun` | `bun test` | `bun run build` | strict `tsconfig`, no `any` drift | `bun-essentials` |
| `go` | `go test ./...` | `go build ./...` + `go vet ./...` clean | `gofmt` + `goimports`, `go mod tidy` | `go-essentials` |
| `rust` | `cargo test` | `cargo build` | `cargo fmt --check`, `cargo clippy -- -D warnings` | `rust-essentials` |
| `dotnet` | `dotnet test` | `dotnet build` (warnings-as-errors) | `dotnet format` | `dotnet-essentials` |
| `python` | `python -m pytest -q` | `python -m compileall .` | `ruff check`, `ruff format --check`, pinned deps | `python-essentials` |
| `php` | `php vendor/bin/phpunit` | `composer install` | Pint/CS-Fixer, PHPStan/Psalm, `strict_types` | `php-essentials` |

Stack laws (all stacks):
- Each task uses ONLY its effective stack's toolchain (`task.stack` ?? roadmap default); engine commands (`orchestrator/engine.ts`, `subagents/runner.ts`) stay `bun`.
- Docker-always: connect via env to declared services; no SQLite/InMemory fallback layers; fail fast when a service is unreachable.
- Parameterized data access always (placeholders / ORM expressions — never string-built SQL).
- Tests prove behavior: stack test command with 0 failures, real output pasted in `workspace/TASK_PROGRESS.md`. No live background servers inside tests (in-memory/transport-level harnesses per stack).
- Never commit dependency trees (`node_modules/`, `target/`, `bin/`+`obj/`, `.venv/`+`__pycache__/`) or per-run files (`workspace/.services.env`).
- **Depth on demand (vendored ECC reference, MIT © 2026 Affaan Mustafa):** essentials skills are the always-injected core; for language depth read `STACK_ECC_REFS` paths in `orchestrator/stacks.ts` (`vendor/ecc/rules/<lang>/{coding-style,patterns,security,testing}.md`, `vendor/ecc/skills/<lang>-{patterns,testing}/SKILL.md`, `vendor/ecc/agents/<lang>-reviewer.md`). Only the manifest is committed — content arrives per-run (Actions cache keyed by manifest, pinned-release download on miss), so prompts reference paths that the workflow guarantees present. Deliberately NOT wired: `rules/*/hooks.md` (interactive-harness triggers, inert in headless runs) and `rules/common/AGENTS.md` (invokes `ecc:*` plugin agents that aren't installed here — this orchestrator is the multi-agent authority). The same skills are staged per-run as `ecc-*` into `.opencode/skills/` (workflow step + runner ensure, toolchain-style — reloadable via the skill tool, never auto-injected). Reviewer agents MUST consult the matching `<lang>-reviewer.md` checklist when reviewing that stack's diff (`go` → `go-reviewer`, `rust` → `rust-reviewer`, `dotnet` → `csharp-reviewer`, `python` → `python-reviewer`, `php` → `php-reviewer`, TS → `typescript-reviewer`).
