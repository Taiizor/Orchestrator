import { describe, it, expect } from "bun:test";
import { validateRoadmap, formatValidation } from "../orchestrator/roadmap_validator.ts";

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
});
