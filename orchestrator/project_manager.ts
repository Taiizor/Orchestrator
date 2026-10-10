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
    // Quota exhaustion masquerades as other errors ("unknown owner type",
    // 403s) — never blame token scopes for it; board sync simply retries
    // next tick after the hourly reset.
    if (/rate limit|quota/i.test(stderr)) {
      if (!this.projectScopeWarned) {
        this.projectScopeWarned = true;
        console.warn(
          "⚠️ GitHub GraphQL quota exhausted — board ops deferred to a later tick (hourly reset). No token change needed."
        );
      }
      return;
    }
    if (/scope|forbidden|resource not accessible|requires authentication|unknown owner type/i.test(stderr)) {
      if (!this.projectScopeWarned) {
        this.projectScopeWarned = true;
        console.warn(
          "⚠️ GitHub Projects API unavailable: token lacks `read:project`/`write:project` scope" +
            (/unknown owner type/i.test(stderr) ? " (classic PAT also needs `read:org` so gh can resolve the org)" : "") +
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
   * Ensure the board Status field offers every lifecycle option the engine
   * writes (Todo, In Progress, In Review, Done, Failed). Fresh boards ship
   * with a smaller set, which used to degrade updates into warnings.
   * Best-effort: warns, never throws.
   */
  public static async ensureStatusOptions(projectNumber: number, owner: string): Promise<void> {
    const want = ["Todo", "In Progress", "In Review", "Done", "Failed"];
    const colors: Record<string, string> = { "In Progress": "YELLOW", "In Review": "BLUE", Done: "GREEN", Failed: "RED" };
    try {
      const view = await this.projectGh(["gh", "project", "view", String(projectNumber), "--owner", owner, "--format", "json"]);
      if (view.exitCode !== 0) {
        this.hintProjectScope(view.stderr);
        return;
      }
      let projectId = "";
      try {
        projectId = JSON.parse(view.stdout).id || "";
      } catch {
        /* fallback below */
      }
      if (!projectId) {
        // `project view` JSON omits the node id — resolve via owner+number
        // (number interpolated: integers need no escaping).
        for (const kind of ["organization", "user"]) {
          const q = await this.projectGh([
            "gh",
            "api",
            "graphql",
            "-F",
            `login=${owner}`,
            "-f",
            `query=query($login:String!){${kind}(login:$login){projectV2(number:${projectNumber}){id}}}`,
          ]);
          try {
            projectId = q.exitCode === 0 ? JSON.parse(q.stdout)?.data?.[kind]?.projectV2?.id || "" : "";
          } catch {
            projectId = "";
          }
          if (projectId) break;
        }
      }
      if (!projectId) {
        console.warn("⚠️ Could not resolve board node id; skipping option sync.");
        return;
      }
      const fq = await this.projectGh([
        "gh",
        "api",
        "graphql",
        "-F",
        `nodeId=${projectId}`,
        "-f",
        "query=query($nodeId:ID!){node(id:$nodeId){... on ProjectV2{fields(first:30){nodes{... on ProjectV2SingleSelectField{id name options{id name color description}}}}}}}",
      ]);
      if (fq.exitCode !== 0) {
        this.hintProjectScope(fq.stderr);
        return;
      }
      const nodes: any[] = JSON.parse(fq.stdout)?.data?.node?.fields?.nodes || [];
      const status = nodes.find((f: any) => f.id && f.name === "Status");
      if (!status) {
        console.warn("⚠️ Board has no Status field; skipping option sync.");
        return;
      }
      const have: { id: string; name: string; color?: string; description?: string }[] = status.options || [];
      const missing = want.filter((w) => !have.some((h) => h.name === w));
      if (missing.length === 0) return;
      // The API requires `color` AND `description` on EVERY option in the
      // list (existing ones included) — both are queried and passed through.
      const desc = (n: string) => `${n} status`;
      const optsLit = [
        ...have.map(
          (h) =>
            `{id:"${h.id}",name:${JSON.stringify(h.name)},color:${h.color || "GRAY"},description:${JSON.stringify(h.description ?? desc(h.name))}}`
        ),
        ...missing.map((m) => `{name:${JSON.stringify(m)},color:${colors[m] || "GRAY"},description:${JSON.stringify(desc(m))}}`),
      ].join(",");
      const mq = `mutation{updateProjectV2Field(input:{fieldId:"${status.id}",singleSelectOptions:[${optsLit}]}){projectV2Field{... on ProjectV2SingleSelectField{options{name}}}}}`;
      const mres = await this.projectGh(["gh", "api", "graphql", "-f", `query=${mq}`]);
      if (mres.exitCode === 0) {
        console.log(`🎛️ Board Status options ensured (added: ${missing.join(", ")}).`);
      } else {
        console.warn("⚠️ Could not add board Status options:", mres.stderr.slice(0, 200));
      }
    } catch (err: any) {
      console.warn("⚠️ Status option sync failed:", String(err?.message || err).slice(0, 200));
    }
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
      const verifyRes = await this.projectGh(["gh", "project", "view", String(roadmap.projectNumber), "--owner", owner]);
      if (verifyRes.exitCode === 0) {
        const relinkArgs = ["gh", "project", "link", String(roadmap.projectNumber), "--owner", owner];
        if (CONFIG.GITHUB_REPOSITORY) relinkArgs.push("--repo", CONFIG.GITHUB_REPOSITORY);
        const relinkRes = await this.projectGh(relinkArgs);
        if (relinkRes.exitCode !== 0) {
          console.warn(`⚠️ Project #${roadmap.projectNumber} exists but repo re-link failed:`, relinkRes.stderr);
        } else {
          console.log(`🔗 Project #${roadmap.projectNumber} linked to repository.`);
        }
        await this.ensureStatusOptions(roadmap.projectNumber, owner);
        return roadmap.projectNumber;
      }
    }

    // 2. Check if a project with matching title already exists
    console.log(`🔍 Checking existing GitHub Projects for owner '${owner}'...`);
    const listRes = await this.projectGh(["gh", "project", "list", "--owner", owner, "--format", "json"]);

    if (listRes.exitCode === 0 && listRes.stdout) {
      try {
        const data = JSON.parse(listRes.stdout);
        const projects = data.projects || (Array.isArray(data) ? data : []);
        const existing = projects.find((p: any) => p.title === projectTitle || p.title.includes(roadmap.projectName));
        if (existing) {
          console.log(`📌 Found existing GitHub Project: #${existing.number} (${existing.title})`);
          roadmap.projectNumber = existing.number;
          roadmap.projectUrl = existing.url;
          await this.ensureStatusOptions(existing.number, owner);
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
      "gh",
      "project",
      "create",
      "--owner",
      owner,
      "--title",
      projectTitle,
      "--format",
      "json",
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
          console.warn(
            `⚠️ Project #${projectNum} created but repo link failed (board won't show under repo Projects tab):`,
            linkRes.stderr
          );
        } else {
          console.log(`🔗 Project #${projectNum} linked to repository.`);
        }
        await this.ensureLabels();
        await this.ensureStatusOptions(projectNum, owner);
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
   * Missing milestones are created; closed ones reopen ONLY when their
   * tasks are still unfinished (isComplete=false). Unconditionally
   * reopening caused close/open thrash with a duplicate release attempt
   * every tick for already-finished milestones.
   */
  public static async ensureMilestones(
    milestones: { title: string; description?: string }[],
    isComplete?: (title: string) => boolean
  ): Promise<void> {
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
        await Bun.sleep(800);
      } else if (hit.state === "closed" && !(isComplete?.(m.title) ?? false)) {
        console.log(`🔓 Reopening closed Milestone: "${m.title}" (#${hit.number}) — unfinished tasks remain...`);
        await GitManager.run(["gh", "api", `repos/:owner/:repo/milestones/${hit.number}`, "-X", "PATCH", "-f", "state=open"]);
        await Bun.sleep(500);
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
      { name: "role:mobile", color: "BFD4F2", description: "Mobile app task" },
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
        "gh",
        "label",
        "create",
        lbl.name,
        "--color",
        lbl.color,
        "--description",
        lbl.description,
        "--force",
      ]);
      await Bun.sleep(400);
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
      "gh",
      "issue",
      "list",
      "--search",
      `[${taskId}]`,
      "--state",
      "all",
      "--limit",
      "50",
      "--json",
      "number,url,title,state",
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
      const viewRes = await GitManager.run(["gh", "issue", "view", String(task.issueNumber), "--json", "number,url,state"]);
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
      const viewRes = await GitManager.run(["gh", "issue", "view", String(task.issueNumber), "--json", "milestone"]);
      if (viewRes.exitCode === 0) {
        try {
          const current = JSON.parse(viewRes.stdout).milestone?.title;
          if (current !== milestoneTitle) {
            await GitManager.run(["gh", "issue", "edit", String(task.issueNumber), "--milestone", milestoneTitle]);
          }
        } catch {
          /* non-fatal */
        }
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
          `**Dependencies:** ${task.dependencies.length > 0 ? task.dependencies.map((d) => `\`${d}\``).join(", ") : "None"}\n` +
          `\n*Details are tracked privately; this issue carries status only.*\n`
        : `### Task Description\n${task.description}\n\n` +
          `**Assigned Role:** \`${task.role}\`\n` +
          `**Branch:** \`${task.branch}\`\n` +
          `**Target Files:** \`${task.targetFiles.join(", ")}\`\n` +
          `**Dependencies:** ${task.dependencies.length > 0 ? task.dependencies.map((d) => `\`${d}\``).join(", ") : "None"}\n`;

      const createArgs = [
        "gh",
        "issue",
        "create",
        "--title",
        `[${task.id}] ${task.title}`,
        "--body",
        body,
        "--label",
        "subagent",
        "--label",
        `role:${task.role}`,
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
      // Polite pacing: GitHub secondary rate limits trigger when creating issues too fast
      await Bun.sleep(1500);
    }
  }

  /**
   * Legacy wrapper: issue sync only. Board membership is batched via
   * syncBoardState — call it once after the loop instead of per task.
   */
  public static async syncTaskToProject(_projectNumber: number | null, task: TaskItem, milestoneTitle?: string): Promise<void> {
    await this.ensureTaskIssue(task, milestoneTitle);
  }

  private static desiredBoardStatus(task: TaskItem): "Todo" | "In Progress" | "In Review" | "Done" | "Failed" {
    switch (task.status) {
      case "IN_PROGRESS":
        return "In Progress";
      case "IN_REVIEW":
        return "In Review";
      case "COMPLETED":
        return "Done";
      case "FAILED":
        return "Failed";
      default:
        return "Todo";
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
  ): Promise<{ byUrl: Map<string, string>; byTask: Map<string, string>; ok: boolean }> {
    const byUrl = new Map<string, string>();
    const byTask = new Map<string, string>();
    const res = await this.projectGh([
      "gh",
      "project",
      "item-list",
      String(projectNumber),
      "--owner",
      owner,
      "--format",
      "json",
      "-L",
      "100",
    ]);
    if (res.exitCode !== 0) {
      this.hintProjectScope(res.stderr);
      console.warn("⚠️ Board snapshot failed:", res.stderr.slice(0, 300));
      return { byUrl, byTask, ok: false };
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
      return { byUrl, byTask, ok: false };
    }
    return { byUrl, byTask, ok: true };
  }

  /**
   * Batched board sync: 1 snapshot read + writes only for missing items or
   * drifted statuses. A steady-state run costs ~1 PAT call instead of 2×tasks.
   * Fresh adds skip the Status edit when the desired value is the board
   * default ("Todo").
   */
  public static async syncBoardState(
    roadmap: Roadmap,
    projectNumber: number
  ): Promise<{ added: number; updated: number; skipped: number }> {
    const stats = { added: 0, updated: 0, skipped: 0 };
    const me = await this.getOwner();
    const repoOwner = await this.getRepoOwner();
    const owner = repoOwner || me;

    const snap = await this.getBoardSnapshot(projectNumber, owner);
    // Fail-closed: a dead snapshot (quota, auth) must NOT look like an
    // empty board — that path re-adds every item and fabricates stats.
    if (!snap.ok) {
      console.warn("⚠️ Board sync skipped: snapshot unavailable; retry next tick.");
      return stats;
    }
    for (const task of roadmap.tasks) {
      if (!task.issueUrl) {
        stats.skipped++;
        continue;
      }
      const desired = this.desiredBoardStatus(task);
      const current = snap.byUrl.get(task.issueUrl) ?? snap.byTask.get(`[${task.id}]`) ?? null;
      if (current === null) {
        const addRes = await this.projectGh([
          "gh",
          "project",
          "item-add",
          String(projectNumber),
          "--owner",
          owner,
          "--url",
          task.issueUrl,
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
        await Bun.sleep(500);
      } else if (current !== desired) {
        await this.updateItemStatus(projectNumber, task, desired);
        stats.updated++;
        await Bun.sleep(500);
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
   * Update Project item Status column (Todo, In Progress, In Review, Done, Failed).
   * Missing options are healed by ensureStatusOptions; a residual miss still
   * warns instead of throwing.
   */
  public static async updateItemStatus(
    projectNumber: number,
    task: TaskItem,
    status: "Todo" | "In Progress" | "In Review" | "Done" | "Failed"
  ): Promise<void> {
    if (!task.issueUrl) return;

    const owner = await this.getBoardOwner();
    console.log(`📊 Moving [${task.id}] to '${status}' in Project #${projectNumber}...`);

    const editArgs = [
      "gh",
      "project",
      "item-edit",
      String(projectNumber),
      "--owner",
      owner,
      "--url",
      task.issueUrl,
      "--field",
      "Status",
      "--value",
      status,
    ];
    let editRes = await this.projectGh(editArgs);
    if (editRes.exitCode !== 0 && /is not an item in project/i.test(editRes.stderr)) {
      // Self-heal: stale boards (same-titled ghosts) or fresh items missing
      // from the board — add first, then retry the edit once.
      console.log(`➕ Issue not on board; adding before status edit...`);
      const addRes = await this.projectGh(["gh", "project", "item-add", String(projectNumber), "--owner", owner, "--url", task.issueUrl]);
      if (addRes.exitCode === 0) {
        editRes = await this.projectGh(editArgs);
      } else {
        this.hintProjectScope(addRes.stderr);
        console.warn(`⚠️ Could not add issue #${task.issueNumber} to project:`, addRes.stderr.slice(0, 200));
      }
    }
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
        "gh",
        "issue",
        "close",
        String(task.issueNumber),
        "--comment",
        `✅ **Task Completed & Verified:** Merged into integration branch with 0 test failures.`,
      ]);
      await Bun.sleep(500);
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
    await GitManager.run(["gh", "issue", "comment", String(task.issueNumber), "--body", body]);
  }
}
