import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitManager } from "../orchestrator/git_manager.ts";
import { CONFIG } from "../orchestrator/config.ts";

/**
 * Long-run credential refresh (TASK-066 class): GitHub App installation
 * tokens live ~1h and a 60-min model timeout + fallback continues can
 * outlive them, making every publish retry fail with "Invalid username or
 * token". These tests pin the URL-management half of the fix — hermetic
 * (local git only, no network, no App credentials).
 *
 * CONFIG/cwd windows are kept as small as possible: this suite runs in the
 * shared test process, where dangling async work from other files can still
 * be on the event loop.
 */
describe("refreshDataRemoteAuth (data remote credential refresh)", () => {
  const origCwd = process.cwd();
  const savedConfig = {
    DATA_REPO: (CONFIG as any).DATA_REPO,
    DATA_PAT: (CONFIG as any).DATA_PAT,
  };
  const appEnvKeys = ["GH_CLIENT_ID", "CLIENT_ID", "GH_APP_PRIVATE_KEY", "APP_PRIVATE_KEY", "GH_APP_INSTALLATION_ID"];
  const savedEnv: Record<string, string | undefined> = {};
  let repoDir: string;

  /**
   * Apply data-mode config for exactly one production call, then restore —
   * keeps the window in which other (dangling) test work could observe
   * "data mode" as small as possible.
   */
  const withDataMode = async (repo: string, pat: string, fn: () => Promise<boolean>): Promise<boolean> => {
    (CONFIG as any).DATA_REPO = repo;
    (CONFIG as any).DATA_PAT = pat;
    try {
      return await fn();
    } finally {
      (CONFIG as any).DATA_REPO = savedConfig.DATA_REPO;
      (CONFIG as any).DATA_PAT = savedConfig.DATA_PAT;
    }
  };

  const refresh = async (repo: string, pat: string): Promise<boolean> =>
    withDataMode(repo, pat, () => GitManager.refreshDataRemoteAuth());

  const remoteUrl = async (): Promise<string> => {
    const res = await GitManager.run(["git", "remote", "get-url", "data"]);
    return res.stdout.trim();
  };

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

  beforeEach(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "orch-reauth-"));
    // Strip App credentials so the mint path returns null deterministically
    // (no network calls); the ambient DATA_PAT fallback is what we exercise.
    for (const key of appEnvKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.chdir(repoDir);
    await GitManager.run(["git", "init", "-q"]);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    for (const key of appEnvKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    (CONFIG as any).DATA_REPO = savedConfig.DATA_REPO;
    (CONFIG as any).DATA_PAT = savedConfig.DATA_PAT;
    await rmSafe(repoDir);
  });

  it("adds the data remote with the ambient token when missing", async () => {
    expect(await refresh("acme/private-data", "ghs_test_token_aaaa")).toBe(true);
    expect(await remoteUrl()).toBe("https://x-access-token:ghs_test_token_aaaa@github.com/acme/private-data.git");
  });

  it("re-points the URL when the credential rotates", async () => {
    expect(await refresh("acme/private-data", "ghs_old_token")).toBe(true);
    expect(await refresh("acme/private-data", "ghs_new_token")).toBe(true);
    expect(await remoteUrl()).toBe("https://x-access-token:ghs_new_token@github.com/acme/private-data.git");
  });

  it("is a no-op when the URL is already current", async () => {
    expect(await refresh("acme/private-data", "ghs_same_token")).toBe(true);
    const before = await remoteUrl();
    expect(await refresh("acme/private-data", "ghs_same_token")).toBe(true);
    expect(await remoteUrl()).toBe(before);
  });

  it("returns false without a token and outside data mode", async () => {
    expect(await refresh("acme/private-data", "")).toBe(false);
    expect(await refresh("", "ghs_test_token_aaaa")).toBe(false);
  });

  it("accepts full https data-repo URLs as well as owner/name", async () => {
    expect(await refresh("https://github.com/acme/private-data.git", "ghs_url_form")).toBe(true);
    expect(await remoteUrl()).toBe("https://x-access-token:ghs_url_form@github.com/acme/private-data.git");
  });

  it("classifies GitHub auth rejections vs non-fast-forward errors", () => {
    const fn = (GitManager as any).looksLikeAuthFailure.bind(GitManager);
    // The exact stderr shape from the WARN log that motivated the fix.
    expect(
      fn(
        "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/acme/private-data.git/'"
      )
    ).toBe(true);
    expect(fn("error: failed to push some refs to 'github.com:acme/private-data.git' (non-fast-forward)")).toBe(false);
    expect(fn("")).toBe(false);
  });
});
