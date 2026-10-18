import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitManager } from "../orchestrator/git_manager.ts";
import { CONFIG } from "../orchestrator/config.ts";

/**
 * TASK-060 class (launch re-verification round 2): the agent committed its
 * own report on a brand-new task branch that had never been published, the
 * runner's publish found an empty stage, and both probes (localCommitsAhead,
 * branchUniqueCommits) returned -1 for the missing remote branch ref — so
 * publish aborted as "no committable output" and the commit died with the
 * runner. Twice. These tests pin the integration-branch fallback and the
 * end-to-end publish/checkpoint behavior on a not-yet-published branch.
 * Hermetic: local bare remote only, no network, no App credentials.
 */
describe("task-branch publish/checkpoint on a never-published branch (TASK-060 class)", () => {
  const origCwd = process.cwd();
  const savedConfig = { DATA_REPO: (CONFIG as any).DATA_REPO };
  const appEnvKeys = ["GH_CLIENT_ID", "CLIENT_ID", "GH_APP_PRIVATE_KEY", "APP_PRIVATE_KEY", "GH_APP_INSTALLATION_ID"];
  const savedEnv: Record<string, string | undefined> = {};
  let root: string;
  let bare: string;
  let work: string;

  /** Windows can hold handles on a freshly-used .git dir; retry the delete. */
  const rmSafe = async (dir: string): Promise<void> => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await Bun.sleep(100 * attempt);
      }
    }
  };

  /** Run git in the work repo and fail loudly on errors. */
  const git = async (...args: string[]): Promise<string> => {
    const res = await GitManager.run(["git", ...args], work);
    if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stdout}${res.stderr}`);
    return res.stdout.trim();
  };

  /** Simulate an agent that commits its own work on a fresh branch. */
  const agentCommitOnNewBranch = async (branch: string, name = "task.txt"): Promise<void> => {
    await git("checkout", "-q", "-b", branch);
    await Bun.write(join(work, name), "agent work\n");
    await git("add", name);
    await git("commit", "-q", "-m", "agent commit");
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "orch-publish-"));
    bare = join(root, "remote.git");
    work = join(root, "work");
    // Strip App credentials so refreshOriginAuth stays inert (no network) —
    // same isolation the reauth suite uses.
    for (const key of appEnvKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Force non-data mode: content remote resolves to "origin".
    (CONFIG as any).DATA_REPO = "";

    await GitManager.run(["git", "init", "--bare", "-q", bare], root);
    await GitManager.run(["git", "init", "-q", work], root);
    await GitManager.run(["git", "config", "user.name", "Test"], work);
    await GitManager.run(["git", "config", "user.email", "test@example.com"], work);
    process.chdir(work);
    await git("checkout", "-q", "-b", "develop");
    await Bun.write(join(work, "base.txt"), "base\n");
    await git("add", "base.txt");
    await git("commit", "-q", "-m", "base");
    await git("remote", "add", "origin", bare.replace(/\\/g, "/"));
    await git("push", "-q", "-u", "origin", "develop");
  });

  afterEach(async () => {
    process.chdir(origCwd);
    for (const key of appEnvKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    (CONFIG as any).DATA_REPO = savedConfig.DATA_REPO;
    await rmSafe(root);
  });

  it("localCommitsAhead falls back to the develop delta when the branch was never published", async () => {
    await agentCommitOnNewBranch("task/T1");
    // origin/task/T1 does not exist; the agent's commit must still count.
    expect(await GitManager.localCommitsAhead("task/T1")).toBe(1);
  });

  it("localCommitsAhead returns -1 only when neither ref resolves", async () => {
    await agentCommitOnNewBranch("task/T1");
    // Remove the integration-branch ref too: now the delta is unknowable.
    await git("update-ref", "-d", "refs/remotes/origin/develop");
    expect(await GitManager.localCommitsAhead("task/T1")).toBe(-1);
  });

  it("localCommitsAhead prefers the branch tip once the remote branch exists", async () => {
    await agentCommitOnNewBranch("task/T1");
    await git("push", "-q", "origin", "task/T1");
    expect(await GitManager.localCommitsAhead("task/T1")).toBe(0);
    await Bun.write(join(work, "more.txt"), "more\n");
    await git("add", "more.txt");
    await git("commit", "-q", "-m", "more");
    expect(await GitManager.localCommitsAhead("task/T1")).toBe(1);
    await git("push", "-q", "origin", "task/T1");
    expect(await GitManager.localCommitsAhead("task/T1")).toBe(0);
  });

  it("publishTaskBranch pushes agent-committed work on a brand-new branch (empty stage)", async () => {
    await agentCommitOnNewBranch("task/T1");
    const head = await git("rev-parse", "HEAD");
    const ok = await GitManager.publishTaskBranch("task/T1", "feat(task): complete deliverables for TASK-T1");
    expect(ok).toBe(true);
    const ls = await GitManager.run(["git", "ls-remote", bare.replace(/\\/g, "/"), "refs/heads/task/T1"], root);
    expect(ls.stdout).toContain(head);
  });

  it("checkpointTaskBranch pushes agent-made commits on a not-yet-published branch instead of skipping", async () => {
    await agentCommitOnNewBranch("task/T2");
    const head = await git("rev-parse", "HEAD");
    const ok = await GitManager.checkpointTaskBranch("task/T2", "TASK-T2");
    expect(ok).toBe(true);
    const ls = await GitManager.run(["git", "ls-remote", bare.replace(/\\/g, "/"), "refs/heads/task/T2"], root);
    expect(ls.stdout).toContain(head);
  });

  it("publishTaskBranch still refuses when the branch genuinely produced nothing", async () => {
    // Fresh branch with zero commits over develop: no stage, no local
    // commits, no remote branch — the original error path must survive.
    await git("checkout", "-q", "-b", "task/empty");
    const ok = await GitManager.publishTaskBranch("task/empty", "feat(task): complete deliverables for TASK-EMPTY");
    expect(ok).toBe(false);
    const ls = await GitManager.run(["git", "ls-remote", bare.replace(/\\/g, "/"), "refs/heads/task/empty"], root);
    expect(ls.stdout.trim()).toBe("");
  });
});
