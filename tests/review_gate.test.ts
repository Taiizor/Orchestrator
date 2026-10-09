import { describe, it, expect } from "bun:test";
import {
  hasStructuredProgress,
  missingSections,
  isDefaultProgress,
  globMatches,
  scanSecrets,
  scanSecretWarnings,
  GATE_VERSION
} from "../orchestrator/review_gate.ts";

describe("Review Gate Module", () => {
  describe("hasStructuredProgress", () => {
    it("should return true when all sections are present", () => {
      const content = "## Done\nstuff\n## Doing\nstuff\n## Todo\nstuff\n## Verification\nstuff";
      expect(hasStructuredProgress(content)).toBe(true);
    });

    it("should return false if any section is missing", () => {
      const content = "## Done\nstuff\n## Doing\nstuff\n## Todo\nstuff";
      expect(hasStructuredProgress(content)).toBe(false);
    });
  });

  describe("missingSections", () => {
    it("should return empty array when all sections exist", () => {
      const content = "done doing todo verification";
      expect(missingSections(content)).toEqual([]);
    });

    it("should return missing section names", () => {
      const content = "done and doing";
      expect(missingSections(content)).toEqual(["todo", "verification"]);
    });
  });

  describe("isDefaultProgress", () => {
    it("should return true for runner placeholder text", () => {
      expect(isDefaultProgress("Some text Executed task deliverables in workspace here")).toBe(true);
      expect(isDefaultProgress("Submitting for orchestrator review")).toBe(true);
    });

    it("should return false for genuine agent report", () => {
      expect(isDefaultProgress("Added login page")).toBe(false);
    });
  });

  describe("globMatches", () => {
    it("should match exact file", () => {
      expect(globMatches("src/index.ts", "src/index.ts")).toBe(true);
      expect(globMatches("src/index.ts", "src/utils.ts")).toBe(false);
    });

    it("should match directory prefix with trailing slash", () => {
      expect(globMatches("src/", "src/index.ts")).toBe(true);
      expect(globMatches("src/", "tests/index.ts")).toBe(false);
    });

    it("should match * wildcard", () => {
      expect(globMatches("src/*", "src/index.ts")).toBe(true);
      expect(globMatches("src/*", "src/components/button.ts")).toBe(false);
    });

    it("should match ** recursive wildcard", () => {
      expect(globMatches("src/**", "src/components/button.ts")).toBe(true);
      expect(globMatches("src/**", "src/index.ts")).toBe(true);
      expect(globMatches("src/**", "tests/index.ts")).toBe(false);
    });

    it("should match dot or ./", () => {
      expect(globMatches(".", "src/index.ts")).toBe(true);
      expect(globMatches("./", "package.json")).toBe(true);
    });
  });

  describe("scanSecrets", () => {
    const files = ["workspace/src/app.ts"];

    it("should detect AWS keys", () => {
      const diff = "+ const aws = 'AKIA1234567890123456';";
      expect(scanSecrets(diff, files)).toContain("AWS access key");
    });

    it("should detect GitHub PATs", () => {
      const diff1 = "+ const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';";
      expect(scanSecrets(diff1, files)).toContain("GitHub PAT");
      const diff2 = "+ const token = 'github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLM';";
      expect(scanSecrets(diff2, files)).toContain("GitHub PAT");
    });

    it("should detect OpenAI and Anthropic API keys", () => {
      const diff1 = "+ const key = 'sk-1234567890abcdef1234567890abcdef12';";
      expect(scanSecrets(diff1, files)).toContain("OpenAI API key");
      const diff2 = "+ const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';";
      expect(scanSecrets(diff2, files)).toContain("Anthropic API key");
    });

    it("should detect generic secrets with real-looking values", () => {
      const diff = "+++ b/workspace/src/app.ts\n+ const API_KEY = 'real_secret_value_here';";
      expect(scanSecrets(diff, files)).toContain("Generic secret assignment");
    });

    it("should ignore placeholder generic secrets", () => {
      const diff = "+ const API_KEY = 'your_api_key_here';";
      expect(scanSecrets(diff, files)).not.toContain("Generic secret assignment");
    });

    it("should ignore generic secrets in test files", () => {
      const diff = "+++ b/workspace/tests/app.test.ts\n+ const secret = 'real_secret_value_here';";
      expect(scanSecrets(diff, ["workspace/tests/app.test.ts"])).not.toContain("Generic secret assignment");
    });

    it("should flag sensitive filenames and avoid false positives", () => {
      expect(scanSecrets("", [".env"])).toContain("Sensitive file (.env/.pem/.key) in changeset");
      expect(scanSecrets("", ["src/cert.pem"])).toContain("Sensitive file (.env/.pem/.key) in changeset");
      expect(scanSecrets("", ["src/server.key"])).toContain("Sensitive file (.env/.pem/.key) in changeset");
      expect(scanSecrets("", ["src/sort.key.ts"])).not.toContain("Sensitive file (.env/.pem/.key) in changeset");
    });

    it("should allow .env.example", () => {
      expect(scanSecrets("", [".env.example"])).not.toContain("Sensitive file (.env/.pem/.key) in changeset");
    });
  });

  describe("scanSecretWarnings", () => {
    it("should generate warnings for placeholder secrets", () => {
      const diff = "+ const API_KEY = 'example_key';";
      const warnings = scanSecretWarnings(diff);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("Placeholder secret-style assignment");
    });
  });

  describe("GATE_VERSION", () => {
    it("should be a number", () => {
      expect(typeof GATE_VERSION).toBe("number");
      expect(GATE_VERSION).toBeGreaterThan(0);
    });
  });
});
