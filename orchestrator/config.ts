/** Parse an integer from env with a guaranteed fallback — never returns NaN. */
function safeInt(envValue: string | undefined, fallback: number): number {
  const parsed = parseInt(envValue || String(fallback), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const CONFIG = {
  // Concurrency & Task limits
  MAX_CONCURRENT_SUBAGENTS: safeInt(process.env.MAX_CONCURRENT_SUBAGENTS, 5),
  MAX_TASK_ATTEMPTS: safeInt(process.env.MAX_TASK_ATTEMPTS, 3),
  // Watchdog: cancel subagent runs older than this (minutes) and re-queue the task
  STALE_RUN_TIMEOUT_MINUTES: safeInt(process.env.STALE_RUN_TIMEOUT_MINUTES, 40),
  // Fast dead-task recovery: IN_PROGRESS + silence since before dispatch +
  // zero active runs anywhere = worker gone (fast fail, infra kill).
  // Frees the task in minutes instead of waiting out STALE_RUN_TIMEOUT.
  IDLE_REQUEUE_MINUTES: safeInt(process.env.IDLE_REQUEUE_MINUTES, 20),
  // Overnight autopilot: FAILED tasks auto-resurrect to PENDING after this
  // cooldown (minutes), at most this many times. Human /retry resets the
  // budget. Prevents an idle night after a terminal failure.
  FAILED_RESURRECT_COOLDOWN_MIN: safeInt(process.env.FAILED_RESURRECT_COOLDOWN_MIN, 60),
  FAILED_AUTO_RESURRECT_MAX: safeInt(process.env.FAILED_AUTO_RESURRECT_MAX, 2),
  // Skill Forger: cap on collected project skills per run (context-budget
  // guard for downstream agent prompts — only role-matching subsets inject,
  // so this is a backstop, not a target. Override via MAX_FORGED_SKILLS.
  MAX_FORGED_SKILLS: safeInt(process.env.MAX_FORGED_SKILLS, 50),
  // Service auto-adopt: cap on total roadmap.services (presets + customs).
  // Bounds cold-runner pull/start time against request spam; microservice
  // roadmaps legitimately need headroom. Override via MAX_SERVICES.
  MAX_SERVICES: safeInt(process.env.MAX_SERVICES, 20),

  // Git & Branching
  BASE_BRANCH: process.env.BASE_BRANCH || "main",
  INTEGRATION_BRANCH: process.env.INTEGRATION_BRANCH || "develop",

  // Dual-repo mode (public skeleton + private data).
  // When DATA_REPO is set ("owner/name" or full https URL), the content
  // branches (task/*, develop) live in the PRIVATE data repo while this
  // public repo keeps engine code only. inputs/, workspace/ and state/ are
  // runtime-synced from the data repo and never committed here.
  // Empty DATA_REPO = legacy single-repo mode (state/roadmap on main).
  DATA_REPO: process.env.DATA_REPO || "",
  DATA_PAT: process.env.DATA_PAT || process.env.GH_PROJECT_TOKEN || "",
  DATA_REMOTE: "data",
  // Feature toggles for the setup action (comma lists from
  // issues|wiki|projects|discussions|pull_requests). Empty = auto: RepoSetup picks
  // topology-aware defaults (dual-repo public drops discussions).
  // Pull requests are enforced on (merge flow needs them on the data repo).
  PUBLIC_FEATURES: process.env.PUBLIC_FEATURES || "",
  DATA_FEATURES: process.env.DATA_FEATURES || "",
  // Engine kill switch (repo-level): set the ORCHESTRATOR_ENABLED repo
  // variable to 0/false/off to stand the engine down (e.g. the template
  // repo itself, which has no project to run). Unset/anything-else = on.
  ORCHESTRATOR_ENABLED: process.env.ORCHESTRATOR_ENABLED ?? "",
  // Extra logins always honored by ChatOps (besides repo collaborators
  // with push access). Comma-separated GitHub usernames.
  CHATOPS_ADMINS: (process.env.CHATOPS_ADMINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Paths
  STATE_DIR: "state",
  ROADMAP_FILE: "state/roadmap.json",
  PROGRESS_MD_FILE: "state/PROGRESS.md",
  COMPILED_SPEC_FILE: "state/COMPILED_SPEC.md",
  INPUTS_DIR: "inputs",
  WORKSPACE_DIR: "workspace",

  // Subagent task progress file inside workspace
  TASK_PROGRESS_FILE: "TASK_PROGRESS.md",

  // OpenCode Models & Free-Tier Fallback Chain (Ordered best to worst)
  // variant = provider-specific reasoning effort (e.g. xhigh/high/medium/low).
  // Models without variant support omit the field and run with OpenCode default.
  // Syntax alternative: "provider/model#variant" is also parsed (see opencode_client.ts).
  FREE_MODELS: [
    { model: "opencode/muse-spark-1.3-contributor-free", variant: "xhigh" },
    { model: "opencode/nemotron-3-ultra-free" },
    { model: "opencode/mimo-v2.6-flash-free" },
    { model: "opencode/big-pickle" },
    { model: "opencode/space-bunny-free", variant: "max" },
  ] as { model: string; variant?: string }[],
  OPENCODE_MODEL: process.env.OPENCODE_MODEL || "", // If set, prioritizes this model before fallback chain. Supports "provider/model#variant" syntax.
  OPENCODE_VARIANT: process.env.OPENCODE_VARIANT || "", // Optional default variant when OPENCODE_MODEL has no "#variant" suffix.
  STANDALONE: true, // Non-interactive standalone server for GitHub Actions

  // GitHub Actions integration
  // GITHUB_TOKEN (temporary, per-repo ~1k/hr): issues, PRs, milestones,
  // discussions, releases — everything except Projects v2.
  // GH_PROJECT_TOKEN (PAT, per-user ~5k/hr): ONLY Projects v2 board ops,
  // which GITHUB_TOKEN can never access. Kept separate so routine calls
  // never burn the user's personal budget.
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  PROJECT_TOKEN: process.env.GH_PROJECT_TOKEN || "",
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || "",
  SUBAGENT_WORKFLOW: "subagent.yml",
  ORCHESTRATOR_WORKFLOW: "orchestrator.yml",

  // GitHub App credentials: Client ID (non-secret identifier) + private key.
  CLIENT_ID: process.env.GH_CLIENT_ID || process.env.CLIENT_ID || "",
  APP_PRIVATE_KEY: process.env.GH_APP_PRIVATE_KEY || process.env.APP_PRIVATE_KEY || "",
  APP_INSTALLATION_ID: process.env.GH_APP_INSTALLATION_ID || process.env.APP_INSTALLATION_ID || "",
} as const;

/**
 * Re-read auth-related env vars into CONFIG.
 *
 * CONFIG is a module-level snapshot taken at import time, but
 * initializeGitHubAppAuth() mints the installation token at runtime
 * (after imports) and writes it into process.env. Without this refresh,
 * consumers reading CONFIG.PROJECT_TOKEN / CONFIG.DATA_PAT would keep
 * seeing "" and silently skip Projects v2 sync / DATA operations.
 * Idempotent and cheap — safe to call at startup. Also refreshes the
 * ORCHESTRATOR_ENABLED kill switch.
 */
export function refreshAuthFromEnv(): void {
  const mutable = CONFIG as unknown as Record<string, unknown>;
  mutable.GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  mutable.PROJECT_TOKEN = process.env.GH_PROJECT_TOKEN || "";
  mutable.DATA_PAT = process.env.DATA_PAT || process.env.GH_PROJECT_TOKEN || "";
  mutable.CLIENT_ID = process.env.GH_CLIENT_ID || process.env.CLIENT_ID || "";
  mutable.APP_PRIVATE_KEY = process.env.GH_APP_PRIVATE_KEY || process.env.APP_PRIVATE_KEY || "";
  mutable.APP_INSTALLATION_ID = process.env.GH_APP_INSTALLATION_ID || process.env.APP_INSTALLATION_ID || "";
  mutable.ORCHESTRATOR_ENABLED = process.env.ORCHESTRATOR_ENABLED ?? "";
}

/**
 * Engine kill switch: false only when ORCHESTRATOR_ENABLED is explicitly
 * set to 0/false/no/off (case-insensitive). Unset, empty, or anything else
 * means ON. Reads the CONFIG snapshot (see refreshAuthFromEnv).
 */
export function isEngineEnabled(): boolean {
  const raw = String(CONFIG.ORCHESTRATOR_ENABLED || "")
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

/**
 * Validate critical config values at startup. Logs warnings for missing
 * optional tokens and throws on impossible numeric states.
 */
export function validateConfig(): void {
  if (CONFIG.MAX_CONCURRENT_SUBAGENTS <= 0) {
    throw new Error(`CONFIG.MAX_CONCURRENT_SUBAGENTS must be > 0, got ${CONFIG.MAX_CONCURRENT_SUBAGENTS}`);
  }
  if (CONFIG.MAX_TASK_ATTEMPTS <= 0) {
    throw new Error(`CONFIG.MAX_TASK_ATTEMPTS must be > 0, got ${CONFIG.MAX_TASK_ATTEMPTS}`);
  }
  if (CONFIG.STALE_RUN_TIMEOUT_MINUTES <= 0) {
    throw new Error(`CONFIG.STALE_RUN_TIMEOUT_MINUTES must be > 0, got ${CONFIG.STALE_RUN_TIMEOUT_MINUTES}`);
  }
  if (!CONFIG.GITHUB_TOKEN && !(CONFIG.CLIENT_ID && CONFIG.APP_PRIVATE_KEY)) {
    console.warn("⚠️ GITHUB_TOKEN is not set — GitHub API calls will fail with 401/403.");
  }
  if (CONFIG.DATA_REPO && !CONFIG.DATA_PAT && !(CONFIG.CLIENT_ID && CONFIG.APP_PRIVATE_KEY)) {
    console.warn("⚠️ DATA_REPO is set but DATA_PAT is empty — dual-repo git operations will fail with auth errors.");
  }
  if (!CONFIG.PROJECT_TOKEN && !(CONFIG.CLIENT_ID && CONFIG.APP_PRIVATE_KEY)) {
    console.warn("⚠️ GH_PROJECT_TOKEN is not set — GitHub Projects v2 board sync will be skipped.");
  }
}
