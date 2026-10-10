/**
 * Project service definitions for Docker-backed CI.
 *
 * Fixed local endpoints (agreed across compose file, workflow step, skill
 * and prompts) so no per-project wiring is needed. Credentials are
 * ephemeral CI-only defaults — NEVER use them outside throwaway runners.
 */
export const SERVICE_DEFS: Record<string, { image: string; env: Record<string, string>; check: string }> = {
  postgres: {
    image: "postgres:16-alpine",
    env: {
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/app",
    },
    check: "pg_isready -h localhost -p 5432 -U postgres",
  },
  redis: {
    image: "redis:7-alpine",
    env: {
      REDIS_URL: "redis://localhost:6379",
    },
    check: "redis-cli -h localhost -p 6379 ping",
  },
  mongo: {
    image: "mongo:7",
    env: {
      MONGO_URL: "mongodb://localhost:27017/app",
    },
    check: "mongosh --quiet --eval 'db.runCommand({ping:1})' mongodb://localhost:27017/app",
  },
  minio: {
    // Legacy alias of "s3" (kept for in-flight roadmaps). MinIO left Docker
    // Hub, so the S3 preset runs Adobe S3Mock (S3 API compatible).
    // Pinned (never :latest): floating tags defeat layer caching and burn
    // pull quota on every cold runner.
    image: "adobe/s3mock:5.2.3",
    env: {
      S3_ENDPOINT: "http://localhost:9090",
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test",
      S3_BUCKET: "uploads",
      S3_REGION: "us-east-1",
    },
    check: "",
  },
  s3: {
    image: "adobe/s3mock:5.2.3",
    env: {
      S3_ENDPOINT: "http://localhost:9090",
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test",
      S3_BUCKET: "uploads",
      S3_REGION: "us-east-1",
    },
    check: "",
  },
};

export const KNOWN_SERVICES = Object.keys(SERVICE_DEFS);

/** Agent-authored service request file (workspace-relative). Agents append
 * entries when they need an undeclared container; the orchestrator tick
 * validates and merges them into roadmap.services (durable from run #2). */
export const SERVICE_REQUEST_FILE = "workspace/services.request.json";

/** Image must be pinned: explicit non-`latest` tag or a sha256 digest.
 * Floating tags defeat layer caching and burn pull quota on cold runners. */
export function isPinnedImage(image: string): boolean {
  if (image.includes("@sha256:")) return true;
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon <= lastSlash) return false;
  const tag = image.slice(lastColon + 1).trim();
  return tag.length > 0 && tag.toLowerCase() !== "latest";
}

function normalizeServiceName(raw: unknown): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ServiceRequestResult {
  valid: ServiceDefinition[];
  rejected: { name: string; reason: string }[];
}

/**
 * Validate agent-authored service requests (parsed JSON). Pure — unit-testable.
 * Rejects: missing/empty name or image, floating (`:latest`) or missing tags,
 * malformed ports/env. Does NOT dedupe against the roadmap (caller does).
 */
