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
    const parseModelSpec = (input: string, fallback?: string) => 
      (OpenCodeClient as any).parseModelSpec(input, fallback);

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
});
