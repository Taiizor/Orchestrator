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

  const remoteUrl = async (): Promise<string> => {
    const res = await GitManager.run(["git", "remote", "get-url", "data"]);
    return res.stdout.trim();
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

  afterEach(() => {
    process.chdir(origCwd);
    for (const key of appEnvKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    (CONFIG as any).DATA_REPO = savedConfig.DATA_REPO;
    (CONFIG as any).DATA_PAT = savedConfig.DATA_PAT;
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("adds the data remote with the ambient token when missing", async () => {
    (CONFIG as any).DATA_REPO = "acme/private-data";
    (CONFIG as any).DATA_PAT = "ghs_test_token_aaaa";
    expect(await GitManager.refreshDataRemoteAuth()).toBe(true);
    expect(await remoteUrl()).toBe("https://x-access-token:ghs_test_token_aaaa@github.com/acme/private-data.git");
  });

  it("re-points the URL when the credential rotates", async () => {
    (CONFIG as any).DATA_REPO = "acme/private-data";
    (CONFIG as any).DATA_PAT = "ghs_old_token";
    expect(await GitManager.refreshDataRemoteAuth()).toBe(true);

    (CONFIG as any).DATA_PAT = "ghs_new_token";
    expect(await GitManager.refreshDataRemoteAuth()).toBe(true);
    expect(await remoteUrl()).toBe("https://x-access-token:ghs_new_token@github.com/acme/private-data.git");
  });

  it("is a no-op when the URL is already current", async () => {
    (CONFIG as any).DATA_REPO = "acme/private-data";
    (CONFIG as any).DATA_PAT = "ghs_same_token";
    expect(await GitManager.refreshDataRemoteAuth()).toBe(true);
    const before = await remoteUrl();
    expect(await GitManager.refreshDataRemoteAuth()).toBe(true);
    expect(await remoteUrl()).toBe(before);
  });

  it("returns false without a token and without data mode", async () => {
    (CONFIG as any).DATA_REPO = "acme/private-data";
    (CONFIG as any).DATA_PAT = "";
    expect(await GitManager.refreshDataRemoteAuth()).toBe(false);

    (CONFIG as any).DATA_REPO = "";
    (CONFIG as any).DATA_PAT = "ghs_test_token_aaaa";
    expect(await GitManager.refreshDataRemoteAuth()).toBe(false);
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
