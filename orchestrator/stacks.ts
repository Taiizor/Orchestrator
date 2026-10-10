import { existsSync } from "node:fs";
import { GitManager } from "./git_manager.ts";

export type StackId = "bun" | "go" | "rust" | "dotnet" | "python" | "php";

export interface StackDef {
  id: StackId;
  label: string;
  testCommand: string;
  buildCommand: string;
  /** Markers proving this stack owns workspace/ (first hit wins, in order below). */
  markers: string[];
  /** Evidence fragments accepted as test proof for this stack. */
  evidence: string[];
}

export const STACKS: Record<StackId, StackDef> = {
  bun: {
    id: "bun",
    label: "Bun + TypeScript",
    testCommand: "bun test",
    buildCommand: "bun run build",
    markers: ["workspace/package.json", "workspace/bun.lock", "workspace/bun.lockb"],
    evidence: ["bun test", "bun run"],
  },
  go: {
    id: "go",
    label: "Go",
    testCommand: "go test ./...",
    buildCommand: "go build ./...",
    markers: ["workspace/go.mod"],
    evidence: ["go test"],
  },
  rust: {
    id: "rust",
    label: "Rust (Cargo)",
    testCommand: "cargo test",
    buildCommand: "cargo build",
    markers: ["workspace/Cargo.toml"],
    evidence: ["cargo test", "test result:"],
  },
  dotnet: {
    id: "dotnet",
    label: ".NET",
    testCommand: "dotnet test",
    buildCommand: "dotnet build",
    markers: ["workspace/*.sln", "workspace/*.csproj"],
    evidence: ["dotnet test", "Passed!", "Passed:", "Failed:"],
  },
  python: {
    id: "python",
    label: "Python (pytest)",
    testCommand: "python -m pytest -q",
    buildCommand: "python -m compileall .",
    markers: ["workspace/pyproject.toml", "workspace/requirements.txt", "workspace/setup.py"],
    evidence: ["pytest", "passed", "PASSED"],
  },
  php: {
    id: "php",
    label: "PHP (PHPUnit)",
    testCommand: "php vendor/bin/phpunit",
    buildCommand: "composer install --no-interaction --prefer-dist",
    markers: ["workspace/composer.json"],
    evidence: ["phpunit", "OK (", "FAILURES", "Tests: "],
  },
};

export const STACK_IDS = Object.keys(STACKS) as StackId[];

/** Essentials skill injected for every agent on a stack (toolchain + idioms). */
export const STACK_ESSENTIAL_SKILLS: Record<StackId, string> = {
  bun: "bun-essentials",
  go: "go-essentials",
  rust: "rust-essentials",
  dotnet: "dotnet-essentials",
  python: "python-essentials",
  php: "php-essentials",
};

/**
 * Staged ECC skill IDs (prefix `ecc-`, see scripts/stage-ecc-skills.ts)
 * offered as on-demand reloads per stack. Never auto-injected (context
 * budget) — the runner lists the present ones in the reload hint.
 */
export const STACK_ECC_SKILL_IDS: Record<StackId, string[]> = {
  bun: ["ecc-bun-runtime"],
  go: ["ecc-golang-patterns", "ecc-golang-testing"],
  rust: ["ecc-rust-patterns", "ecc-rust-testing"],
  dotnet: ["ecc-dotnet-patterns", "ecc-csharp-testing"],
  python: ["ecc-python-patterns", "ecc-python-testing"],
  php: ["ecc-laravel-patterns", "ecc-laravel-tdd"],
};

/**
 * Vendored ECC reference depth (MIT, © 2026 Affaan Mustafa) per stack.
 * NOT auto-injected (context budget) — agents read these on demand when the
 * essentials skill points at them. Covered by existence tests.
 */
