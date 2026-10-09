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
  /** Feature name -> repo settings key. (Pull requests have no off switch.) */
  private static readonly FEATURE_KEYS: Record<string, string> = {
    issues: "has_issues",
    wiki: "has_wiki",
    projects: "has_projects",
    discussions: "has_discussions",
  };

  /** Parse "issues,wiki" env into a validated set (unknown names ignored). */
  public static parseFeatures(raw: string | undefined, fallback: string): Set<string> {
    const src = (raw || "").trim() ? raw! : fallback;
    const known = Object.keys(this.FEATURE_KEYS);
    return new Set(
      src.split(",").map((s) => s.trim().toLowerCase()).filter((s) => known.includes(s))
    );
  }

  /**
   * Topology-aware feature defaults (used when PUBLIC_/DATA_FEATURES env is
   * empty = auto). Dual-repo: public keeps issues (dashboard/task
   * issues/ChatOps) + projects (board); agent threads live in the data
   * repo's discussions, so public discussions stay OFF without setup
   * fighting the owner. Single-repo: public needs everything.
   */
  public static defaultFeatures(which: "public" | "data"): string {
    if (which === "data") return "discussions";
    return GitManager.isDataMode() ? "issues,projects" : "issues,discussions,projects";
  }

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
    pat: string,
    wanted?: Set<string>
  ): Promise<RepoSetupReport> {
    const slug = `${owner}/${repo}`;
    const lines: string[] = [];
    const want = wanted ?? new Set(["issues", "discussions", "projects"]);
    const checks: Record<string, boolean> = { allow_merge_commit: true };
    for (const [feat, key] of Object.entries(this.FEATURE_KEYS)) {
      checks[key] = want.has(feat);
    }
    // Reads go through the PAT too when available: the ambient GITHUB_TOKEN
    // cannot even SEE a private data repo (API returns 404, not 403).
    const get = await this.runAs(["gh", "api", `repos/${slug}`], pat);
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
    for (const [key, wantVal] of Object.entries(checks)) {
      const current = !!info[key];
      if (current === wantVal) {
        lines.push(`✅ ${key} = ${current}`);
      } else {
        lines.push(`🔧 ${key}: ${current} → ${wantVal}`);
        patch[key] = wantVal;
      }
    }
    lines.push(`ℹ️ visibility=${info.private ? "private" : "public"}, default_branch=${info.default_branch}`);

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
