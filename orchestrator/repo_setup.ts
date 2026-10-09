import { GitManager } from "./git_manager.ts";

export interface RepoSetupReport {
  repo: string;
  lines: string[];
}

/**
 * One-shot repository settings audit & repair (NOT a tick step — settings
 * rarely change, so this runs only via `action=setup`).
 *
 * Desired state: issues/discussions/projects ON (agent coordination needs
 * them), merge-commit allowed (PR flow uses --merge). Wiki/visibility are
 * reported, never touched.
 *
 * Reads work with any token; WRITES need an admin-capable PAT
 * (classic `repo` scope). GITHUB_TOKEN alone can only report.
 */
export class RepoSetup {
  private static readonly WANT: Record<string, boolean> = {
    has_issues: true,
    has_discussions: true,
    has_projects: true,
    allow_merge_commit: true,
  };

  private static async runAs(
    cmd: string[],
    pat: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (pat) {
      return GitManager.run(cmd, ".", undefined, { GH_TOKEN: pat, GITHUB_TOKEN: pat });
    }
    return GitManager.run(cmd);
  }

  public static async ensureRepoSettings(
    owner: string,
    repo: string,
    pat: string
  ): Promise<RepoSetupReport> {
    const slug = `${owner}/${repo}`;
    const lines: string[] = [];
    const get = await this.runAs(["gh", "api", `repos/${slug}`], "");
    if (get.exitCode !== 0) {
      lines.push(`❌ Cannot read ${slug}: ${get.stderr.slice(0, 120)}`);
      return { repo: slug, lines };
    }
    let info: any = {};
    try {
      info = JSON.parse(get.stdout);
    } catch {
      lines.push(`❌ Unparseable settings response for ${slug}.`);
      return { repo: slug, lines };
    }

    const patch: Record<string, boolean> = {};
    for (const [key, want] of Object.entries(this.WANT)) {
      const current = !!info[key];
      if (current === want) {
        lines.push(`✅ ${key} = ${current}`);
      } else {
        lines.push(`🔧 ${key}: ${current} → ${want}`);
        patch[key] = want;
      }
    }
    lines.push(`ℹ️ visibility=${info.private ? "private" : "public"}, wiki=${!!info.has_wiki}, default_branch=${info.default_branch}`);

    const keys = Object.keys(patch);
    if (keys.length === 0) {
      lines.push(`🎉 ${slug} already matches desired settings.`);
      return { repo: slug, lines };
    }
    if (!pat) {
      lines.push(`⚠️ No admin PAT available — cannot apply (${keys.join(", ")}). Re-run with GH_PROJECT_TOKEN/DATA_PAT.`);
      return { repo: slug, lines };
    }
    const args = ["gh", "api", `repos/${slug}`, "-X", "PATCH"];
    for (const [k, v] of Object.entries(patch)) args.push("-F", `${k}=${v}`);
    const res = await this.runAs(args, pat);
    if (res.exitCode === 0) {
      lines.push(`✅ Applied: ${keys.join(", ")}`);
    } else {
      lines.push(`❌ Patch failed: ${res.stderr.slice(0, 200)}`);
    }
    return { repo: slug, lines };
  }
}
