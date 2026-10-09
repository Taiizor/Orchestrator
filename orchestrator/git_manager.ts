import { CONFIG } from "./config.ts";

export class GitManager {
  /**
   * Run a shell command via Bun.spawn
   */
  public static async run(
    cmd: string[],
    cwd = ".",
    input?: string,
    envOverrides?: Record<string, string>
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const options: any = {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      };
      if (envOverrides) {
        options.env = { ...process.env, ...envOverrides };
      }
      if (input !== undefined) {
        options.stdin = new Response(input).body;
      }
      const proc = Bun.spawn(cmd, options);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
    } catch (err: any) {
      return { stdout: "", stderr: err?.message || String(err), exitCode: 1 };
    }
  }

  /**
   * Configure Git author identity for automated CI commits
   */
  public static async setupGitAuthor(): Promise<void> {
    await this.run(["git", "config", "user.name", "github-actions[bot]"]);
    await this.run(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"]);
  }

  /**
   * Fetch all remote branches
   */
  public static async fetchAll(): Promise<void> {
    await this.run(["git", "fetch", "--all"]);
  }

  /**
   * Check if a remote or local branch exists
   */
  public static async branchExists(branchName: string): Promise<boolean> {
    const res = await this.run(["git", "rev-parse", "--verify", branchName]);
    if (res.exitCode === 0) return true;
    const remoteRes = await this.run(["git", "rev-parse", "--verify", `origin/${branchName}`]);
    return remoteRes.exitCode === 0;
  }

  /**
   * Get diff between a task branch and base branch
   */
  public static async getBranchDiff(taskBranch: string, baseBranch: string): Promise<string> {
    await this.fetchAll();
    const res = await this.run(["git", "diff", `origin/${baseBranch}...origin/${taskBranch}`]);
    if (res.exitCode !== 0) {
      // Try local diff fallback
      const localRes = await this.run(["git", "diff", `${baseBranch}...${taskBranch}`]);
      return localRes.stdout;
    }
    return res.stdout;
  }

  /**
   * List files changed on a task branch vs base branch.
   */
  public static async getBranchFileList(taskBranch: string, baseBranch: string): Promise<string[]> {
    await this.fetchAll();
    const base = baseBranch || CONFIG.INTEGRATION_BRANCH;
    const res = await this.run([
      "git", "diff", "--name-only", `origin/${base}...origin/${taskBranch}`,
    ]);
    if (res.exitCode === 0 && res.stdout.trim()) {
      return res.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
    }
    const localRes = await this.run(["git", "diff", "--name-only", `${base}...${taskBranch}`]);
    if (localRes.exitCode === 0 && localRes.stdout.trim()) {
      return localRes.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
    }
    return [];
  }

  /**
   * Merge task branch into integration branch cleanly
   */
  public static async mergeTaskBranch(taskBranch: string, targetBranch: string, commitMsg: string): Promise<boolean> {
    await this.fetchAll();
    await this.run(["git", "checkout", targetBranch]);
    await this.run(["git", "pull", "origin", targetBranch]);

    const mergeRes = await this.run(["git", "merge", "--no-ff", `origin/${taskBranch}`, "-m", commitMsg]);
    if (mergeRes.exitCode !== 0) {
      console.warn(`⚠️ Merge conflict detected when merging ${taskBranch} into ${targetBranch}. Invoking AI Conflict Resolver...`);
      
      const { ConflictResolver } = await import("./conflict_resolver.ts");
      const resolved = await ConflictResolver.resolveConflicts();

      if (resolved) {
        console.log(`🎉 Merge conflict automatically resolved by AI for ${taskBranch}!`);
        await this.run(["git", "commit", "-m", `chore(merge): resolve conflicts integrating ${taskBranch}`]);
      } else {
        console.error(`❌ Automated conflict resolution could not resolve ${taskBranch} safely. Aborting merge.`);
        await this.run(["git", "merge", "--abort"]);
        return false;
      }
    }

    const pushRes = await this.run(["git", "push", "origin", targetBranch]);
    return pushRes.exitCode === 0;
  }

  /**
   * Commit and push changes on current branch (e.g. state branch or main).
   * Uses optimistic-concurrency retries: on push rejection, fetch + rebase
   * and retry up to 3 times so parallel orchestrator/subagent writers
   * don't silently drop state updates.
   */
  public static async commitAndPush(message: string, files: string[] = ["."], maxRetries = 3): Promise<boolean> {
    for (const file of files) {
      await this.run(["git", "add", file]);
    }
    const commitRes = await this.run(["git", "commit", "-m", message]);
    if (commitRes.exitCode !== 0 && !commitRes.stdout.includes("nothing to commit") && !commitRes.stderr.includes("nothing to commit")) {
      console.warn("Git commit output:", commitRes.stdout || commitRes.stderr);
    }
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const pushRes = await this.run(["git", "push"]);
      if (pushRes.exitCode === 0) return true;
      console.warn(`⚠️ Push rejected (attempt ${attempt}/${maxRetries}). Fetching and rebasing...`);
      await this.run(["git", "fetch", "origin"]);
      const rebaseRes = await this.run(["git", "pull", "--rebase"]);
      if (rebaseRes.exitCode !== 0) {
        console.error("❌ Rebase failed; aborting to avoid corrupting state:", rebaseRes.stderr);
        await this.run(["git", "rebase", "--abort"]);
        return false;
      }
    }
    return false;
  }

  /**
   * Dispatch Subagent GitHub Actions workflow
   */
  public static async dispatchSubagentWorkflow(taskId: string, role: string, branch: string): Promise<boolean> {
    console.log(`🚀 Dispatching GitHub Action for ${taskId} (${role}) on branch ${branch}...`);

    // Using gh CLI (pre-installed in GitHub Actions runners)
    const res = await this.run([
      "gh", "workflow", "run", CONFIG.SUBAGENT_WORKFLOW,
      "-f", `taskId=${taskId}`,
      "-f", `role=${role}`,
      "-f", `branch=${branch}`
    ]);

    if (res.exitCode !== 0) {
      console.error(`Failed to dispatch workflow via gh CLI:`, res.stderr);
      return false;
    }

    console.log(`✅ Workflow successfully dispatched for ${taskId}.`);
    return true;
  }

  /**
   * Check status of GitHub workflow runs
   */
  public static async getRecentWorkflowRuns(workflowName: string): Promise<any[]> {
    const res = await this.run([
      "gh", "run", "list",
      "--workflow", workflowName,
      "--json", "databaseId,status,conclusion,name,headBranch,createdAt"
    ]);

    if (res.exitCode !== 0) {
      return [];
    }

    try {
      return JSON.parse(res.stdout);
    } catch {
      return [];
    }
  }

  /**
   * Get all currently active (in_progress, queued, waiting, requested) subagent runs.
   * Queries without --status filter and filters locally so queued runs are not missed.
   */
  public static async getActiveSubagentRuns(): Promise<any[]> {
    const res = await this.run([
      "gh", "run", "list",
      "--workflow", CONFIG.SUBAGENT_WORKFLOW,
      "--limit", "50",
      "--json", "databaseId,status,conclusion,name,headBranch,createdAt,updatedAt"
    ]);

    if (res.exitCode !== 0) return [];
    try {
      const runs = JSON.parse(res.stdout);
      return runs.filter((r: any) =>
        ["in_progress", "queued", "waiting", "requested", "pending"].includes(r.status)
      );
    } catch {
      return [];
    }
  }

  /**
   * Find the most recent workflow run for a given task branch (for runId tracking).
   */
  public static async findRunForBranch(branch: string): Promise<number | null> {
    const runs = await this.getRecentWorkflowRuns(CONFIG.SUBAGENT_WORKFLOW);
    const match = runs.find((r: any) => r.headBranch === branch);
    // getRecentWorkflowRuns payload has no headBranch; fall back to full query
    if (match?.databaseId) return match.databaseId;
    const res = await this.run([
      "gh", "run", "list",
      "--workflow", CONFIG.SUBAGENT_WORKFLOW,
      "--limit", "50",
      "--json", "databaseId,headBranch,createdAt"
    ]);
    if (res.exitCode !== 0) return null;
    try {
      const all = JSON.parse(res.stdout);
      const hit = all.find((r: any) => r.headBranch === branch);
      return hit ? hit.databaseId : null;
    } catch {
      return null;
    }
  }

  /**
   * Cancel an active subagent workflow run (intervene / redirect)
   */
  public static async cancelWorkflowRun(runId: number): Promise<boolean> {
    console.log(`🛑 Cancelling workflow run ${runId}...`);
    const res = await this.run(["gh", "run", "cancel", String(runId)]);
    return res.exitCode === 0;
  }

  /**
   * Get recent log tail of a specific workflow run
   */
  public static async getRunLogs(runId: number): Promise<string> {
    const res = await this.run(["gh", "run", "view", String(runId), "--log"]);
    return res.exitCode === 0 ? res.stdout.slice(-4000) : "";
  }
}
