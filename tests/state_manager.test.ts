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
      const task = createMockTask("t1", "IN_PROGRESS");
      delete (task as any).updatedAt;
      const local = createMockRoadmap([task]);
      const remote = createMockRoadmap([createMockTask("t1", "COMPLETED", "2026-10-10T09:00:00Z")]);

      const merged = StateManager.mergeRoadmaps(local, remote);
      expect(merged.tasks[0].status).toBe("COMPLETED");
    });

    it("local COMPLETED globalStatus survives a stale IN_PROGRESS remote (finale regression)", () => {
      const local = createMockRoadmap([]);
      (local as any).globalStatus = "COMPLETED";
      const remote = createMockRoadmap([]);
      (remote as any).globalStatus = "IN_PROGRESS";

      expect(StateManager.mergeRoadmaps(local, remote).globalStatus).toBe("COMPLETED");
    });

    it("remote COMPLETED globalStatus is adopted by a stale local copy", () => {
      const local = createMockRoadmap([]);
      (local as any).globalStatus = "IN_PROGRESS";
      const remote = createMockRoadmap([]);
      (remote as any).globalStatus = "COMPLETED";

      expect(StateManager.mergeRoadmaps(local, remote).globalStatus).toBe("COMPLETED");
    });

    it("non-terminal globalStatus follows the local writer", () => {
      const local = createMockRoadmap([]);
      (local as any).globalStatus = "PAUSED";
      const remote = createMockRoadmap([]);
      (remote as any).globalStatus = "IN_PROGRESS";

      expect(StateManager.mergeRoadmaps(local, remote).globalStatus).toBe("PAUSED");
    });

    it("milestones union by title: locally-registered milestone survives a stale remote", () => {
      const local = createMockRoadmap([]);
      (local as any).milestones = [
        { title: "v1.0.0", description: "base" },
        { title: "v1.2.0 - Part 3B", description: "Added via ChatOps /add" },
      ];
      const remote = createMockRoadmap([]);
      (remote as any).milestones = [{ title: "v1.0.0", description: "base" }];

      const merged = StateManager.mergeRoadmaps(local, remote);
      expect((merged.milestones || []).map((m: any) => m.title)).toEqual(["v1.0.0", "v1.2.0 - Part 3B"]);
    });

    it("milestones stay undefined when both sides lack them", () => {
      const merged = StateManager.mergeRoadmaps(createMockRoadmap([]), createMockRoadmap([]));
      expect(merged.milestones).toBeUndefined();
    });

    it("preserves linkage fields across writers (no double dispatch / orphan issues)", () => {
      const lt = createMockTask("t1", "IN_PROGRESS", "2026-10-10T10:00:00Z");
      (lt as any).dispatchedAt = "2026-10-10T10:00:00Z";
      (lt as any).runId = 111;
      const rt = createMockTask("t1", "IN_PROGRESS", "2026-10-10T09:00:00Z");
      (rt as any).issueNumber = 5;
      (rt as any).issueUrl = "https://x/5";
      const local = createMockRoadmap([lt]);
      const remote = createMockRoadmap([rt]);

      const m = StateManager.mergeRoadmaps(local, remote).tasks[0] as any;
      expect(m.dispatchedAt).toBe("2026-10-10T10:00:00Z");
      expect(m.runId).toBe(111);
      expect(m.issueNumber).toBe(5);
      expect(m.issueUrl).toBe("https://x/5");
    });

    it("renames same-ID different-content tasks instead of dropping one", () => {
      const lt = createMockTask("TASK-9", "PENDING", "2026-10-10T10:00:00Z");
      (lt as any).createdAt = "2026-10-10T10:00:00Z";
      (lt as any).title = "Local thing";
      (lt as any).description = "local content";
      const rt = createMockTask("TASK-9", "PENDING", "2026-10-10T09:00:00Z");
      (rt as any).createdAt = "2026-10-10T09:00:00Z";
      (rt as any).title = "Different thing";
      (rt as any).description = "remote content";
      const merged = StateManager.mergeRoadmaps(createMockRoadmap([lt]), createMockRoadmap([rt]));
      const ids = merged.tasks.map((t) => t.id);
      expect(new Set(ids).size).toBe(2);
      expect(ids).toContain("TASK-9");
    });

    it("unions consumedServiceRequests and keeps max board sync time", () => {
      const local = createMockRoadmap([]);
      (local as any).consumedServiceRequests = ["a", "b"];
      (local as any).lastBoardSyncAt = "2026-10-10T10:00:00Z";
      const remote = createMockRoadmap([]);
      (remote as any).consumedServiceRequests = ["b", "c"];
      (remote as any).lastBoardSyncAt = "2026-10-10T09:00:00Z";
      const m = StateManager.mergeRoadmaps(local, remote) as any;
      expect(m.consumedServiceRequests.sort()).toEqual(["a", "b", "c"]);
      expect(m.lastBoardSyncAt).toBe("2026-10-10T10:00:00Z");
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