export const STACK_ECC_REFS: Record<StackId, string[]> = {
  bun: [
    "vendor/ecc/skills/bun-runtime/SKILL.md",
    "vendor/ecc/agents/typescript-reviewer.md",
    "vendor/ecc/agents/react-reviewer.md",
  ],
  go: [
    "vendor/ecc/rules/golang/coding-style.md",
    "vendor/ecc/rules/golang/patterns.md",
    "vendor/ecc/rules/golang/security.md",
    "vendor/ecc/rules/golang/testing.md",
    "vendor/ecc/skills/golang-patterns/SKILL.md",
    "vendor/ecc/skills/golang-testing/SKILL.md",
    "vendor/ecc/agents/go-reviewer.md",
  ],
  rust: [
    "vendor/ecc/rules/rust/coding-style.md",
    "vendor/ecc/rules/rust/patterns.md",
    "vendor/ecc/rules/rust/security.md",
    "vendor/ecc/rules/rust/testing.md",
    "vendor/ecc/skills/rust-patterns/SKILL.md",
    "vendor/ecc/skills/rust-testing/SKILL.md",
    "vendor/ecc/agents/rust-reviewer.md",
  ],
  dotnet: [
    "vendor/ecc/rules/csharp/coding-style.md",
    "vendor/ecc/rules/csharp/patterns.md",
    "vendor/ecc/rules/csharp/security.md",
    "vendor/ecc/rules/csharp/testing.md",
    "vendor/ecc/skills/dotnet-patterns/SKILL.md",
    "vendor/ecc/skills/csharp-testing/SKILL.md",
    "vendor/ecc/agents/csharp-reviewer.md",
  ],
  python: [
    "vendor/ecc/rules/python/coding-style.md",
    "vendor/ecc/rules/python/patterns.md",
    "vendor/ecc/rules/python/security.md",
    "vendor/ecc/rules/python/testing.md",
    "vendor/ecc/rules/python/fastapi.md",
    "vendor/ecc/skills/python-patterns/SKILL.md",
    "vendor/ecc/skills/python-testing/SKILL.md",
    "vendor/ecc/agents/python-reviewer.md",
  ],
  php: [
    "vendor/ecc/rules/php/coding-style.md",
    "vendor/ecc/rules/php/patterns.md",
    "vendor/ecc/rules/php/security.md",
    "vendor/ecc/rules/php/testing.md",
    "vendor/ecc/skills/laravel-patterns/SKILL.md",
    "vendor/ecc/skills/laravel-tdd/SKILL.md",
    "vendor/ecc/agents/php-reviewer.md",
  ],
};

