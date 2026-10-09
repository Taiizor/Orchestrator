import { CONFIG } from "./config.ts";

export class GitManager {
  /**
   * Run a shell command via Bun.spawn.
   * timeoutMs > 0 kills the process group on expiry (returns exitCode 124
   * with a marker) so hung CLIs can never stall a tick forever.
   */
  public static async run(
    cmd: string[],
    cwd = ".",
    input?: string,
    envOverrides?: Record<string, string>,
    timeoutMs = 0
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
      let timedOut = false;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              try {
                proc.kill();
              } catch {
                // already exited
              }
            }, timeoutMs)
          : undefined;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      if (timer) clearTimeout(timer);
      if (timedOut) {
        return {
          stdout: stdout.trim(),
          stderr: (stderr.trim() + `\n[TIMEOUT after ${timeoutMs}ms: ${cmd[0]}]`).trim(),
          exitCode: 124,
        };
      }
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
    } catch (err: any) {
      return { stdout: "", stderr: err?.message || String(err), exitCode: 1 };
    }
  }

  /**
   * True when two refs share at least one commit. Three-dot diffs need a
   * merge base; without one (e.g. a task branch forked from the wrong
   * remote) diff tooling fails — callers must treat that as UNKNOWN,
   * never as "no changes".
   */
  public static async haveCommonAncestor(a: string, b: string): Promise<boolean> {
    await this.fetchAll();
    const res = await this.run(["git", "merge-base", a, b]);
    return res.exitCode === 0;
  }

  /**
   * Commits on the branch unreachable from the base (i.e. real new work).
   * Zero + empty diff means the agent produced nothing (merged branches keep
   * their unique commits, so they never hit zero).
   * Returns -1 when unknowable — including unrelated histories, where a
   * two-dot range would yield a bogus full-branch count. Callers route -1
   * to review, never to auto-complete.
   */
  public static async branchUniqueCommits(branchName: string, baseBranch: string): Promise<number> {
    const remote = this.contentRemote();
    const base = baseBranch || CONFIG.INTEGRATION_BRANCH;
    if (!(await this.haveCommonAncestor(`${remote}/${base}`, `${remote}/${branchName}`))) {
      return -1;
    }
    const res = await this.run(["git", "rev-list", "--count", `${remote}/${base}..${remote}/${branchName}`]);
    if (res.exitCode === 0 && /^\d+$/.test(res.stdout.trim())) {
      return parseInt(res.stdout.trim(), 10);
    }
    return -1;
  }

  /**
   * Newest commit timestamp (ms) among branch-unique commits, or -1 when the
   * branch adds nothing over base. Unlike tip time, this ignores inherited
   * history — a no-op publish pointing at a recent develop commit reads stale.
   */
  public static async branchUniqueTipTime(branchName: string, baseBranch: string): Promise<number> {
    const remote = this.contentRemote();
    const base = baseBranch || CONFIG.INTEGRATION_BRANCH;
    if (!(await this.haveCommonAncestor(`${remote}/${base}`, `${remote}/${branchName}`))) {
      return -1;
    }
    const res = await this.run(["git", "log", "-1", "--format=%ct", `${remote}/${base}..${remote}/${branchName}`]);
    if (res.exitCode === 0 && /^\d+$/.test(res.stdout.trim())) {
      return parseInt(res.stdout.trim(), 10) * 1000;
    }
    return -1;
  }

  /**
   * Tip commit SHA of a content branch, or null when unresolvable.
   * Used to skip re-reviewing unchanged branches (LLM cost saver).
   */
  public static async branchTipSha(branchName: string): Promise<string | null> {
    await this.fetchAll();
    const remote = this.contentRemote();
    for (const ref of [`${remote}/${branchName}`, branchName]) {
      const res = await this.run(["git", "rev-parse", ref]);
      const sha = res.stdout.trim();
      if (res.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha)) return sha;
    }
    return null;
  }

  /**
   * Last-commit timestamp (ms) of a content branch tip, or -1 when the
   * branch/ref is unknown. Used by the watchdog to tell live workers
   * (fresh pushes) from dead ones.
   */
  public static async branchTipTime(branchName: string): Promise<number> {
    const remote = this.contentRemote();
    for (const ref of [`${remote}/${branchName}`, branchName]) {
      const res = await this.run(["git", "log", "-1", "--format=%ct", ref]);
      if (res.exitCode === 0 && /^\d+$/.test(res.stdout.trim())) {
        return parseInt(res.stdout.trim(), 10) * 1000;
      }
    }
    return -1;
  }

  /**
   * Configure Git author identity for automated CI commits
   */
  public static async setupGitAuthor(): Promise<void> {
    await this.run(["git", "config", "user.name", "github-actions[bot]"]);
    await this.run(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"]);
  }

  // =====================================================================
  // Dual-repo layer (public skeleton + private data repo).
  // Data mode is ON when CONFIG.DATA_REPO is set. Content branches
  // (task/*, develop) and the inputs//workspace/ trees then live in the
  // data repo; this public repo keeps engine code + state/* only.
  // =====================================================================

  /** True when content branches live in the private data repo. */
  public static isDataMode(): boolean {
    return !!CONFIG.DATA_REPO.trim();
  }

  /** Remote carrying content branches: "data" or legacy "origin". */
  public static contentRemote(): string {
    return this.isDataMode() ? CONFIG.DATA_REMOTE : "origin";
  }

  /** Normalize DATA_REPO ("owner/name" or https URL) to "owner/name". */
  public static dataRepoSlug(): string | null {
    const raw = (CONFIG.DATA_REPO || "").trim().replace(/\/+$/, "");
    if (!raw) return null;
    const m = raw.match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
    if (m) return m[1].trim();
    if (/^[^/\s]+\/[^/\s]+$/.test(raw)) return raw;
    return null;
  }

  /**
   * Effective data credential, whitespace-trimmed. Pasted secrets with
   * trailing newlines are a classic silent-auth-failure source.
   */
  public static dataPat(): string {
    return (CONFIG.DATA_PAT || "").trim();
  }

  /**
   * Env override neutralizing the credential that actions/checkout stores
   * (http.https://github.com/.extraheader with the PUBLIC repo's
   * GITHUB_TOKEN). Without this, every data-remote call sends the wrong
   * Authorization header and GitHub answers "Repository not found" — even
   * with a perfectly valid PAT embedded in the URL.
   */
  private static dataGitEnv(): Record<string, string> {
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "",
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  /** git invocation for data-remote network ops (fetch/push/ls-remote). */
  public static async dataGit(
    args: string[],
    cwd = ".",
    input?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.run(["git", ...args], cwd, input, this.dataGitEnv());
  }

  /**
   * Network op against a named remote: data-remote calls go through the
   * extraheader-neutralized path, everything else uses ambient auth.
   * (Neutralizing globally would break origin pushes that rely on the
   * checkout-stored credential.)
   */
  public static async remoteGit(
    remote: string,
    args: string[],
    cwd = ".",
    input?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.isDataMode() && remote === CONFIG.DATA_REMOTE) {
      return this.dataGit(args, cwd, input);
    }
    return this.run(["git", ...args], cwd, input);
  }

  /**
   * Register + fetch the data remote (PAT-authenticated). Idempotent.
   * Returns false when DATA_REPO is unset or unreachable — callers fall
   * back to single-repo behavior.
   */
  public static async ensureDataRemote(): Promise<boolean> {
    if (!this.isDataMode()) return false;
    const slug = this.dataRepoSlug();
    if (!slug) {
      console.warn(`⚠️ DATA_REPO value "${CONFIG.DATA_REPO}" is not a valid owner/name or URL. Single-repo fallback.`);
      return false;
    }
    const remote = CONFIG.DATA_REMOTE;
    const existing = await this.run(["git", "remote", "get-url", remote]);
    const pat = this.dataPat();
    let url = `https://github.com/${slug}.git`;
    if (pat) {
      const user = slug.split("/")[0];
      url = `https://${user}:${pat}@github.com/${slug}.git`;
      console.log(`🔑 Data remote auth: explicit DATA_PAT/GH_PROJECT_TOKEN (${pat.length} chars).`);
    } else {
      console.warn("⚠️ DATA_PAT (or GH_PROJECT_TOKEN) is empty; data remote may fail auth.");
    }
    if (existing.exitCode !== 0) {
      await this.run(["git", "remote", "add", remote, url]);
    } else {
      // Refresh credentials in case the PAT rotated
      await this.run(["git", "remote", "set-url", remote, url]);
    }
    // Scrub note: the PAT lives only in local .git/config of the ephemeral
    // runner and is never printed (we never log remote URLs).
    const fetchRes = await this.remoteGit(remote, ["fetch", remote]);
    if (fetchRes.exitCode !== 0) {
      console.warn(`⚠️ Could not fetch data remote "${slug}":`, fetchRes.stderr);
      return false;
    }
    console.log(`📦 Data remote ready: ${slug} (content branches via "${remote}/...").`);
    return true;
  }

  /**
   * Materialize data content (inputs/, workspace/) from a data-remote branch
   * into the workdir. Ignored by git locally, so public commits can't leak it.
   * Tries the requested ref, then develop, then main (first-run bootstrap).
   */
  public static async syncDataIn(branch: string, paths: string[] = [CONFIG.INPUTS_DIR, CONFIG.WORKSPACE_DIR]): Promise<boolean> {
    if (!this.isDataMode()) return true;
    const remote = CONFIG.DATA_REMOTE;
    const candidates = [branch, CONFIG.INTEGRATION_BRANCH, CONFIG.BASE_BRANCH];
    let synced = false;
    for (const ref of candidates) {
      await this.remoteGit(remote, ["fetch", remote, ref]);
      // Checkout paths individually: a data branch may legitimately lack
      // some of them (e.g. inputs-only seed without workspace/ yet).
      for (const p of paths) {
        const res = await this.run(["git", "checkout", `${remote}/${ref}`, "--", p]);
        if (res.exitCode === 0) {
          console.log(`📥 Synced ${p} from ${remote}/${ref}.`);
          synced = true;
        }
      }
      if (synced) return true;
    }
    console.log(`ℹ️ No data content found on ${remote} yet (fresh data repo?) — using local templates.`);
    return false;
  }

  /** Materialize private runtime state (roadmap/progress) from data main. */
  public static async syncStateIn(): Promise<boolean> {
    return this.syncDataIn(CONFIG.BASE_BRANCH, [CONFIG.STATE_DIR]);
  }

  /**
   * Read a file from a content branch (data-aware). Returns null when absent.
   */
  public static async showFile(branch: string, path: string): Promise<string | null> {
    await this.fetchAll();
    const remote = this.contentRemote();
    const res = await this.run(["git", "show", `${remote}/${branch}:${path}`]);
    if (res.exitCode === 0) return res.stdout;
    const localRes = await this.run(["git", "show", `${branch}:${path}`]);
    return localRes.exitCode === 0 ? localRes.stdout : null;
  }

  /**
   * Fetch all remote branches
   */
  public static async fetchAll(): Promise<void> {
    await this.run(["git", "fetch", "--all"]);
  }

  /**
   * Check if a remote or local branch exists (content-remote aware)
   */
  public static async branchExists(branchName: string): Promise<boolean> {
    const res = await this.run(["git", "rev-parse", "--verify", branchName]);
    if (res.exitCode === 0) return true;
    const remoteRes = await this.run(["git", "rev-parse", "--verify", `${this.contentRemote()}/${branchName}`]);
    return remoteRes.exitCode === 0;
  }

  /**
   * Get diff between a task branch and base branch (content-remote aware).
   * Three-dot first (changes since fork); when histories are unrelated and
   * no merge base exists, falls back to two-dot (tip-vs-tip) so reviewers
   * still see content instead of a misleading empty diff.
   */
  public static async getBranchDiff(taskBranch: string, baseBranch: string): Promise<string> {
    await this.fetchAll();
    const remote = this.contentRemote();
    const three = await this.run(["git", "diff", `${remote}/${baseBranch}...${remote}/${taskBranch}`]);
    if (three.exitCode === 0) return three.stdout;
    const localThree = await this.run(["git", "diff", `${baseBranch}...${taskBranch}`]);
    if (localThree.exitCode === 0 && localThree.stdout.trim()) return localThree.stdout;
    // Unrelated histories: tip-vs-tip needs no merge base.
    const twoDot = await this.run(["git", "diff", `${remote}/${baseBranch}..${remote}/${taskBranch}`]);
    if (twoDot.exitCode === 0) return twoDot.stdout;
    return localThree.stdout;
  }

  /**
   * List files changed on a task branch vs base branch.
   * Returns null when the branches cannot be diffed at all (e.g. no
   * common ancestor AND tip diff unavailable) — UNKNOWN, never [].
   * An empty array means a successful diff with zero files.
   * With excludeDeleted, pure removals are hidden: scope/secret/size rules
   * judge what the task ADDED or changed, not repair-era files missing
   * from its tree but alive on develop.
   */
  public static async getBranchFileList(
    taskBranch: string,
    baseBranch: string,
    opts?: { excludeDeleted?: boolean }
  ): Promise<string[] | null> {
    await this.fetchAll();
    const base = baseBranch || CONFIG.INTEGRATION_BRANCH;
    const remote = this.contentRemote();
    const filt = opts?.excludeDeleted ? ["--diff-filter=ACMR"] : [];
    const res = await this.run(["git", "diff", "--name-only", ...filt, `${remote}/${base}...${remote}/${taskBranch}`]);
    if (res.exitCode === 0) {
      return res.stdout
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    }
    const localRes = await this.run(["git", "diff", "--name-only", ...filt, `${base}...${taskBranch}`]);
    if (localRes.exitCode === 0) {
      return localRes.stdout
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    }
    // Last resort: tip-vs-tip needs no merge base.
    const twoDot = await this.run(["git", "diff", "--name-only", ...filt, `${remote}/${base}..${remote}/${taskBranch}`]);
    if (twoDot.exitCode === 0) {
      return twoDot.stdout
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    }
    return null;
  }

  /**
   * Merge task branch into integration branch cleanly.
   * Content push always targets the content remote (data repo in dual-repo
   * mode) — task/develop branches must never leak to the public origin.
   */
  public static async mergeTaskBranch(taskBranch: string, targetBranch: string, commitMsg: string): Promise<boolean> {
    await this.fetchAll();
    const remote = this.contentRemote();
    // Ensure local target tracks the content remote's integration branch
    await this.run(["git", "checkout", "-B", targetBranch, `${remote}/${targetBranch}`]);
    await this.remoteGit(remote, ["pull", remote, targetBranch]);

    const mergeRes = await this.run(["git", "merge", "--no-ff", `${remote}/${taskBranch}`, "-m", commitMsg]);
    if (mergeRes.exitCode !== 0) {
      console.warn(
        `⚠️ Merge conflict detected when merging ${taskBranch} into ${targetBranch}. Invoking AI Conflict Resolver...`
      );

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

    const pushRes = await this.remoteGit(remote, ["push", remote, targetBranch]);
    return pushRes.exitCode === 0;
  }

  /**
   * Check if a branch exists on a remote (no local checkout needed).
   */
  public static async remoteHasBranch(remote: string, branch: string): Promise<boolean> {
    const res = await this.remoteGit(remote, ["ls-remote", "--heads", remote, branch]);
    return res.exitCode === 0 && res.stdout.trim().length > 0;
  }

  /**
   * Publish a task branch's data content (inputs//workspace/) to the content
   * remote. Force-adds gitignored paths (-f) so agent output travels while
   * the public origin never sees a byte of it.
   */
  public static async publishTaskBranch(branch: string, commitMsg: string): Promise<boolean> {
    // Scrub the index first: file restores above (engine files, state) stage
    // additions the data branch must never absorb. Only inputs/workspace
    // travel in the publish commit.
    await this.run(["git", "reset", "-q"]);
    await this.run(["git", "add", "-f", CONFIG.INPUTS_DIR, CONFIG.WORKSPACE_DIR]);
    // Never publish dependency trees: `add -f` overrides gitignore, and an
    // agent-side `bun install` inside workspace/ would otherwise commit
    // thousands of node_modules files (broke diffs, reviews and merges).
    await this.run(["git", "reset", "-q", `${CONFIG.WORKSPACE_DIR}/node_modules`]);
    const commitRes = await this.run(["git", "commit", "-m", commitMsg]);
    if (commitRes.exitCode !== 0 && !/nothing to commit/i.test(commitRes.stdout + commitRes.stderr)) {
      console.warn("Data commit output:", commitRes.stdout || commitRes.stderr);
    }
    const remote = this.contentRemote();
    const pushRes = await this.remoteGit(remote, ["push", "-u", remote, `HEAD:${branch}`]);
    if (pushRes.exitCode !== 0) {
      console.error(`❌ Could not push data branch ${branch} to ${remote}:`, pushRes.stderr);
      return false;
    }
    return true;
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
    if (
      commitRes.exitCode !== 0 &&
      !commitRes.stdout.includes("nothing to commit") &&
      !commitRes.stderr.includes("nothing to commit")
    ) {
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
      "gh",
      "workflow",
      "run",
      CONFIG.SUBAGENT_WORKFLOW,
      "-f",
      `taskId=${taskId}`,
      "-f",
      `role=${role}`,
      "-f",
      `branch=${branch}`,
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
      "gh",
      "run",
      "list",
      "--workflow",
      workflowName,
      "--json",
      "databaseId,status,conclusion,name,headBranch,createdAt",
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
      "gh",
      "run",
      "list",
      "--workflow",
      CONFIG.SUBAGENT_WORKFLOW,
      "--limit",
      "50",
      "--json",
      "databaseId,status,conclusion,name,headBranch,createdAt,updatedAt",
    ]);

    if (res.exitCode !== 0) return [];
    try {
      const runs = JSON.parse(res.stdout);
      return runs.filter((r: any) => ["in_progress", "queued", "waiting", "requested", "pending"].includes(r.status));
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
      "gh",
      "run",
      "list",
      "--workflow",
      CONFIG.SUBAGENT_WORKFLOW,
      "--limit",
      "50",
      "--json",
      "databaseId,headBranch,createdAt",
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
