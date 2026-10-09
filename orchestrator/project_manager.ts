import { CONFIG } from "./config.ts";
import { GitManager } from "./git_manager.ts";
import type { Roadmap, TaskItem } from "./types.ts";

export class ProjectManager {
  private static projectScopeWarned = false;

  /**
   * Run a `gh project ...` command with the PAT when available.
   * Projects v2 is unreachable with GITHUB_TOKEN, and routine issue/PR
   * calls must NOT burn the user's personal PAT budget — so only board
   * ops go through this path. Falls back to ambient auth when the secret
   * is unset (e.g. local dev with OAuth).
   */
  private static projectGh(args: string[]) {
    if (CONFIG.PROJECT_TOKEN) {
      return GitManager.run(args, ".", undefined, {
        GH_TOKEN: CONFIG.PROJECT_TOKEN,
        GITHUB_TOKEN: CONFIG.PROJECT_TOKEN,
      });
    }
    return GitManager.run(args);
  }

  private static hintProjectScope(stderr: string): void {
    if (/scope|forbidden|resource not accessible|requires authentication|unknown owner type/i.test(stderr)) {
      if (!this.projectScopeWarned) {
        this.projectScopeWarned = true;
        console.warn(
          "⚠️ GitHub Projects API unavailable: token lacks `read:project`/`write:project` scope" +
          ( /unknown owner type/i.test(stderr) ? " (classic PAT also needs `read:org` so gh can resolve the org)" : "" ) +
          ". Create a classic PAT with `repo` + `project` (+ `read:org` for org repos), " +
          "save it as the `GH_PROJECT_TOKEN` repo secret, and re-run. Kanban sync is skipped until then."
        );
      }
    }
  }

  /**
   * Get authenticated user login or "@me"
   */
  public static async getOwner(): Promise<string> {
    const res = await GitManager.run(["gh", "api", "user", "-q", ".login"]);
    return res.exitCode === 0 && res.stdout.trim() ? res.stdout.trim() : "@me";
  }

  /**
   * Owner of the current repository (org login or user login).
   * Org-owned repos REQUIRE org-owned projects: a user-owned board can
   * neither link to an org repo nor accept its issues.
   */
  public static async getRepoOwner(): Promise<string | null> {
    const res = await GitManager.run(["gh", "repo", "view", "--json", "owner", "--jq", ".owner.login"]);
    return res.exitCode === 0 && res.stdout.trim() ? res.stdout.trim() : null;
  }

