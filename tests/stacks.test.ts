import { describe, it, expect } from "bun:test";
import { STACKS, STACK_IDS, TEST_EVIDENCE_RX, isKnownStackCommand, normalizeStackId } from "../orchestrator/stacks.ts";
import { validateRoadmap } from "../orchestrator/roadmap_validator.ts";

describe("stacks registry", () => {
  it("covers bun, go, rust, dotnet, python", () => {
    expect([...STACK_IDS].sort()).toEqual(["bun", "dotnet", "go", "python", "rust"]);
    for (const id of STACK_IDS) {
      expect(STACKS[id].testCommand.length).toBeGreaterThan(0);
      expect(STACKS[id].buildCommand.length).toBeGreaterThan(0);
    }
  });

  it("accepts every toolchain as test evidence", () => {
    for (const s of ["bun test 5 pass", "go test ok", "cargo test test result: ok", "dotnet test Passed!", "pytest 3 passed"]) {
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
    expect(isKnownStackCommand("echo hello")).toBe(false);
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
