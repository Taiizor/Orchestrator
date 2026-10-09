import { parseArgs } from "util";
import { existsSync } from "fs";
import { CONFIG } from "../orchestrator/config.ts";
import { StateManager } from "../orchestrator/state_manager.ts";
import { GitManager } from "../orchestrator/git_manager.ts";
import { OpenCodeClient } from "../orchestrator/opencode_client.ts";
import { ProjectManager } from "../orchestrator/project_manager.ts";
import { DiscussionManager } from "../orchestrator/discussion_manager.ts";
import type { TaskItem } from "../orchestrator/types.ts";

async function main() {
  const { values } = parseArgs({
    args: Bun.argv,
    options: {
      taskId: { type: "string" },
      role: { type: "string" },
      branch: { type: "string" },
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
  const branchExists = await GitManager.branchExists(branch);
  if (branchExists) {
    await GitManager.run(["git", "checkout", "-B", branch, `${remote}/${branch}`]);
    await GitManager.run(["git", "pull", remote, branch]);
  } else {
    // Checkout from integration branch
    await GitManager.run(["git", "checkout", "-B", branch, `${remote}/${CONFIG.INTEGRATION_BRANCH}`]);
  }

  // Materialize data content for this branch (dual-repo only; no-op otherwise)
  await GitManager.syncDataIn(branch);

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
    architect: ["sqlite-hardening", "api-contracts", "sql-review"],
    backend: ["api-contracts", "error-handling", "backend-structure", "security-scan"],
    frontend: ["ui-conventions", "design-system", "i18n"],
    qa: ["test-evidence", "test-driven-development", "code-review"],
    security: ["security-scan", "auth-review"],
    reviewer: ["code-review", "api-design"],
    tracker: ["code-review", "test-evidence"],
    fullstack: ["api-contracts", "ui-conventions", "systematic-debugging", "code-review"],
  };
  let skillsText = "";
  const skillNames = ROLE_SKILLS[role] || [];
  for (const name of skillNames) {
    const p = `.opencode/skills/${name}/SKILL.md`;
    if (existsSync(p)) {
      // Strip frontmatter for prompt injection (native tool reads it separately)
      const raw = await Bun.file(p).text();
      skillsText += `\n\n${raw.replace(/^---[\s\S]*?---\s*/, "")}`;
    }
  }
  if (skillNames.length > 0) {
    skillsText += `\n\n> You can reload any of these skills on demand with the skill tool: ${skillNames.map((n) => `\`${n}\``).join(", ")}.`;
  }

  // Check for shared system contracts
  const contractsPath = "workspace/CONTRACTS.md";
  let contractsText = "";
  if (existsSync(contractsPath)) {
    contractsText = `\n\n### 📜 Shared System & API Contracts (workspace/CONTRACTS.md):\n${await Bun.file(contractsPath).text()}\n`;
  }

  // Check for synthesized master specification
  const specPath = CONFIG.COMPILED_SPEC_FILE;
  let compiledSpecText = "";
  if (existsSync(specPath)) {
    compiledSpecText = `\n\n### 📘 Canonical Project Specification (${specPath}):\n${await Bun.file(specPath).text()}\n`;
  }

  let prompt = `${basePrompt}\n\n${rolePrompt}${skillsText}${contractsText}${compiledSpecText}\n\n`;
  prompt += `## Assigned Task: [${task.id}] - ${task.title}\n\n`;
  prompt += `**Description:**\n${task.description}\n\n`;
  prompt += `**Target Files:**\n${task.targetFiles.join(", ")}\n\n`;

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
        prompt += `### 💬 Peer Discussion Context (discussion #${thread.number}, most recent last):\n` +
          replies.map((r) => `> ${r.replace(/\n/g, "\n> ")}`).join("\n\n") + `\n\n`;
        console.log(`💬 Injected ${replies.length} discussion replies into prompt.`);
      }
    }
  } catch { /* discussions are best-effort */ }

  prompt += `\nPlease execute this task now. Create/edit code inside the workspace/ directory, test your code, and make sure to update workspace/TASK_PROGRESS.md with your Done, Doing, Todo, and Verification sections.`;

  console.log(`⚡ Running OpenCode CLI for ${task.id} with fallback chain...`);

  const res = await OpenCodeClient.runWithFallback(prompt);
  console.log("OpenCode Output Summary:", res.stdout ? res.stdout.slice(-1000) : "No stdout");
  if (res.exitCode !== 0) {
    console.error("OpenCode process exited with error:", res.stderr);
  }

  // 1. Run automated test proof if tests exist
  let testProof = "No unit tests found in workspace yet.";
  const glob = new Bun.Glob("**/*.{test,spec}.{ts,js}");
  let hasTests = false;
  for await (const _ of glob.scan({ cwd: "workspace" })) {
    hasTests = true;
    break;
  }

  if (hasTests) {
    console.log("🧪 Executing 'bun test' to verify deliverables...");
    const testProc = Bun.spawn(["bun", "test"], { cwd: "workspace", stderr: "pipe", stdout: "pipe" });
    const stdout = await new Response(testProc.stdout).text();
    const stderr = await new Response(testProc.stderr).text();
    const exitCode = await testProc.exited;
    testProof = (stdout + "\n" + stderr).trim();
    if (exitCode !== 0) {
      console.warn("⚠️ Automated tests reported failures. Embedding test output into TASK_PROGRESS.md for review.");
    } else {
      console.log("✅ All automated tests passed successfully!");
    }
  }

  // Ensure workspace/TASK_PROGRESS.md exists and has real test proof
  const progressPath = `workspace/${CONFIG.TASK_PROGRESS_FILE}`;
  if (!existsSync(progressPath)) {
    const defaultProgress = `# 📝 Task Progress: ${task.id} - ${task.title}\n\n` +
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
