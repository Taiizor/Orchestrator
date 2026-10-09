import { CONFIG } from "./config.ts";
import { GitManager } from "./git_manager.ts";
import type { TaskItem } from "./types.ts";

export interface GateResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
  fileList: string[];
  diffStat: string;
}

const REQUIRED_SECTIONS = [
  "done",
  "doing",
  "todo",
  "verification",
];

/** Check TASK_PROGRESS.md has all 4 structured sections with non-empty content. */
export function hasStructuredProgress(content: string): boolean {
  const lower = content.toLowerCase();
  return REQUIRED_SECTIONS.every((s) => lower.includes(s));
}

export function missingSections(content: string): string[] {
  const lower = content.toLowerCase();
  return REQUIRED_SECTIONS.filter((s) => !lower.includes(s));
}

/**
 * Runner-written placeholder progress (emitted when the agent left no
 * report). Structurally valid but content-free — must never count as
 * evidence of work.
 */
const DEFAULT_PROGRESS_MARKERS = [
  "Executed task deliverables in workspace",
  "Submitting for orchestrator review",
  "Awaiting review and integration",
];

export function isDefaultProgress(content: string): boolean {
  return DEFAULT_PROGRESS_MARKERS.some((m) => content.includes(m));
}

/** Minimal glob matcher supporting *, ** suffixes used in targetFiles. */
export function globMatches(pattern: string, file: string): boolean {
  // Normalize: strip trailing /** or /* or /
  let p = pattern.trim();
  if (p === "." || p === "./") return true;
  if (p.endsWith("/**")) {
    return file.startsWith(p.slice(0, -3));
  }
  if (p.endsWith("/*")) {
    const base = p.slice(0, -2);
    if (!file.startsWith(base + "/")) return false;
    return !file.slice(base.length + 1).includes("/");
  }
  if (p.endsWith("/")) {
    return file.startsWith(p);
  }
  if (p.includes("*")) {
    // Escape regex, then * -> .*, ** -> .*
    const rx = new RegExp(
      "^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, ".*") + "$"
    );
    return rx.test(file);
  }
  // Exact file or directory prefix
  return file === p || file.startsWith(p.endsWith("/") ? p : p + "/");
}

function isAllowedFile(task: TaskItem, file: string): boolean {
  // Always allow the task's own progress report and shared contracts updates
  if (file === "workspace/TASK_PROGRESS.md") return true;
  if (file === "workspace/CONTRACTS.md") return true;
  // Empty directory placeholders are legitimate scaffolding, not scope creep
  if (file.endsWith("/.gitkeep") || file === ".gitkeep") return true;
  if (file.startsWith("state/")) return false; // state files must only change via orchestrator
  return (task.targetFiles || []).some((pat) => {
    // targetFiles entries are workspace-relative; diff paths are repo-relative
    const norm = pat.replace(/^workspace\//, "workspace/");
    return globMatches(norm, file) || globMatches(pat, file);
  });
}

const SECRET_PATTERNS: { name: string; rx: RegExp }[] = [
  { name: "AWS access key", rx: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub PAT", rx: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "GitHub OAuth", rx: /gho_[A-Za-z0-9]{20,}/ },
  { name: "Slack token", rx: /xox[bap]-/ },
  { name: "Private key block", rx: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "Generic secret assignment", rx: /(api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: ".env file", rx: /^\+?.*\.env/i },
];

export function scanSecrets(diff: string, files: string[]): string[] {
  const hits: string[] = [];
  for (const pat of SECRET_PATTERNS) {
    if (pat.rx.test(diff)) hits.push(pat.name);
  }
  if (files.some((f) => /(^|\/)\.env($|\.)/.test(f) || f.includes(".pem") || f.includes(".key"))) {
    hits.push("Sensitive file (.env/.pem/.key) in changeset");
  }
  return [...new Set(hits)];
}

function touchesApiOrSchema(files: string[]): boolean {
  return files.some(
    (f) =>
      f.startsWith("workspace/src/api/") ||
      f.startsWith("workspace/src/db/") ||
      f.startsWith("workspace/src/services/") ||
      f.startsWith("workspace/drizzle/")
  );
}

/**
 * Deterministic pre-LLM gate. Fails fast on empty diff, missing progress
 * structure, secret hits, or out-of-scope writes. Warns on contract drift.
 */
export async function runReviewGate(
  task: TaskItem,
  diff: string,
  progressContent: string
): Promise<GateResult> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const fileList = (await GitManager.getBranchFileList(task.branch, CONFIG.INTEGRATION_BRANCH)) ?? [];
  const remote = GitManager.contentRemote();
  // Legacy fork check: branches that share no history with develop produce
  // tip-vs-tip file lists (whole trees). File-level rules can't attribute
  // those, so they are skipped with a warning; the reviewer judges content.
  const lineageBroken = !(await GitManager.haveCommonAncestor(`${remote}/${CONFIG.INTEGRATION_BRANCH}`, `${remote}/${task.branch}`));
  if (lineageBroken) {
    warnings.push("Branch shares no history with develop (legacy fork); file-level scope/drift rules skipped — reviewer judges full tip diff.");
  }
  const statRes = await GitManager.run([
    "git",
    "diff",
    "--stat",
    `${remote}/${CONFIG.INTEGRATION_BRANCH}...${remote}/${task.branch}`,
  ]);
  const diffStat = statRes.exitCode === 0 ? statRes.stdout.slice(0, 2000) : "";

  if (!diff.trim() && fileList.length === 0) {
    failures.push("Empty diff: task branch has no changes vs develop.");
  }
  if (!progressContent || progressContent === "No progress file provided.") {
    failures.push("Missing workspace/TASK_PROGRESS.md on task branch.");
  } else {
    const missing = missingSections(progressContent);
    if (missing.length > 0) {
      failures.push(`TASK_PROGRESS.md missing sections: ${missing.join(", ")}.`);
    }
    if (isDefaultProgress(progressContent)) {
      failures.push("TASK_PROGRESS.md is the runner placeholder, not an agent report: no evidence of work. Produce real Done/Verification content.");
    }
    if (!/bun test|bun run|test proof|passing|passed/i.test(progressContent)) {
      warnings.push("Verification section has no recognizable test evidence (bun test output).");
    }
  }

  const outOfScope = lineageBroken ? [] : fileList.filter((f) => !isAllowedFile(task, f));
  if (outOfScope.length > 0) {
    // Operator-created tasks (/add, /revise) carry no disjoint targetFiles
    // scoping — warn instead of failing, the reviewer judges relevance.
    if (!task.targetFiles || task.targetFiles.length === 0) {
      warnings.push(
        `Unscoped task touched ${outOfScope.length} files outside any targetFiles contract; reviewer must verify relevance.`
      );
    } else {
      failures.push(
        `Out-of-scope files modified (${outOfScope.slice(0, 10).join(", ")}${outOfScope.length > 10 ? ` +${outOfScope.length - 10} more` : ""}). Allowed: ${(task.targetFiles || []).join(", ")}.`
      );
    }
  }

  const secrets = scanSecrets(diff, fileList);
  if (secrets.length > 0) {
    failures.push(`Potential secret leak detected: ${secrets.join(", ")}.`);
  }

  if (!lineageBroken && touchesApiOrSchema(fileList) && !fileList.includes("workspace/CONTRACTS.md")) {
    warnings.push("API/schema/services changed but workspace/CONTRACTS.md not updated (contract drift).");
  }

  return { passed: failures.length === 0, failures, warnings, fileList, diffStat };
}
