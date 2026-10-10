# 🚀 OpenCode Multi-Agent GitHub Actions Orchestrator

An enterprise-grade, autonomous multi-agent software engineering framework that plans, develops, audits, tests, and merges complete applications inside **GitHub Actions** using **OpenCode**.

---


> **Start here:** [Getting Started](#-getting-started) below runs your first project. Deep dives: [ARCHITECTURE.md](./ARCHITECTURE.md) (diagrams, pillars, roles, layout) · [AGENTS.md](./AGENTS.md) (agent constitution) · [CONTRIBUTING.md](./CONTRIBUTING.md) · [SECURITY.md](./SECURITY.md).

## What it does

- **Plans** your `inputs/` into a dependency-managed roadmap, then **dispatches** one subagent per task on isolated branches.
- **Builds polyglot products** — Bun, Go, Rust, .NET, Python, PHP (default stack per roadmap, override per layer; engine itself always runs on Bun).
- **Docker-always services** (Postgres/Redis/Mongo/S3 or any image) with ephemeral data and fail-fast discipline.
- **Quality gates**: deterministic checks → reviewer → security audit → test proof; conflicts auto-resolved and re-verified.
- **Live board**: GitHub Projects v2, milestones, per-task issues, dashboard + ChatOps steering.

## 🛠️ Getting Started

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
