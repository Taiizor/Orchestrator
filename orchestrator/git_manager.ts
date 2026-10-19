import { CONFIG, refreshAuthFromEnv } from "./config.ts";
import { getInstallationToken, isGitHubAppConfigured } from "./github_app.ts";
import * as GhQuota from "./gh_quota.ts";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { rmSync, mkdirSync, cpSync } from "node:fs";

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
      // gh CLI reads ambient GH_TOKEN/GITHUB_TOKEN at spawn; workflow-minted
      // App tokens expire after ~1h, so a long run must re-mint before its
      // gh calls (board sync, wake calls, releases). A string compare on
      // nearly every call, one mint per hour. The race bounds the refresh so
      // a slow mint can never stall the command itself.
      if (cmd[0] === "gh") {
        await Promise.race([GitManager.ensureFreshGhToken(), Bun.sleep(30_000)]);
      }
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
        const out = {
          stdout: stdout.trim(),
          stderr: (stderr.trim() + `\n[TIMEOUT after ${timeoutMs}ms: ${cmd[0]}]`).trim(),
          exitCode: 124,
        };
        if (cmd[0] === "gh") GhQuota.noteApiResult(out.stderr, out.exitCode);
        return out;
      }
      const res = { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
      // Quota awareness: 429/rate-limit text opens a cooldown window so
      // cosmetic callers degrade instead of burning the shared budget.
      // Local git plumbing never matches (no gh involved) — zero behavior
      // change for merge/persist/dispatch paths.
      if (cmd[0] === "gh") GhQuota.noteApiResult(res.stderr, res.exitCode);
      return res;
    } catch (err: any) {
      return { stdout: "", stderr: err?.message || String(err), exitCode: 1 };
    }
  }

  /** Cooldown after a failed mint attempt: gh calls must not hammer the
   *  GitHub API trying to refresh credentials that cannot be minted. */
  private static ghTokenRefreshFailedAt = 0;

  /**
   * Keep ambient gh credentials fresh for the process lifetime. Workflow-
   * minted App installation tokens live ~1h; a run that outlives its token
   * (60-min model timeout + model fallback continues — TASK-066 class)
   * would otherwise see every later `gh` call fail auth (board syncs, wake
   * calls, releases). The github_app layer re-mints with a 3-minute expiry
   * buffer, so this costs a string compare per call and one mint per hour.
   *
   * Derived surfaces (GH_PROJECT_TOKEN / DATA_PAT) rotate with the same
   * token ONLY while they hold the previous value — a dedicated PAT secret
   * is never overwritten. Fully inert when App credentials are absent.
   */
  public static async ensureFreshGhToken(): Promise<void> {
    try {
      if (!isGitHubAppConfigured()) return;
      if (Date.now() - GitManager.ghTokenRefreshFailedAt < 5 * 60 * 1000) return;
      const previous = new Set([process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter((v): v is string => Boolean(v)));
      const token = await getInstallationToken();
      if (!token) {
        GitManager.ghTokenRefreshFailedAt = Date.now();
        return;
      }
      GitManager.ghTokenRefreshFailedAt = 0;
      process.env.GH_TOKEN = token;
      process.env.GITHUB_TOKEN = token;
      for (const key of ["GH_PROJECT_TOKEN", "DATA_PAT"]) {
        const current = (process.env[key] || "").trim();
        if (current && previous.has(current)) process.env[key] = token;
      }
      // CONFIG is a snapshot: sync it so CONFIG.PROJECT_TOKEN / DATA_PAT
      // readers (ProjectManager, issue release paths) see the fresh value.
      refreshAuthFromEnv();
    } catch {
      // Credential housekeeping must never break a command.
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
   * Count of LOCAL commits ahead of the remote task-branch tip. Positive
   * means commits exist only on this machine and a dead runner would lose
   * them — publish/checkpoint must push before returning success. When the
   * task-branch ref is missing entirely (brand-new, never-published
   * branch) the delta is measured against the integration branch instead:
   * the runner bases every fresh task branch on it, so commits over
   * develop are exactly the agent's unpushed work. Returns -1 only when
   * neither ref resolves; callers must NOT treat that as "in sync".
   *
   * Why this exists: agents sometimes leave a plain `git commit` as their
   * handoff ("ready for the runner to publish"). Publish/checkpoint then
   * see an empty stage and — reading only REMOTE refs — conclude the work
   * is already on the branch, skipping the push. TASK-064 burned all three
   * attempts exactly this way (605 green tests lost each time). TASK-060
   * hit the same class before its branch ever existed remotely: the
   * missing branch ref made both probes return -1, publish aborted as
   * "no committable output", and two full launch re-verifications died
   * with their runners.
   */
  public static async localCommitsAhead(branchName: string): Promise<number> {
    const remote = this.contentRemote();
    const res = await this.run(["git", "rev-list", "--count", `${remote}/${branchName}..HEAD`]);
    if (res.exitCode === 0 && /^\d+$/.test(res.stdout.trim())) {
      return parseInt(res.stdout.trim(), 10);
    }
    const base = await this.run(["git", "rev-list", "--count", `${remote}/${CONFIG.INTEGRATION_BRANCH}..HEAD`]);
    if (base.exitCode === 0 && /^\d+$/.test(base.stdout.trim())) {
      return parseInt(base.stdout.trim(), 10);
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
    if (remote === "origin") {
      // Long runs: the checkout-stored extraheader dies after ~1h; rotate it
      // so ambient origin ops (fetch/ls-remote/push) keep authenticating.
      await this.refreshOriginAuth({ cwd });
    }
    return this.run(["git", ...args], cwd, input);
  }

  /**
   * Point the data remote URL at the freshest credential available and
   * report whether one was found. GitHub App installation tokens live ~1h;
   * a run that outlives its token (60-min model timeout + model fallback
   * continues — TASK-066) would otherwise keep retrying with a dead
   * credential until the publish is lost. Prefers an in-process mint (the
   * github_app cache re-mints with a 3-min expiry buffer) and falls back to
   * the ambient DATA_PAT. `force` bypasses the mint cache for credentials
   * GitHub already rejected. Cheap + idempotent: when the URL is already
   * current, nothing is rewritten and nothing is logged.
   */
  public static async refreshDataRemoteAuth(opts: { force?: boolean } = {}): Promise<boolean> {
    if (!this.isDataMode()) return false;
    const slug = this.dataRepoSlug();
    if (!slug) return false;
    let token = this.dataPat();
    let source = token ? `explicit DATA_PAT/GH_PROJECT_TOKEN (${token.length} chars)` : "";
    try {
      const minted = ((await getInstallationToken({ force: opts.force })) || "").trim();
      if (minted) {
        token = minted;
        source = `GitHub App installation token (${minted.length} chars)`;
      }
    } catch {
      // Mint failed — the ambient DATA_PAT (if any) is still a candidate.
    }
    if (!token) {
      console.warn("⚠️ DATA_PAT (or GH_PROJECT_TOKEN) is empty and no App token is available; data remote may fail auth.");
      return false;
    }
    const remote = CONFIG.DATA_REMOTE;
    const url = `https://x-access-token:${token}@github.com/${slug}.git`;
    const existing = await this.run(["git", "remote", "get-url", remote]);
    if (existing.exitCode === 0 && existing.stdout.trim() === url) return true;
    if (existing.exitCode !== 0) {
      await this.run(["git", "remote", "add", remote, url]);
    } else {
      // Credential rotated (rotated PAT or a fresh installation token).
      await this.run(["git", "remote", "set-url", remote, url]);
    }
    console.log(`🔑 Data remote auth: ${source}.`);
    return true;
  }

  /** Origin credential state: null = not probed, false = no checkout-managed
   *  header, string = last `AUTHORIZATION: basic ...` value seen or written. */
  private static originAuthCurrent: string | false | null = null;
  /** Test seam: replaces the minted token (no network). Production: null. */
  private static originAuthTokenProvider: ((opts: { force?: boolean }) => Promise<string | null>) | null = null;

  /**
   * actions/checkout stores the job-start credential as an
   * `http.https://github.com/.extraheader` entry in the local git config.
   * That token dies after ~1h — silently breaking every ambient origin
   * operation in a long run (fetch --all, single-repo state/tag/seed
   * pushes): the origin-side leftovers of the TASK-066 class. Rotate the
   * stored header to a fresh App installation token.
   *
   * Strictly conservative: inert without App credentials, inert when no
   * checkout-managed basic-auth header exists (SSH/local setups), scoped to
   * the local config, and skips the write while the stored header already
   * carries the current token (one subprocess on the first call, one more
   * per mint rotation after that).
   */
  public static async refreshOriginAuth(opts: { force?: boolean; cwd?: string } = {}): Promise<boolean> {
    if (!isGitHubAppConfigured()) return false;
    if (GitManager.originAuthCurrent === false) return false;
    const cwd = opts.cwd ?? ".";
    const key = "http.https://github.com/.extraheader";
    if (GitManager.originAuthCurrent === null) {
      const probe = await this.run(["git", "config", "--local", "--get", key], cwd);
      const value = probe.stdout.trim();
      if (probe.exitCode !== 0 || !/^AUTHORIZATION:\s*basic\s+\S+/i.test(value)) {
        GitManager.originAuthCurrent = false;
        return false;
      }
      GitManager.originAuthCurrent = value;
    }
    const token = GitManager.originAuthTokenProvider
      ? await GitManager.originAuthTokenProvider(opts)
      : await getInstallationToken({ force: opts.force });
    if (!token) return false;
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    if (GitManager.originAuthCurrent === header) return false;
    const set = await this.run(["git", "config", "--local", key, header], cwd);
    if (set.exitCode !== 0) return false;
    GitManager.originAuthCurrent = header;
    return true;
  }

  /**
   * Register + fetch the data remote (token-authenticated). Idempotent.
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
    await this.refreshDataRemoteAuth();
    // Scrub note: the token lives only in local .git/config of the ephemeral
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
    // Per-PATH across refs: paths live on different branches (inputs-only
    // seed on main, workspace on develop). Returning after the first hit
    // left the other paths stale/missing — each path walks all refs.
    const got = new Set<string>();
    for (const p of paths) {
      for (const ref of candidates) {
        await this.remoteGit(remote, ["fetch", remote, ref]);
        // Checkout paths individually: a data branch may legitimately lack
        // some of them (e.g. inputs-only seed without workspace/ yet).
        const res = await this.run(["git", "checkout", `${remote}/${ref}`, "--", p]);
        if (res.exitCode === 0) {
          console.log(`📥 Synced ${p} from ${remote}/${ref}.`);
          got.add(p);
          break;
        }
      }
    }
    if (got.size > 0) {
      // Unstage immediately: these files must live in the workdir WITHOUT
      // entering the index — staged state blocks later `checkout -B`
      // switches ("would be overwritten") and leaks into unrelated commits.
      await this.run(["git", "reset", "-q", "--", ...paths]);
      return true;
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
    // Long runs outlive BOTH credentials (checkout extraheader + data URL
    // token); rotate them before a network fetch so refs stay current.
    if (this.isDataMode()) await this.refreshDataRemoteAuth();
    await this.refreshOriginAuth();
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
   * Restore engine files (orchestrator/, subagents/, skills, manifest) from
   * the public checkout after switching to a data-only branch. Data
   * branches lack them, which breaks post-checkout dynamic imports and
   * prompt reads (ENOENT). Warn-only; publish paths scrub the index so
   * these never leak into data commits.
   */
  public static async restoreEngineFiles(): Promise<void> {
    const eng = await this.run([
      "git",
      "checkout",
      "origin/main",
      "--",
      "orchestrator",
      "subagents",
      ".opencode",
      "package.json",
    ]);
    if (eng.exitCode !== 0) {
      console.warn("⚠️ Engine file restore had issues:", (eng.stdout + eng.stderr).slice(0, 300));
      return;
    }
    // Keep workdir files, drop them from the index (same anti-leak rule).
    await this.run(["git", "reset", "-q", "--", "orchestrator", "subagents", ".opencode", "package.json"]);
  }

  /**
   * True when every conflicted path is the per-task scratch report, which
   * every task branch rewrites (auto-resolvable via --ours, no AI needed).
   */
  public static isProgressOnlyConflict(files: string[]): boolean {
    const progressRel = `${CONFIG.WORKSPACE_DIR}/${CONFIG.TASK_PROGRESS_FILE}`;
    return files.length > 0 && files.every((f) => f.replace(/\\/g, "/") === progressRel);
  }

  /**
   * Merge task branch into integration branch cleanly.
   * Content push always targets the content remote (data repo in dual-repo
   * mode) — task/develop branches must never leak to the public origin.
   */
  public static async mergeTaskBranch(taskBranch: string, targetBranch: string, commitMsg: string): Promise<boolean> {
    await this.fetchAll();
    const remote = this.contentRemote();
    // Heal the progress-report merge driver BEFORE merging: GitHub PR merges
    // ignore .gitattributes drivers, so the local fallback below is where
    // the driver actually prevents TASK_PROGRESS.md conflicts. No-op when
    // present or in single-repo mode.
    await this.ensureProgressMergeDriver();
    // Import the resolver BEFORE switching branches: afterwards the workdir
    // holds a data-only tree and the module file is unreachable (ENOENT).
    const { ConflictResolver } = await import("./conflict_resolver.ts");
    // Remember where we are so the tick workdir is left intact afterwards.
    const startRef = (await this.run(["git", "branch", "--show-current"])).stdout.trim() || "main";
    // Clear staged leftovers (synced state etc.) — they abort the switch
    // ("would be overwritten") and would pollute the merge commit.
    await this.run(["git", "reset", "-q"]);
    // Ensure local target tracks the content remote's integration branch
    await this.run(["git", "checkout", "-B", targetBranch, `${remote}/${targetBranch}`]);
    await this.restoreEngineFiles();
    await this.remoteGit(remote, ["pull", remote, targetBranch]);

    const mergeRes = await this.run(["git", "merge", "--no-ff", `${remote}/${taskBranch}`, "-m", commitMsg]);
    if (mergeRes.exitCode !== 0) {
      // Progress-only conflicts resolve deterministically: TASK_PROGRESS.md
      // is a per-task scratch report rewritten by every task, so concurrent
      // branches ALWAYS conflict on it. Keep the integration-branch copy and
      // skip the AI resolver (which adds nothing for a scratch file). Any
      // other conflicted file routes to the resolver below.
      const conflicted = (await this.run(["git", "diff", "--name-only", "--diff-filter=U"])).stdout
        .split("\n")
        .map((f) => f.trim().replace(/\\/g, "/"))
        .filter(Boolean);
      const progressRel = `${CONFIG.WORKSPACE_DIR}/${CONFIG.TASK_PROGRESS_FILE}`;
      if (GitManager.isProgressOnlyConflict(conflicted)) {
        console.log(
          `🧹 Progress-only merge conflict on ${taskBranch}; keeping ${targetBranch} copy (scratch report), no AI resolver needed.`
        );
        await this.run(["git", "checkout", "--ours", "--", progressRel]);
        await this.run(["git", "add", "--", progressRel]);
        const rc = await this.run([
          "git",
          "-c",
          "user.name=github-actions[bot]",
          "-c",
          "user.email=github-actions[bot]@users.noreply.github.com",
          "commit",
          "-m",
          `chore(merge): keep ${targetBranch} TASK_PROGRESS.md integrating ${taskBranch}`,
        ]);
        if (rc.exitCode !== 0) {
          console.error(`❌ Progress-only resolve commit failed for ${taskBranch}; aborting merge.`);
          await this.run(["git", "merge", "--abort"]);
          await this.run(["git", "checkout", startRef]);
          return false;
        }
      } else {
        console.warn(
          `⚠️ Merge conflict detected when merging ${taskBranch} into ${targetBranch}. Invoking AI Conflict Resolver...`
        );

        const resolved = await ConflictResolver.resolveConflicts();

        if (resolved) {
          console.log(`🎉 Merge conflict automatically resolved by AI for ${taskBranch}!`);
          const rc = await this.run(["git", "commit", "-m", `chore(merge): resolve conflicts integrating ${taskBranch}`]);
          if (rc.exitCode !== 0) {
            // A failed resolve-commit is NOT an integration: abort so the next
            // tick retries from a clean tree instead of recording COMPLETED
            // over unmerged work.
            console.error(`❌ Resolve commit failed for ${taskBranch}; aborting merge.`);
            await this.run(["git", "merge", "--abort"]);
            await this.run(["git", "checkout", startRef]);
            return false;
          }
        } else {
          console.error(`❌ Automated conflict resolution could not resolve ${taskBranch} safely. Aborting merge.`);
          await this.run(["git", "merge", "--abort"]);
          await this.run(["git", "checkout", startRef]);
          return false;
        }
      }
    }

    const push = await this.pushWithAuthRetry(remote, [remote, targetBranch], {
      maxRetries: 3,
      betweenAttempts: async (attempt) => {
        const delayMs = attempt * 2000 + Math.floor(Math.random() * 1000);
        console.warn(
          `⚠️ Push failed for merged ${targetBranch} (attempt ${attempt}/3). Backing off for ${delayMs}ms before pull & rebase...`
        );
        await Bun.sleep(delayMs);
        await this.remoteGit(remote, ["pull", "--rebase", remote, targetBranch]);
      },
    });
    if (!push.ok) {
      console.error(`❌ Push failed for merged ${targetBranch} after 3 attempts:`, push.stderr);
    }
    await this.run(["git", "checkout", startRef]);
    return push.ok;
  }

  /**
   * Publish adopted workspace content (inputs/ + workspace/, minus dependency
   * trees and regenerable CI files — same exclusions as publishTaskBranch)
   * onto a data-remote branch via an isolated linked worktree. Used by adopt
   * to seed data/develop so future task branches have a fork point.
   * Returns false on failure (never throws).
   */
  public static async publishWorkspaceTree(
    branch = CONFIG.INTEGRATION_BRANCH,
    commitMsg = "chore(adopt): seed adopted workspace content"
  ): Promise<boolean> {
    const remote = CONFIG.DATA_REMOTE;
    const botIdentity = ["-c", "user.name=github-actions[bot]", "-c", "user.email=github-actions[bot]@users.noreply.github.com"];
    const wtDir = join(tmpdir(), `data-tree-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const wt = async (args: string[]) => this.run(["git", "-C", wtDir, ...args]);
    const cleanup = async () => {
      try {
        await this.run(["git", "worktree", "remove", "--force", wtDir]);
      } catch {
        // Ephemeral runner; leftovers die with the VM (matters only locally).
      }
      try {
        await this.run(["git", "worktree", "prune"]);
      } catch {
        // Best-effort.
      }
    };
    // Mirror sources: force-add overrides gitignore; node_modules and the
    // per-run services env must never travel (thousands of files / diff noise).
    // Same for workspace build output (dist/build/coverage/...): regenerable
    // compiler/bundler artifacts, never reviewable — once flooded a branch
    // with ~100 dist/ files and failed the scope gate three attempts running.
    const isBuildOutputPath = (s: string): boolean => {
      const n = s.replace(/\\/g, "/");
      return (
        /^(?:\.\/)?workspace\/(dist|build|out|coverage|storybook-static)(\/|$)/.test(n) ||
        /\/(obj|TestResults|bin\/(Debug|Release|x64|x86|arm64|net[0-9]))(\/|$)/i.test(n)
      );
    };
    const mirrorFromWorkdir = async (dst: string) => {
      for (const srcDir of [CONFIG.INPUTS_DIR, CONFIG.WORKSPACE_DIR]) {
        const src = join(".", srcDir);
        const target = join(dst, srcDir);
        try {
          rmSync(target, { recursive: true, force: true });
          cpSync(src, target, {
            recursive: true,
            filter: (s) => !s.includes("node_modules") && !s.endsWith(".services.env") && !isBuildOutputPath(s),
          });
        } catch {
          return false;
        }
      }
      return true;
    };
    try {
      await this.run(["git", "worktree", "prune"]);
      rmSync(wtDir, { recursive: true, force: true });
      const hasBranch = await this.remoteHasBranch(remote, branch);
      const startPoint = hasBranch ? `${remote}/${branch}` : `${remote}/${CONFIG.BASE_BRANCH}`;
      const add = await this.run(["git", "worktree", "add", "--detach", wtDir, startPoint]);
      if (add.exitCode !== 0) {
        console.warn("⚠️ Data tree worktree setup failed:", (add.stdout + add.stderr).slice(0, 300));
        return false;
      }
      // Commit + push with per-attempt credential refresh; each retry first
      // re-syncs the scratch worktree onto the remote tip and re-applies the
      // mirror (the fixed non-fast-forward recovery, now credential-aware).
      const prepare = async (): Promise<boolean> => {
        if (!(await mirrorFromWorkdir(wtDir))) {
          console.warn("⚠️ Data tree mirror failed.");
          return false;
        }
        await wt(["add", "-f", CONFIG.INPUTS_DIR, CONFIG.WORKSPACE_DIR]);
        await wt(["reset", "-q", `${CONFIG.WORKSPACE_DIR}/node_modules`, `${CONFIG.WORKSPACE_DIR}/.services.env`]);
        await wt([
          "reset",
          "-q",
          "--",
          ":(glob)**/obj/**",
          ":(glob)**/TestResults/**",
          ":(glob)**/bin/Debug/**",
          ":(glob)**/bin/Release/**",
        ]);
        const commit = await wt([...botIdentity, "commit", "-m", commitMsg]);
        if (commit.exitCode !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
          console.warn(`⚠️ Data tree commit failed:`, (commit.stdout + commit.stderr).slice(0, 300));
          return false;
        }
        return true;
      };
      if (!(await prepare())) return false;
      const push = await this.pushWithAuthRetry(remote, [`HEAD:refs/heads/${branch}`], {
        cwd: wtDir,
        betweenAttempts: async (attempt) => {
          console.warn(`⚠️ Data tree push rejected (attempt ${attempt}/3). Re-syncing...`);
          await Bun.sleep(attempt * 2000);
          await this.remoteGit(remote, ["fetch", remote, branch], wtDir);
          await wt(["reset", "--hard", `${remote}/${branch}`]);
          return prepare();
        },
      });
      if (!push.ok) {
        console.warn(`   ↳ push stderr: ${push.stderr.slice(0, 300)}`);
      }
      return push.ok;
    } finally {
      await cleanup();
    }
  }

  /**
   * Check if a branch exists on a remote (no local checkout needed).
   */
  public static async remoteHasBranch(remote: string, branch: string): Promise<boolean> {
    const res = await this.remoteGit(remote, ["ls-remote", "--heads", remote, branch]);
    return res.exitCode === 0 && res.stdout.trim().length > 0;
  }

  /**
   * Write one file's content onto a data-remote branch (default: integration
   * branch) via an isolated linked worktree — the main checkout is never
   * switched. Creates the content from the remote default branch when the
   * target branch is missing. Returns false on failure (never throws).
   */
  public static async publishFileToData(
    relPath: string,
    content: string,
    commitMsg: string,
    branch = CONFIG.INTEGRATION_BRANCH
  ): Promise<boolean> {
    const remote = CONFIG.DATA_REMOTE;
    const botIdentity = ["-c", "user.name=github-actions[bot]", "-c", "user.email=github-actions[bot]@users.noreply.github.com"];
    const wtDir = join(tmpdir(), `data-file-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const wt = async (args: string[]) => this.run(["git", "-C", wtDir, ...args]);
    const stageAndCommit = async (): Promise<boolean> => {
      const dst = join(wtDir, relPath);
      try {
        mkdirSync(dirname(dst), { recursive: true });
        await Bun.write(dst, content);
      } catch {
        return false;
      }
      await wt(["add", "-f", relPath]);
      const commit = await wt([...botIdentity, "commit", "-m", commitMsg]);
      return commit.exitCode === 0 || /nothing to commit/i.test(commit.stdout + commit.stderr);
    };
    const cleanup = async () => {
      try {
        await this.run(["git", "worktree", "remove", "--force", wtDir]);
      } catch {
        // Ephemeral runner; leftovers die with the VM (matters only locally).
      }
      try {
        await this.run(["git", "worktree", "prune"]);
      } catch {
        // Best-effort.
      }
    };
    try {
      await this.run(["git", "worktree", "prune"]);
      rmSync(wtDir, { recursive: true, force: true });
      const hasBranch = await this.remoteHasBranch(remote, branch);
      const startPoint = hasBranch ? `${remote}/${branch}` : `${remote}/${CONFIG.BASE_BRANCH}`;
      const add = await this.run(["git", "worktree", "add", "--detach", wtDir, startPoint]);
      if (add.exitCode !== 0) {
        console.warn(`⚠️ Data file worktree setup failed for ${relPath}:`, (add.stdout + add.stderr).slice(0, 300));
        return false;
      }
      if (!(await stageAndCommit())) {
        console.warn(`⚠️ Data file stage/commit failed for ${relPath}.`);
        return false;
      }
      const push = await this.pushWithAuthRetry(remote, [`HEAD:refs/heads/${branch}`], {
        cwd: wtDir,
        betweenAttempts: async (attempt) => {
          console.warn(`⚠️ Data file push rejected for ${relPath} (attempt ${attempt}/3). Re-syncing...`);
          await Bun.sleep(attempt * 2000);
          await this.remoteGit(remote, ["fetch", remote, branch], wtDir);
          // Reset only the SCRATCH worktree, then re-apply the file.
          await wt(["reset", "--hard", `${remote}/${branch}`]);
          if (!(await stageAndCommit())) {
            console.warn(`⚠️ Data file stage/commit failed for ${relPath} (attempt ${attempt}/3).`);
            return false;
          }
        },
      });
      if (!push.ok) {
        console.warn(`   ↳ push stderr: ${push.stderr.slice(0, 300)}`);
      }
      return push.ok;
    } finally {
      await cleanup();
    }
  }

  /** Merge-driver rule keeping task→develop merges conflict-free on the
   * per-task scratch report. Builtin `merge=ours` needs no runner config,
   * unlike custom drivers. */
  public static readonly PROGRESS_MERGE_RULE = "workspace/TASK_PROGRESS.md merge=ours";

  /**
   * Full .gitattributes content ensuring the progress-report merge driver.
   * Pure (unit-tested): returns null when no write is needed.
   */
  public static progressMergeDriverContent(existing: string | null): string | null {
    const rule = GitManager.PROGRESS_MERGE_RULE;
    if (existing === null || existing.trim().length === 0) {
      return (
        `# Auto detect text files and perform LF normalization\n* text=auto\n\n` +
        `# Per-task scratch report: keep the destination copy on conflict so\n` +
        `# task merges never block on this regenerable file.\n${rule}\n`
      );
    }
    const normalized = existing.replace(/\r\n/g, "\n");
    if (normalized.split("\n").some((l) => l.trim() === rule)) return null;
    return normalized.replace(/\n+$/, "\n") + `\n# Per-task scratch report: keep the destination copy on conflict.\n${rule}\n`;
  }

  /**
   * Heal long-lived content branches missing the progress-report merge
   * driver (e.g. data repos created before the skeleton shipped it).
   * Data-mode only — single-repo projects inherit it from the template on
   * develop. Best-effort: returns false (never throws) when the write is
   * unnecessary or fails; callers proceed with the merge regardless.
   */
  public static async ensureProgressMergeDriver(): Promise<boolean> {
    if (!this.isDataMode()) return true;
    let existing: string | null = null;
    try {
      existing = await this.showFile(CONFIG.INTEGRATION_BRANCH, ".gitattributes");
    } catch {
      return false;
    }
    const content = GitManager.progressMergeDriverContent(existing);
    if (content === null) return true;
    return this.publishFileToData(".gitattributes", content, "chore(data): ensure TASK_PROGRESS.md merge driver");
  }

  /**
   * Stage product work (inputs/ + workspace/) with the full junk-scrub
   * rule set, returning staged paths. Shared by publishTaskBranch and
   * checkpointTaskBranch so the two can never drift apart.
   */
  public static async stageWorkspaceForPublish(): Promise<string[]> {
    // Scrub the index first: file restores above (engine files, state) stage
    // additions the data branch must never absorb. Only workspace
    // travels in the publish commit.
    await this.run(["git", "reset", "-q"]);
    const a = await this.run(["git", "add", "-f", CONFIG.WORKSPACE_DIR]);
    if (a.exitCode !== 0) {
      console.warn(`⚠️ git add -f ${CONFIG.WORKSPACE_DIR} failed:`, (a.stdout + a.stderr).slice(0, 300));
    }
    // Never publish dependency trees: `add -f` overrides gitignore, and an
    // agent-side `bun install` inside workspace/ would otherwise commit
    // thousands of node_modules files (broke diffs, reviews and merges).
    // Same for `.services.env`: per-run rendered CI endpoints, regenerable
    // every run — committing it only adds diff noise and scope-gate hits.
    // Nested trees too (web/node_modules from a UI task's install): glob
    // magic covers any depth. PHP Composer and Go vendor trees are the same
    // class of junk.
    await this.run(["git", "reset", "-q", `${CONFIG.WORKSPACE_DIR}/node_modules`]);
    await this.run(["git", "reset", "-q", `${CONFIG.WORKSPACE_DIR}/.services.env`]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/node_modules/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/target/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/__pycache__/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/.venv/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/vendor/**"]);
    // .NET / compiler build outputs and test artifacts: regenerable, never
    // reviewable. Dotnet build/test emits hundreds of DLLs, pdb, cache, and
    // nuget assets into obj/ and bin/ (Debug/Release/etc.).
    await this.run(["git", "reset", "-q", "--", ":(glob)**/obj/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/TestResults/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/bin/Debug/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/bin/Release/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/bin/x64/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/bin/x86/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/bin/arm64/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/bin/net*/**"]);
    // Runtime-generated product files: `add -f` overrides the product
    // .gitignore, so Laravel test runs would otherwise publish their cache,
    // throwaway storage probes and a 200k-line laravel.log (once tripped the
    // payload scanner). Regenerable, never reviewable.
    await this.run(["git", "reset", "-q", "--", ":(glob)**/bootstrap/cache/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/storage/logs/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/storage/framework/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/.phpunit.result.cache"]);
    // Framework build output (Nuxt/Next): regenerable, never reviewable —
    // a backend task that touched the frontend tree once published 30 files
    // of .nuxt/ generated types.
    await this.run(["git", "reset", "-q", "--", ":(glob)**/.nuxt/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/.next/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/.output/**"]);
    // Generic build output (tsc/bundlers/coverage): regenerable, never
    // reviewable — a task that ran `bun build` inside workspace/ once
    // published ~100 dist/ files and failed the scope gate three attempts
    // in a row. Mirrors isBuildOutput() in review_gate.ts.
    await this.run(["git", "reset", "-q", "--", ":(glob)**/dist/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/build/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/coverage/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/out/**"]);
    await this.run(["git", "reset", "-q", "--", ":(glob)**/storybook-static/**"]);
    const staged = await this.run(["git", "diff", "--cached", "--name-only"]);
    return staged.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  }

  /**
   * Best-effort checkpoint of current workdir progress onto a task branch.
   * Called periodically WHILE the agent works: if the workflow timeout kills
   * the job, the next attempt resumes from the checkpoint instead of
   * starting over (the runner checks out the existing remote branch).
   * Never throws; empty stage is fine (returns true, nothing to save).
   */
  public static async checkpointTaskBranch(branch: string, taskId: string): Promise<boolean> {
    try {
      const files = await this.stageWorkspaceForPublish();
      if (files.length === 0) {
        // The agent may have committed its own work ("git commit"): those
        // commits exist only on this machine. Push them now so a dead
        // runner does not take the work with it (TASK-064 class).
        const ahead = await this.localCommitsAhead(branch);
        if (ahead > 0) {
          const remote = this.contentRemote();
          console.log(`💾 Checkpoint: ${ahead} agent-made local commit(s) not yet on ${branch}; pushing them.`);
          return this.pushHeadToBranch(branch, remote);
        }
        // Auditable no-op: operators watching the log must be able to tell
        // "nothing to save" apart from "checkpoint never ran".
        console.log(`💾 Checkpoint: no changes on ${branch}, skipping.`);
        return true;
      }
      const commit = await this.run([
        "git",
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=github-actions[bot]@users.noreply.github.com",
        "commit",
        "-m",
        `wip(task): automated checkpoint for ${taskId} (partial state)`,
      ]);
      if (commit.exitCode !== 0) return false;
      if (await this.pushHeadToBranch(branch, this.contentRemote())) {
        console.log(`💾 Checkpointed ${files.length} file(s) to ${branch}.`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  /**
   * Push to a remote with credential freshness (TASK-066 class): when the
   * target is the content remote, the data URL is re-pointed at a fresh App
   * token before EVERY attempt, and a GitHub auth rejection ("Invalid
   * username or token") force-re-mints the credential for the retry instead
   * of bouncing off the same dead token — installation tokens live ~1h and a
   * run can outlive its token (60-min model timeout + fallback continues).
   * Non-content remotes pass straight through untouched.
   *
   * `betweenAttempts` carries the caller's own re-sync logic (pull/rebase,
   * fetch/reset) and may return false to abort the retry loop early.
   */
  public static async pushWithAuthRetry(
    remote: string,
    args: string[],
    opts: { cwd?: string; maxRetries?: number; betweenAttempts?: (attempt: number) => Promise<boolean | void> } = {}
  ): Promise<{ ok: boolean; stderr: string }> {
    const cwd = opts.cwd ?? ".";
    const maxRetries = opts.maxRetries ?? 3;
    const isContentRemote = this.isDataMode() && remote === CONFIG.DATA_REMOTE;
    const isOriginRemote = remote === "origin";
    let forceCredentialRefresh = false;
    let lastStderr = "";
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (isContentRemote) {
        await this.refreshDataRemoteAuth({ force: forceCredentialRefresh });
      } else if (isOriginRemote) {
        await this.refreshOriginAuth({ force: forceCredentialRefresh, cwd });
      }
      const pushRes = await this.remoteGit(remote, ["push", ...args], cwd);
      if (pushRes.exitCode === 0) return { ok: true, stderr: "" };
      lastStderr = (pushRes.stderr || "").trim();
      // `force` bypasses the mint cache once GitHub has rejected a credential
      // the cache still trusts.
      forceCredentialRefresh = this.looksLikeAuthFailure(lastStderr);
      if (attempt < maxRetries && opts.betweenAttempts) {
        const cont = await opts.betweenAttempts(attempt);
        if (cont === false) break;
      }
    }
    return { ok: false, stderr: lastStderr };
  }

  /**
   * Push the current HEAD to the content-remote task branch with the
   * standard transient-failure backoff. Shared by the publish path (fresh
   * publish commit) and the recovery paths (agent-made local commits that
   * were never pushed), so the two can never drift apart.
   */
  private static async pushHeadToBranch(branch: string, remote: string, maxRetries = 3): Promise<boolean> {
    const push = await this.pushWithAuthRetry(remote, ["-u", remote, `HEAD:refs/heads/${branch}`], {
      maxRetries,
      betweenAttempts: async (attempt) => {
        const delayMs = attempt * 2000 + Math.floor(Math.random() * 1000);
        console.warn(
          `⚠️ Push rejected for data branch ${branch} (attempt ${attempt}/${maxRetries}). Backing off for ${delayMs}ms...`
        );
        await Bun.sleep(delayMs);
      },
    });
    if (!push.ok) {
      console.error(`❌ Could not push data branch ${branch} to ${remote} after ${maxRetries} attempts:`, push.stderr);
    }
    return push.ok;
  }

  /**
   * GitHub's rejection text for a dead/revoked/missing credential — distinct
   * from non-fast-forward rejections, which a fresh token cannot fix.
   */
  private static looksLikeAuthFailure(stderr: string): boolean {
    return /invalid username or token|authentication failed|password authentication is not supported|could not read username|terminal prompts disabled/i.test(
      stderr || ""
    );
  }

  /**
   * Publish a task branch's data content (inputs//workspace/) to the content
   * remote. Force-adds gitignored paths (-f) so agent output travels while
   * the public origin never sees a byte of it.
   */
  public static async publishTaskBranch(branch: string, commitMsg: string): Promise<boolean> {
    const files = await this.stageWorkspaceForPublish();
    const remote = this.contentRemote();
    if (files.length === 0) {
      // Empty stage means one of two very different things:
      //  a) The agent committed its own work locally ("git commit") — the
      //     commit exists ONLY on this CI machine. Returning without a
      //     push silently loses it when the runner exits (TASK-064: three
      //     attempts, 605 green tests each, lost exactly this way).
      //  b) A no-op republish: the work is already on the remote branch.
      // Only (b) is success. LOCAL HEAD vs the remote tip tells them apart;
      // comparing remote-only refs made (a) look like (b) before this check.
      const ahead = await this.localCommitsAhead(branch);
      if (ahead > 0) {
        console.log(`📦 Empty stage, but ${ahead} local commit(s) ahead of ${remote}/${branch} — pushing agent-committed work.`);
        return this.pushHeadToBranch(branch, remote);
      }
      const unique = await this.branchUniqueCommits(branch, CONFIG.INTEGRATION_BRANCH);
      if (unique > 0) {
        console.log(`ℹ️ Nothing new to publish on ${branch} (work already on branch).`);
        return true;
      }
      console.error(`❌ Nothing staged for publish on ${branch}: agent produced no committable output.`);
      return false;
    }
    console.log(`📦 Publishing ${files.length} files to ${branch}.`);
    const commitRes = await this.run(["git", "commit", "-m", commitMsg]);
    if (commitRes.exitCode !== 0) {
      console.warn("Data commit output:", commitRes.stdout || commitRes.stderr);
      return false;
    }
    return this.pushHeadToBranch(branch, remote);
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
      const delayMs = attempt * 2000 + Math.floor(Math.random() * 1000);
      console.warn(`⚠️ Push rejected (attempt ${attempt}/${maxRetries}). Backing off for ${delayMs}ms before fetch & rebase...`);
      await Bun.sleep(delayMs);
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
  public static async dispatchSubagentWorkflow(taskId: string, role: string, branch: string, stack?: string): Promise<boolean> {
    console.log(`🚀 Dispatching GitHub Action for ${taskId} (${role}) on branch ${branch}...`);

    // Using gh CLI (pre-installed in GitHub Actions runners)
    const args = [
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
    ];
    if (stack) args.push("-f", `stack=${stack}`);
    const res = await this.run(args);

    if (res.exitCode !== 0) {
      console.error(`Failed to dispatch workflow via gh CLI:`, res.stderr);
      return false;
    }

    // Verify a run actually materialized: `gh workflow run` exiting 0 only
    // means the API accepted the request — GitHub can still drop it
    // silently (a lost dispatch once left a task IN_PROGRESS with no worker
    // forever). Poll briefly for the new run; on absence report failure so
    // the caller keeps the task PENDING for the next tick instead.
    const since = Date.now() - 10_000;
    for (let attempt = 1; attempt <= 6; attempt++) {
      await Bun.sleep(15_000);
      const list = await this.run([
        "gh",
        "run",
        "list",
        "--workflow",
        CONFIG.SUBAGENT_WORKFLOW,
        "--limit",
        "10",
        "--json",
        "databaseId,name,createdAt",
      ]);
      if (list.exitCode === 0) {
        try {
          const runs = JSON.parse(list.stdout) as Array<{ databaseId: number; name: string; createdAt: string }>;
          const hit = runs.find((r) => r.name.includes(taskId) && Date.parse(r.createdAt) >= since);
          if (hit) {
            console.log(`✅ Workflow successfully dispatched for ${taskId} (run #${hit.databaseId}).`);
            return true;
          }
        } catch {
          /* unparseable list — retry */
        }
      }
      console.log(`⏳ Dispatch of ${taskId} not visible yet (attempt ${attempt}/6)...`);
    }
    console.error(`❌ No workflow run materialized for ${taskId} after dispatch; keeping task queued.`);
    return false;
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
      "databaseId,status,conclusion,name,displayTitle,headBranch,createdAt,updatedAt",
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
