import { describe, it, expect } from "bun:test";
import { selectPrunableComments } from "../orchestrator/issue_manager.ts";
import type { PrunableComment } from "../orchestrator/issue_manager.ts";

describe("Dashboard Comment Pruning", () => {
  const H = 3600 * 1000;
  const NOW = Date.parse("2026-10-14T12:00:00Z");
  const old = new Date(NOW - 24 * H).toISOString();
  const recent = new Date(NOW - 15 * 60 * 1000).toISOString();
  const rocket = [{ content: "ROCKET", users: { totalCount: 1 } }];
  const mk = (over: Partial<PrunableComment> & { id: string }): PrunableComment => ({
    author: { login: "Taiizor" },
    body: "/tick",
    createdAt: old,
    reactionGroups: rocket,
    ...over,
  });
  const botAck = (body: string, over: Partial<PrunableComment> = {}): PrunableComment =>
    mk({ id: `IC_${Math.random()}`, author: { login: "github-actions[bot]" }, body, reactionGroups: [], ...over });

  it("AC1: keeps the trailing window immune", () => {
    const comments = Array.from({ length: 15 }, (_, i) => mk({ id: `IC_${i}` }));
    const out = selectPrunableComments(comments, { now: NOW });
    expect(out.length).toBe(5);
    expect(out.map((c) => c.id)).toEqual(["IC_0", "IC_1", "IC_2", "IC_3", "IC_4"]);
  });

  it("AC2: fresh processed comments are immune", () => {
    const out = selectPrunableComments(
      [...Array.from({ length: 11 }, (_, i) => mk({ id: `IC_old${i}` })), mk({ id: "IC_new", createdAt: recent })],
      { now: NOW, keepRecentCount: 0 }
    );
    expect(out.map((c) => c.id)).not.toContain("IC_new");
  });

  it("AC3: unprocessed commands are immune at any age", () => {
    const ancient = new Date(NOW - 48 * H).toISOString();
    const out = selectPrunableComments([mk({ id: "IC_x", createdAt: ancient, reactionGroups: [] })], {
      now: NOW,
      keepRecentCount: 0,
    });
    expect(out).toEqual([]);
  });

  it("AC4: caps deletions per cycle", () => {
    const comments = Array.from({ length: 100 }, (_, i) => mk({ id: `IC_${i}` }));
    const out = selectPrunableComments(comments, { now: NOW, keepRecentCount: 0, maxBatchSize: 10 });
    expect(out.length).toBe(10);
  });

  it("prunes disposable bot acks, keeps high-value content", () => {
    const tick = botAck("🔔 **Tick requested:** cycle dispatched.");
    const queued = botAck("➕ **Task [TASK-1] queued as PENDING.**");
    const answer = botAck("❓ **Answer:**\n\nForty-two.");
    const status = botAck("📊 **Current Status Report:**\n\nAll good.");
    const out = selectPrunableComments([tick, queued, answer, status], { now: NOW, keepRecentCount: 0 });
    expect(out.map((c) => c.body.slice(0, 12))).toEqual([tick.body.slice(0, 12), queued.body.slice(0, 12)]);
  });

  it("high-value wins over disposable on overlap", () => {
    const tricky = botAck("📊 **Current Status Report:** [FIX-ROUND: x] done.");
    const out = selectPrunableComments([tricky], { now: NOW, keepRecentCount: 0 });
    expect(out).toEqual([]);
  });

  it("high-value content is immune regardless of author login", () => {
    const machineUser = mk({
      id: "IC_m",
      author: { login: "soferity-orchestrator" },
      body: "📜 **Run log tail for [TASK-016]:**\n```\nlogs",
      reactionGroups: rocket,
    });
    const out = selectPrunableComments([machineUser], { now: NOW, keepRecentCount: 0 });
    expect(out).toEqual([]);
  });

  it("ignores unparsable entries fail-closed", () => {
    const bad = mk({ id: "IC_bad", createdAt: "not-a-date" });
    const noAuthor = { id: "IC_noa", body: "/tick", createdAt: old, reactionGroups: rocket } as PrunableComment;
    expect(selectPrunableComments([bad, noAuthor], { now: NOW, keepRecentCount: 0 }).map((c) => c.id)).toEqual(["IC_noa"]);
  });

  it("returns [] for empty input", () => {
    expect(selectPrunableComments([], { now: NOW })).toEqual([]);
  });
});