  /**
   * Ensure a GitHub Project (v2) exists and is linked to the repository.
   * The board is created under the REPO owner (org for org repos), otherwise
   * GitHub refuses both the repo link and cross-owner issue membership.
   */
  public static async ensureProject(roadmap: Roadmap): Promise<number | null> {
    const me = await this.getOwner();
    const repoOwner = await this.getRepoOwner();
    const owner = repoOwner || me;
    if (repoOwner && repoOwner !== me) {
      console.log(`🏢 Repo is org-owned (${repoOwner}); using org-owned project board.`);
    }
    const projectTitle = `${roadmap.projectName} Kanban Board`;

    // 1. If roadmap already has project number, verify it (and re-link)
    if (roadmap.projectNumber) {
      const verifyRes = await this.projectGh([
        "gh", "project", "view", String(roadmap.projectNumber),
        "--owner", owner
      ]);
      if (verifyRes.exitCode === 0) {
        const relinkArgs = ["gh", "project", "link", String(roadmap.projectNumber), "--owner", owner];
        if (CONFIG.GITHUB_REPOSITORY) relinkArgs.push("--repo", CONFIG.GITHUB_REPOSITORY);
        const relinkRes = await this.projectGh(relinkArgs);
        if (relinkRes.exitCode !== 0) {
          console.warn(`⚠️ Project #${roadmap.projectNumber} exists but repo re-link failed:`, relinkRes.stderr);
        } else {
          console.log(`🔗 Project #${roadmap.projectNumber} linked to repository.`);
        }
        return roadmap.projectNumber;
      }
    }

    // 2. Check if a project with matching title already exists
    console.log(`🔍 Checking existing GitHub Projects for owner '${owner}'...`);
    const listRes = await this.projectGh([
      "gh", "project", "list",
      "--owner", owner,
      "--format", "json"
    ]);

    if (listRes.exitCode === 0 && listRes.stdout) {
      try {
        const data = JSON.parse(listRes.stdout);
        const projects = data.projects || (Array.isArray(data) ? data : []);
        const existing = projects.find((p: any) => p.title === projectTitle || p.title.includes(roadmap.projectName));
        if (existing) {
          console.log(`📌 Found existing GitHub Project: #${existing.number} (${existing.title})`);
          roadmap.projectNumber = existing.number;
          roadmap.projectUrl = existing.url;
          return existing.number;
        }
      } catch (err) {
        console.warn("Could not parse project list JSON:", err);
      }
    } else {
      this.hintProjectScope(listRes.stderr);
    }

    // 3. Create new GitHub Project (v2)
    console.log(`✨ Creating new GitHub Project: "${projectTitle}"...`);
    const createRes = await this.projectGh([
      "gh", "project", "create",
      "--owner", owner,
      "--title", projectTitle,
      "--format", "json"
    ]);

    if (createRes.exitCode === 0 && createRes.stdout) {
      try {
        const created = JSON.parse(createRes.stdout);
        const projectNum = created.number;
        console.log(`🎉 Successfully created GitHub Project #${projectNum}!`);

        // Link project to current repository (explicit --repo: without it
        // the link silently no-ops in non-interactive runners, leaving the
        // repo Projects tab empty even though the board exists).
        const linkArgs = ["gh", "project", "link", String(projectNum), "--owner", owner];
        if (CONFIG.GITHUB_REPOSITORY) linkArgs.push("--repo", CONFIG.GITHUB_REPOSITORY);
        const linkRes = await this.projectGh(linkArgs);
        if (linkRes.exitCode !== 0) {
          console.warn(`⚠️ Project #${projectNum} created but repo link failed (board won't show under repo Projects tab):`, linkRes.stderr);
        } else {
          console.log(`🔗 Project #${projectNum} linked to repository.`);
        }
        await this.ensureLabels();
        
        roadmap.projectNumber = projectNum;
        roadmap.projectUrl = created.url;
        return projectNum;
      } catch (err) {
        console.error("Failed to parse created project response:", err);
      }
    } else {
      this.hintProjectScope(createRes.stderr);
      console.warn("Warning: Could not create GitHub Project via CLI:", createRes.stderr);
    }

    return null;
  }

  /**
   * Ensure Milestones exist in the repository.
   * Missing milestones are created; milestones that were closed while their
   * tasks are still unfinished are reopened.
   */
  public static async ensureMilestones(milestones: { title: string; description?: string }[]): Promise<void> {
    await this.ensureLabels();
    if (!milestones || milestones.length === 0) return;

    // Fetch existing milestones (open + closed). NOTE: state must be a query
    // param in the path — `-f state=all` is misinterpreted as a create call.
    const listRes = await GitManager.run(["gh", "api", "repos/:owner/:repo/milestones?state=all&per_page=100"]);
    const existing = new Map<string, { number: number; state: string }>();

    if (listRes.exitCode === 0 && listRes.stdout) {
      try {
        const items = JSON.parse(listRes.stdout);
        for (const m of items) existing.set(m.title, { number: m.number, state: m.state });
      } catch {
        // Fallback
      }
    }

    for (const m of milestones) {
      const hit = existing.get(m.title);
      if (!hit) {
        console.log(`🏷️ Creating GitHub Milestone: "${m.title}"...`);
        const args = ["gh", "api", "repos/:owner/:repo/milestones", "-f", `title=${m.title}`];
        if (m.description) args.push("-f", `description=${m.description}`);
        await GitManager.run(args);
      } else if (hit.state === "closed") {
        console.log(`🔓 Reopening closed Milestone: "${m.title}" (#${hit.number}) — unfinished tasks remain...`);
        await GitManager.run([
          "gh", "api", `repos/:owner/:repo/milestones/${hit.number}`,
          "-X", "PATCH",
          "-f", "state=open",
        ]);
      }
    }
  }

