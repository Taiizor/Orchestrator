import { describe, it, expect } from "bun:test";
import { initialTargetFilesForOperatorTask, resolveReviseDependencies } from "../orchestrator/issue_manager.ts";
import { validateRoadmap } from "../orchestrator/roadmap_validator.ts";

describe("operator task scoping (/add)", () => {
  it("leaves operator-added tasks unscoped even on contract claims", () => {
    // TASK-043 precedent: scoping a cross-layer task to ["workspace/CONTRACTS.md"]
    // alone turns the gate's out-of-scope check into a guaranteed failure.
    expect(initialTargetFilesForOperatorTask()).toEqual([]);
  });

  it("keeps split-stack validation green for unscoped tasks anchored on the owner", () => {
    const mk = (id: string, stack: string, targetFiles: string[], cmd: string, deps: string[] = []) => ({
      id,
      role: "backend",
      dependencies: deps,
      targetFiles,
      description: "word ".repeat(25).trim(),
      deliverables: ["Create x", "Test x"],
      verificationCommand: cmd,
      stack,
    });
    const r = validateRoadmap({
      stack: "go",
      tasks: [
        mk("t0", "go", ["workspace/CONTRACTS.md"], "go test ./..."),
        mk("t1", "bun", initialTargetFilesForOperatorTask(), "bun test", ["t0"]),
      ],
    });
    expect(r.errors).toEqual([]);
  });
});

describe("revise dependency inheritance (/revise)", () => {
  it("waits for the target and everything the target waited for", () => {
    // TASK-048 precedent: a bun revise depending only on its target loses the
    // contract-task anchor and is DAG-rejected.
    expect(resolveReviseDependencies("TASK-047", ["TASK-009", "TASK-043"])).toEqual(["TASK-047", "TASK-009", "TASK-043"]);
  });

  it("dedupes and tolerates missing dep lists", () => {
    expect(resolveReviseDependencies("TASK-001", ["TASK-001"])).toEqual(["TASK-001"]);
    expect(resolveReviseDependencies("TASK-001", undefined)).toEqual(["TASK-001"]);
  });

  it("passes split-stack validation with inherited contract anchor", () => {
    const mk = (id: string, stack: string, targetFiles: string[], cmd: string, deps: string[] = []) => ({
      id,
      role: "frontend",
      dependencies: deps,
      targetFiles,
      description: "word ".repeat(25).trim(),
      deliverables: ["Create x", "Test x"],
      verificationCommand: cmd,
      stack,
    });
    const r = validateRoadmap({
      stack: "go",
      tasks: [
        mk("t0", "go", ["workspace/CONTRACTS.md"], "go test ./..."),
        mk("t1", "bun", ["workspace/ui"], "bun test", ["t0"]),
        mk("t2", "bun", [], "bun test", resolveReviseDependencies("t1", ["t0"])),
      ],
    });
    expect(r.errors).toEqual([]);
  });
});