export function parseServiceRequests(raw: unknown): ServiceRequestResult {
  const valid: ServiceDefinition[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const list = Array.isArray(raw) ? raw : (raw as Record<string, unknown>)?.services;
  if (!Array.isArray(list)) {
    return { valid, rejected: [{ name: "?", reason: 'request file must be a JSON array (or {"services": [...]})' }] };
  }
  for (const entry of list) {
    const name = normalizeServiceName((entry as Record<string, unknown>)?.name);
    if (!name) {
      rejected.push({ name: "?", reason: "missing service name" });
      continue;
    }
    const image =
      typeof (entry as Record<string, unknown>)?.image === "string"
        ? ((entry as Record<string, unknown>).image as string).trim()
        : "";
    if (!image) {
      rejected.push({ name, reason: "missing image" });
      continue;
    }
    if (!isPinnedImage(image)) {
      rejected.push({
        name,
        reason: `image "${image.slice(0, 80)}" is not pinned (need an explicit non-latest tag or sha256 digest)`,
      });
      continue;
    }
    const e = entry as Record<string, unknown>;
    let ports: string[] | undefined;
    if (e.ports !== undefined) {
      if (
        !Array.isArray(e.ports) ||
        !(e.ports as unknown[]).every((p) => typeof p === "string" && /^\d+:\d+$/.test((p as string).trim()))
      ) {
        rejected.push({ name, reason: 'ports must be ["host:container", ...] with numeric ports' });
        continue;
      }
      ports = (e.ports as string[]).map((p) => p.trim());
    }
    let env: Record<string, string> | undefined;
    if (e.env !== undefined) {
      if (typeof e.env !== "object" || e.env === null || Array.isArray(e.env)) {
        rejected.push({ name, reason: "env must be a {KEY: value} object" });
        continue;
      }
      const entries = Object.entries(e.env as Record<string, unknown>);
      if (!entries.every(([k, v]) => k.trim().length > 0 && typeof v === "string")) {
        rejected.push({ name, reason: "env keys/values must be non-empty strings" });
        continue;
      }
      env = Object.fromEntries(entries.map(([k, v]) => [k, v as string]));
    }
    valid.push({ name, image, ...(env ? { env } : {}), ...(ports ? { ports } : {}) });
  }
  return { valid, rejected };
}

/** Built-in readiness probes for known services (used by `compose up --wait`). */
const PRESET_HEALTHCHECKS: Record<string, string[]> = {
  postgres: ["CMD-SHELL", "pg_isready -U postgres"],
  redis: ["CMD", "redis-cli", "ping"],
  mongo: ["CMD", "mongosh", "--quiet", "--eval", "db.runCommand({ping:1})"],
};

import type { ServiceDefinition } from "./types.ts";

export type ServiceSpec = string | ServiceDefinition;

/** Normalize roadmap entries: known-name shorthand or full custom object. */
export function normalizeServices(
  specs: ServiceSpec[]
): { name: string; image: string; env: Record<string, string>; ports: string[]; command?: string; healthcheck?: string[] }[] {
  const out: {
    name: string;
    image: string;
    env: Record<string, string>;
    ports: string[];
    command?: string;
    healthcheck?: string[];
  }[] = [];
  const seen = new Set<string>();
  const push = (entry: {
    name: string;
    image: string;
    env: Record<string, string>;
    ports: string[];
    command?: string;
    healthcheck?: string[];
  }) => {
    if (seen.has(entry.name)) return;
    seen.add(entry.name);
    out.push(entry);
  };
  for (const s of specs || []) {
    if (typeof s === "string") {
      if (s === "minio") {
        console.warn(`⚠️ Service preset "minio" renamed to "s3" (Adobe S3Mock backend). Mapping automatically.`);
      }
      const key = s === "minio" ? "s3" : s;
      const preset = SERVICE_DEFS[key];
      if (!preset) continue;
      const ports =
        key === "postgres" ? ["5432:5432"] : key === "redis" ? ["6379:6379"] : key === "mongo" ? ["27017:27017"] : ["9090:9090"];
      push({ name: key, image: preset.image, env: { ...preset.env }, ports });
    } else if (s && typeof s.name === "string" && typeof s.image === "string") {
      const name = s.name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!name || !s.image.trim()) continue; // validator rejects these at plan time
      out.push({
        name,
        image: s.image.trim(),
        env: { ...(s.env || {}) },
        ports: Array.isArray(s.ports) ? s.ports : [],
        command: s.command,
        healthcheck: Array.isArray(s.healthcheck) ? s.healthcheck : undefined,
      });
    }
  }
  return out;
}

/**
 * Deterministic compose file from a service list (pure — unit-testable).
 * Accepts known-name shorthands and full custom definitions
 * ({name, image, env?, ports?, command?, healthcheck?}).
 * Data is ephemeral (tmpfs/anonymous volumes): perfect for tests, useless
 * for persistence. Agents must seed fixtures per run.
 */
export function renderComposeYaml(specs: ServiceSpec[]): string {
  const normalized = normalizeServices(specs);
  const blocks: string[] = [];
  for (const svc of normalized) {
    // pull_policy: missing — never re-pull a present image (quota saver on
    // cold runners; tags are pinned so staleness is a non-issue).
    const lines = [`  ${svc.name}:`, `    image: ${svc.image}`, `    pull_policy: missing`];
    if (svc.name === "postgres") {
      lines.push(`    environment:\n      POSTGRES_USER: postgres\n      POSTGRES_PASSWORD: postgres\n      POSTGRES_DB: app`);
    }
    if (svc.ports.length > 0) {
      lines.push(`    ports:\n${svc.ports.map((p) => `      - "${p}"`).join("\n")}`);
    }
    if (svc.command) lines.push(`    command: ${svc.command}`);
    const hc = svc.healthcheck || PRESET_HEALTHCHECKS[svc.name];
    if (hc) {
      lines.push(`    healthcheck:\n      test: ${JSON.stringify(hc)}\n      interval: 5s\n      timeout: 5s\n      retries: 20`);
    }
    blocks.push(lines.join("\n"));
  }
  return `# Auto-generated by OpenCode Orchestrator — ephemeral CI services.\n# Do NOT use these credentials outside throwaway runners.\nservices:\n${blocks.join("\n")}\n`;
}

/** Flat env map for the picked services (exported via $GITHUB_ENV). */
export function serviceEnv(specs: ServiceSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const svc of normalizeServices(specs)) Object.assign(out, svc.env);
  return out;
}

/** KEY=VAL lines for the workflow to append to $GITHUB_ENV (custom env included). */
export function renderEnvFile(specs: ServiceSpec[]): string {
  return (
    Object.entries(serviceEnv(specs))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  );
}
