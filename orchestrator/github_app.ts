import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { refreshAuthFromEnv } from "./config.ts";

export interface AppTokenResult {
  token: string;
  expiresAt: string;
}

let cachedToken: AppTokenResult | null = null;

/**
 * Check if GitHub App credentials (Client ID and Private Key) are present
 * either in environment variables or passed parameters.
 */
export function isGitHubAppConfigured(): boolean {
  const clientId = process.env.GH_CLIENT_ID || process.env.CLIENT_ID;
  const privateKey = process.env.GH_APP_PRIVATE_KEY || process.env.APP_PRIVATE_KEY || process.env.GH_APP_PRIVATE_KEY_PATH;
  return Boolean(clientId && privateKey);
}

/**
 * Normalizes the private key from:
 * 1. Raw PEM string (-----BEGIN ...)
 * 2. File path pointing to a .pem file
 * 3. Base64-encoded PEM string
 */
export function normalizePrivateKey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return trimmed;
  }
  // If it's a file path that exists
  if (existsSync(trimmed)) {
    try {
      return readFileSync(trimmed, "utf-8").trim();
    } catch {
      // fallback
    }
  }
  // Try base64 decoding (useful for GitHub Action secrets or single-line env vars)
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf-8").trim();
    if (decoded.startsWith("-----BEGIN")) {
      return decoded;
    }
  } catch {
    // not valid base64
  }
  return trimmed;
}

/**
 * Generate a RS256 JSON Web Token (JWT) valid for up to 10 minutes,
 * as required by GitHub App authentication.
 */
export function generateAppJwt(clientId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60, // 60 seconds clock drift allowance
      exp: now + 600, // 10 minutes maximum allowed by GitHub
      iss: clientId,
    })
  ).toString("base64url");

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKeyPem, "base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Request an installation access token from GitHub API for the app installation.
 * Results are cached in-memory until near expiry.
 */
export async function getInstallationToken(options?: {
  clientId?: string;
  privateKey?: string;
  installationId?: string;
  owner?: string;
  repo?: string;
}): Promise<string | null> {
  // Return cached token if still valid (with 3-minute safety buffer)
  if (cachedToken) {
    const expires = new Date(cachedToken.expiresAt).getTime();
    if (expires - Date.now() > 3 * 60 * 1000) {
      return cachedToken.token;
    }
  }

  const clientId = options?.clientId || process.env.GH_CLIENT_ID || process.env.CLIENT_ID || "";
  const rawKey =
    options?.privateKey ||
    process.env.GH_APP_PRIVATE_KEY ||
    process.env.APP_PRIVATE_KEY ||
    process.env.GH_APP_PRIVATE_KEY_PATH ||
    "";

  if (!clientId || !rawKey) return null;

  const privateKey = normalizePrivateKey(rawKey);
  const jwt = generateAppJwt(clientId, privateKey);

  let installationId = options?.installationId || process.env.GH_APP_INSTALLATION_ID || process.env.APP_INSTALLATION_ID || "";

  // If installation ID is not explicitly provided, attempt auto-discovery
  if (!installationId) {
    const repoSlug = process.env.GITHUB_REPOSITORY || "";
    const [defaultOwner, defaultRepo] = repoSlug.split("/");
    const owner = options?.owner || defaultOwner;
    const repo = options?.repo || defaultRepo;

    // 1. Try repo-specific installation
    if (owner && repo) {
      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Orchestrator-App",
          },
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (data?.id) installationId = String(data.id);
        }
      } catch {
        /* non-fatal */
      }
    }

    // 2. Try org-specific installation
    if (!installationId && owner) {
      try {
        const res = await fetch(`https://api.github.com/orgs/${owner}/installation`, {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Orchestrator-App",
          },
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (data?.id) installationId = String(data.id);
        }
      } catch {
        /* non-fatal */
      }
    }

    // 3. Try listing all installations of the app
    if (!installationId) {
      try {
        const res = await fetch("https://api.github.com/app/installations", {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Orchestrator-App",
          },
        });
        if (res.ok) {
          const data = (await res.json()) as any[];
          if (Array.isArray(data) && data.length > 0 && data[0]?.id) {
            installationId = String(data[0].id);
          }
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  if (!installationId) {
    console.warn("⚠️ GitHub App configured but installation ID could not be resolved.");
    return null;
  }

  try {
    const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Orchestrator-App",
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`⚠️ GitHub App token request failed (${res.status}): ${errText.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as any;
    cachedToken = {
      token: data.token,
      expiresAt: data.expires_at,
    };
    return cachedToken.token;
  } catch (err: any) {
    console.warn("⚠️ Network error while minting GitHub App token:", err?.message || err);
    return null;
  }
}

/**
 * Initialize GitHub App authentication at startup.
 * If credentials are present, mints an ephemeral installation token and sets
 * environment variables (GH_TOKEN, GH_PROJECT_TOKEN, DATA_PAT) if not already set.
 * Returns true if authenticated via App, false if falling back to ambient tokens.
 */
export async function initializeGitHubAppAuth(): Promise<boolean> {
  if (!isGitHubAppConfigured()) return false;

  try {
    const token = await getInstallationToken();
    if (token) {
      const clientId = process.env.GH_CLIENT_ID || process.env.CLIENT_ID;
      console.log(`🤖 Authenticated via GitHub App (Client ID: ${clientId}).`);

      // Populate ambient tokens if not explicitly set
      if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
        process.env.GH_TOKEN = token;
        process.env.GITHUB_TOKEN = token;
      }
      if (!process.env.GH_PROJECT_TOKEN) {
        process.env.GH_PROJECT_TOKEN = token;
      }
      if (!process.env.DATA_PAT) {
        process.env.DATA_PAT = token;
      }
      // CONFIG is snapshotted at import time — refresh it so downstream
      // readers (ProjectManager, GitManager) see the minted token instead
      // of the stale "" value.
      refreshAuthFromEnv();
      return true;
    }
  } catch (err: any) {
    console.warn("⚠️ GitHub App authentication failed; falling back to ambient credentials:", err?.message || err);
  }
  return false;
}