  /**
   * Ensure required workflow and role labels exist in repository
   */
  public static async ensureLabels(): Promise<void> {
    const requiredLabels = [
      { name: "subagent", color: "1D76DB", description: "Managed by autonomous subagents" },
      { name: "role:architect", color: "5319E7", description: "Architectural and schema task" },
      { name: "role:backend", color: "0E8A16", description: "Backend, API, and service task" },
      { name: "role:frontend", color: "BFD4F2", description: "Frontend and UI component task" },
      { name: "role:qa", color: "FBCA04", description: "Testing and QA task" },
      { name: "role:security", color: "D93F0B", description: "Security audit and hardening task" },
      { name: "role:tracker", color: "006B75", description: "Progress audit task" },
      { name: "role:reviewer", color: "C2E0C6", description: "Code review and inspection task" },
      { name: "role:fullstack", color: "5319E7", description: "Fullstack task" },
      { name: "dashboard", color: "0E8A16", description: "Orchestrator dashboard issue" },
      { name: "agents", color: "1D76DB", description: "Agent coordination thread" },
      { name: "agent-talk", color: "BFD4F2", description: "Agent discussion thread" },
    ];

    for (const lbl of requiredLabels) {
      await GitManager.run([
        "gh", "label", "create", lbl.name,
        "--color", lbl.color,
        "--description", lbl.description,
        "--force"
      ]);
    }
  }

  /**
   * Find an existing issue for a task by its "[TASK-ID]" title prefix.
   * Searches open AND closed issues and matches the prefix in code, so a
   * re-planned roadmap reuses (and reopens) the canonical issue instead of
   * opening duplicates.
   */
  public static async findTaskIssue(taskId: string): Promise<{ number: number; url: string; state: string } | null> {
    const res = await GitManager.run([
      "gh", "issue", "list",
      "--search", `[${taskId}]`,
      "--state", "all",
      "--limit", "50",
      "--json", "number,url,title,state",
    ]);
    if (res.exitCode !== 0 || !res.stdout.trim()) return null;
    try {
      const issues = JSON.parse(res.stdout);
      const hits = issues.filter((i: any) => String(i.title).startsWith(`[${taskId}]`));
      if (hits.length === 0) return null;
      // Canonical = oldest (lowest number)
      hits.sort((a: any, b: any) => a.number - b.number);
      if (hits.length > 1) {
        console.warn(`⚠️ Found ${hits.length} issues for [${taskId}]; canonical is #${hits[0].number}.`);
      }
      return { number: hits[0].number, url: hits[0].url, state: hits[0].state };
    } catch {
      return null;
    }
  }

