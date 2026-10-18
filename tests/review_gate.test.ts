import { describe, it, expect } from "bun:test";
import {
  hasStructuredProgress,
  missingSections,
  isDefaultProgress,
  globMatches,
  isAllowedFile,
  isGeneratedJunkPath,
  isTestPath,
  checkEvidenceStamp,
  scanSecrets,
  scanSecretWarnings,
  scanSqlInjection,
  scanFallbackLayers,
  scanDemoSmells,
  classifyGateFailure,
  priorFixRounds,
  GATE_VERSION,
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
    it("should return true for the fresh-file runner template", () => {
      const tpl =
        "# 📝 Task Progress: TASK-001 - x\n\n### 1. ✅ Done\n- Executed task deliverables in workspace\n\n" +
        "### 2. ⚡ Doing\n- Submitting for orchestrator review\n\n" +
        "### 3. 📋 Todo\n- Awaiting review and integration\n";
      expect(isDefaultProgress(tpl)).toBe(true);
    });

    it("should return true for the cumulative fallback section", () => {
      const tpl =
        "### 1. ✅ Done\n- Runner fallback entry: no agent-written section for TASK-064 was found in this cumulative file at publish time.\n\n" +
        "### 2. ⚡ Doing\n- Submitting for orchestrator review.\n\n" +
        "### 3. 📋 Todo\n- Awaiting review and integration.\n";
      expect(isDefaultProgress(tpl)).toBe(true);
    });

    it("should return false for real reports that quote a marker mid-sentence (TASK-057 regression)", () => {
      expect(isDefaultProgress("Some text Executed task deliverables in workspace here")).toBe(false);
      expect(isDefaultProgress("Submitting for orchestrator review")).toBe(false);
      expect(
        isDefaultProgress(
          "- Submitting for orchestrator review (attempt 2: placeholder replaced with this report; deliverables already committed on `task/TASK-057`)."
        )
      ).toBe(false);
    });

    it("should return false for genuine agent report", () => {
      expect(isDefaultProgress("### 1. ✅ Done\n- Added login page with tests\n")).toBe(false);
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
      expect(scanSecrets("", [".env"])).toContain("Sensitive file (.env/.pem/.key/credentials/secrets) in changeset");
      expect(scanSecrets("", ["src/cert.pem"])).toContain("Sensitive file (.env/.pem/.key/credentials/secrets) in changeset");
      expect(scanSecrets("", ["src/server.key"])).toContain("Sensitive file (.env/.pem/.key/credentials/secrets) in changeset");
      expect(scanSecrets("", ["src/sort.key.ts"])).not.toContain(
        "Sensitive file (.env/.pem/.key/credentials/secrets) in changeset"
      );
    });

    it("should allow .env.example", () => {
      expect(scanSecrets("", [".env.example"])).not.toContain("Sensitive file (.env/.pem/.key/credentials/secrets) in changeset");
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

  describe("checkEvidenceStamp", () => {
    it("passes stamped runner output", () => {
      expect(checkEvidenceStamp("[runner-executed] 'go test ./...' exit=0\ngo test ok")).toBe("ok");
    });
    it("fails unstamped pasted output", () => {
      expect(checkEvidenceStamp("go test ok\nall passing")).toBe("unstamped");
    });
    it("warns when no evidence at all", () => {
      expect(checkEvidenceStamp("did some work, trust me")).toBe("missing-evidence");
    });
  });

  describe("GATE_VERSION", () => {
    it("should be a number", () => {
      expect(typeof GATE_VERSION).toBe("number");
      expect(GATE_VERSION).toBeGreaterThan(0);
    });
    it("is 12 after the exact-bullet placeholder detector change", () => {
      expect(GATE_VERSION).toBe(12);
    });
  });

  describe("isGeneratedJunkPath", () => {
    it("flags dependency trees, build output, and runtime junk", () => {
      for (const f of [
        "workspace/node_modules/foo/index.js",
        "workspace/Son.Dash/vendor/aws/sdk.php",
        "workspace/Son.Front/.nuxt/app.config.mjs",
        "workspace/web/dist/bundle.js",
        "workspace/Son.Dash/storage/logs/laravel.log",
        "workspace/Son.Dash/storage/framework/views/x.php",
        "workspace/Son.Dash/bootstrap/cache/services.php",
        "workspace/Son.Dash/.phpunit.result.cache",
      ]) {
        expect(isGeneratedJunkPath(f)).toBe(true);
      }
    });
    it("keeps product code and about-adjacent names", () => {
      for (const f of [
        "workspace/src/api/handler.ts",
        "workspace/Son.Dash/app/Models/Anime.php",
        "workspace/docs/about.md",
        "workspace/outbox/worker.ts",
      ]) {
        expect(isGeneratedJunkPath(f)).toBe(false);
      }
    });
  });

  describe("classifyGateFailure", () => {
    it("routes empty diff, stamp, and secret failures", () => {
      expect(classifyGateFailure(["Empty diff: task branch has no changes vs develop."]).map((d) => d.kind)).toEqual([
        "empty-diff",
      ]);
      expect(
        classifyGateFailure(["Test evidence present but no [runner-executed] stamp: proof must come from elsewhere."]).map(
          (d) => d.kind
        )
      ).toEqual(["unstamped-proof"]);
      expect(classifyGateFailure(["Potential secret leak detected: Generic secret assignment."]).map((d) => d.kind)).toEqual([
        "secret",
      ]);
    });
    it("calls placeholder-only SQL hits an engine false positive", () => {
      const failures = [
        'Possible SQL injection (unparameterized query): Possible SQL concatenation in workspace/src/db.ts: const q = await db.query("SELECT * FROM t WHERE id=$1", [id]).',
      ];
      expect(classifyGateFailure(failures).map((d) => d.kind)).toEqual(["sql-false-positive"]);
    });
    it("leaves real concatenation to the normal reject path", () => {
      const failures = [
        'Possible SQL injection (unparameterized query): Possible SQL concatenation in workspace/src/db.ts: const q = "SELECT * FROM t WHERE id = " + id.',
      ];
      expect(classifyGateFailure(failures)).toEqual([]);
    });
    it("routes tests-only scope to test-scope with files", () => {
      const failures = ["Out-of-scope files modified (workspace/tests/a.test.ts, workspace/tests/b.test.ts). Allowed: x."];
      const [d] = classifyGateFailure(failures);
      expect(d.kind).toBe("test-scope");
      expect(d.files).toEqual(["workspace/tests/a.test.ts", "workspace/tests/b.test.ts"]);
    });
    it("routes junk-only scope to build-output vs vendor-junk", () => {
      const [b] = classifyGateFailure(["Out-of-scope files modified (workspace/web/dist/a.js). Allowed: x."]);
      expect(b.kind).toBe("build-output");
      const [v] = classifyGateFailure(["Out-of-scope files modified (workspace/Son.Dash/vendor/a.php). Allowed: x."]);
      expect(v.kind).toBe("vendor-junk");
    });
    it("prefers the full gate file list over truncated messages", () => {
      const failures = ["Out-of-scope files modified (workspace/web/dist/a.js, +1 more). Allowed: x."];
      const [d] = classifyGateFailure(failures, { outOfScope: ["workspace/web/dist/a.js", "workspace/src/api/h.ts"] });
      expect(d.kind).toBe("unknown");
    });
    it("treats truncated message lists as unknown", () => {
      const [d] = classifyGateFailure(["Out-of-scope files modified (workspace/web/dist/a.js, +2 more). Allowed: x."]);
      expect(d.kind).toBe("unknown");
    });
    it("routes mixed scope to unknown", () => {
      const [d] = classifyGateFailure([
        "Out-of-scope files modified (workspace/web/dist/a.js, workspace/src/api/h.ts). Allowed: x.",
      ]);
      expect(d.kind).toBe("unknown");
    });
    it("returns [] for unrecognized failures (normal reject path)", () => {
      expect(classifyGateFailure(["TASK_PROGRESS.md missing sections: doing."])).toEqual([]);
    });
  });

  describe("priorFixRounds", () => {
    it("extracts recorded fix-round kinds", () => {
      expect(priorFixRounds("[FIX-ROUND: build-output] did x\n[FIX-ROUND: test-scope] did y")).toEqual([
        "build-output",
        "test-scope",
      ]);
    });
    it("is empty without markers", () => {
      expect(priorFixRounds("plain notes")).toEqual([]);
      expect(priorFixRounds(undefined)).toEqual([]);
    });
  });

  describe("content scans", () => {
    const h = (f: string) => `+++ b/${f}`;
    it("flags SQL concatenation outside tests", () => {
      const diff = `${h("workspace/api/db.ts")}\n+const q = "SELECT * FROM t WHERE id=" + id;`;
      expect(scanSqlInjection(diff).length).toBeGreaterThan(0);
      const param = `${h("workspace/api/db.ts")}\n+const q = await db.query("SELECT * FROM t WHERE id=$1", [id]);`;
      expect(scanSqlInjection(param)).toEqual([]);
      const test = `${h("workspace/api/db.test.ts")}\n+const q = "SELECT x" + y;`;
      expect(scanSqlInjection(test)).toEqual([]);
    });
    it("flags embedded fallback layers outside tests", () => {
      const diff = `${h("workspace/src/db.ts")}\n+import Database from "better-sqlite3";`;
      expect(scanFallbackLayers(diff).length).toBeGreaterThan(0);
      const mem = `${h("workspace/api/s.ts")}\n+const db = new Database(':memory:');`;
      expect(scanFallbackLayers(mem).length).toBeGreaterThan(0);
      const pg = `${h("workspace/api/s.ts")}\n+const db = new Database(process.env.DATABASE_URL);`;
      expect(scanFallbackLayers(pg)).toEqual([]);
    });
    it("warns on mock-money literals and dead controls (never fails)", () => {
      const diff = `${h("workspace/web/Bal.tsx")}\n+const mockBalance = 100;\n+<a href="#">x</a>`;
      expect(scanDemoSmells(diff).length).toBeGreaterThan(0);
    });
    it("skips minified bundles in content scans (027 dist false-positive)", () => {
      const diff = `${h("workspace/web/dist/assets/index-SSZJwS87.js")}\n+var Nr=Symbol.for("x");SELECT a+"b";`;
      expect(scanSqlInjection(diff)).toEqual([]);
      expect(scanDemoSmells(diff)).toEqual([]);
      expect(scanFallbackLayers(diff)).toEqual([]);
    });
    it("does not flag indented parameterized SQL (diff-marker false positive)", () => {
      const indented = [
        `${h("workspace/src/services/store.ts")}\n+        \`INSERT INTO hunts`,
        `${h("workspace/src/services/store.ts")}\n+      "SELECT * FROM players WHERE hunt_id = $1 ORDER BY joined_at ASC"`,
        `${h("workspace/src/api/handler.ts")}\n+      "SELECT id FROM players WHERE hunt_id = $1 AND token_hash = $2"`,
        `${h("workspace/src/db/queries.ts")}\n+    \`SELECT p.id AS player_id,`,
      ];
      for (const diff of indented) expect(scanSqlInjection(diff)).toEqual([]);
    });
    it("still flags real concatenation and interpolation", () => {
      const concat = `${h("workspace/src/a.ts")}\n+const q = "SELECT * FROM t WHERE id = " + id;`;
      expect(scanSqlInjection(concat).length).toBeGreaterThan(0);
      const interp = `${h("workspace/src/a.ts")}\n+const q = \`SELECT * FROM t WHERE id = \${id}\`;`;
      expect(scanSqlInjection(interp).length).toBeGreaterThan(0);
    });
    it("catches stripe live keys and credential-store filenames", () => {
      const diff = `${h("workspace/api/pay.ts")}\n+const k = "sk_live_abc123";`;
      expect(scanSecrets(diff, ["workspace/api/pay.ts"]).join(" ")).toMatch(/Stripe/);
      expect(scanSecrets("", ["workspace/credentials.json"])).toContain(
        "Sensitive file (.env/.pem/.key/credentials/secrets) in changeset"
      );
    });
  });

  describe("isAllowedFile", () => {
    const task = { targetFiles: ["workspace/api/handlers/auth.go"] } as any;
    it("allows lockfiles and manifests at any depth (scope regression)", () => {
      for (const f of [
        "workspace/go.mod",
        "workspace/go.sum",
        "workspace/web/bun.lock",
        "workspace/web/package.json",
        "workspace/api/Cargo.lock",
        "workspace/svc/requirements.txt",
        "workspace/svc/composer.lock",
      ]) {
        expect(isAllowedFile(task, f)).toBe(true);
      }
    });
    it("still rejects dependency trees and unrelated sources", () => {
      for (const f of [
        "workspace/web/node_modules/.bin/esbuild",
        "workspace/web/node_modules/react/index.js",
        "workspace/api/target/debug/app",
        "workspace/other/thing.go",
      ]) {
        expect(isAllowedFile(task, f)).toBe(false);
      }
    });
    it("allows the task's own scope, progress, and contracts", () => {
      expect(isAllowedFile(task, "workspace/api/handlers/auth.go")).toBe(true);
      expect(isAllowedFile(task, "workspace/TASK_PROGRESS.md")).toBe(true);
      expect(isAllowedFile(task, "workspace/CONTRACTS.md")).toBe(true);
    });
  });
});
