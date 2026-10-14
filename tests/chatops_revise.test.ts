import { describe, it, expect } from "bun:test";
import { getReviseBlocker } from "../orchestrator/issue_manager.ts";

describe("getReviseBlocker", () => {
  it("rejects FAILED targets with a /retry pointer", () => {
    const msg = getReviseBlocker({ id: "TASK-003", role: "backend", status: "FAILED" });
    expect(msg).not.toBeNull();
    expect(msg!).toContain("FAILED");
    expect(msg!).toContain("/retry TASK-003");
    expect(msg!).toContain("COMPLETED");
  });
  it("rejects launch targets (role wins over status)", () => {
    const completed = getReviseBlocker({ id: "TASK-010", role: "launch", status: "COMPLETED" });
    expect(completed).not.toBeNull();
    expect(completed!).toContain("launch verification");
    const failed = getReviseBlocker({ id: "TASK-010", role: "launch", status: "FAILED" });
    expect(failed).not.toBeNull();
    expect(failed!).toContain("launch verification");
  });
  it("allows COMPLETED and PENDING non-launch targets", () => {
    expect(getReviseBlocker({ id: "TASK-002", role: "fullstack", status: "COMPLETED" })).toBeNull();
    expect(getReviseBlocker({ id: "TASK-004", role: "backend", status: "PENDING" })).toBeNull();
  });
});
