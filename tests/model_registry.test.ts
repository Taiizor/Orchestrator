import { describe, it, expect } from "bun:test";
import { parseModelRegistry, contextWindowsOf, effectiveContextWindows } from "../orchestrator/model_registry.ts";

const PAYLOAD = {
  location: { directory: "/repo" },
  data: [
    {
      id: "minimax-m3.1-flash-free",
      modelID: "minimax-m3.1-flash-free",
      providerID: "opencode",
      name: "MiniMax M3.1 Flash Free",
      variants: [{ id: "low" }, { id: "max" }],
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      enabled: true,
      limit: { context: 1000000, output: 512000 },
    },
    {
      id: "deepseek-v4.1-flash-free",
      modelID: "deepseek-v4.1-flash-free",
      providerID: "opencode",
      name: "DeepSeek V4.1 Flash Free",
      cost: [{ input: 0, output: 0 }],
      enabled: false,
      limit: { context: 200000, output: 32000 },
    },
    {
      id: "gpt-5.5",
      modelID: "gpt-5.5",
      providerID: "opencode",
      name: "GPT-5.5",
      cost: [{ input: 1.5, output: 6 }],
      enabled: true,
      limit: { context: 400000, output: 128000 },
    },
  ],
};

describe("Model registry", () => {
  describe("parseModelRegistry", () => {
    it("parses the CLI's {location, data} envelope", () => {
      const models = parseModelRegistry(JSON.stringify(PAYLOAD));
      expect(models.length).toBe(3);
      expect(models[0].id).toBe("opencode/minimax-m3.1-flash-free");
      expect(models[0].context).toBe(1_000_000);
      expect(models[0].output).toBe(512_000);
      expect(models[0].variants).toEqual(["low", "max"]);
      expect(models[0].free).toBe(true);
      expect(models[0].enabled).toBe(true);
    });

    it("parses a bare array payload", () => {
      const models = parseModelRegistry(JSON.stringify(PAYLOAD.data));
      expect(models.length).toBe(3);
    });

    it("marks paid models as not free and disabled models as disabled", () => {
      const models = parseModelRegistry(JSON.stringify(PAYLOAD));
      expect(models[1].enabled).toBe(false);
      expect(models[2].free).toBe(false);
    });

    it("returns an empty list for unparsable or unexpected payloads", () => {
      expect(parseModelRegistry("not json")).toEqual([]);
      expect(parseModelRegistry("{}")).toEqual([]);
      expect(parseModelRegistry("")).toEqual([]);
    });

    it("skips entries without provider or model id", () => {
      const models = parseModelRegistry(JSON.stringify({ data: [{ name: "nameless" }, null, 42] }));
      expect(models).toEqual([]);
    });
  });

  describe("contextWindowsOf", () => {
    it("maps context windows by fully qualified id", () => {
      const windows = contextWindowsOf(parseModelRegistry(JSON.stringify(PAYLOAD)));
      expect(windows.get("opencode/minimax-m3.1-flash-free")).toBe(1_000_000);
      expect(windows.get("opencode/deepseek-v4.1-flash-free")).toBe(200_000);
    });

    it("drops entries without a usable window", () => {
      const windows = contextWindowsOf(parseModelRegistry(JSON.stringify({ data: [{ providerID: "p", modelID: "m" }] })));
      expect(windows.size).toBe(0);
    });
  });

  describe("effectiveContextWindows", () => {
    it("prefers the live registry over the static table", () => {
      const live = parseModelRegistry(
        JSON.stringify({
          data: [{ providerID: "opencode", modelID: "deepseek-v4.1-flash-free", limit: { context: 262144, output: 32000 } }],
        })
      );
      const windows = effectiveContextWindows(live);
      expect(windows.get("opencode/deepseek-v4.1-flash-free")).toBe(262144);
    });

    it("keeps the static table for models the registry does not report", () => {
      const windows = effectiveContextWindows([]);
      // Static fallback still covers the roster when the CLI is unreachable.
      expect(windows.get("opencode/minimax-m3.1-flash-free")).toBe(1_000_000);
      expect(windows.get("opencode/longcat-2.5-preview-free")).toBe(1_000_000);
    });
  });
});
