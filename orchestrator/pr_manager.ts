import { CONFIG } from "./config.ts";
import { GitManager } from "./git_manager.ts";
import type { TaskItem } from "./types.ts";

export interface TaskPR {
  number: number;
  url: string;
}

/**
 * Pull-request flow for task branches.
 *
 * Approved work is integrated via a real PR (reviewable audit trail) instead
 * of a silent direct merge. On PR-merge failure (e.g. conflicts) the caller
 * falls back to the local AI conflict-resolver merge.
 */
export class PRManager {
  /**
   * gh invocation for board/PR ops. In dual-repo mode the data repo is
   * private: ambient GITHUB_TOKEN cannot even resolve it
   * ("Could not resolve to a Repository"), so every call runs under the
   * data PAT (same pattern as RepoSetup).
   */
  private static gh(args: string[]) {
    if (GitManager.isDataMode()) {
      const pat = GitManager.dataPat();
      if (pat) return GitManager.run(args, ".", undefined, { GH_TOKEN: pat, GITHUB_TOKEN: pat });
    }
    return GitManager.run(args);
  }

  /**
   * Extra gh flags targeting the data repo in dual-repo mode, so review
   * PRs live privately. Empty in single-repo mode (current repo default).
   */
  private static repoFlag(): string[] {
    const slug = GitManager.isDataMode() ? GitManager.dataRepoSlug() : null;
    return slug ? ["--repo", slug] : [];
  }

  /** Open PR for a head branch, if any. */
  public static async getOpenPR(branch: string): Promise<TaskPR | null> {
    const res = await this.gh([
      "gh",
      "pr",
      "list",
      ...this.repoFlag(),
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,url",
    ]);
    if (res.exitCode !== 0 || !res.stdout.trim()) return null;
    try {
      const prs = JSON.parse(res.stdout);
      return prs.length > 0 ? { number: prs[0].number, url: prs[0].url } : null;
    } catch {
      return null;
    }
  }

  /** Create a PR for the task branch, or reuse the existing open one. */
  public static async createOrGetTaskPR(task: TaskItem, base?: string): Promise<TaskPR | null> {
    const existing = await this.getOpenPR(task.branch);
    if (existing) {
      console.log(`🔀 Reusing open PR #${existing.number} for ${task.branch}`);
      return existing;
    }
    const target = base || CONFIG.INTEGRATION_BRANCH;
    const title = `[${task.id}] ${task.title}`;
    const body =
      `### Task ${task.id} — ${task.title}\n\n${task.description}\n\n` +
      `**Role:** \`${task.role}\` | **Branch:** \`${task.branch}\`\n` +
      `**Target files:** \`${(task.targetFiles || []).join(", ")}\`\n\n` +
      `---\n*Opened by the Orchestrator after deterministic gate + reviewer approval.*`;
    console.log(`🔀 Opening PR ${task.branch} → ${target}...`);
    const res = await this.gh([
      "gh",
      "pr",
      "create",
      ...this.repoFlag(),
      "--head",
      task.branch,
      "--base",
      target,
      "--title",
      title,
      "--body",
      body,
    ]);
    if (res.exitCode !== 0) {
      // Race: PR appeared between check and create — re-list once.
      if (/already exists|already open/i.test(res.stderr)) {
        return this.getOpenPR(task.branch);
      }
      console.warn(`⚠️ PR creation failed for ${task.branch}:`, res.stderr);
      return null;
    }
    const match = res.stdout.match(/\/pull\/(\d+)/);
    if (match) {
      const pr = { number: parseInt(match[1], 10), url: res.stdout.trim() };
      console.log(`🎉 Opened PR #${pr.number} for [${task.id}]`);
      return pr;
    }
    return this.getOpenPR(task.branch);
  }

  public static async postReviewComment(prNumber: number, body: string): Promise<void> {
    await this.gh(["gh", "pr", "comment", String(prNumber), ...this.repoFlag(), "--body", body]);
  }

  /**
   * Merge an approved PR. Returns true on success.
   * Conflicted/unmergable PRs return false so the caller can use the
   * local merge + AI conflict resolver instead.
   */
  public static async mergeTaskPR(prNumber: number): Promise<boolean> {
    const res = await this.gh(["gh", "pr", "merge", String(prNumber), ...this.repoFlag(), "--merge", "--delete-branch=false"]);
    if (res.exitCode !== 0) {
      console.warn(`⚠️ gh pr merge #${prNumber} failed (likely conflicts):`, res.stderr);
      return false;
    }
    console.log(`✅ PR #${prNumber} merged.`);
    return true;
  }
}
