export const CONFIG = {
  // Concurrency & Task limits
  MAX_CONCURRENT_SUBAGENTS: parseInt(process.env.MAX_CONCURRENT_SUBAGENTS || "5", 10),
  MAX_TASK_ATTEMPTS: parseInt(process.env.MAX_TASK_ATTEMPTS || "3", 10),
  // Watchdog: cancel subagent runs older than this (minutes) and re-queue the task
  STALE_RUN_TIMEOUT_MINUTES: parseInt(process.env.STALE_RUN_TIMEOUT_MINUTES || "40", 10),

  // Git & Branching
  BASE_BRANCH: process.env.BASE_BRANCH || "main",
  INTEGRATION_BRANCH: process.env.INTEGRATION_BRANCH || "develop",

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
};
