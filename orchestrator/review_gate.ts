import { CONFIG } from "./config.ts";
import { GitManager } from "./git_manager.ts";
import { TEST_EVIDENCE_RX, RUNNER_MARK_RX } from "./stacks.ts";
import type { TaskItem } from "./types.ts";

export interface GateResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
  fileList: string[];
  diffStat: string;
  /** True when the branch shares no history with develop (file rules skipped). */
  lineageBroken?: boolean;
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
 * evidence of work. Matched as WHOLE bullet lines, and at least TWO must
 * hit: both runner templates (fresh-file and cumulative fallback) carry
 * >=2 exact bullets, while a genuine report may quote a single marker
 * mid-sentence. TASK-057 burned all three attempts because the old
 * substring check flagged "- Submitting for orchestrator review (attempt
 * 2: ...)" — a real report's Doing line that merely starts with a marker.
 */
const PLACEHOLDER_BULLET_RXS = [
  /^-\s*Executed task deliverables in workspace\.?\s*$/m,
  /^-\s*Submitting for orchestrator review\.?\s*$/m,
  /^-\s*Awaiting review and integration\.?\s*$/m,
];

export function isDefaultProgress(content: string): boolean {
  return PLACEHOLDER_BULLET_RXS.filter((rx) => rx.test(content)).length >= 2;
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

/** Basename allowlist for build manifests/lockfiles (any depth). */
const LOCKFILE_BASENAMES = new Set([
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.toml",
  "Cargo.lock",
  "requirements.txt",
  "requirements-dev.txt",
  "poetry.lock",
  "Pipfile.lock",
  "composer.json",
  "composer.lock",
  "Gemfile.lock",
  "pom.xml",
]);

function isLockfile(file: string): boolean {
  const base = file.split("/").pop() || "";
  return LOCKFILE_BASENAMES.has(base);
}

export function isAllowedFile(task: TaskItem, file: string): boolean {
  // Always allow the task's own progress report and shared contracts updates
  if (file === "workspace/TASK_PROGRESS.md") return true;
  if (file === "workspace/CONTRACTS.md") return true;
  // Runner-rendered CI artifacts (deterministic, regenerable): never scope
  // violations, even when legacy publishes committed them onto old branches.
  if (file === "workspace/.services.env") return true;
  if (file === "workspace/docker-compose.services.yml") return true;
  // Service auto-adopt requests: the tick validates and merges them into
  // roadmap.services (durable from the next run).
  if (file === "workspace/services.request.json") return true;
  // Git hygiene files (.gitkeep, .gitignore, .gitattributes) are legitimate scaffolding, not scope creep
  if (
    file.endsWith("/.gitkeep") ||
    file === ".gitkeep" ||
    file.endsWith("/.gitignore") ||
    file === ".gitignore" ||
    file.endsWith("/.gitattributes") ||
    file === ".gitattributes"
  ) {
    return true;
  }
  // Build manifests and lockfiles are always in scope: a task that needs a
  // module where none exists must init it (go.mod, package.json-adjacent
  // locks), and builds must stay reproducible. Without this, the gate killed
  // tasks for adding go.mod/go.sum (TASK-007) or web/bun.lock (TASK-013).
  // Dependency TREES (node_modules/, target/, ...) are still violations —
  // publish scrubs them before they reach review.
  if (isLockfile(file)) return true;
  if (file.startsWith("state/")) return false; // state files must only change via orchestrator
  return (task.targetFiles || []).some((pat) => {
    // targetFiles entries are workspace-relative; diff paths are repo-relative
    return globMatches(pat, file);
  });
}

const SECRET_PATTERNS: { name: string; rx: RegExp }[] = [
  { name: "AWS access key", rx: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub PAT", rx: /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{50,})/ },
  { name: "GitHub OAuth", rx: /gho_[A-Za-z0-9]{20,}/ },
  { name: "Slack token", rx: /xox[bap]-/ },
  { name: "OpenAI API key", rx: /sk-[A-Za-z0-9]{32,}/ },
  { name: "Anthropic API key", rx: /sk-ant-[A-Za-z0-9_-]{32,}/ },
  { name: "Stripe live key", rx: /[rs]k_live_[A-Za-z0-9]+/ },
  { name: "Private key block", rx: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];
// NOTE: no `.env`-string content pattern — filenames are covered by the
// files rule below, and README-style "copy .env.example to .env" docs must
// never fail the gate.

const GENERIC_SECRET_RX =
  /(api[_-]?key|secret|password|passwd|pwd|client[_-]?secret|access[_-]?token|auth[_-]?token|bearer|jwt)\s*[:=]\s*['"]([^'"]+)['"]/i;
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

/** Evidence-stamp verdict for a progress report: unstamped toolchain output
 *  is pasted text, not executed proof (TASK-001 fabrication class). */
export function checkEvidenceStamp(progressContent: string): "ok" | "missing-evidence" | "unstamped" {
  if (!TEST_EVIDENCE_RX.test(progressContent)) return "missing-evidence";
  if (!RUNNER_MARK_RX.test(progressContent)) return "unstamped";
  return "ok";
}

/** Build-output dirs: generated bundles trip content heuristics (minified
 *  SQL keywords, mock-looking strings). Secrets still scan everywhere —
 *  a bundled key is a leak — but SQL/fallback/demo-content scans skip dist/.
 */
function isBuildOutput(file: string): boolean {
  return /(^|\/)(dist|build|out|coverage|storybook-static)\//.test(file);
}

/** Paths whose secret-shaped literals are fixtures by definition. */
export function isTestPath(file: string): boolean {
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
  // NOTE: NO build-output exemption — a bundled secret is still a leak.
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
  // Credential-store files are always reject-grade, anywhere (including the
  // odd test path — a committed credentials.json is never a fixture).
  if (
    files.some((f) => {
      const m = f.match(/(^|\/)\.env([^/]*)$/i);
      if (m && m[2] !== ".example") return true;
      if (/\.(pem|key)$/i.test(f)) return true;
      return /(^|\/)(credentials\.json|secrets?\.ya?ml|secrets?\.json)$/i.test(f);
    })
  ) {
    hits.push("Sensitive file (.env/.pem/.key/credentials/secrets) in changeset");
  }
  return [...new Set(hits)];
}

/**
 * Regenerable dependency trees and runtime junk: the same class publish
 * scrubbing excludes (mirrors publishTaskBranch exclusions — keep in sync).
 * A committed vendor/ or 200k-line laravel.log trips scanners on
 * third-party code and payload heuristics; it is never reviewable work.
 */
export function isGeneratedJunkPath(file: string): boolean {
  const norm = file.replace(/\\/g, "/");
  return (
    /(^|\/)node_modules\//.test(norm) ||
    /(^|\/)vendor\//.test(norm) ||
    /(^|\/)(\.nuxt|\.next|\.output|dist|build|out|coverage|storybook-static)\//.test(norm) ||
    /(^|\/)storage\/(logs|framework)\//.test(norm) ||
    /(^|\/)bootstrap\/cache\//.test(norm) ||
    /(^|\/)(obj|TestResults)\//.test(norm) ||
    /(^|\/)bin\/(Debug|Release|net[0-9]|x64|x86|arm64)\//i.test(norm) ||
    norm.endsWith(".phpunit.result.cache")
  );
}

/** SQL keyword on a line that also builds strings → injection-shaped. */
const SQL_KW_RX = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|DROP\s+TABLE|WHERE)\b/i;
const SQL_CONCAT_RX = /(\+\s*['"`]|[`'"]\s*\+|\$\{|%s|fmt\.Sprintf|format\(|Query\(.*\+|Exec\(.*\+)/;

export function scanSqlInjection(diff: string): string[] {
  const hits: string[] = [];
  for (const [file, lines] of addedLinesByFile(diff)) {
    if (isTestPath(file) || isBuildOutput(file)) continue;
    if (!/\.(ts|js|tsx|jsx|go|py|php|rb|java|kt|cs|rs)$/i.test(file)) continue;
    for (const line of lines) {
      // Strip the diff marker before testing: addedLinesByFile retains the
      // leading "+", so without this the `\+\s*['"`]` alternative matches
      // EVERY indented line that merely starts with a string literal
      // (e.g. `+        "SELECT ... WHERE x = $1"`) — a false positive that
      // failed fully-parameterized queries (TASK-002/TASK-004 class).
      const content = line.startsWith("+") ? line.slice(1) : line;
      if (SQL_KW_RX.test(content) && SQL_CONCAT_RX.test(content)) {
        hits.push(`Possible SQL concatenation in ${file}: ${line.slice(1, 100).trim()}`);
        break;
      }
    }
  }
  return hits;
}

/** Embedded fallback data layers — Docker-always forbids every one of these. */
const FALLBACK_RX = /better-sqlite3|:memory:|new Database\(\s*['"]|sqlite3?\.open\(\s*['"]|sql\.open\(\s*["']sqlite/i;

export function scanFallbackLayers(diff: string): string[] {
  const hits: string[] = [];
  for (const [file, lines] of addedLinesByFile(diff)) {
    if (isTestPath(file) || isBuildOutput(file)) continue;
    if (!/\.(ts|js|tsx|jsx|go|py|php|rb|java|kt|cs|rs)$/i.test(file)) continue;
    for (const line of lines) {
      if (FALLBACK_RX.test(line)) {
        hits.push(`Embedded fallback data layer in ${file}: ${line.slice(1, 100).trim()}`);
        break;
      }
    }
  }
  return hits;
}

/** Heuristic tier (warn-only): mock-money literals and dead UI controls.
 *  Too context-sensitive to fail closed — a finance test asserting on
 *  "mock balance" text would false-positive — but reviewers must see them.
 */
export function scanDemoSmells(diff: string): string[] {
  const warns: string[] = [];
  const mockMoney = /(mock|fake|stub|placeholder|sample|demo)[-_ ]?(balance|fund|money|amount|ledger|payout)/i;
  for (const [file, lines] of addedLinesByFile(diff)) {
    if (isTestPath(file) || isBuildOutput(file)) continue;
    for (const line of lines) {
      if (mockMoney.test(line)) {
        warns.push(`Mock-money literal in ${file} — confirm sandbox-backed proof, not demo funds`);
        break;
      }
    }
  }
  for (const [file, lines] of addedLinesByFile(diff)) {
    if (isTestPath(file) || isBuildOutput(file)) continue;
    if (!/\.(tsx|jsx|vue|html|php|tsx?)$/i.test(file)) continue;
    for (const line of lines) {
      if (/href\s*=\s*["']#["']/.test(line)) {
        warns.push(`Dead control href="#" in ${file} — every control must resolve (route/handler/shipped JS)`);
        break;
      }
    }
  }
  return [...new Set(warns)];
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

export type GateFailureKind =
  | "sql-false-positive"
  | "test-scope"
  | "build-output"
  | "vendor-junk"
  | "unstamped-proof"
  | "progress-conflict"
  | "secret"
  | "empty-diff"
  | "unknown";

export interface FailureDiagnosis {
  kind: GateFailureKind;
  files: string[];
  prescription: string;
}

/** File names listed in an "Out-of-scope files modified (...)" message. */
function parseListedOutOfScope(text: string): { files: string[]; truncated: boolean } {
  const m = text.match(/out-of-scope files modified \(([^)]*)\)/i);
  if (!m) return { files: [], truncated: false };
  const raw = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const truncated = raw.some((s) => /^\+\d+\s+more$/i.test(s));
  const files = raw.filter((s) => !/^\+\d+\s+more$/i.test(s)).map((s) => s.replace(/^`|`$/g, ""));
  return { files, truncated };
}

/**
 * Code-level string building (real concatenation). Placeholders ($n, %s,
 * ?, :name) alone do NOT count — with the diff-marker strip live, a hit
 * carrying only placeholders is an engine bug, never agent SQLi.
 */
function hasCodeLevelConcat(code: string): boolean {
  return /(\+\s*['"`]|[`'"]\s*\+|\$\{|fmt\.Sprintf|(?<!\$)\bformat\(|Query\(.*\+|Exec\(.*\+)/.test(code);
}

/**
 * Diagnose deterministic-gate failures into actionable kinds (pure,
 * unit-tested). Returns [] when no auto-fix applies (normal reject path).
 * `diff` re-tests SQL hits strictly; `outOfScope` (full, untruncated file
 * list from the gate) beats message parsing. `progress-conflict` is a
 * merge-time condition and is never emitted here — listed for completeness.
 */
export function classifyGateFailure(failures: string[], opts?: { diff?: string; outOfScope?: string[] }): FailureDiagnosis[] {
  const out: FailureDiagnosis[] = [];
  const text = failures.join("\n");
  if (/empty diff/i.test(text)) {
    out.push({
      kind: "empty-diff",
      files: [],
      prescription: "Already integrated; mark COMPLETED per existing empty-diff path.",
    });
  }
  if (/no \[runner-executed\] stamp/i.test(text)) {
    out.push({
      kind: "unstamped-proof",
      files: [],
      prescription:
        "Re-run the task's test command via the runner so TASK_PROGRESS.md carries a stamped proof block; change nothing else.",
    });
  }
  if (/secret leak/i.test(text)) {
    out.push({
      kind: "secret",
      files: [],
      prescription: "Escalate to human immediately; never auto-touch secrets.",
    });
  }
  // SQL hits: with marker-strip live, re-test strictly. Only placeholders +
  // no code-level concat operator = engine false positive (do not retry the
  // task for it). Anything else is real concatenation → normal reject path.
  if (/sql injection|sql concatenation/i.test(text)) {
    const snippets: string[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/possible sql (?:injection[^\n]*?|concatenation) in ([^\n]+)/i);
      if (m) snippets.push(m[1]);
    }
    const hasSqlKw = (s: string) => SQL_KW_RX.test(s);
    const onlyPlaceholders = (s: string) => !hasCodeLevelConcat(s);
    const verifiable = snippets.filter(hasSqlKw);
    if (verifiable.length > 0 && verifiable.every(onlyPlaceholders)) {
      out.push({
        kind: "sql-false-positive",
        files: [],
        prescription: "Engine scanner bug (residual false positive); flag loudly, do not retry the task for it.",
      });
    }
  }
  // Out-of-scope routing needs the file set. Truncated message lists hide
  // files behind "+N more" — never classify on a partial set (would
  // misroute mixed diffs); the full gate fileList is authoritative.
  if (/out-of-scope files/i.test(text)) {
    const parsed = parseListedOutOfScope(text);
    const oos = opts?.outOfScope && opts.outOfScope.length > 0 ? opts.outOfScope : parsed.files;
    const partial = !(opts?.outOfScope && opts.outOfScope.length > 0) && (parsed.files.length === 0 || parsed.truncated);
    if (!partial && oos.length > 0) {
      const kinds = new Set(oos.map((f) => (isTestPath(f) ? "test" : isGeneratedJunkPath(f) ? "junk" : "code")));
      if (kinds.size === 1 && kinds.has("test")) {
        out.push({
          kind: "test-scope",
          files: [...oos],
          prescription:
            "Relocate the listed tests to a QA-owned task or widen the task's targetFiles; NEVER delete coverage to satisfy the gate.",
        });
      } else if (kinds.size === 1 && kinds.has("junk")) {
        const buildOnly = oos.every((f) => /(^|\/)(dist|build|out|coverage|storybook-static)\//.test(f.replace(/\\/g, "/")));
        out.push({
          kind: buildOnly ? "build-output" : "vendor-junk",
          files: [...oos],
          prescription:
            "Remove the listed regenerable paths from the task branch (git rm); extend the publish exclusion list so add -f can never stage them again.",
        });
      } else {
        out.push({
          kind: "unknown",
          files: [...oos],
          prescription: "Mixed or unrecognized scope shape; needs reviewer diagnosis.",
        });
      }
    } else {
      out.push({
        kind: "unknown",
        files: [...oos],
        prescription: "Out-of-scope set not fully visible; needs reviewer diagnosis.",
      });
    }
  }
  return out;
}

/**
 * Fix-round markers already recorded in review notes (budget ledger:
 * max 1 auto-fix per task+signature).
 */
export function priorFixRounds(notes?: string): string[] {
  const out: string[] = [];
  for (const m of (notes || "").matchAll(/\[FIX-ROUND: ([^\]]+)\]/g)) out.push(m[1]);
  return out;
}

/**
 * Gate ruleset version. Bumped whenever deterministic rules change
 * (scope lists, secret patterns, file filters): old verdicts recorded
 * under a previous version must be re-evaluated, never skipped by the
 * unchanged-tip optimization.
 */
export const GATE_VERSION = 14;

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
    const stamp = checkEvidenceStamp(progressContent);
    if (stamp === "missing-evidence") {
      warnings.push(
        "Verification section has no recognizable test evidence (bun test | go test | cargo test | dotnet test | pytest | phpunit output)."
      );
    } else if (stamp === "unstamped") {
      // Anti-fabrication: evidence patterns with no runner stamp are pasted
      // text, not executed proof (the TASK-001 class: plausible output the
      // runner never produced). Fail closed — re-running the task re-stamps.
      failures.push(
        "Test evidence present but no [runner-executed] stamp: proof must come from the runner's own test execution, not pasted text."
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

  // Injection + fallback layers fail closed (precise, low-FP patterns).
  for (const hit of scanSqlInjection(diff)) {
    failures.push(`Possible SQL injection (unparameterized query): ${hit}.`);
  }
  for (const hit of scanFallbackLayers(diff)) {
    failures.push(`Embedded fallback data layer (Docker-always violation): ${hit}.`);
  }
  // Demo smells are heuristic — warn so the (LLM) reviewer sees them.
  for (const w of scanDemoSmells(diff)) warnings.push(w);

  if (!lineageBroken && touchesApiOrSchema(fileList) && !fileList.includes("workspace/CONTRACTS.md")) {
    warnings.push("API/schema/services changed but workspace/CONTRACTS.md not updated (contract drift).");
  }
  if (!lineageBroken && fileList.includes("workspace/services.request.json") && !fileList.includes("workspace/CONTRACTS.md")) {
    warnings.push("New Docker service requested but workspace/CONTRACTS.md not updated (env endpoints undocumented).");
  }

  return { passed: failures.length === 0, failures, warnings, fileList, diffStat, lineageBroken };
}

/**
 * Robustly extract and parse a { approved, notes, suggestedFixes } JSON block from reviewer LLM output.
 * Handles markdown fences, preamble text, unescaped newlines in JSON strings, and regex fallback.
 */
export function parseReviewOutput(stdout: string): { approved: boolean; notes: string; suggestedFixes: string[] } | null {
  if (!stdout || !stdout.trim()) return null;

  // 1. Collect all fenced blocks (reversed: evaluate later/final block first)
  const fencedMatches = Array.from(stdout.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi));
  const candidates: string[] = fencedMatches.map((m) => m[1]).reverse();

  // 2. Add greedy block as fallback
  const greedy = stdout.match(/\{[\s\S]*\}/);
  if (greedy) candidates.push(greedy[0]);

  // 3. Add any object containing "approved"
  const approvedBlocks = Array.from(stdout.matchAll(/\{[^{}]*"approved"\s*:\s*(?:true|false)[\s\S]*?\}/gi));
  candidates.push(...approvedBlocks.map((m) => m[0]));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (typeof parsed.approved === "boolean") {
        return {
          approved: parsed.approved,
          notes: String(parsed.notes || ""),
          suggestedFixes: Array.isArray(parsed.suggestedFixes) ? parsed.suggestedFixes.map(String) : [],
        };
      }
    } catch {
      // Relaxed sanitization: replace raw control characters / unescaped newlines in string literals
      try {
        const sanitized = c.replace(/:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g, (_, str) => {
          return `: "${str.replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t")}"`;
        });
        const parsed = JSON.parse(sanitized.trim());
        if (typeof parsed.approved === "boolean") {
          return {
            approved: parsed.approved,
            notes: String(parsed.notes || ""),
            suggestedFixes: Array.isArray(parsed.suggestedFixes) ? parsed.suggestedFixes.map(String) : [],
          };
        }
      } catch {
        /* try next candidate */
      }
    }
  }

  // 4. Regex fallback: extract "approved" boolean and "notes" string
  const approvedMatch = stdout.match(/"approved"\s*:\s*(true|false)/i);
  if (approvedMatch) {
    const isApproved = approvedMatch[1].toLowerCase() === "true";
    const notesMatch = stdout.match(/"notes"\s*:\s*"([\s\S]*?)"(?:\s*[,}\n]|\s*$)/i);
    return {
      approved: isApproved,
      notes: notesMatch ? notesMatch[1].replace(/\\n/g, "\n") : isApproved ? "Approved by reviewer." : "Rejected by reviewer.",
      suggestedFixes: [],
    };
  }

  return null;
}
