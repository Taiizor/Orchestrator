import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  isGitHubAppConfigured,
  normalizePrivateKey,
  generateAppJwt,
  initializeGitHubAppAuth,
} from "../orchestrator/github_app.ts";
import { CONFIG, refreshAuthFromEnv } from "../orchestrator/config.ts";

describe("GitHub App Module", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GH_APP_ID;
    delete process.env.APP_ID;
    delete process.env.GH_APP_PRIVATE_KEY;
    delete process.env.APP_PRIVATE_KEY;
    delete process.env.GH_APP_INSTALLATION_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("isGitHubAppConfigured should return false when credentials are empty", () => {
    expect(isGitHubAppConfigured()).toBe(false);
  });

  it("isGitHubAppConfigured should return true when APP_ID and private key are present", () => {
    process.env.GH_APP_ID = "123456";
    process.env.GH_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
    expect(isGitHubAppConfigured()).toBe(true);
  });

  it("normalizePrivateKey should preserve raw PEM", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    expect(normalizePrivateKey(pem)).toBe(pem);
  });

  it("normalizePrivateKey should decode base64 encoded PEM", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----";
    const b64 = Buffer.from(pem).toString("base64");
    expect(normalizePrivateKey(b64)).toBe(pem);
  });

  it("generateAppJwt should create a valid 3-part JWT with expected claims", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });

    const jwt = generateAppJwt("987654", privateKey);
    const parts = jwt.split(".");
    expect(parts.length).toBe(3);

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf-8"));
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    expect(payload.iss).toBe("987654");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp - payload.iat).toBe(660); // 10 min + 60s skew allowance
  });

  it("initializeGitHubAppAuth should return false and not throw when unconfigured", async () => {
    const res = await initializeGitHubAppAuth();
    expect(res).toBe(false);
  });

  it("refreshAuthFromEnv should sync runtime env into the CONFIG snapshot", () => {
    const prevEnv = {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GH_TOKEN: process.env.GH_TOKEN,
      GH_PROJECT_TOKEN: process.env.GH_PROJECT_TOKEN,
      DATA_PAT: process.env.DATA_PAT,
    };

    process.env.GITHUB_TOKEN = "";
    process.env.GH_TOKEN = "ghs_test_runtime_token";
    process.env.GH_PROJECT_TOKEN = "ghs_test_project_token";
    process.env.DATA_PAT = "";
    refreshAuthFromEnv();
    // GITHUB_TOKEN falls back to GH_TOKEN; DATA_PAT falls back to GH_PROJECT_TOKEN
    expect(CONFIG.GITHUB_TOKEN).toBe("ghs_test_runtime_token");
    expect(CONFIG.PROJECT_TOKEN).toBe("ghs_test_project_token");
    expect(CONFIG.DATA_PAT).toBe("ghs_test_project_token");

    // Restore ambient env and re-sync so no state leaks to other tests
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    refreshAuthFromEnv();
  });
});
