import { CONFIG } from "./config.ts";
import { GitManager } from "./git_manager.ts";
import { TEST_EVIDENCE_RX } from "./stacks.ts";
import type { TaskItem } from "./types.ts";

export interface GateResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
  fileList: string[];
  diffStat: string;
}

const REQUIRED_SECTIONS = ["done", "doing", "todo", "verification"];

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
      "^" +
        p
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, ".*") +
        "$"
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
  // Runner-rendered CI artifacts (deterministic, regenerable): never scope
  // violations, even when legacy publishes committed them onto old branches.
  if (file === "workspace/.services.env") return true;
  if (file === "workspace/docker-compose.services.yml") return true;
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
  { name: "GitHub PAT", rx: /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{50,})/ },
  { name: "GitHub OAuth", rx: /gho_[A-Za-z0-9]{20,}/ },
  { name: "Slack token", rx: /xox[bap]-/ },
  { name: "OpenAI API key", rx: /sk-[A-Za-z0-9]{32,}/ },
  { name: "Anthropic API key", rx: /sk-ant-[A-Za-z0-9_-]{32,}/ },
  { name: "Private key block", rx: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];
// NOTE: no `.env`-string content pattern — filenames are covered by the
// files rule below, and README-style "copy .env.example to .env" docs must
// never fail the gate.

const GENERIC_SECRET_RX = /(api[_-]?key|secret|password)\s*[:=]\s*['"]([^'"]+)['"]/i;
/** Values that are obviously synthetic fixtures, not leaked credentials. */
const PLACEHOLDER_VALUE_RX = /(your|example|sample|placeholder|changeme|todo|test|mock|fake|dummy|xxx)/i;

/** Added content lines only: deletions cannot leak, `+++` headers are noise. */
function addedLines(diff: string): string[] {
  return diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
}

/**
 * Added lines grouped by file (from `+++ b/<path>` hunk headers).
 * Lets the generic-assignment rule exempt test fixtures, where fake
 * secrets are the entire point.
 */
function addedLinesByFile(diff: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let cur = "";
  for (const raw of diff.split("\n")) {
    const h = raw.match(/^\+\+\+ b\/(.+)$/);
    if (h) {
      cur = h[1].trim();
      if (!map.has(cur)) map.set(cur, []);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++") && cur) {
      map.get(cur)!.push(raw);
    }
  }
  return map;
}

/** Paths whose secret-shaped literals are fixtures by definition. */
function isTestPath(file: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|__mocks__|__fixtures__|fixtures?|test-utils|e2e|cypress)\//i.test(file) ||
    /\.(test|spec)\.[a-z]+$/i.test(file)
  );
}

export function scanSecrets(diff: string, files: string[]): string[] {
  const hits: string[] = [];
  const added = addedLines(diff);
  const text = added.join("\n");
  for (const pat of SECRET_PATTERNS) {
    if (pat.rx.test(text)) hits.push(pat.name);
  }
  // Generic assignments with NON-placeholder values, in NON-test files,
  // with single-token values only. Test fixtures, human sentences
  // ("Must mix...") and synthetic values go to warnings or nowhere.
  for (const [file, lines] of addedLinesByFile(diff)) {
    if (isTestPath(file)) continue;
    for (const line of lines) {
      const m = line.match(GENERIC_SECRET_RX);
      if (m && !/\s/.test(m[2]) && !PLACEHOLDER_VALUE_RX.test(m[2])) {
        hits.push("Generic secret assignment");
        break;
      }
    }
    if (hits.includes("Generic secret assignment")) break;
  }
  // Sensitive filenames — except the canonical `.env.example` template.
  // Match actual .pem or .key extensions, not substring hits like sort.key.ts.
  if (
    files.some((f) => {
      const m = f.match(/(^|\/)\.env([^/]*)$/i);
      if (m && m[2] !== ".example") return true;
      return /\.(pem|key)$/i.test(f);
    })
  ) {
    hits.push("Sensitive file (.env/.pem/.key) in changeset");
  }
  return [...new Set(hits)];
}

/** Soft-tier: secret-shaped assignments with placeholder values. Warn only. */
export function scanSecretWarnings(diff: string): string[] {
  const warns: string[] = [];
  for (const line of addedLines(diff)) {
    const m = line.match(GENERIC_SECRET_RX);
    if (m && PLACEHOLDER_VALUE_RX.test(m[2])) {
      warns.push(`Placeholder secret-style assignment (${m[1]}=…) — verify no real credential before merge`);
    }
  }
  return [...new Set(warns)];
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
 * Gate ruleset version. Bumped whenever deterministic rules change
 * (scope lists, secret patterns, file filters): old verdicts recorded
 * under a previous version must be re-evaluated, never skipped by the
 * unchanged-tip optimization.
 */
export const GATE_VERSION = 4;

/**
 * Deterministic pre-LLM gate. Fails fast on empty diff, missing progress
 * structure, secret hits, or out-of-scope writes. Warns on contract drift.
 */
export async function runReviewGate(task: TaskItem, diff: string, progressContent: string): Promise<GateResult> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const fileList = (await GitManager.getBranchFileList(task.branch, CONFIG.INTEGRATION_BRANCH, { excludeDeleted: true })) ?? [];
  const remote = GitManager.contentRemote();
  // Legacy fork check: branches that share no history with develop produce
  // tip-vs-tip file lists (whole trees). File-level rules can't attribute
  // those, so they are skipped with a warning; the reviewer judges content.
  const lineageBroken = !(await GitManager.haveCommonAncestor(
    `${remote}/${CONFIG.INTEGRATION_BRANCH}`,
    `${remote}/${task.branch}`
  ));
  if (lineageBroken) {
    warnings.push(
      "Branch shares no history with develop (legacy fork); file-level scope/drift rules skipped — reviewer judges full tip diff."
    );
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
      failures.push(
        "TASK_PROGRESS.md is the runner placeholder, not an agent report: no evidence of work. Produce real Done/Verification content."
      );
    }
    if (!TEST_EVIDENCE_RX.test(progressContent)) {
      warnings.push(
        "Verification section has no recognizable test evidence (bun test | go test | cargo test | dotnet test | pytest output)."
      );
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
  for (const w of scanSecretWarnings(diff)) warnings.push(w);

  if (!lineageBroken && touchesApiOrSchema(fileList) && !fileList.includes("workspace/CONTRACTS.md")) {
    warnings.push("API/schema/services changed but workspace/CONTRACTS.md not updated (contract drift).");
  }

  return { passed: failures.length === 0, failures, warnings, fileList, diffStat };
}
