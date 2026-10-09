import { describe, it, expect } from "bun:test";
import { StateManager } from "../orchestrator/state_manager.ts";
import type { Roadmap, TaskItem } from "../orchestrator/types.ts";

describe("State Manager Module", () => {
  const createMockTask = (id: string, status: string, updatedAt?: string, dependencies: string[] = []): TaskItem => ({
    id,
    title: `Task ${id}`,
    role: "backend",
    branch: `task/${id}`,
    status: status as any,
    targetFiles: [],
    dependencies,
    attempts: 0,
    updatedAt: updatedAt || new Date().toISOString(),
  });

  const createMockRoadmap = (tasks: TaskItem[]): Roadmap => ({
    projectName: "Test",
    globalStatus: "ACTIVE",
    updatedAt: new Date().toISOString(),
    tasks,
  });

  describe("getReadyTasks", () => {
    it("should return PENDING tasks with COMPLETED dependencies", () => {
      const roadmap = createMockRoadmap([
        createMockTask("t1", "COMPLETED"),
        createMockTask("t2", "PENDING", undefined, ["t1"]),
        createMockTask("t3", "PENDING", undefined, ["t99"]), // dep not met
      ]);
      const ready = StateManager.getReadyTasks(roadmap, 5);
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe("t2");
    });

    it("should respect maxCount considering IN_PROGRESS tasks", () => {
      const roadmap = createMockRoadmap([
        createMockTask("t1", "IN_PROGRESS"),
        createMockTask("t2", "PENDING"),
        createMockTask("t3", "PENDING"),
      ]);
      const ready = StateManager.getReadyTasks(roadmap, 2);
      // maxCount is 2, 1 is IN_PROGRESS, so 1 slot available
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe("t2");
    });

    it("should exclude non-PENDING tasks", () => {
      const roadmap = createMockRoadmap([
        createMockTask("t1", "FAILED"),
        createMockTask("t2", "COMPLETED"),
      ]);
      const ready = StateManager.getReadyTasks(roadmap, 5);
      expect(ready.length).toBe(0);
    });
  });

  describe("mergeRoadmaps", () => {
    it("terminal state (COMPLETED) wins over older non-terminal", () => {
      const local = createMockRoadmap([createMockTask("t1", "IN_PROGRESS", "2026-10-10T09:00:00Z")]);
      const remote = createMockRoadmap([createMockTask("t1", "COMPLETED", "2026-10-10T10:00:00Z")]);
      
      const merged = StateManager.mergeRoadmaps(local, remote);
      expect(merged.tasks[0].status).toBe("COMPLETED");
    });

    it("both terminal: newer updatedAt wins (local vs remote)", () => {
      const local = createMockRoadmap([createMockTask("t1", "FAILED", "2026-10-10T10:00:00Z")]);
      const remote = createMockRoadmap([createMockTask("t1", "COMPLETED", "2026-10-10T09:00:00Z")]);
      
      const merged = StateManager.mergeRoadmaps(local, remote);
      expect(merged.tasks[0].status).toBe("FAILED");
    });

    it("newer non-terminal (resurrection) overrides older terminal", () => {
      const local = createMockRoadmap([createMockTask("t1", "PENDING", "2026-10-10T10:00:00Z")]);
      const remote = createMockRoadmap([createMockTask("t1", "FAILED", "2026-10-10T09:00:00Z")]);
      
      const merged = StateManager.mergeRoadmaps(local, remote);
      expect(merged.tasks[0].status).toBe("PENDING");
    });

    it("tasks only in local or remote are preserved", () => {
      const local = createMockRoadmap([createMockTask("t1", "PENDING")]);
      const remote = createMockRoadmap([createMockTask("t2", "COMPLETED")]);
      
      const merged = StateManager.mergeRoadmaps(local, remote);
      expect(merged.tasks.length).toBe(2);
      expect(merged.tasks.map(t => t.id).sort()).toEqual(["t1", "t2"]);
    });

    it("handles undefined updatedAt causing NaN Date.parse", () => {
      const local = createMockRoadmap([createMockTask("t1", "IN_PROGRESS", undefined)]);
      const remote = createMockRoadmap([createMockTask("t1", "COMPLETED", "2026-10-10T09:00:00Z")]);
      
      const merged = StateManager.mergeRoadmaps(local, remote);
      expect(merged.tasks[0].status).toBe("COMPLETED");
    });
  });

  describe("renderProgressMarkdown", () => {
    it("produces valid markdown including task counts", () => {
      const roadmap = createMockRoadmap([
        createMockTask("t1", "COMPLETED"),
        createMockTask("t2", "PENDING"),
      ]);
      const md = StateManager.renderProgressMarkdown(roadmap);
      expect(md).toContain("1 / 2 tasks");
      expect(md).toContain("1 pending");
      expect(md).toContain("| ID | Title | Role | Status | Branch | Dependencies | Notes |");
    });

    it("redact mode hides titles and branches", () => {
      const roadmap = createMockRoadmap([
        createMockTask("t1", "COMPLETED"),
      ]);
      const md = StateManager.renderProgressMarkdown(roadmap, { redact: true });
      expect(md).not.toContain("Title");
      expect(md).not.toContain("Branch");
      expect(md).toContain("| ID | Role | Status | Dependencies |");
    });
  });
});
