# 🚀 OpenCode Multi-Agent GitHub Actions Orchestrator

An enterprise-grade, autonomous multi-agent software engineering framework that plans, develops, audits, tests, and merges complete applications inside **GitHub Actions** using **OpenCode**.

---

## 🌟 1. System Architecture & Workflows

### A. End-to-End Orchestration Flowchart

```mermaid
flowchart TD
    subgraph Inputs["📁 1. Project Requirements (inputs/)"]
        Spec["spec.md (Features & Tech Stack)"]
        Assets["assets/ (Mockups, Diagrams)"]
        Refs["references/ (APIs, Data)"]
    end

    subgraph OrchestratorEngine["🤖 2. Orchestrator Engine (orchestrator.yml)"]
        Plan["Task Planner (DAG Decomposition)"]
        Roadmap["state/roadmap.json & PROGRESS.md"]
        Dispatch["gh workflow run subagent.yml"]
        Sleep["💤 Exits Immediately (0 Runner Minutes)"]
    end

    subgraph Subagents["🛠️ 3. Parallel Execution (Up to 5 Subagents)"]
        AgentA["Architect (Schema, Types & Contracts)"]
        AgentB["Backend (REST APIs & Services)"]
        AgentC["Frontend (UI & State)"]
        TaskProg["workspace/TASK_PROGRESS.md\n(Done, Doing, Todo, Verification)"]
    end

    subgraph QualityGate["🔍 4. Review & Quality Gate"]
        Tracker["Tracker: Claims vs Git Diff Audit"]
        Security["Security: SQLi, Secrets, Path Traversal"]
        Reviewer["Reviewer: Clean Code & stack tests"]
    end

    subgraph Integration["🌿 5. Branch Merge & Conflict Resolution"]
        GitMerge{"Git Merge to develop"}
        ConflictResolver["🔧 AI Conflict Resolver\n(OpenCode reconciles code)"]
        Success["✅ Task Merged & Next Tasks Unlocked"]
        Rejection["⚠️ Rejected with reviewNotes & Re-dispatched"]
    end

    Inputs --> Plan
    Plan --> Roadmap
    Roadmap --> Dispatch
    Dispatch --> Sleep

    Dispatch -.-> AgentA & AgentB & AgentC
    AgentA & AgentB & AgentC --> TaskProg
    TaskProg --> QualityGate

    QualityGate -->|Approved| GitMerge
    QualityGate -->|Rejected| Rejection
    Rejection -.->|Re-dispatch with fixes| Subagents

    GitMerge -->|Clean Merge| Success
    GitMerge -->|Conflict Detected| ConflictResolver
    ConflictResolver -->|Verified with stack tests| Success
```

---

### B. Event-Driven Wakeup & Zero-Cost Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor User as Developer / User
    participant GH as GitHub Actions
    participant Orch as 🤖 Orchestrator
    participant State as 📊 State (orchestrator-state)
    participant Sub as 🛠️ Subagent Runner

    User->>GH: Triggers Orchestrator (workflow_dispatch: plan)
    GH->>Orch: Starts Orchestrator Runner
    Orch->>State: Parses inputs/ and writes initial roadmap.json
    Orch->>GH: Dispatches ready subagent tasks (gh workflow run)
    Note over Orch: 💤 Orchestrator shuts down (0 runner minutes wasted!)

    GH->>Sub: Starts parallel Subagent jobs (task branches)
    Sub->>Sub: Runs OpenCode (muse-spark / nemotron free models)
    Sub->>Sub: Writes code, runs stack tests, updates TASK_PROGRESS.md
    Sub->>GH: Pushes branch & marks task IN_REVIEW
    Sub->>GH: 🔔 Wakes up Orchestrator (gh workflow run orchestrator.yml)
    Note over Sub: Subagent finishes and exits

    GH->>Orch: Orchestrator wakes up (tick / review)
    Orch->>Orch: Audits progress (Tracker + Security + Reviewer)
    alt Quality Gate Approved
        Orch->>GH: Merges task branch into develop (Auto-resolves conflicts if any)
        Orch->>State: Updates PROGRESS.md & unlocks next tasks
        Orch->>GH: Dispatches next tasks or finishes project
    else Quality Gate Rejected
        Orch->>State: Adds reviewNotes with fixes
        Orch->>GH: Re-dispatches subagent with corrective directives
    end