  /**
   * Create a GitHub Issue for a task and assign to Milestone (issue side only).
   * Idempotent: reuses the canonical "[TASK-ID]" issue when one exists.
   * Board membership is handled separately by syncBoardState (batched).
   */
  public static async ensureTaskIssue(task: TaskItem, milestoneTitle?: string): Promise<void> {
    // 0. Adopt an existing canonical issue when the roadmap lost its linkage
    //    (e.g. fresh plan run) instead of opening a duplicate.
    if (!task.issueNumber || !task.issueUrl) {
      const found = await this.findTaskIssue(task.id);
      if (found) {
        console.log(`♻️ Reusing existing issue #${found.number} for [${task.id}] (no duplicate created).`);
        task.issueNumber = found.number;
        task.issueUrl = found.url;
        if (found.state === "CLOSED" && task.status !== "COMPLETED") {
          await GitManager.run(["gh", "issue", "reopen", String(found.number)]);
        }
      }
    } else {
      // Verify the recorded issue still exists (cross-repo state or deleted issue)
      const viewRes = await GitManager.run([
        "gh", "issue", "view", String(task.issueNumber),
        "--json", "number,url,state",
      ]);
      if (viewRes.exitCode !== 0) {
        console.warn(`⚠️ Recorded issue #${task.issueNumber} for [${task.id}] is gone; searching canonical...`);
        task.issueNumber = undefined;
        task.issueUrl = undefined;
        const found = await this.findTaskIssue(task.id);
        if (found) {
          task.issueNumber = found.number;
          task.issueUrl = found.url;
        }
      }
    }

    // 1b. Enforce milestone on adopted issues (adoption path skips --milestone)
    if (task.issueNumber && milestoneTitle) {
      const viewRes = await GitManager.run([
        "gh", "issue", "view", String(task.issueNumber),
        "--json", "milestone",
      ]);
      if (viewRes.exitCode === 0) {
        try {
          const current = JSON.parse(viewRes.stdout).milestone?.title;
          if (current !== milestoneTitle) {
            await GitManager.run([
              "gh", "issue", "edit", String(task.issueNumber),
              "--milestone", milestoneTitle,
            ]);
          }
        } catch { /* non-fatal */ }
      }
    }

    // 1. Create Issue if none exists
    if (!task.issueNumber || !task.issueUrl) {
      console.log(`📝 Creating GitHub Issue for [${task.id}]...`);
      // Dual-repo: issue bodies stay public — no task descriptions, only
      // role/branch metadata. Full instructions live in the private roadmap.
      const body = GitManager.isDataMode()
        ? `**Assigned Role:** \`${task.role}\`\n` +
          `**Branch:** \`${task.branch}\`\n` +
          `**Target Files:** \`${task.targetFiles.join(", ")}\`\n` +
          `**Dependencies:** ${task.dependencies.length > 0 ? task.dependencies.map(d => `\`${d}\``).join(", ") : "None"}\n` +
          `\n*Details are tracked privately; this issue carries status only.*\n`
        : `### Task Description\n${task.description}\n\n` +
          `**Assigned Role:** \`${task.role}\`\n` +
          `**Branch:** \`${task.branch}\`\n` +
          `**Target Files:** \`${task.targetFiles.join(", ")}\`\n` +
          `**Dependencies:** ${task.dependencies.length > 0 ? task.dependencies.map(d => `\`${d}\``).join(", ") : "None"}\n`;

      const createArgs = [
        "gh", "issue", "create",
        "--title", `[${task.id}] ${task.title}`,
        "--body", body,
        "--label", "subagent",
        "--label", `role:${task.role}`
      ];

      if (milestoneTitle) {
        createArgs.push("--milestone", milestoneTitle);
      }

      const issueRes = await GitManager.run(createArgs);
      if (issueRes.exitCode === 0 && issueRes.stdout) {
        task.issueUrl = issueRes.stdout.trim();
        const match = task.issueUrl.match(/\/issues\/(\d+)/);
        if (match) {
          task.issueNumber = parseInt(match[1], 10);
        }
      }
    }
  }

  /**
   * Legacy wrapper: issue sync only. Board membership is batched via
   * syncBoardState — call it once after the loop instead of per task.
   */
  public static async syncTaskToProject(_projectNumber: number | null, task: TaskItem, milestoneTitle?: string): Promise<void> {
    await this.ensureTaskIssue(task, milestoneTitle);
  }

  private static desiredBoardStatus(task: TaskItem): "Todo" | "In Progress" | "In Review" | "Done" {
    switch (task.status) {
      case "IN_PROGRESS": return "In Progress";
      case "IN_REVIEW": return "In Review";
      case "COMPLETED": return "Done";
      default: return "Todo";
    }
  }

  /**
   * Snapshot the board in ONE call via `gh project item-list`.
   * Returns issue URL -> status, plus title-prefix index as fallback.
   * Writes are then limited to real deltas (missing items, drifted status).
   */
  public static async getBoardSnapshot(
    projectNumber: number,
    owner: string
  ): Promise<{ byUrl: Map<string, string>; byTask: Map<string, string> }> {
    const byUrl = new Map<string, string>();
    const byTask = new Map<string, string>();
    const res = await this.projectGh([
      "gh", "project", "item-list", String(projectNumber),
      "--owner", owner,
      "--format", "json",
      "-L", "100",
    ]);
    if (res.exitCode !== 0) {
      this.hintProjectScope(res.stderr);
      console.warn("⚠️ Board snapshot failed:", res.stderr.slice(0, 300));
      return { byUrl, byTask };
    }
    try {
      const items = JSON.parse(res.stdout);
      const list = Array.isArray(items) ? items : items.items || [];
      for (const it of list) {
        const url: string = it.url || it.content?.url || "";
        const title: string = it.title || "";
        const status: string = it.status || it.Status || "";
        if (url) byUrl.set(url, status);
        const m = title.match(/^(\[TASK-[^\]]+\])/);
        if (m) byTask.set(m[1], status);
      }
      console.log(`📸 Board snapshot: ${byUrl.size} items found.`);
    } catch {
      console.warn("⚠️ Board snapshot parse failed; response head:", res.stdout.slice(0, 300));
    }
    return { byUrl, byTask };
  }

  /**
   * Batched board sync: 1 snapshot read + writes only for missing items or
   * drifted statuses. A steady-state run costs ~1 PAT call instead of 2×tasks.
   * Fresh adds skip the Status edit when the desired value is the board
   * default ("Todo").
   */
  public static async syncBoardState(roadmap: Roadmap, projectNumber: number): Promise<{ added: number; updated: number; skipped: number }> {
    const stats = { added: 0, updated: 0, skipped: 0 };
    const me = await this.getOwner();
    const repoOwner = await this.getRepoOwner();
    const owner = repoOwner || me;

    const snap = await this.getBoardSnapshot(projectNumber, owner);
    for (const task of roadmap.tasks) {
      if (!task.issueUrl) {
        stats.skipped++;
        continue;
      }
      const desired = this.desiredBoardStatus(task);
      const current = snap.byUrl.get(task.issueUrl) ?? snap.byTask.get(`[${task.id}]`) ?? null;
      if (current === null) {
        const addRes = await this.projectGh([
          "gh", "project", "item-add", String(projectNumber),
          "--owner", owner,
          "--url", task.issueUrl,
        ]);
        if (addRes.exitCode !== 0) {
          this.hintProjectScope(addRes.stderr);
          console.warn(`⚠️ Could not add issue #${task.issueNumber} to project:`, addRes.stderr);
          continue;
        }
        stats.added++;
        // Fresh items default to Todo — edit only when the task is past that.
        if (desired !== "Todo") {
          await this.updateItemStatus(projectNumber, task, desired);
          stats.updated++;
        } else {
          stats.skipped++;
        }
      } else if (current !== desired) {
        await this.updateItemStatus(projectNumber, task, desired);
        stats.updated++;
      } else {
        stats.skipped++;
      }
    }
    console.log(`📊 Board sync: ${stats.added} added, ${stats.updated} status updates, ${stats.skipped} already in sync.`);
    return stats;
  }

  /** Board owner: repo owner (org-aware). updateItemStatus previously used the
   *  user login, which targeted the wrong (orphan) board for org repos. */
  private static async getBoardOwner(): Promise<string> {
    return (await this.getRepoOwner()) || (await this.getOwner());
  }

  /**
   * Update Project item Status column (Todo, In Progress, In Review, Done).
   * Warns (does not throw) when the project or the Status option is missing —
   * e.g. fresh Projects v2 boards have no "In Review" option until added.
   */
  public static async updateItemStatus(
    projectNumber: number,
    task: TaskItem,
    status: "Todo" | "In Progress" | "In Review" | "Done"
  ): Promise<void> {
    if (!task.issueUrl) return;

    const owner = await this.getBoardOwner();
    console.log(`📊 Moving [${task.id}] to '${status}' in Project #${projectNumber}...`);

    const editRes = await this.projectGh([
      "gh", "project", "item-edit", String(projectNumber),
      "--owner", owner,
      "--url", task.issueUrl,
      "--field", "Status",
      "--value", status
    ]);
    if (editRes.exitCode !== 0) {
      this.hintProjectScope(editRes.stderr);
      console.warn(
        `⚠️ Could not set Status='${status}' for [${task.id}] ` +
        `(board may lack this option — add it via Project Settings > Status field):`,
        editRes.stderr
      );
    }

    // If task is completed and verified, close the GitHub Issue
    if (status === "Done" && task.issueNumber) {
      await GitManager.run([
        "gh", "issue", "close", String(task.issueNumber),
        "--comment", `✅ **Task Completed & Verified:** Merged into integration branch with 0 test failures.`
      ]);
    }
  }

  /**
   * Post progress comment to the task's linked GitHub Issue.
   * In dual-repo mode issues are public: strip everything after the first
   * line (review notes and details stay in the private workspace).
   */
  public static async postTaskProgressComment(task: TaskItem, comment: string): Promise<void> {
    if (!task.issueNumber) return;
    const body = GitManager.isDataMode() ? comment.split("\n")[0] : comment;
    await GitManager.run([
      "gh", "issue", "comment", String(task.issueNumber),
      "--body", body
    ]);
  }
}
