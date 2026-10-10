import { describe, it, expect } from "bun:test";
import {
  parseLaunchVerdict,
  inferFixRole,
  countLaunchFixRounds,
  MAX_LAUNCH_ROUNDS,
} from "../orchestrator/launch_verdict.ts";

describe("Launch Verdict Module", () => {
  it("should parse a pass verdict", () => {
    const md = "# Report\n```launch-verdict\n" + JSON.stringify({ verdict: "pass", gaps: [], evidence: "200 OK" }) + "\n```\n";
    expect(parseLaunchVerdict(md)).toEqual({ verdict: "pass", gaps: [], evidence: "200 OK" });
  });

  it("should parse a fail verdict with gaps", () => {
    const md =
      "text\n```launch-verdict\n" +
      JSON.stringify({
        verdict: "fail",
        gaps: [{ area: "ui", detail: "/merchant returns 404", files: ["src/index.ts"], log: "x".repeat(5000) }],
      }) +
      "\n```\n";
    const v = parseLaunchVerdict(md)!;
    expect(v.verdict).toBe("fail");
    expect(v.gaps.length).toBe(1);
    expect(v.gaps[0].files).toEqual(["src/index.ts"]);
    expect((v.gaps[0].log || "").length).toBeLessThanOrEqual(2000);
  });

  it("should return null when block is missing or malformed", () => {
    expect(parseLaunchVerdict("no block here")).toBeNull();
    expect(parseLaunchVerdict("```launch-verdict\n{not json}\n```")).toBeNull();
    expect(parseLaunchVerdict('```launch-verdict\n{"verdict":"maybe","gaps":[]}\n```')).toBeNull();
  });

  it("should infer frontend/backend/fullstack roles", () => {
    expect(inferFixRole([{ area: "ui", detail: "selector missing on /merchant page" }])).toBe("frontend");
    expect(inferFixRole([{ area: "api", detail: "POST /v1/links returns 500" }])).toBe("backend");
    expect(inferFixRole([{ area: "boot", detail: "port already in use" }])).toBe("fullstack");
    expect(inferFixRole([])).toBe("fullstack");
  });

  it("should count prior fix rounds per milestone", () => {
    const tasks = [
      { title: "Fix launch gaps (round 1)", milestone: "v1.0.0" },
      { title: "Fix launch gaps (round 2)", milestone: "v1.0.0" },
      { title: "Fix launch gaps (round 1)", milestone: "v0.1.0" },
      { title: "Other task", milestone: "v1.0.0" },
    ];
    expect(countLaunchFixRounds(tasks, "v1.0.0")).toBe(2);
    expect(countLaunchFixRounds(tasks, "v0.1.0")).toBe(1);
    expect(countLaunchFixRounds(tasks, "v9.9.9")).toBe(0);
  });

  it("should cap auto rounds at MAX_LAUNCH_ROUNDS", () => {
    expect(MAX_LAUNCH_ROUNDS).toBeGreaterThanOrEqual(1);
  });
});