```

---

### C. PR Review & Automated Merge Conflict Resolution

```mermaid
flowchart LR
    A[Task Branch Push] --> B[Deterministic Gate + Quality & Security Gate]
    B -->|Passed| C[Open / Reuse PR task-branch → develop]
    C --> D[Post review summary as PR comment]

    D --> E[gh pr merge]
    E -->|Success| F[✅ Merged, issue closed, Kanban → Done]
    E -->|Unmergable / Conflict| G[Local merge + AI ConflictResolver]
    G --> H[Runs stack tests in workspace/]
    H -->|Tests Pass| F
    H -->|Tests Fail| I[Reject with reviewNotes & Re-dispatch]
```

---

## 🎯 2. Core Pillars & Design Principles

### 1. 📝 Double-Layered Progress Tracking (Done, Doing, Todo & Verification)
- **Global Roadmap ([`state/PROGRESS.md`](state/PROGRESS.md) & [`state/roadmap.json`](state/roadmap.json)):**  
  Maintained by the Orchestrator. Displays the master project status, completed milestones, queued tasks, and active subagent runs.
- **Task Progress Report ([`workspace/TASK_PROGRESS.md`](workspace/TASK_PROGRESS.md)):**  
  Maintained by each subagent on its task branch. Strictly formatted:
  - **1. ✅ Done:** Concrete list of created/modified files and functions.
  - **2. ⚡ Doing:** Current operational status.
  - **3. 📋 Todo:** Next steps or integration notes for downstream tasks.
  - **4. 🧪 Verification & Test Proof:** Terminal output of the product stack's tests proving zero errors.
- **Tracker Agent Audit:** The `tracker` subagent cross-references claimed progress against the actual `git diff` to eliminate hallucinations and incomplete implementations.

### 2. 🛡️ Enterprise Security & Quality Gate
Before any branch is merged into `develop`:
- **Security Auditor ([`subagents/prompts/roles/security.md`](subagents/prompts/roles/security.md)):**  
  Scans code for SQL injection (enforcing prepared statements), secret/token leaks, path traversal, command injection, and resource exhaustion. Generates `workspace/SECURITY_AUDIT.md`.
- **Container services (skill `container-services`):**
  Docker is always available (local + CI): declared services (Postgres, Redis, Mongo, S3, or any custom image) are provisioned as ephemeral containers with fixed env endpoints. No SQLite/InMemory fallback paths.
- **API Contracts (skill `api-contracts`), UI Conventions (skill `ui-conventions`), Test Evidence (skill `test-evidence`):**
  Role-specific native skills under [`.opencode/skills/`](.opencode/skills/) — deterministically injected per role and reloadable on demand via the `skill` tool.
- **Universal craft skills:** `systematic-debugging`, `test-driven-development`, `api-design`, `sql-review`, `web-accessibility`, `auth-review`, `i18n`, `design-system`, `error-handling`, `backend-structure`, `mobile-essentials`, `deployment-readiness`, `observability-basics`, `performance-budgets`, `external-integrations`, `documentation-discipline`, `frontend-stack` — injected for the most relevant roles, natively discoverable by every agent.
- **Stack essentials (one per product stack, always injected):** `bun-essentials`, `go-essentials`, `rust-essentials`, `dotnet-essentials`, `python-essentials`, `php-essentials` — toolchain, idioms, and verify commands for the roadmap's stack (see AGENTS.md §9). Each points at vendored ECC depth (`vendor/ecc/rules|skills|agents`, MIT © 2026 Affaan Mustafa) for on-demand reading. Only `vendor/ecc/.manifest.json` + `ATTRIBUTION.md` are committed (content is fetched, never pushed): fresh clones and CI get content via `bun run ecc:install` (local `./ECC-main` when present, else the pinned GitHub release, disk-cached) — workflows do this automatically (Actions cache keyed by manifest, release download on miss). `bun run ecc:verify` checks drift, `--all` installs the full agent surface (skills+rules+agents — interactive slash-commands excluded) instead of the curated 39.
- **No framework lock-in:** shadcn/Next.js/Nuxt/Blazor skills are deliberately NOT vendored (stale fast, bloat). Instead: docs-first protocol (`frontend-stack`), live official docs via `webfetch`, and project skill drops at `inputs/skills/<role>-<name>/SKILL.md` (auto-injected for that role, travel with project data).
- **Skill forge:** on every `plan`, the Skill Forger analyzes the stack and writes missing project-specific skills into `inputs/skills/` (`MAX_FORGED_SKILLS`, default 50; validated frontmatter, committed). Manual drops welcome anytime — same convention.
- **Code Reviewer ([`subagents/prompts/roles/reviewer.md`](subagents/prompts/roles/reviewer.md)):**  
  Enforces clean code standards, SOLID principles, error boundaries, and regression safety.

### 3. ⚡ Concurrency & Conflict Prevention
- **Isolated Git Branches:** Every subagent works on a separate branch (`task/<taskId>`).
- **Disjoint Scoping:** Orchestrator assigns non-overlapping target files (e.g. `src/db/*` vs `src/ui/*`) to independent parallel tasks.
- **AI Conflict Resolver ([`orchestrator/conflict_resolver.ts`](orchestrator/conflict_resolver.ts)):**  
  If two branches modify the same file (e.g. adding dependencies to `package.json` or routes to `index.ts`), OpenCode analyzes Git conflict markers, cleanly merges both changes, validates with the stack's tests, and commits the resolved merge autonomously!

### 4. 🎁 100% Free-Tier & Zero-Cost Model Cascade
OpenCode allows execution without registration or API keys through generous IP-rate-limited free models. Because **every GitHub Actions runner receives a brand-new IP address**, rate limits are practically non-existent across runs!
The built-in [`OpenCodeClient`](orchestrator/opencode_client.ts) features an automatic fallback cascade:
1. `opencode/muse-spark-1.3-contributor-free` *(Primary & High Quality)*
2. `opencode/nemotron-3-ultra-free` *(Fallback 1)*
3. `opencode/mimo-v2.6-flash-free` *(Fallback 2)*
4. `opencode/big-pickle` *(Fallback 3)*
5. `opencode/space-bunny-free` *(Fallback 4)*

### 5. ⏱️ Actions Timeouts & Deadlock Watchdog
- **Subagents:** `timeout-minutes: 35` (Broad window for compilation, tests, and free model latency, while preventing quota exhaustion).
- **Orchestrator:** `timeout-minutes: 30` (Quick review & dispatch cycle).
- **Watchdog Observation:** The Orchestrator monitors active runs via `gh run list --workflow subagent.yml --status in_progress` and can intervene via `gh run cancel` to re-steer stalled tasks.

### 6. 📊 Native GitHub Projects (v2) Kanban Board & Milestones
The Orchestrator natively interfaces with **GitHub Projects (v2)** via the `gh project` CLI:
- **Interactive Kanban Board:** Automatically creates and links a project board (`<ProjectName> Kanban Board`) with columns:
  - 📋 `Todo`: Queued tasks waiting for dependencies.
  - ⚡ `In Progress`: Actively executing subagent tasks.
  - 🔍 `In Review`: Finished tasks under Quality Gate inspection.
  - ✅ `Done`: Verified and merged tasks.
- **Product Owner Interactivity:** You can drag and drop cards to adjust priorities or add new issues; the Orchestrator reads project updates on every tick!
- **Categorized Milestones:** Groups tasks under structured milestones (e.g. `v0.1.0 - Foundation & Schema`, `v0.2.0 - Core Services & API`, `v1.0.0 - Release`).
- **Live Issue Updates:** Each task is tracked as a native GitHub Issue with real-time status comments.

### 7. 📜 Shared System Contracts Bridge (`workspace/CONTRACTS.md`)
To ensure frontend and QA subagents build against exact API definitions:
- Architect and Backend agents automatically document schemas, endpoint URLs, request shapes, and response codes in `workspace/CONTRACTS.md`.
- `subagents/runner.ts` automatically injects this contract file into dependent subagents so they never guess endpoint paths or parameter names.

### 8. 🏷️ Milestone Releases & Git Tags
Upon completing project milestones or reaching 100% completion, the Orchestrator automatically:
- Creates a semantic Git Tag (e.g. `v1.0.0`).
- Publishes a formal GitHub Release with changelogs and deliverables summary via `gh release create`.

### 9. ⚡ GitHub Actions Caching
Both `orchestrator.yml` and `subagent.yml` utilize `actions/cache@v6` to cache Bun packages and the OpenCode binary across runs, slashing job spin-up times from 40s down to 5s.

### 10. 💬 Interactive ChatOps Control Center
You can steer, pause, or query the autonomous team directly from GitHub Issue comments on the Dashboard Issue:
- `/pause`: Pause new task dispatches while letting active runs safely finish.
- `/resume`: Unpause scheduling and dispatch the next batch of ready tasks.
- `/tick`: Trigger an immediate orchestration cycle (same as the 15-min cron).
- `/directive <TASK-ID> "instruction"`: Inject new directives or course corrections into a task; automatically cancels any active run and re-queues it with the directive.
- `/retry <TASK-ID>`: Reset retry counter to 0 and re-queue a failed or stuck task.
- `/status`: Post an instantaneous progress snapshot comment.
- `/discuss <TASK-ID> "message"`: Relay a message to the task's agent discussion thread (agents read it on retry).
- `/setup [public|data|all]`: Audit & repair repo features (issues/wiki/projects/discussions/pull-requests).
- `/ask <question>`: Answer from live roadmap state (cited task IDs).
- `/add <role> "title" -- "description" [deps:A,B] [milestone:M]`: Queue a DAG-validated PENDING task.
- `/log <TASK-ID>`: Tail recent subagent run logs for that task.
- `/revise <TASK-ID> "change"`: Queue a surgical revision task (originals stay COMPLETED).

### 11. 🧱 Planned Task Anatomy & Spec Quality Gate
- Every planned task carries `description` (min ~80 words, exact file paths), `deliverables` (min 2 acceptance items, injected into the subagent prompt), and `verificationCommand` (exact proof command). Thin plans are flagged by the deterministic roadmap validator.
- Stage-1 synthesis is gated too: the compiled spec is checked against the analyst prompt's own required sections plus a length floor, with one automatic expansion pass on gaps — quality over speed, pipeline never blocks.

---

## 👥 3. Agent Ecosystem & Responsibilities

| Role | System Prompt | Primary Mission | Key Deliverables |
| :--- | :--- | :--- | :--- |
| **Orchestrator** | [`orchestrator/prompts/system.md`](orchestrator/prompts/system.md) | Plans roadmap, decomposes tasks, monitors execution, resolves conflicts, merges branches. | `state/roadmap.json`, `state/PROGRESS.md`, PR Merges |
| **System Architect** | [`subagents/prompts/roles/architect.md`](subagents/prompts/roles/architect.md) | Initializes foundation, sets up Docker-backed data layer, shared contracts. | `src/db/**`, `src/types/`, migrations |
| **Backend Developer** | [`subagents/prompts/roles/backend.md`](subagents/prompts/roles/backend.md) | Implements REST APIs, controllers, services, and database queries. | `src/api/**`, `src/services/**`, unit tests |
| **Frontend Developer**| [`subagents/prompts/roles/frontend.md`](subagents/prompts/roles/frontend.md) | Builds responsive UI, components, styling, and client-side state. | `src/ui/**`, client bundler configs |
| **Mobile Developer**| [`subagents/prompts/roles/mobile.md`](subagents/prompts/roles/mobile.md) | Builds mobile features: offline-first, permissions, push, store readiness. | `src/mobile/**`, platform configs |
| **QA Engineer** | [`subagents/prompts/roles/qa.md`](subagents/prompts/roles/qa.md) | Writes automated unit and integration tests with the product stack's runner. | `tests/**`, test execution logs |
| **Security Auditor** | [`subagents/prompts/roles/security.md`](subagents/prompts/roles/security.md) | Audits SQL injection, secret leaks, path traversal, payload size limits. | `workspace/SECURITY_AUDIT.md` |
| **Progress Tracker** | [`subagents/prompts/roles/tracker.md`](subagents/prompts/roles/tracker.md) | Audits `TASK_PROGRESS.md` claims against actual git diffs to eliminate hallucinations. | Progress audit reports |
| **Code Reviewer** | [`subagents/prompts/roles/reviewer.md`](subagents/prompts/roles/reviewer.md) | Evaluates clean code standards, error boundaries, edge cases, regression risks. | Review evaluation JSON & comments |
| **Fullstack Developer** | [`subagents/prompts/roles/fullstack.md`](subagents/prompts/roles/fullstack.md) | Owns vertical slices end-to-end (API + services + UI + tests) in one branch. | Slice across `src/api/**`, `services/**`, `ui/**`, tests |
| **Launch Verification** | [`subagents/prompts/roles/launch.md`](subagents/prompts/roles/launch.md) | Boots the composed app and proves tak-çalıştır (Playwright/HTTP verdict block). | Boot proof + probe results |

---

## 📂 4. Project Directory Structure

```
Orchestrator/
├── .github/
│   └── workflows/
│       ├── orchestrator.yml        # Orchestrator runner (cron + manual + subagent event triggers)
│       ├── subagent.yml            # Subagent task worker (runs OpenCode in headless CI)
│       └── chatops.yml             # ChatOps fast lane (slash commands on the dashboard issue)
├── AGENTS.md                       # Master operational constitution for all agents
├── opencode.json                   # OpenCode runtime config (model defaults, no-share, no-autoupdate, allow-all tools)
├── inputs/                         # Put your project specs here
│   ├── README.md                   # Guide for inputs
│   ├── spec.md                     # Target project requirements
│   ├── assets/                     # Mockups, screenshots, architecture diagrams
│   └── references/                 # API specs, sample data, URLs
├── orchestrator/
│   ├── config.ts                   # Concurrency limits, timeouts, kill switch & fallback models
│   ├── types.ts                    # TypeScript schemas for tasks, roadmap, reports
│   ├── stacks.ts                   # Product stack registry (bun/go/rust/dotnet/python/php) + ECC refs
│   ├── service_manager.ts          # Docker service presets, compose render, request validation
│   ├── opencode_client.ts          # Free-tier model fallback runner
│   ├── project_manager.ts          # GitHub Projects v2, Milestones & Issues bridge
│   ├── conflict_resolver.ts        # AI-driven Git merge conflict resolver
│   ├── issue_manager.ts            # Master Issue, ChatOps & Release Manager
│   ├── state_manager.ts            # Roadmap state & PROGRESS.md generator
│   ├── git_manager.ts              # Git branching, merging, and gh CLI bridge
│   ├── engine.ts                   # Main orchestration engine (plan, adopt, tick)
│   ├── github_app.ts               # GitHub App JWT + installation-token minting
│   ├── launch_verdict.ts           # Launch-verdict parsing + fix-round caps
│   ├── spec_checks.ts              # Stage-1 spec quality gate (sections, length floor)
│   ├── skill_format.ts             # Forged-skill frontmatter normalize/validate
│   ├── discussion_manager.ts       # Per-task agent discussion threads
│   ├── repo_setup.ts               # Repo feature audit/repair (setup action)
│   ├── pr_manager.ts               # PR open/merge + review comments
│   ├── review_gate.ts              # Deterministic pre-LLM gate (v6)
│   ├── roadmap_validator.ts        # Roadmap DAG + stack + coverage validation
│   └── prompts/
│       ├── system.md               # Orchestrator rules & environment constraints
│       ├── analyst.md              # Requirements synthesis + completeness floor
│       ├── planner.md              # Task decomposition & DAG generation prompt
│       ├── reviewer.md             # Subagent evaluation and approval prompt
│       ├── skill_forger.md         # Project-skill forging prompt
│       └── conflict_resolver.md    # Conflict resolution prompt
├── scripts/
│   ├── install-ecc.ts              # Repo-scoped ECC installer (release → vendor/ecc)
│   └── stage-ecc-skills.ts         # Per-run ECC skill staging (.opencode/skills/ecc-*)
├── vendor/
│   └── ecc/                        # Pinned ECC reference (manifest committed, content fetched)
│       ├── .manifest.json          # File hashes + version pin
│       └── ATTRIBUTION.md          # MIT attribution
├── tests/                          # Engine unit tests (bun test)
├── subagents/
│   ├── runner.ts                   # Subagent executor running OpenCode
│   └── prompts/
│       ├── base_agent.md           # Instructions for TASK_PROGRESS.md & environment
│       └── roles/                  # Role-specific system prompts
│           ├── architect.md        # Database schema & project scaffolding
│           ├── backend.md          # REST APIs & business logic
│           ├── frontend.md         # UI components & styling
│           ├── mobile.md           # Mobile features (offline-first, push, store)
│           ├── qa.md               # Unit, integration & E2E tests
│           ├── security.md         # Vulnerability & security auditor
│           ├── reviewer.md         # PR review agent
│           ├── tracker.md          # Deliverables auditor & diff verifier
│           ├── fullstack.md        # Vertical slices (API + services + UI + tests)
│           └── launch.md           # Launch verification (boot proof + verdict)
├── .opencode/
│   └── skills/                     # Native skills: craft + stack essentials (+ staged ecc-*, ignored)
├── state/
│   ├── roadmap.json                # Master JSON DAG state
│   └── PROGRESS.md                 # Auto-generated markdown progress board
└── workspace/                      # Target application code generated by subagents
```

---

## 🛠️ 5. Getting Started

### Step 1: Configure GitHub Authentication (App preferred, PAT fallback)

**Recommended: GitHub App** (higher rate limits, no personal token, covers the private data repo):
1. Create an App at the org level (**Organization Settings > Developer settings > GitHub Apps > New GitHub App**): `Contents`, `Pull requests`, `Issues`, `Discussions`, `Actions` = Read & Write; `Projects` = Read & Write; `Metadata` = Read-only. `Where can this be installed: Only on this account`.
2. Generate a private key (**App settings > Credentials > Key pairs**) and **Install** the App with **All repositories** (or at least every engine + data repo).
3. Add an organization **Variable** `GH_CLIENT_ID` (the App's Client ID, non-secret) and an organization **Secret** `GH_APP_PRIVATE_KEY` (the `.pem` content). Workflows use `actions/create-github-app-token@v3` (`client-id` input) and the engine mints the same token locally.

**Legacy fallback: Personal Access Token (PAT):**
1. Generate a classic PAT (**Settings > Developer settings > Personal access tokens**) with scopes `repo`, `project`, `discussion`.
2. Save it as a repository secret named **`GH_PROJECT_TOKEN`**.

In both cases, under **Settings > Actions > General > Workflow permissions**, select **"Read and write permissions"** and check **"Allow GitHub Actions to create and approve pull requests"**.
*(Optional)* Add API keys (`ANTHROPIC_API_KEY`, etc.) if you wish to use paid models instead of the built-in free models.

### Step 2: Define Your Target Project
Edit [`inputs/spec.md`](inputs/spec.md) with your project requirements, user stories, and tech stack preferences. Add any visual mockups into `inputs/assets/`.

### Step 2b (optional): Dual-repo mode — public skeleton + private data
To run this template as a **public** repo while keeping project content private:
1. Create a **private** repository for project data (e.g. `my-org/my-project-data`).
2. Push your real `inputs/` + `workspace/` content there (any branch layout; the orchestrator seeds `develop` on first `plan` if missing).
3. Add two repository secrets to the **public** repo:
   - **`DATA_REPO`** = `owner/name` (or full URL) of the private data repo.
   - **`DATA_PAT`** = only needed when the data repo lives under a DIFFERENT owner/account than the App installation (classic PAT with `repo` scope). Same-org data repos are covered by the App token (falls back to `GH_PROJECT_TOKEN` when set).
   - **`DOCKERHUB_USERNAME`** + **`DOCKERHUB_TOKEN`** = optional single account; or **`DOCKERHUB_POOL`** = JSON array `[{"username":"u1","token":"t1"},...]` — runs spread pulls across accounts by run ID (pool wins when both set; anonymous pulls otherwise).
5. *(Optional)* Feature toggles as repository **Variables** (Settings → Secrets and variables → Actions → Variables):
   - `PUBLIC_FEATURES` (default `issues,discussions,projects`), `DATA_FEATURES` (default `discussions`) — comma lists from `issues|wiki|projects|discussions|pull_requests`. Enforced by `action=setup` or dashboard `/setup [public|data|all]`. (PRs are enforced on where the merge flow needs them.)
4. `inputs/*` (except templates), `workspace/*` and `state/*` are `.gitignore`d here: CI materializes them from the data repo at runtime and publishes agent output back to data branches. Task branches and review **PRs live in the data repo**; issues/milestones/board stay public (titles + statuses only, bodies redacted), and the dashboard renders **redacted** (IDs/roles/statuses/dependencies, no titles or notes).

Leave `DATA_REPO` empty for classic single-repo mode (everything in one repo).

### Step 3: Trigger the Orchestrator
1. Open the **Actions** tab on GitHub.
2. Select **🤖 Orchestrator Engine**.
3. Click **Run workflow** (Action: `plan`).

The Orchestrator will decompose the project, launch the first batch of subagents, and shut down. From that point forward, the subagents will build the application, trigger the review gates, resolve any conflicts, and assemble the working software into `workspace/`!

**Already have code?** Run workflow with Action: **`adopt`** instead of `plan`. Adopt surveys `workspace/`, backfills a roadmap of COMPLETED baseline tasks (one per area), reverse-engineers `workspace/CONTRACTS.md` when missing, seeds the content branch, and wires milestones + board project + dashboard — with NO per-task issues or board cards for adopted history (those appear for future work only). Refuses when a roadmap already exists (never overwrites history) or when `workspace/` holds only scaffolding (use `plan`). Re-running adopt is safe: already-adopted state is detected, never duplicated.

> 🔌 **Kill switch (template repos):** the engine ticks every 15 min by schedule. On a repo with no project to run (like this template itself), set the **`ORCHESTRATOR_ENABLED`** repo variable to `false` (repo Settings → Secrets and variables → Variables; lowercase). Scheduled and manual runs stand down with exit 0 — no auth, no dispatch, no review. Delete the variable (or set anything else) to resume.

---

## 💻 Local Development & CLI

You can run and test the entire engine locally using **Bun**:

```bash
# Install dependencies
bun install

# Run planning phase locally from inputs/
bun run orchestrator:plan

# Run tick cycle (review & dispatch ready tasks)
bun run orchestrator:tick

# Run a specific subagent manually
bun run subagents/runner.ts --taskId=TASK-001 --role=architect --branch=task/TASK-001
```
