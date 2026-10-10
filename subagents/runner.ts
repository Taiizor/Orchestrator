import { parseArgs } from "util";
import { existsSync } from "fs";
import { CONFIG } from "../orchestrator/config.ts";
import { StateManager } from "../orchestrator/state_manager.ts";
import { GitManager } from "../orchestrator/git_manager.ts";
import { OpenCodeClient } from "../orchestrator/opencode_client.ts";
import {
  STACKS,
  STACK_ESSENTIAL_SKILLS,
  STACK_ECC_SKILL_IDS,
  detectWorkspaceStack,
  normalizeStackId,
  runStackTests,
} from "../orchestrator/stacks.ts";
import { stageEccSkills } from "../scripts/stage-ecc-skills.ts";
import { ProjectManager } from "../orchestrator/project_manager.ts";
import { DiscussionManager } from "../orchestrator/discussion_manager.ts";
import { initializeGitHubAppAuth } from "../orchestrator/github_app.ts";
import type { TaskItem } from "../orchestrator/types.ts";

async function main() {
  const { values } = parseArgs({
    args: Bun.argv,
    options: {
      taskId: { type: "string" },
      role: { type: "string" },
      branch: { type: "string" },
      stack: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });

  const taskId = values.taskId;
  if (!taskId) {
    console.error("❌ Error: --taskId argument is required.");
    process.exit(1);
  }

  console.log(`🤖 Starting Subagent runner for Task: ${taskId}...`);

  // Optional: Authenticate via GitHub App if CLIENT_ID / APP_PRIVATE_KEY are provided
  await initializeGitHubAppAuth();

  await GitManager.setupGitAuthor();
  await GitManager.run(["git", "fetch", "--all"]);

  // Dual-repo: private state + data remote first (no-ops in single-repo mode)
  if (GitManager.isDataMode()) {
    await GitManager.ensureDataRemote();
    await GitManager.syncStateIn();
  }

  // Ensure state files are available locally
  if (!existsSync(CONFIG.ROADMAP_FILE)) {
    console.log("📥 Checking out latest state files from origin/main...");
    await GitManager.run(["git", "checkout", "origin/main", "--", CONFIG.STATE_DIR]);
  }

  // Load roadmap
  const roadmap = await StateManager.loadRoadmap();
  if (!roadmap) {
    console.error("❌ Roadmap not found in state directory.");
    process.exit(1);
  }
  // NOTE: service compose files are rendered AFTER the branch checkout
  // below. Rendering them here used to plant untracked files that the
  // checkout refused to overwrite ("would be overwritten"), failing the
  // checkout silently and stranding agents on main lineage.

  const task = roadmap.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`❌ Task ${taskId} not found in roadmap.`);
    process.exit(1);
  }

  const role = values.role || task.role;
  const branch = values.branch || task.branch;
  const remote = GitManager.contentRemote();

  // Dual-repo: register the private data remote first so every content
  // operation below resolves against it. No-op in single-repo mode.
  if (GitManager.isDataMode()) {
    await GitManager.ensureDataRemote();
  }

  // Switch / Create task branch (on the CONTENT remote in dual-repo mode,
  // so agent output never touches the public origin)
  console.log(`🌿 Ensuring task branch ${branch} (remote: ${remote})...`);
  // Refresh refs first: a stale/missing integration ref used to make the
  // checkout below fail silently, stranding agents on public-main lineage
  // (unmergeable, undiffable branches).
  await GitManager.remoteGit(remote, ["fetch", remote, CONFIG.INTEGRATION_BRANCH]);
  await GitManager.remoteGit(remote, ["fetch", remote, branch]);
  const remoteBranchRef = (await GitManager.run(["git", "rev-parse", "--verify", `${remote}/${branch}`])).exitCode === 0;
  if (remoteBranchRef) {
    // -B resets exactly to the remote tip; no pull (pull risks merge
    // commits and masks checkout failures — both broke lineage before).
    const co = await GitManager.run(["git", "checkout", "-B", branch, `${remote}/${branch}`]);
    if (co.exitCode !== 0) {
      console.error(`❌ [${taskId}] checkout of ${remote}/${branch} failed:`, (co.stdout + co.stderr).slice(0, 500));
      process.exit(1);
    }
  } else {
    // Checkout from integration branch
    const co = await GitManager.run(["git", "checkout", "-B", branch, `${remote}/${CONFIG.INTEGRATION_BRANCH}`]);
    if (co.exitCode !== 0) {
      console.error(
        `❌ [${taskId}] checkout of ${remote}/${CONFIG.INTEGRATION_BRANCH} failed:`,
        (co.stdout + co.stderr).slice(0, 500)
      );
      process.exit(1);
    }
  }
  // Data branches carry product trees only — the checkout above deletes
  // tracked engine files from disk, breaking post-checkout imports and
  // prompt reads. Restore them (warn-only; index pollution is scrubbed
  // in publishTaskBranch before committing).
  await GitManager.restoreEngineFiles();
  // Lineage guard (fail-closed): the workdir MUST share history with the
  // content integration branch. NOTE: merge-base EXISTENCE, not
  // --is-ancestor — a healthy branch forked from an older develop is merely
  // diverged (behind + ahead), still perfectly mergeable. Demanding strict
  // descendance stalls every in-flight branch as develop advances.
  // Exit loudly only on truly unrelated histories.
  const related = await GitManager.haveCommonAncestor(`${remote}/${CONFIG.INTEGRATION_BRANCH}`, "HEAD");
  if (!related) {
    const diag = await GitManager.run([
      "git",
      "rev-parse",
      `${remote}/${CONFIG.INTEGRATION_BRANCH}`,
      "HEAD",
      "--abbrev-ref",
      "HEAD",
    ]);
    console.error(
      `❌ [${taskId}] branch ${branch} shares no history with ${remote}/${CONFIG.INTEGRATION_BRANCH}; refusing to work on broken lineage. Refs: ${diag.stdout.trim().replace(/\n/g, " ")}`
    );
    process.exit(1);
  }

  // Materialize data content for this branch (dual-repo only; no-op otherwise)
  await GitManager.syncDataIn(branch);

  // Render service compose AFTER checkout+sync (see note above: writing
  // these before checkout breaks it via untracked-overwrite protection).
  {
    const { renderComposeYaml, renderEnvFile, normalizeServices } = await import("../orchestrator/service_manager.ts");
    const picked = normalizeServices(roadmap.services || []);
    if (picked.length > 0) {
      await Bun.write(`${CONFIG.WORKSPACE_DIR}/docker-compose.services.yml`, renderComposeYaml(picked));
      await Bun.write(`${CONFIG.WORKSPACE_DIR}/.services.env`, renderEnvFile(picked));
    }
  }

  // Ensure state directory remains present on task branch for prompt context
  if (!existsSync(CONFIG.ROADMAP_FILE)) {
    await GitManager.run(["git", "checkout", "origin/main", "--", CONFIG.STATE_DIR]);
  }

  // Build the Prompt for OpenCode
  let basePrompt = "";
  const basePromptPath = "subagents/prompts/base_agent.md";
  if (existsSync(basePromptPath)) {
    basePrompt = await Bun.file(basePromptPath).text();
  }

  let rolePrompt = "";
  const rolePromptPath = `subagents/prompts/roles/${role}.md`;
  if (existsSync(rolePromptPath)) {
    rolePrompt = await Bun.file(rolePromptPath).text();
  }

  // Dynamically attach relevant skills (deterministic injection; the same
  // skills are natively discoverable via the `skill` tool from
  // .opencode/skills/<name>/SKILL.md — reload them on demand by name).
  const ROLE_SKILLS: Record<string, string[]> = {
    architect: ["api-contracts", "sql-review"],
    backend: [
      "api-contracts",
      "error-handling",
      "backend-structure",
      "security-scan",
      "container-services",
      "observability-basics",
      "external-integrations",
    ],
    frontend: ["ui-conventions", "design-system", "i18n", "frontend-stack", "web-accessibility"],
    mobile: ["ui-conventions", "mobile-essentials", "i18n", "frontend-stack"],
    qa: ["test-evidence", "test-driven-development", "code-review", "container-services"],
    security: ["security-scan", "auth-review"],
    reviewer: ["code-review", "api-design", "documentation-discipline", "security-scan"],
    tracker: ["code-review", "test-evidence"],
    fullstack: ["api-contracts", "ui-conventions", "systematic-debugging", "code-review"],
    launch: ["container-services", "systematic-debugging", "test-evidence", "observability-basics"],
  };
  // Product stack precedence: --stack CLI (dispatch input) → roadmap.stack →
  // workspace markers. Every agent additionally gets its stack's essentials
  // skill (toolchain + idioms for the product language).
  const cliStack = typeof values.stack === "string" ? values.stack : undefined;
  const productStack = normalizeStackId(cliStack ?? (roadmap as { stack?: unknown }).stack, await detectWorkspaceStack("."));
  console.log(`🧱 Product stack: ${productStack} (${STACKS[productStack].label}).`);
  const stackSkill = STACK_ESSENTIAL_SKILLS[productStack];
  let skillsText = "";
  const skillNames = [...new Set([...(ROLE_SKILLS[role] || []), ...(stackSkill ? [stackSkill] : [])])];
  // ECC depth available like a toolchain: ensure staged (no-op when fresh),
  // then offer the stack's staged IDs as on-demand reloads (never injected).
  try {
    const staged = await stageEccSkills();
    if (!staged.skipped) console.log(`🧩 Staged ${staged.staged} ECC skills for on-demand reload.`);
  } catch (err: any) {
    console.warn(`⚠️ ECC skill staging failed (non-fatal): ${err?.message || err}`);
  }
  const eccReloadable = (STACK_ECC_SKILL_IDS[productStack] || []).filter((id) => existsSync(`.opencode/skills/${id}/SKILL.md`));
  for (const name of skillNames) {
    const p = `.opencode/skills/${name}/SKILL.md`;
    if (existsSync(p)) {
      // Strip frontmatter for prompt injection (native tool reads it separately)
      const raw = await Bun.file(p).text();
      skillsText += `\n\n${raw.replace(/^---[\s\S]*?---\s*/, "")}`;
    }
  }
  // Project-level skill drops: inputs/skills/<role>-*/SKILL.md (e.g.
  // inputs/skills/frontend-nextjs/SKILL.md). They override generic guidance
  // and travel with the project data repo, not the template.
  const projectSkillDirs: string[] = [];
  try {
    const glob = new Bun.Glob("inputs/skills/*");
    for await (const rel of glob.scan({ cwd: ".", onlyFiles: false })) {
      const base = rel.split(/[/\\]/).pop() || "";
      if (base.startsWith(`${role}-`)) projectSkillDirs.push(rel);
    }
  } catch {
    /* no project skills */
  }
  for (const dir of projectSkillDirs.sort()) {
    const norm = dir.replace(/\\/g, "/");
    const p = `${norm}/SKILL.md`;
    if (existsSync(p)) {
      const raw = await Bun.file(p).text();
      skillsText += `\n\n${raw.replace(/^---[\s\S]*?---\s*/, "")}`;
      skillNames.push(norm.split("/").pop() || norm);
    }
  }
  if (skillNames.length > 0 || eccReloadable.length > 0) {
    skillsText += `\n\n> You can reload any of these skills on demand with the skill tool: ${[...skillNames, ...eccReloadable.filter((id) => !skillNames.includes(id))].map((n) => `\`${n}\``).join(", ")}.`;
    skillsText += `\n> Beyond this list you MAY browse and self-select: all staged \`ecc-*\` skills are loadable, and \`vendor/ecc/\` (rules/skills/agents) is readable for anything your task needs — prefer the vetted paths above first. On any conflict between ECC guidance and this prompt / AGENTS.md, OUR directives win.`;
  }

  // Check for shared system contracts
  const contractsPath = "workspace/CONTRACTS.md";
  let contractsText = "";
  if (existsSync(contractsPath)) {
    contractsText = `\n\n### 📜 Shared System & API Contracts (workspace/CONTRACTS.md):\n${await Bun.file(contractsPath).text()}\n`;
  }

  // Check for synthesized master specification (bounded: full specs run
  // tens of KB and would drown small-context free models; the agent can pull
  // the complete file from the data remote when it needs more).
  const specPath = CONFIG.COMPILED_SPEC_FILE;
  const MAX_SPEC_CHARS = 40000;
  let compiledSpecText = "";
  if (existsSync(specPath)) {
    const fullSpec = await Bun.file(specPath).text();
    const shown = fullSpec.length > MAX_SPEC_CHARS ? fullSpec.slice(0, MAX_SPEC_CHARS) : fullSpec;
    const truncNote =
      fullSpec.length > MAX_SPEC_CHARS
        ? `\n_(Spec truncated to ${MAX_SPEC_CHARS} chars here; full text at \`${specPath}\` on data/main — fetch it via \`git show data/main:${specPath}\` if your task needs details beyond this excerpt.)_\n`
        : "";
    compiledSpecText = `\n\n### 📘 Canonical Project Specification (${specPath}):\n${shown}\n${truncNote}`;
  }

  let prompt = `${basePrompt}\n\n${rolePrompt}${skillsText}${contractsText}${compiledSpecText}\n\n`;
  prompt += `## Assigned Task: [${task.id}] - ${task.title}\n\n`;
  prompt += `**Description:**\n${task.description}\n\n`;
  prompt += `**Target Files:**\n${task.targetFiles.join(", ")}\n\n`;
  if (task.deliverables && task.deliverables.length > 0) {
    prompt += `**Acceptance Criteria (ALL must hold before you finish):**\n${task.deliverables.map((d) => `- [ ] ${d}`).join("\n")}\n\n`;
  }
  if (task.verificationCommand) {
    prompt += `**Verification Command:** \`${task.verificationCommand}\` — run it and paste the real output in TASK_PROGRESS.md.\n\n`;
  }

  if (task.reviewNotes) {
    prompt += `### ⚠️ Important Reviewer Feedback from Previous Attempt:\n${task.reviewNotes}\n`;
    prompt += `You MUST resolve the issues mentioned above!\n\n`;
  }

  // Peer discussion context: inject recent replies from the task's agent-talk
  // thread so agents learn from peers/operators on retries (fail-soft).
  try {
    const thread = await DiscussionManager.findTaskDiscussion(task.id);
    if (thread) {
      const replies = await DiscussionManager.getRecentReplies(thread.id, 5);
      if (replies.length > 0) {
        prompt +=
          `### 💬 Peer Discussion Context (discussion #${thread.number}, most recent last):\n` +
          replies.map((r) => `> ${r.replace(/\n/g, "\n> ")}`).join("\n\n") +
          `\n\n`;
        console.log(`💬 Injected ${replies.length} discussion replies into prompt.`);
      }
    }
  } catch {
    /* discussions are best-effort */
  }

  prompt += `\nPlease execute this task now. Create/edit code inside the workspace/ directory, test your code, and make sure to update workspace/TASK_PROGRESS.md with your Done, Doing, Todo, and Verification sections.`;

  // Launch-role browser pre-install: deterministic HTML signals decide BEFORE
  // the agent runs (browser download takes minutes). Best-effort — the agent
  // re-decides live and installs on its own if signals were wrong.
  if (role === "launch") {
    let browserReady = false;
    try {
      let uiSignals = false;
      try {
        const uiGlob = new Bun.Glob("workspace/src/ui/**/*.ts");
        for await (const f of uiGlob.scan({ cwd: ".", onlyFiles: true })) {
          if (!f.endsWith(".test.ts")) {
            uiSignals = true;
            break;
          }
        }
      } catch {
        /* no UI tree */
      }
      if (!uiSignals) {
        try {
          const pkg = JSON.parse(await Bun.file("workspace/package.json").text());
          const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          uiSignals = Object.keys(deps).some((d) => d.includes("playwright"));
        } catch {
          /* no readable package.json */
        }
      }
      if (uiSignals) {
        console.log("🌐 Launch task: UI signals detected — pre-installing headless Chromium (best-effort)...");
        const inst = await GitManager.run(
          ["bunx", "playwright", "install", "chromium", "--with-deps"],
          ".",
          undefined,
          undefined,
          8 * 60 * 1000
        );
        browserReady = inst.exitCode === 0;
        console.log(
          browserReady
            ? "✅ Chromium pre-installed."
            : "⚠️ Chromium pre-install failed; agent will try on its own or degrade to HTTP smoke."
        );
      } else {
        console.log("ℹ️ Launch task: no UI signals — skipping browser pre-install (agent decides live).");
      }
    } catch (err: any) {
      console.warn("⚠️ Browser pre-install probe failed (non-fatal):", err?.message || err);
    }
    prompt += `\n\n**Browser smoke precondition:** headless Chromium pre-installed=${browserReady}. Follow your role protocol: probe live routes first, use Playwright only if HTML is actually served (install it yourself if missing), and report infra failures as \`skipped\`, never \`fail\`.`;
  }

  console.log(`⚡ Running OpenCode CLI for ${task.id} with fallback chain...`);

  // Attach referenced project files (mockups, docs) so the agent SEES them
  // instead of bare filenames (multimodal --file; server-side resized).
  // Sources: task description + prior review notes. Best-effort, capped.
  const referencedFiles: string[] = [];
  try {
    const hay = `${task.description}\n${task.reviewNotes || ""}`;
    const seen = new Set<string>();
    for (const m of hay.matchAll(/inputs\/[^\s)"']+/g)) {
      const p = m[0].replace(/[.,;:!?]+$/, "");
      if (p && !seen.has(p) && referencedFiles.length < 12 && existsSync(p)) {
        seen.add(p);
        referencedFiles.push(p);
      }
    }
    if (referencedFiles.length > 0) {
      console.log(`🖼️ Attaching ${referencedFiles.length} referenced file(s) to the agent call.`);
    }
  } catch {
    // Attachment is optional; the prompt carries filenames regardless.
  }

  const res = await OpenCodeClient.runWithFallback(prompt, {
    timeoutMs: 30 * 60 * 1000,
    files: referencedFiles.length > 0 ? referencedFiles : undefined,
  });
  console.log("OpenCode Output Summary:", res.stdout ? res.stdout.slice(-1000) : "No stdout");
  if (res.exitCode !== 0) {
    console.error("OpenCode process exited with error:", res.stderr);
    // Present partial work for review if the agent left any; otherwise fail
    // loudly WITHOUT pushing an empty result — an empty "completion" would
    // otherwise loop through review as did-nothing work.
    const dirty = await GitManager.run(["git", "status", "--porcelain", "--", CONFIG.WORKSPACE_DIR, CONFIG.INPUTS_DIR]);
    if (!dirty.stdout.trim()) {
      console.error(`❌ [${task.id}] model run failed with zero workdir changes; leaving task for watchdog retry.`);
      process.exit(1);
    }
    console.warn(`⚠️ [${task.id}] model run failed, but uncommitted work exists — publishing partial progress for review.`);
  }

  // 1. Run automated test proof with the product stack's toolchain.
  // Detection order: roadmap.stack (planner-declared) → workspace markers.
  let testProof = "No unit tests found in workspace yet.";
  const stackHasTests = async (): Promise<boolean> => {
    if (productStack === "go") {
      const glob = new Bun.Glob("**/*_test.go");
      for await (const _ of glob.scan({ cwd: "workspace" })) return true;
      return existsSync("workspace/go.mod");
    }
    if (productStack === "rust") return existsSync("workspace/Cargo.toml");
    if (productStack === "dotnet") {
      for (const pat of ["workspace/*.sln", "workspace/**/*.csproj"] as const) {
        try {
          const glob = new Bun.Glob(pat);
          for await (const _ of glob.scan({ cwd: ".", onlyFiles: true })) return true;
        } catch {
          /* continue */
        }
      }
      return false;
    }
    if (productStack === "python") {
      for (const pat of ["workspace/test_*.py", "workspace/**/*_test.py", "workspace/tests/**/*.py"] as const) {
        try {
          const glob = new Bun.Glob(pat);
          for await (const _ of glob.scan({ cwd: ".", onlyFiles: true })) return true;
        } catch {
          /* continue */
        }
      }
      return existsSync("workspace/pyproject.toml") || existsSync("workspace/requirements.txt");
    }
    if (productStack === "php") {
      for (const pat of ["workspace/**/*Test.php", "workspace/tests/**/*.php"] as const) {
        try {
          const glob = new Bun.Glob(pat);
          for await (const _ of glob.scan({ cwd: ".", onlyFiles: true })) return true;
        } catch {
          /* continue */
        }
      }
      return existsSync("workspace/composer.json");
    }
    const glob = new Bun.Glob("**/*.{test,spec}.{ts,js}");
    for await (const _ of glob.scan({ cwd: "workspace" })) return true;
    return false;
  };

  if (await stackHasTests()) {
    console.log(`🧪 Executing '${STACKS[productStack].testCommand}' to verify deliverables...`);
    const testRes = await runStackTests(productStack, "workspace");
    testProof = ((testRes.stdout || "") + "\n" + (testRes.stderr || "")).trim() || `(no output, exit ${testRes.exitCode})`;
    if (testRes.exitCode !== 0) {
      console.warn("⚠️ Automated tests reported failures. Embedding test output into TASK_PROGRESS.md for review.");
    } else {
      console.log("✅ All automated tests passed successfully!");
    }
  }

  // Ensure workspace/TASK_PROGRESS.md exists and has real test proof
  const progressPath = `workspace/${CONFIG.TASK_PROGRESS_FILE}`;
  if (!existsSync(progressPath)) {
    const defaultProgress =
      `# 📝 Task Progress: ${task.id} - ${task.title}\n\n` +
      `**Role:** ${task.role}\n**Status:** IN_REVIEW\n\n` +
      `### 1. ✅ Done\n- Executed task deliverables in workspace\n\n` +
      `### 2. ⚡ Doing\n- Submitting for orchestrator review\n\n` +
      `### 3. 📋 Todo\n- Awaiting review and integration\n\n` +
      `### 4. 🧪 Verification & Test Proof\n\`\`\`\n${testProof}\n\`\`\`\n`;
    await Bun.write(progressPath, defaultProgress);
  } else {
    let existingContent = await Bun.file(progressPath).text();
    if (!existingContent.includes("### 4. 🧪 Verification & Test Proof") || existingContent.includes("Executed in headless CI")) {
      existingContent += `\n\n### 4. 🧪 Verification & Test Proof\n\`\`\`\n${testProof}\n\`\`\`\n`;
      await Bun.write(progressPath, existingContent);
    }
  }

  // Publish data content to the CONTENT remote (data repo in dual-repo
  // mode). The public origin never receives task branches.
  console.log(`📦 Publishing data work to branch ${branch}...`);
  const published = await GitManager.publishTaskBranch(branch, `feat(task): complete deliverables for ${task.id}`);
  if (!published) {
    console.error(`❌ Data publish failed for ${task.id}; stopping before review wake.`);
    process.exit(1);
  }

  // Update GitHub Projects Kanban item to "In Review" (GitHub API, no git race)
  if (roadmap.projectNumber) {
    await ProjectManager.updateItemStatus(roadmap.projectNumber, task, "In Review");
    await ProjectManager.postTaskProgressComment(
      task,
      `⚡ **Deliverables Ready:** Subagent finished execution on \`${branch}\`. Submitted for Orchestrator review.`
    );
  }

  // Agent-talk is strictly on-demand: no auto-posted summaries (they only
  // duplicated TASK_PROGRESS.md). Threads are created lazily by operator
  // /discuss relay; retries read back any replies via prompt injection above.

  // Notify / trigger Orchestrator
  console.log("🔔 Waking up Orchestrator workflow to review completed work...");
  await GitManager.run(["gh", "workflow", "run", CONFIG.ORCHESTRATOR_WORKFLOW]);

  console.log(`🎉 Subagent finished execution for ${task.id}.`);
}

main().catch((err) => {
  console.error("Fatal error in subagent runner:", err);
  process.exit(1);
});
