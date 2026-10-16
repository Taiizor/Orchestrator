import { describe, it, expect } from "bun:test";
import {
  isLimited,
  noteApiResult,
  quotaFromPayload,
  resetQuotaForTests,
  cooldownRemainingSec,
} from "../orchestrator/gh_quota.ts";
import { ProjectManager } from "../orchestrator/project_manager.ts";
import { GitManager } from "../orchestrator/git_manager.ts";

describe("gh_quota", () => {
  it("opens a cooldown only on rate-limit evidence with failing exit", () => {
    resetQuotaForTests();
    expect(isLimited()).toBe(false);
    noteApiResult("some generic error", 1);
    expect(isLimited()).toBe(false);
    noteApiResult("all good", 0);
    expect(isLimited()).toBe(false);
    noteApiResult("API rate limit exceeded for installation ID 1", 1);
    expect(isLimited()).toBe(true);
    expect(cooldownRemainingSec()).toBeGreaterThan(0);
  });

  it("also triggers on 429 / quota / exceeded text", () => {
    resetQuotaForTests();
    noteApiResult("HTTP 429 too many requests", 1);
    expect(isLimited()).toBe(true);
    resetQuotaForTests();
    noteApiResult("quota exhausted, retry later", 1);
    expect(isLimited()).toBe(true);
  });

  it("parses rate_limit payloads without spawning gh", () => {
    const ok = quotaFromPayload({ resources: { core: { remaining: 4000, reset: 1 }, graphql: { remaining: 3900, reset: 1 } } });
    expect(ok.low).toBe(false);
    expect(ok.core).toBe(4000);
    const low = quotaFromPayload({ resources: { core: { remaining: 12, reset: 1 }, graphql: { remaining: 4000, reset: 1 } } });
    expect(low.low).toBe(true);
    const broken = quotaFromPayload({ nope: true });
    expect(broken.core).toBe(-1);
    expect(broken.low).toBe(false);
    resetQuotaForTests();
  });
});

describe("ensureTaskIssue with batched index", () => {
  it("trusts a matching index entry with zero gh calls", async () => {
    const calls: string[][] = [];
    const orig = GitManager.run;
    (GitManager as any).run = async (cmd: string[], ...rest: any[]) => {
      calls.push(cmd);
      return { stdout: "", stderr: "stubbed", exitCode: 1 };
    };
    try {
      const task: any = {
        id: "TASK-001",
        role: "backend",
        status: "PENDING",
        branch: "task/TASK-001-x",
        dependencies: [],
        targetFiles: ["workspace/a.ts"],
        issueNumber: 7,
        issueUrl: "https://github.com/o/r/issues/7",
      };
      const index = new Map([
        [7, { url: "https://github.com/o/r/issues/7", title: "[TASK-001] Thing", state: "OPEN", milestone: "v0.1.0" }],
      ]);
      await ProjectManager.ensureTaskIssue(task, "v0.1.0", index);
      expect(calls.length).toBe(0);
      expect(task.issueNumber).toBe(7);
    } finally {
      (GitManager as any).run = orig;
    }
  });

  it("adopts canonical issue from index titles without searching", async () => {
    const calls: string[][] = [];
    const orig = GitManager.run;
    (GitManager as any).run = async (cmd: string[], ...rest: any[]) => {
      calls.push(cmd);
      return { stdout: "", stderr: "stubbed", exitCode: 1 };
    };
    try {
      const task: any = {
        id: "TASK-002",
        role: "backend",
        status: "PENDING",
        branch: "task/TASK-002-y",
        dependencies: [],
        targetFiles: ["workspace/b.ts"],
      };
      const index = new Map([
        [9, { url: "https://github.com/o/r/issues/9", title: "[TASK-002] Other", state: "OPEN", milestone: "" }],
        [4, { url: "https://github.com/o/r/issues/4", title: "[TASK-002] Other", state: "CLOSED", milestone: "" }],
      ]);
      await ProjectManager.ensureTaskIssue(task, undefined, index);
      // Canonical = oldest (lowest number); CLOSED + non-COMPLETED triggers
      // exactly one reopen call, nothing else.
      expect(task.issueNumber).toBe(4);
      expect(calls.length).toBe(1);
      expect(calls[0].join(" ")).toContain("reopen");
    } finally {
      (GitManager as any).run = orig;
    }
  });
});
