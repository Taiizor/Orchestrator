import { existsSync } from "node:fs";
import { GitManager } from "./git_manager.ts";

export type StackId = "bun" | "go" | "rust" | "dotnet" | "python";

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
};

export const STACK_IDS = Object.keys(STACKS) as StackId[];

/** Combined evidence pattern: any supported toolchain output counts as proof. */
export const TEST_EVIDENCE_RX =
  /bun test|bun run|go test|cargo test|test result:|dotnet (test|build)|pytest|passed!|passing|passed/i;

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
    c.includes("pytest") ||
    c.includes("python -m")
  );
}

/** Detect the product stack from workspace markers (first hit wins). */
export async function detectWorkspaceStack(cwd = "."): Promise<StackId> {
  const join = (p: string) => (cwd === "." ? p : `${cwd.replace(/\/$/, "")}/${p}`);
  if (existsSync(join("workspace/go.mod"))) return "go";
  if (existsSync(join("workspace/Cargo.toml"))) return "rust";
  if (existsSync(join("workspace/pyproject.toml"))) return "python";
  if (existsSync(join("workspace/requirements.txt"))) return "python";
  if (existsSync(join("workspace/setup.py"))) return "python";
  try {
    const glob = new Bun.Glob("workspace/*.sln");
    for await (const _ of glob.scan({ cwd, onlyFiles: true })) return "dotnet";
  } catch {
    /* no sln */
  }
  try {
    const glob = new Bun.Glob("workspace/**/*.csproj");
    for await (const _ of glob.scan({ cwd, onlyFiles: true })) return "dotnet";
  } catch {
    /* no csproj */
  }
  return "bun";
}

/** Normalize a declared stack value; unknown/empty falls back to detected/default. */
export function normalizeStackId(raw: unknown, fallback: StackId = "bun"): StackId {
  if (typeof raw === "string" && (STACK_IDS as string[]).includes(raw.toLowerCase())) {
    return raw.toLowerCase() as StackId;
  }
  return fallback;
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

/** One-line toolchain reference for agent prompts. */
export function stackPromptTable(): string {
  return [
    "| Stack | Test command | Build command |",
    "|---|---|---|",
    ...STACK_IDS.map((id) => `| \`${id}\` | \`${STACKS[id].testCommand}\` | \`${STACKS[id].buildCommand}\` |`),
  ].join("\n");
}
