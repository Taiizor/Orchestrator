import { describe, it, expect } from "bun:test";
import { validateRoadmap, formatValidation, sanitizeCoverage } from "../orchestrator/roadmap_validator.ts";

describe("Roadmap Validator Module", () => {
  describe("validateRoadmap", () => {
    it("should error on empty tasks array", () => {
      const result = validateRoadmap({ tasks: [] });
      expect(result.errors).toContain("Roadmap has zero tasks.");
    });

    it("should error on duplicate task IDs", () => {
      const result = validateRoadmap({
        tasks: [
          { id: "task1", role: "backend", dependencies: [], targetFiles: ["src/a.ts"] },
          { id: "task1", role: "frontend", dependencies: [], targetFiles: ["src/b.ts"] }
        ]
      });
      expect(result.errors.some(e => e.includes("Duplicate task IDs: task1"))).toBe(true);
    });

    it("should error on invalid roles", () => {
      const result = validateRoadmap({
        tasks: [{ id: "task1", role: "magician", dependencies: [], targetFiles: ["src/a.ts"] }]
      });
      expect(result.errors.some(e => e.includes("invalid role \"magician\""))).toBe(true);
    });

    it("should error on self-dependency", () => {
      const result = validateRoadmap({
        tasks: [{ id: "task1", role: "backend", dependencies: ["task1"], targetFiles: ["src/a.ts"] }]
      });
      expect(result.errors.some(e => e.includes("depends on itself"))).toBe(true);
    });

    it("should error on unknown dependency", () => {
      const result = validateRoadmap({
        tasks: [{ id: "task1", role: "backend", dependencies: ["ghost_task"], targetFiles: ["src/a.ts"] }]
      });
      expect(result.errors.some(e => e.includes("unknown task \"ghost_task\""))).toBe(true);
    });

    it("should detect dependency cycle (A->B->C->A)", () => {
      const result = validateRoadmap({
        tasks: [
          { id: "A", role: "backend", dependencies: ["B"], targetFiles: ["src/a.ts"] },
          { id: "B", role: "backend", dependencies: ["C"], targetFiles: ["src/b.ts"] },
          { id: "C", role: "backend", dependencies: ["A"], targetFiles: ["src/c.ts"] }
        ]
      });
      expect(result.errors.some(e => e.includes("Dependency cycle detected"))).toBe(true);
    });

    it("should allow diamond dependency (A->B, A->C, B->D, C->D)", () => {
      const result = validateRoadmap({
        tasks: [
          { id: "D", role: "backend", dependencies: [], targetFiles: ["src/d.ts"] },
          { id: "B", role: "backend", dependencies: ["D"], targetFiles: ["src/b.ts"] },
          { id: "C", role: "backend", dependencies: ["D"], targetFiles: ["src/c.ts"] },
          { id: "A", role: "backend", dependencies: ["B", "C"], targetFiles: ["src/a.ts"] }
        ]
      });
      expect(result.errors.length).toBe(0);
    });

    it("should error on unknown service string", () => {
      const result = validateRoadmap({
        tasks: [{ id: "t1", role: "backend", dependencies: [], targetFiles: ["a.ts"] }],
        services: ["magic_db"]
      });
      expect(result.errors.some(e => e.includes("Unknown CI service \"magic_db\""))).toBe(true);
    });

    it("should allow known service presets", () => {
      const result = validateRoadmap({
        tasks: [{ id: "t1", role: "backend", dependencies: [], targetFiles: ["a.ts"] }],
        services: ["postgres", "redis", "mongo", "minio", "s3"]
      });
      expect(result.errors.length).toBe(0);
    });

    it("should error on invalid custom service definition", () => {
      const result = validateRoadmap({
        tasks: [{ id: "t1", role: "backend", dependencies: [], targetFiles: ["a.ts"] }],
        services: [{ name: "custom" }] // missing image
      });
      expect(result.errors.some(e => e.includes("Invalid custom service definition"))).toBe(true);
    });

    it("should warn on missing targetFiles", () => {
      const result = validateRoadmap({
        tasks: [{ id: "t1", role: "backend", dependencies: [], targetFiles: [] as any }]
      });
      expect(result.warnings.some(w => w.includes("has no targetFiles"))).toBe(true);
    });

    it("should warn on overlapping targetFiles on parallel tasks", () => {
      const result = validateRoadmap({
        tasks: [
          { id: "t1", role: "backend", dependencies: [], targetFiles: ["src/*"] },
          { id: "t2", role: "backend", dependencies: [], targetFiles: ["src/index.ts"] }
        ]
      });
      expect(result.warnings.some(w => w.includes("overlapping targetFiles"))).toBe(true);
    });

    it("should warn on unknown milestone reference", () => {
      const result = validateRoadmap({
        tasks: [{ id: "t1", role: "backend", dependencies: [], targetFiles: ["a"], milestone: "m1" }],
        milestones: [{ title: "m2" }]
      });
      expect(result.warnings.some(w => w.includes("unknown milestone"))).toBe(true);
    });

    it("should warn on thin description", () => {
      const result = validateRoadmap({
        tasks: [{ id: "t1", role: "backend", dependencies: [], targetFiles: ["a"], description: "Do stuff" }]
      });
      expect(result.warnings.some(w => w.includes("description is thin"))).toBe(true);
    });

    it("should warn on missing deliverables and verificationCommand", () => {
      const result = validateRoadmap({
        tasks: [{
          id: "t1", role: "backend", dependencies: [], targetFiles: ["a"],
          description: "word ".repeat(25).trim()
        }]
      });
      expect(result.warnings.some(w => w.includes("fewer than 2 deliverables"))).toBe(true);
      expect(result.warnings.some(w => w.includes("no verificationCommand"))).toBe(true);
    });

    it("should not warn on a fully specified task", () => {
      const result = validateRoadmap({
        tasks: [{
          id: "t1", role: "backend", dependencies: [], targetFiles: ["a"],
          description: "word ".repeat(25).trim(),
          deliverables: ["Create a.ts", "Test a.ts"],
          verificationCommand: "bun test"
        }]
      });
      expect(result.warnings.length).toBe(0);
    });

    it("should error on unknown per-task stack but accept known ones", () => {
      const contract = {
        id: "t0", role: "architect", dependencies: [], targetFiles: ["workspace/CONTRACTS.md"],
        description: "word ".repeat(25).trim(),
        deliverables: ["Write CONTRACTS.md", "Generate typed client"],
        verificationCommand: "go test ./..."
      };
      const base = {
        id: "t1", role: "backend", dependencies: ["t0"], targetFiles: ["a"],
        description: "word ".repeat(25).trim(),
        deliverables: ["Create a.ts", "Test a.ts"],
        verificationCommand: "go test ./..."
      };
      const bad = validateRoadmap({ stack: "bun", tasks: [contract, { ...base, stack: "cobol" }] });
      expect(bad.errors.some((e) => e.includes("unknown task stack"))).toBe(true);
      const good = validateRoadmap({ stack: "bun", tasks: [contract, { ...base, stack: "go" }] });
      expect(good.errors).toEqual([]);
      const inherited = validateRoadmap({ stack: "go", tasks: [{ ...base, dependencies: [] }] });
      expect(inherited.errors).toEqual([]);
    });

    it("should accept case/whitespace variants of known stacks", () => {
      const base = {
        id: "t1", role: "backend", dependencies: [], targetFiles: ["a"],
        description: "word ".repeat(25).trim(),
        deliverables: ["Create a.ts", "Test a.ts"],
        verificationCommand: "go test ./..."
      };
      expect(validateRoadmap({ stack: " Go ", tasks: [{ ...base }] }).errors).toEqual([]);
      expect(validateRoadmap({ stack: "bun", tasks: [{ ...base, stack: "GO" }] }).errors).toEqual([]);
    });

    it("should warn when verificationCommand belongs to another layer", () => {
      const contract = {
        id: "t0", role: "architect", dependencies: [], targetFiles: ["workspace/CONTRACTS.md"],
        description: "word ".repeat(25).trim(),
        deliverables: ["Write CONTRACTS.md", "Generate typed client"],
        verificationCommand: "bun test"
      };
      const base = {
        id: "t1", role: "backend", dependencies: ["t0"], targetFiles: ["a"],
        description: "word ".repeat(25).trim(),
        deliverables: ["Create a.ts", "Test a.ts"],
        verificationCommand: "bun test"
      };
      const r = validateRoadmap({ stack: "bun", tasks: [contract, { ...base, stack: "go" }] });
      expect(r.warnings.some((w) => w.includes("effective stack is go"))).toBe(true);
      const ok = validateRoadmap({ stack: "bun", tasks: [contract, { ...base, stack: "go", verificationCommand: "go test ./..." }] });
      expect(ok.warnings.some((w) => w.includes("effective stack"))).toBe(false);
      expect(ok.errors).toEqual([]);
    });

    it("should error on split stacks without a contract task", () => {
      const mk = (id: string, stack: string, targetFiles: string[], cmd: string, deps: string[] = []) => ({
        id, role: "backend", dependencies: deps, targetFiles,
        description: "word ".repeat(25).trim(),
        deliverables: ["Create x", "Test x"],
        verificationCommand: cmd, stack,
      });
      const split = validateRoadmap({
        stack: "go",
        tasks: [mk("t1", "go", ["workspace/api"], "go test ./..."), mk("t2", "bun", ["workspace/ui"], "bun test")],
      });
      expect(split.errors.some((e) => e.includes("no task owning workspace/CONTRACTS.md"))).toBe(true);
      const contracted = validateRoadmap({
        stack: "go",
        tasks: [
          mk("t0", "go", ["workspace/CONTRACTS.md"], "go test ./..."),
          mk("t1", "go", ["workspace/api"], "go test ./...", ["t0"]),
          mk("t2", "bun", ["workspace/ui"], "bun test", ["t0"]),
        ],
      });
      expect(contracted.errors).toEqual([]);
    });

    it("should error when an override-stack task bypasses the contract task", () => {
      const mk = (id: string, stack: string, targetFiles: string[], cmd: string, deps: string[] = []) => ({
        id, role: "backend", dependencies: deps, targetFiles,
        description: "word ".repeat(25).trim(),
        deliverables: ["Create x", "Test x"],
        verificationCommand: cmd, stack,
      });
      const r = validateRoadmap({
        stack: "go",
        tasks: [
          mk("t0", "go", ["workspace/CONTRACTS.md"], "go test ./..."),
          mk("t1", "bun", ["workspace/ui"], "bun test"),
        ],
      });
      expect(r.errors.some((e) => e.includes("does not depend on the contract task"))).toBe(true);
    });

    it("should error on invalid task IDs", () => {
      const base = {
        role: "backend", dependencies: [], targetFiles: ["a"],
        description: "word ".repeat(25).trim(),
        deliverables: ["Create a.ts", "Test a.ts"],
        verificationCommand: "bun test"
      };
      for (const badId of ["bad id", "task/001", "../x", "TASK 001", ""]) {
        const r = validateRoadmap({ tasks: [{ ...base, id: badId }] });
        expect(r.errors.some((e) => e.includes("invalid task ID"))).toBe(true);
      }
      const good = validateRoadmap({ tasks: [{ ...base, id: "TASK-001" }] });
      expect(good.errors).toEqual([]);
    });

    it("should enforce launch discipline (round present, unique per milestone)", () => {
      const mkLaunch = (id: string, milestone: string, round: any) => ({
        id, role: "launch", dependencies: [], targetFiles: ["workspace/src/index.ts"],
        milestone,
        description: "word ".repeat(25).trim(),
        deliverables: ["Boot app", "Probe surfaces"],
        verificationCommand: "bun test workspace/tests/smoke",
        launchRound: round,
      });
      const ms = [{ title: "v1" }];
      const noRound = validateRoadmap({ milestones: ms, tasks: [mkLaunch("t1", "v1", undefined)] });
      expect(noRound.errors.some((e) => e.includes("no launchRound"))).toBe(true);
      const badRound = validateRoadmap({ milestones: ms, tasks: [mkLaunch("t1", "v1", 0)] });
      expect(badRound.errors.some((e) => e.includes("positive integer"))).toBe(true);
      const dupe = validateRoadmap({
        milestones: ms,
        tasks: [mkLaunch("t1", "v1", 1), mkLaunch("t2", "v1", 1)],
      });
      expect(dupe.errors.some((e) => e.includes("exactly one per round"))).toBe(true);
      const ok = validateRoadmap({
        milestones: ms,
        tasks: [mkLaunch("t1", "v1", 1), mkLaunch("t2", "v1", 2)],
      });
      expect(ok.errors).toEqual([]);
    });

    it("should grandfather COMPLETED launches predating the round rule", () => {
      const old = {
        id: "t0", role: "launch", dependencies: [], targetFiles: ["workspace/src/index.ts"],
        milestone: "v1",
        description: "word ".repeat(25).trim(),
        deliverables: ["Boot app", "Probe surfaces"],
        verificationCommand: "bun test",
        status: "COMPLETED",
      };
      const r = validateRoadmap({ milestones: [{ title: "v1" }], tasks: [old] });
      expect(r.errors).toEqual([]);
    });

    it("should warn on uncovered input files", () => {
      const tasks = [{
        id: "t1", role: "backend", dependencies: [], targetFiles: ["a"],
        description: "word ".repeat(25).trim(),
        deliverables: ["Create a.ts", "Test a.ts"],
        verificationCommand: "bun test"
      }];
      const covered = validateRoadmap({
        tasks,
        inputFiles: ["inputs/spec.md", "inputs/mock.png"],
        coverage: { "inputs/spec.md": ["t1"], "inputs/mock.png": ["t1"] }
      });
      expect(covered.warnings.length).toBe(0);

      const missing = validateRoadmap({
        tasks,
        inputFiles: ["inputs/spec.md", "inputs/mock.png"],
        coverage: { "inputs/spec.md": ["t1"] }
      });
      expect(missing.warnings.some(w => w.includes('Input "inputs/mock.png" is not covered'))).toBe(true);

      const nomap = validateRoadmap({ tasks, inputFiles: ["inputs/spec.md"] });
      expect(nomap.warnings.some(w => w.includes("no input-coverage map"))).toBe(true);
    });

    it("should skip coverage checks without inputFiles", () => {
      const result = validateRoadmap({
        tasks: [{ id: "t1", role: "backend", dependencies: [], targetFiles: ["a"] }]
      });
      expect(result.warnings.some(w => w.includes("not covered"))).toBe(false);
    });
  });

  describe("formatValidation", () => {
    it("should return OK if no errors or warnings", () => {
      expect(formatValidation({ errors: [], warnings: [] })).toBe("OK");
    });

    it("should format errors and warnings", () => {
      const str = formatValidation({ errors: ["Err1"], warnings: ["Warn1"] });
      expect(str).toContain("Errors:");
      expect(str).toContain("- Err1");
      expect(str).toContain("Warnings:");
      expect(str).toContain("- Warn1");
    });
  });

  describe("sanitizeCoverage", () => {
    it("should keep string keys with string-id arrays", () => {
      expect(sanitizeCoverage({ "inputs/a.md": ["t1", "t2"], "inputs/b.png": ["t1"] })).toEqual({
        "inputs/a.md": ["t1", "t2"],
        "inputs/b.png": ["t1"],
      });
    });

    it("should drop non-array values and non-string ids", () => {
      expect(sanitizeCoverage({ "inputs/a.md": "t1", "inputs/b.md": ["t1", 42, null], "inputs/c.md": [] })).toEqual({
        "inputs/b.md": ["t1"],
      });
    });

    it("should return {} for non-objects", () => {
      expect(sanitizeCoverage(null)).toEqual({});
      expect(sanitizeCoverage("x")).toEqual({});
      expect(sanitizeCoverage([["a", ["t1"]]])).toEqual({});
    });
  });
});
