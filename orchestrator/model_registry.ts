import { CONFIG } from "./config.ts";

/**
 * Live model registry access.
 *
 * The OpenCode CLI owns the authoritative catalog: which models it can
 * resolve, their context windows, their variants and their cost. Reading it
 * from the CLI itself (GET /api/model on the running service) keeps the
 * engine aligned with the binary in use — a model released after the CLI
 * build is simply absent from the list, which is exactly the signal the
 * engine needs before it burns an attempt on it.
 *
 * The static table in CONFIG stays as a fallback for the case where the CLI
 * cannot be reached (no service, timeout, unparsable payload).
 */

export interface RegistryModel {
  /** Fully qualified id, e.g. "opencode/minimax-m3.1-flash-free". */
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  /** Context window in tokens, when the registry reports one. */
  context?: number;
  /** Max output tokens, when the registry reports one. */
  output?: number;
  /** Reasoning-effort variants the model exposes ("low" … "max"). */
  variants: string[];
  /** True when the provider charges nothing for input and output. */
  free: boolean;
  enabled: boolean;
}

let cachedRegistry: Promise<RegistryModel[] | null> | undefined;

/**
 * Parse the CLI's /api/model payload. The endpoint answers with a
 * {location, data} envelope; bare arrays are accepted too. Unparsable input
 * yields an empty list (the caller then keeps the static fallback).
 */
export function parseModelRegistry(raw: string): RegistryModel[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : [];
  const models: RegistryModel[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const m = entry as Record<string, any>;
    const providerID = String(m.providerID || "");
    const modelID = String(m.modelID || m.id || "");
    if (!providerID || !modelID) continue;
    const cost = Array.isArray(m.cost) ? m.cost[0] : m.cost;
    const inputCost = Number(cost?.input);
    const outputCost = Number(cost?.output);
    const context = Number(m.limit?.context);
    const output = Number(m.limit?.output);
    models.push({
      id: `${providerID}/${modelID}`,
      providerID,
      modelID,
      name: String(m.name || modelID),
      context: Number.isFinite(context) && context > 0 ? context : undefined,
      output: Number.isFinite(output) && output > 0 ? output : undefined,
      variants: Array.isArray(m.variants) ? m.variants.map((v: any) => String(v?.id ?? v)).filter((v: string) => !!v) : [],
      free: Number.isFinite(inputCost) && inputCost === 0 && (!Number.isFinite(outputCost) || outputCost === 0),
      enabled: m.enabled !== false,
    });
  }
  return models;
}

/**
 * Query the CLI's model registry. Spawns `opencode api get /api/model`,
 * which attaches to the running service (or starts one when needed).
 */
async function queryModelRegistry(timeoutMs: number): Promise<RegistryModel[] | null> {
  const proc = Bun.spawn(["opencode", "api", "get", "/api/model"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  try {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const models = parseModelRegistry(stdout);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The CLI's live model registry, memoized for the process lifetime. Resolves
 * to null when the CLI cannot be reached — callers then fall back to the
 * static table in CONFIG.
 */
export function loadModelRegistry(timeoutMs = 20_000): Promise<RegistryModel[] | null> {
  if (!cachedRegistry) {
    cachedRegistry = queryModelRegistry(timeoutMs).catch(() => null);
  }
  return cachedRegistry;
}

/** Context windows keyed by fully qualified model id. */
export function contextWindowsOf(models: RegistryModel[]): Map<string, number> {
  const windows = new Map<string, number>();
  for (const m of models) {
    if (typeof m.context === "number" && m.context > 0) windows.set(m.id, m.context);
  }
  return windows;
}

/** Ids the CLI can resolve right now (its own registry, minus disabled models). */
export function resolvableModelIds(models: RegistryModel[]): Set<string> {
  return new Set(models.filter((m) => m.enabled).map((m) => m.id));
}

/**
 * Effective context windows: the live registry wins, the static table fills
 * the gaps for models the registry does not report.
 */
export function effectiveContextWindows(models: RegistryModel[] | null): Map<string, number> {
  const windows = new Map<string, number>();
  for (const [id, window] of Object.entries(CONFIG.FREE_MODEL_CONTEXT_WINDOWS)) {
    if (typeof window === "number") windows.set(id, window);
  }
  if (models) {
    for (const [id, window] of contextWindowsOf(models)) windows.set(id, window);
  }
  return windows;
}