/** Combined evidence pattern: any supported toolchain output counts as proof. */
export const TEST_EVIDENCE_RX =
  /bun test|bun run|go test|cargo test|test result:|dotnet (test|build)|pytest|phpunit|pest|OK \(|FAILURES|passed!|passing|passed/i;

/** Does a verificationCommand belong to a known stack toolchain? */
export function isKnownStackCommand(cmd: string): boolean {
  const c = (cmd || "").toLowerCase();
  return (
    c.includes("bun test") ||
    c.includes("bun run") ||
    c.includes("go test") ||
    c.includes("go build") ||
    c.includes("cargo test") ||
    c.includes("cargo build") ||
    c.includes("dotnet test") ||
    c.includes("dotnet build") ||
    c.includes("phpunit") ||
    c.includes("pest") ||
    c.includes("composer") ||
    c.includes("artisan") ||
    c.includes("pytest") ||
    c.includes("python -m")
  );
}

/** Detect the product stack from workspace markers (first hit wins). */
export async function detectWorkspaceStack(cwd = "."): Promise<StackId> {
  const all = await detectWorkspaceStacks(cwd);
  return all[0] ?? "bun";
}

/** Detect EVERY product stack present (mixed trees: go API + bun UI). */
export async function detectWorkspaceStacks(cwd = "."): Promise<StackId[]> {
  const join = (p: string) => (cwd === "." ? p : `${cwd.replace(/\/$/, "")}/${p}`);
  const found: StackId[] = [];
  if (existsSync(join("workspace/go.mod"))) found.push("go");
  if (existsSync(join("workspace/Cargo.toml"))) found.push("rust");
  if (
    existsSync(join("workspace/pyproject.toml")) ||
    existsSync(join("workspace/requirements.txt")) ||
    existsSync(join("workspace/setup.py"))
  ) {
    found.push("python");
  }
  if (existsSync(join("workspace/composer.json"))) found.push("php");
  try {
    const glob = new Bun.Glob("workspace/*.sln");
    for await (const _ of glob.scan({ cwd, onlyFiles: true })) {
      found.push("dotnet");
      break;
    }
  } catch {
    /* no sln */
  }
  if (!found.includes("dotnet")) {
    try {
      const glob = new Bun.Glob("workspace/**/*.csproj");
      for await (const _ of glob.scan({ cwd, onlyFiles: true })) {
        found.push("dotnet");
        break;
      }
    } catch {
      /* no csproj */
    }
  }
  if (
    existsSync(join("workspace/package.json")) ||
    existsSync(join("workspace/bun.lock")) ||
    existsSync(join("workspace/bun.lockb"))
  ) {
    found.push("bun");
  }
  return found;
}

/** Normalize a declared stack value; unknown/empty falls back to detected/default. */
export function normalizeStackId(raw: unknown, fallback: StackId = "bun"): StackId {
  if (typeof raw === "string" && (STACK_IDS as string[]).includes(raw.toLowerCase())) {
    return raw.toLowerCase() as StackId;
  }
  return fallback;
}

/**
 * A task's effective stack: explicit task.stack wins, else the roadmap
 * default. Layers may differ (go API + bun UI) — each task proves itself
 * with its own toolchain.
 */
export function effectiveTaskStack(task: { stack?: unknown }, roadmapStack: unknown, fallback: StackId = "bun"): StackId {
  const base = normalizeStackId(roadmapStack, fallback);
  if (task.stack === undefined || task.stack === null || task.stack === "") return base;
  return normalizeStackId(task.stack, base);
}

export interface StackTestResult {
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run the stack's test suite inside workspace/. Never throws (exitCode -1 on spawn failure). */
export async function runStackTests(stack: StackId, cwd = "workspace"): Promise<StackTestResult> {
  const def = STACKS[stack];
  const parts = def.testCommand.split(" ").filter(Boolean);
  try {
    const proc = Bun.spawn(parts, { cwd, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { command: parts, stdout, stderr, exitCode };
  } catch (err: any) {
    return { command: parts, stdout: "", stderr: String(err?.message || err), exitCode: -1 };
  }
}

/** Verify resolved code after conflict resolution using the workspace stack. */
export async function verifyWorkspace(stack: StackId, cwd = "workspace"): Promise<boolean> {
  console.log(`🧪 Verifying resolved code with '${STACKS[stack].testCommand}' in ${cwd}/...`);
  const res = await GitManager.run(
    [STACKS[stack].testCommand.split(" ")[0], ...STACKS[stack].testCommand.split(" ").slice(1)],
    cwd
  );
  const output = (res.stdout + "\n" + res.stderr).toLowerCase();
  const noTests = /no tests? found|no test files|no tests ran|0 (tests|pass)|no test suites/.test(output);
  const hasFailures = /fail/.test(output) && !/0 fail/.test(output);
  if (!noTests && (res.exitCode !== 0 || hasFailures)) {
    console.warn("⚠️ Automated tests failed after resolving conflict:", res.stderr || res.stdout);
    return false;
  }
  return true;
}

/**
 * Verify EVERY stack present in a (possibly mixed) workspace. Merges can
 * touch several layers at once — one suite passing must not mask another
 * layer's breakage. Empty tree = legacy bun default (unchanged behavior).
 */
export async function verifyAllWorkspaceStacks(): Promise<boolean> {
  const stacks = await detectWorkspaceStacks(".");
  const list = stacks.length > 0 ? stacks : (["bun"] as StackId[]);
  if (list.length > 1) {
    console.log(`🧪 Mixed workspace detected (${list.join(" + ")}); verifying each stack.`);
  }
  let allOk = true;
  for (const s of list) {
    if (!(await verifyWorkspace(s, "workspace"))) allOk = false;
  }
  return allOk;
}

/** One-line toolchain reference for agent prompts. */
export function stackPromptTable(): string {
  return [
    "| Stack | Test command | Build command |",
    "|---|---|---|",
    ...STACK_IDS.map((id) => `| \`${id}\` | \`${STACKS[id].testCommand}\` | \`${STACKS[id].buildCommand}\` |`),
  ].join("\n");
}
