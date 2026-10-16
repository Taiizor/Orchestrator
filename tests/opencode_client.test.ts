import { describe, it, expect } from "bun:test";
import { OpenCodeClient } from "../orchestrator/opencode_client.ts";

describe("OpenCode Client Module", () => {
  describe("extractText", () => {
    it("should handle valid JSON event stream with part field", () => {
      const stream = `{"type": "part", "part": {"text": "hello"}}\n{"type": "part", "part": {"text": " world"}}`;
      expect(OpenCodeClient.extractText(stream)).toBe("hello world");
    });

    it("should handle valid JSON event stream with delta field", () => {
      const stream = `{"type": "delta", "delta": "hello"}\n{"type": "delta", "delta": " world"}`;
      expect(OpenCodeClient.extractText(stream)).toBe("hello world");
    });

    it("should handle array content blocks with text fields", () => {
      const stream = `{"type": "message", "content": [{"text": "hello "}, {"text": "world"}]}`;
      expect(OpenCodeClient.extractText(stream)).toBe("hello world");
    });

    it("should handle mixed JSON and non-JSON lines", () => {
      const stream = `Some random debug log\n{"type": "text", "text": "parsed"}\nMore logs`;
      // 'Some random debug log' doesn't start with '{', so it's ignored.
      // 'More logs' also ignored.
      expect(OpenCodeClient.extractText(stream)).toBe("parsed");
    });

    it("should return empty string for empty input", () => {
      expect(OpenCodeClient.extractText("")).toBe("");
      expect(OpenCodeClient.extractText("   \n  ")).toBe("");
    });

    it("should fallback to raw stdout for non-JSON input", () => {
      const plain = "Just plain text output from model";
      expect(OpenCodeClient.extractText(plain)).toBe("Just plain text output from model");
    });
  });

  describe("parseModelSpec (private)", () => {
    // Access private method for testing pure logic
    const parseModelSpec = (input: string, fallback?: string) => (OpenCodeClient as any).parseModelSpec(input, fallback);

    it("should parse 'provider/model' without variant", () => {
      expect(parseModelSpec("provider/model")).toEqual({ model: "provider/model" });
    });

    it("should parse 'provider/model#variant' and extract variant", () => {
      expect(parseModelSpec("provider/model#variant")).toEqual({ model: "provider/model", variant: "variant" });
    });

    it("should handle model only (no slash)", () => {
      expect(parseModelSpec("model")).toEqual({ model: "model" });
    });

    it("should apply fallbackVariant parameter when no # is present", () => {
      expect(parseModelSpec("provider/model", "high")).toEqual({ model: "provider/model", variant: "high" });
    });

    it("should parse empty string input", () => {
      expect(parseModelSpec("")).toEqual({ model: "" });
    });
  });

  describe("runStreaming (private)", () => {
    // Access private method for testing live-spawn behavior (bun -e works
    // on every OS the suite runs on).
    const runStreaming = (
      cmd: string[],
      input: string | undefined,
      timeoutMs: number,
      label: string,
      digestMs = 60_000,
      quotaIdleMs = 120_000
    ) => (OpenCodeClient as any).runStreaming(cmd, input, timeoutMs, label, digestMs, quotaIdleMs);

    it("should capture stdout and exit code of a fast command", async () => {
      const res = await runStreaming(["bun", "-e", "console.log('hi-stream')"], undefined, 10_000, "test");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("hi-stream");
    });

    it("should kill on timeout with exit 124 and a marker", async () => {
      const started = Date.now();
      const res = await runStreaming(["bun", "-e", "setTimeout(()=>console.log('late'),30000)"], undefined, 1_500, "test");
      expect(res.exitCode).toBe(124);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(res.stderr).toContain("TIMEOUT after 1500ms");
    });

    it("should abort a quota-signalled stall after the idle threshold", async () => {
      const started = Date.now();
      const res = await runStreaming(
        ["bun", "-e", "console.log('rate limit exceeded');setTimeout(()=>{},30000)"],
        undefined,
        25_000,
        "test",
        500,
        1_500
      );
      expect(res.exitCode).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(`${res.stdout} ${res.stderr}`).toContain("rate limit exceeded");
    });

    it("should NOT kill on innocent quota-adjacent chatter while work continues", async () => {
      // Prints the bare word "quota", keeps emitting, exits cleanly: the old
      // broad matcher killed runs like this half a second in.
      const started = Date.now();
      const res = await runStreaming(
        [
          "bun",
          "-e",
          "console.log('quota info');let i=0;const t=setInterval(()=>{console.log('tick'+(++i));if(i>=3){clearInterval(t);}} ,1000)",
        ],
        undefined,
        15_000,
        "test",
        500,
        1_500
      );
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("tick3");
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
    });
  });

  describe("session helpers", () => {
    it("extractSessionId finds the first non-empty id", () => {
      const raw = `{"type":"step_start","timestamp":1,"sessionID":"ses_abc123"}\n{"type":"text","text":"hi"}`;
      expect(OpenCodeClient.extractSessionId(raw)).toBe("ses_abc123");
    });

    it("extractSessionId ignores empty ids and plain text", () => {
      expect(OpenCodeClient.extractSessionId(`{"type":"error","sessionID":""}`)).toBeUndefined();
      expect(OpenCodeClient.extractSessionId("no json here")).toBeUndefined();
    });

    it("extractErrorDetail returns the first error message", () => {
      const raw = `{"type":"step_start","timestamp":1}\n{"type":"error","timestamp":2,"sessionID":"s","error":{"type":"auth","message":"provider logged out"}}`;
      expect(OpenCodeClient.extractErrorDetail(raw)).toBe("provider logged out");
    });

    it("extractErrorDetail is undefined without error events", () => {
      expect(OpenCodeClient.extractErrorDetail(`{"type":"text","text":"ok"}`)).toBeUndefined();
    });

    it("extractUsage sums cost/tokens/steps over step_finish events", () => {
      const raw = [
        `{"type":"step_finish","timestamp":1,"sessionID":"s","part":{"cost":0.5,"tokens":100}}`,
        `{"type":"step_finish","timestamp":2,"sessionID":"s","part":{"cost":1.5,"tokens":200}}`,
        `{"type":"text","text":"hi"}`,
      ].join("\n");
      expect(OpenCodeClient.extractUsage(raw)).toEqual({ cost: 2, tokens: 300, steps: 2 });
    });

    it("extractUsage is zeroed without step events", () => {
      expect(OpenCodeClient.extractUsage("nothing")).toEqual({ cost: 0, tokens: 0, steps: 0 });
    });

    it("toolEventName reads tool names, ignores other lines", () => {
      expect(OpenCodeClient.toolEventName(`{"type":"tool_use","timestamp":1,"sessionID":"s","part":{"name":"edit"}}`)).toBe(
        "edit"
      );
      expect(OpenCodeClient.toolEventName(`{"type":"text","text":"hi"}`)).toBeUndefined();
      expect(OpenCodeClient.toolEventName("not json")).toBeUndefined();
    });

    it("buildCommand appends --session only when given", () => {
      const withSid = (OpenCodeClient as any).buildCommand({ model: "a/b" }, undefined, "ses_1");
      expect(withSid).toEqual(["opencode", "run", "--model", "a/b", "--format", "json", "--session", "ses_1"]);
      const without = (OpenCodeClient as any).buildCommand({ model: "a/b" });
      expect(without).not.toContain("--session");
    });

    it("buildCommand appends --agent and --title only when given", () => {
      const full = (OpenCodeClient as any).buildCommand({ model: "a/b" }, ["f.png"], undefined, {
        agent: "build",
        title: "[TASK-1] t",
      });
      expect(full).toEqual([
        "opencode",
        "run",
        "--model",
        "a/b",
        "--format",
        "json",
        "--file",
        "f.png",
        "--agent",
        "build",
        "--title",
        "[TASK-1] t",
      ]);
      const bare = (OpenCodeClient as any).buildCommand({ model: "a/b" }, undefined, undefined, {});
      expect(bare).not.toContain("--agent");
      expect(bare).not.toContain("--title");
    });

    it("buildCommand appends --fork only with a session that forks", () => {
      const forked = (OpenCodeClient as any).buildCommand({ model: "a/b" }, undefined, "ses_1", { fork: true });
      expect(forked).toEqual(["opencode", "run", "--model", "a/b", "--format", "json", "--session", "ses_1", "--fork"]);
      const noFork = (OpenCodeClient as any).buildCommand({ model: "a/b" }, undefined, "ses_1", { fork: false });
      expect(noFork).not.toContain("--fork");
      const noSession = (OpenCodeClient as any).buildCommand({ model: "a/b" }, undefined, undefined, { fork: true });
      expect(noSession).not.toContain("--fork");
      expect(noSession).not.toContain("--session");
    });

    it("filterAttachableFiles keeps small files, skips >10MiB", async () => {
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = join(tmpdir(), `opencode-attach-test-${process.pid}-${Date.now()}`);
      await Bun.$`mkdir -p ${dir}`.quiet();
      await Bun.write(join(dir, "small.txt"), "hello");
      const big = Buffer.alloc(11 * 1024 * 1024, 0);
      await Bun.write(join(dir, "big.bin"), big);
      const { kept, skipped } = await OpenCodeClient.filterAttachableFiles([join(dir, "small.txt"), join(dir, "big.bin")]);
      expect(kept).toEqual([join(dir, "small.txt")]);
      expect(skipped.length).toBe(1);
      expect(skipped[0].path).toBe(join(dir, "big.bin"));
      await Bun.$`rm -rf ${dir}`.quiet();
    });

    it("filterAttachableFiles keeps missing files (CLI reports those)", async () => {
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const missing = join(tmpdir(), `opencode-nope-${Date.now()}`, "missing.txt");
      const { kept, skipped } = await OpenCodeClient.filterAttachableFiles([missing]);
      expect(kept).toEqual([missing]);
      expect(skipped).toEqual([]);
    });

    it("parseSessionListId reads array, object, and raw-id shapes", () => {
      expect(OpenCodeClient.parseSessionListId(JSON.stringify([{ id: "ses_aaa", title: "t" }, { id: "ses_bbb" }]))).toBe(
        "ses_aaa"
      );
      expect(OpenCodeClient.parseSessionListId(JSON.stringify({ sessions: [{ sessionID: "ses_ccc" }] }))).toBe("ses_ccc");
      expect(OpenCodeClient.parseSessionListId(`{"id": "ses_ddd"}`)).toBe("ses_ddd");
      expect(OpenCodeClient.parseSessionListId("[]")).toBeUndefined();
      expect(OpenCodeClient.parseSessionListId("not json at all")).toBeUndefined();
      expect(OpenCodeClient.parseSessionListId("")).toBeUndefined();
    });
  });
});
