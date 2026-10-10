import { describe, it, expect } from "bun:test";
import { STACKS, STACK_IDS, STACK_ECC_REFS, STACK_ESSENTIAL_SKILLS, TEST_EVIDENCE_RX, isKnownStackCommand, normalizeStackId } from "../orchestrator/stacks.ts";
import { validateRoadmap } from "../orchestrator/roadmap_validator.ts";

describe("stacks registry", () => {
  it("covers bun, go, rust, dotnet, python, php", () => {
    expect([...STACK_IDS].sort()).toEqual(["bun", "dotnet", "go", "php", "python", "rust"]);
    for (const id of STACK_IDS) {
      expect(STACKS[id].testCommand.length).toBeGreaterThan(0);
      expect(STACKS[id].buildCommand.length).toBeGreaterThan(0);
    }
  });

  it("accepts every toolchain as test evidence", () => {
    for (const s of ["bun test 5 pass", "go test ok", "cargo test test result: ok", "dotnet test Passed!", "pytest 3 passed", "phpunit OK (5 tests)", "FAILURES! Tests: 3"]) {
      expect(TEST_EVIDENCE_RX.test(s)).toBe(true);
    }
  });

  it("normalizes unknown stacks to fallback", () => {
    expect(normalizeStackId("go")).toBe("go");
    expect(normalizeStackId("Go")).toBe("go");
    expect(normalizeStackId("cobol", "bun")).toBe("bun");
    expect(normalizeStackId(undefined)).toBe("bun");
  });

  it("recognizes known stack commands", () => {
    expect(isKnownStackCommand("go test ./...")).toBe(true);
    expect(isKnownStackCommand("cargo test")).toBe(true);
    expect(isKnownStackCommand("dotnet test")).toBe(true);
    expect(isKnownStackCommand("python -m pytest -q")).toBe(true);
    expect(isKnownStackCommand("vendor/bin/phpunit")).toBe(true);
    expect(isKnownStackCommand("php artisan test")).toBe(true);
    expect(isKnownStackCommand("echo hello")).toBe(false);
  });

  it("maps every stack to an existing essentials skill", async () => {
    for (const id of STACK_IDS) {
      const skill = STACK_ESSENTIAL_SKILLS[id];
      expect(typeof skill).toBe("string");
      const f = Bun.file(`.opencode/skills/${skill}/SKILL.md`);
      expect(await f.exists()).toBe(true);
      const text = await f.text();
      expect(text.includes(STACKS[id].testCommand)).toBe(true);
    }
  });

  it("references only manifest-pinned ECC depth files", async () => {
    // The manifest (committed) is the pin: fetched content is verified
    // against it, so refs must resolve inside it — no disk content needed.
    const manifest = (await Bun.file("vendor/ecc/.manifest.json").json()) as {
      eccVersion: string;
      files: Record<string, string>;
    };
    expect(manifest.eccVersion).toMatch(/^\d+\.\d+/);
    expect(Object.keys(manifest.files).length).toBeGreaterThan(30);
    for (const id of STACK_IDS) {
      expect(STACK_ECC_REFS[id].length).toBeGreaterThan(0);
      for (const ref of STACK_ECC_REFS[id]) {
        expect(Object.hasOwn(manifest.files, ref)).toBe(true);
      }
    }
  });
});

describe("roadmap stack validation", () => {
  const base = {
    tasks: [
      {
        id: "TASK-001",
        role: "backend",
        dependencies: [],
        targetFiles: ["workspace/src/api"],
        description: Array(25).fill("word").join(" "),
        deliverables: ["a", "b"],
        verificationCommand: "go test ./...",
      },
    ],
    milestones: [{ title: "v0.1.0" }],
  };
  it("accepts a known stack", () => {
    const r = validateRoadmap({ ...base, stack: "go" });
    expect(r.errors).toEqual([]);
  });
  it("rejects an unknown stack", () => {
    const r = validateRoadmap({ ...base, stack: "cobol" });
    expect(r.errors.join(" ")).toMatch(/Unknown stack/);
  });
  it("warns on toolchain-unknown verificationCommand", () => {
    const r = validateRoadmap({ ...base, stack: "go", tasks: [{ ...base.tasks[0], verificationCommand: "echo hi" }] });
    expect(r.warnings.join(" ")).toMatch(/no known stack toolchain/);
  });
});
