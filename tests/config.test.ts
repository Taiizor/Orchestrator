import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { CONFIG, validateConfig, isEngineEnabled } from "../orchestrator/config.ts";

describe("Config Module", () => {
  let originalConfig: any;

  beforeEach(() => {
    // Save original values to restore them later
    originalConfig = { ...CONFIG };
  });

  afterEach(() => {
    // Restore original values
    for (const key of Object.keys(originalConfig)) {
      (CONFIG as any)[key] = originalConfig[key];
    }
  });

  it("should have numeric default values for limits", () => {
    expect(typeof CONFIG.MAX_CONCURRENT_SUBAGENTS).toBe("number");
    expect(Number.isNaN(CONFIG.MAX_CONCURRENT_SUBAGENTS)).toBe(false);

    expect(typeof CONFIG.MAX_TASK_ATTEMPTS).toBe("number");
    expect(Number.isNaN(CONFIG.MAX_TASK_ATTEMPTS)).toBe(false);

    expect(typeof CONFIG.STALE_RUN_TIMEOUT_MINUTES).toBe("number");
    expect(Number.isNaN(CONFIG.STALE_RUN_TIMEOUT_MINUTES)).toBe(false);
  });

  it("should freeze CONFIG at compile time (readonly properties exist)", () => {
    // Just verifying some properties exist
    expect(CONFIG.BASE_BRANCH).toBeDefined();
    expect(CONFIG.STATE_DIR).toBe("state");
  });

  it("validateConfig should throw if MAX_CONCURRENT_SUBAGENTS <= 0", () => {
    (CONFIG as any).MAX_CONCURRENT_SUBAGENTS = 0;
    expect(() => validateConfig()).toThrow(/MAX_CONCURRENT_SUBAGENTS must be > 0/);

    (CONFIG as any).MAX_CONCURRENT_SUBAGENTS = -1;
    expect(() => validateConfig()).toThrow(/MAX_CONCURRENT_SUBAGENTS must be > 0/);
  });

  it("validateConfig should throw if MAX_TASK_ATTEMPTS <= 0", () => {
    (CONFIG as any).MAX_TASK_ATTEMPTS = 0;
    expect(() => validateConfig()).toThrow(/MAX_TASK_ATTEMPTS must be > 0/);
  });

  it("validateConfig should throw if STALE_RUN_TIMEOUT_MINUTES <= 0", () => {
    (CONFIG as any).STALE_RUN_TIMEOUT_MINUTES = -5;
    expect(() => validateConfig()).toThrow(/STALE_RUN_TIMEOUT_MINUTES must be > 0/);
  });

  it("validateConfig should warn if GITHUB_TOKEN is not set", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    (CONFIG as any).GITHUB_TOKEN = "";

    validateConfig();

    expect(warnSpy).toHaveBeenCalledWith("⚠️ GITHUB_TOKEN is not set — GitHub API calls will fail with 401/403.");
    warnSpy.mockRestore();
  });

  it("validateConfig should warn if DATA_REPO is set but DATA_PAT is empty", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    (CONFIG as any).DATA_REPO = "owner/repo";
    (CONFIG as any).DATA_PAT = "";

    validateConfig();

    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️ DATA_REPO is set but DATA_PAT is empty — dual-repo git operations will fail with auth errors."
    );
    warnSpy.mockRestore();
  });

  it("validateConfig should warn if PROJECT_TOKEN is not set", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    (CONFIG as any).PROJECT_TOKEN = "";

    validateConfig();

    expect(warnSpy).toHaveBeenCalledWith("⚠️ GH_PROJECT_TOKEN is not set — GitHub Projects v2 board sync will be skipped.");
    warnSpy.mockRestore();
  });

  describe("free model roster", () => {
    it("should give every free model a known context window", () => {
      // A roster entry without a window cannot be skipped after a context
      // rejection, and silently disables the narrow-candidate skip.
      const windows = CONFIG.FREE_MODEL_CONTEXT_WINDOWS;
      for (const entry of CONFIG.FREE_MODELS as (string | { model: string })[]) {
        const id = typeof entry === "string" ? entry : entry.model;
        expect(windows[id]).toBeDefined();
      }
    });

    it("should keep a wide-window rescue reachable after the primary", () => {
      // An oversized session must have somewhere to go: at least one later
      // model has to be at least as wide as the primary.
      const roster = CONFIG.FREE_MODELS as { model: string }[];
      const primaryWindow = CONFIG.FREE_MODEL_CONTEXT_WINDOWS[roster[0].model] ?? 0;
      const hasRescue = roster.slice(1).some((m) => (CONFIG.FREE_MODEL_CONTEXT_WINDOWS[m.model] ?? 0) >= primaryWindow);
      expect(hasRescue).toBe(true);
    });
  });

  describe("isEngineEnabled (ORCHESTRATOR_ENABLED kill switch)", () => {
    it("is ON when unset or empty", () => {
      (CONFIG as any).ORCHESTRATOR_ENABLED = "";
      expect(isEngineEnabled()).toBe(true);
    });
    it("is OFF for 0/false/no/off (any case, padded)", () => {
      for (const v of ["0", "false", "FALSE", "  off ", "No", "nO"]) {
        (CONFIG as any).ORCHESTRATOR_ENABLED = v;
        expect(isEngineEnabled()).toBe(false);
      }
    });
    it("is ON for anything else", () => {
      for (const v of ["1", "true", "yes", "on", "anything"]) {
        (CONFIG as any).ORCHESTRATOR_ENABLED = v;
        expect(isEngineEnabled()).toBe(true);
      }
    });
  });
});
