import type { Roadmap } from "./types.ts";
import { STACK_IDS, isKnownStackCommand } from "./stacks.ts";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const VALID_ROLES = new Set([
  "architect",
  "backend",
  "frontend",
  "mobile",
  "qa",
  "reviewer",
  "security",
  "tracker",
  "fullstack",
  "launch",
]);

function globOverlap(a: string, b: string): boolean {
  // Conservative overlap: same prefix or one is prefix of the other
  const na = a.replace(/\/\*\*$/, "/").replace(/\/\*$/, "/");
  const nb = b.replace(/\/\*\*$/, "/").replace(/\/\*$/, "/");
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

/** Sanitize a planner-authored input-coverage map (string keys, string[] ids). */
export function sanitizeCoverage(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || !Array.isArray(v)) continue;
    const ids = (v as unknown[]).filter((x) => typeof x === "string").map(String);
    if (ids.length > 0) out[k] = ids;
  }
  return out;
}

/** Validate planner-generated roadmap before persisting. */
export function validateRoadmap(raw: {
  tasks: {
    id: string;
    role: string;
    dependencies: string[];
    targetFiles: string[];
    milestone?: string;
    description?: string;
    deliverables?: string[];
    verificationCommand?: string;
  }[];
  milestones?: { title: string }[];
  services?: (string | { name?: string; image?: string; env?: Record<string, string>; ports?: string[] })[];
  stack?: unknown;
  /** Coverable input files (`inputs/`-relative posix paths). Only the plan path supplies these. */
  inputFiles?: string[];
  /** Input-file → task ID coverage map authored by the planner. */
  coverage?: Record<string, string[]>;
}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tasks = raw.tasks || [];

  if (tasks.length === 0) errors.push("Roadmap has zero tasks.");

  if (raw.stack !== undefined && !(typeof raw.stack === "string" && (STACK_IDS as string[]).includes(raw.stack))) {
    errors.push(`Unknown stack "${String(raw.stack).slice(0, 40)}". Known: ${STACK_IDS.join(", ")}.`);
  }

  const KNOWN_SERVICES = ["postgres", "redis", "mongo", "minio", "s3"];
  for (const s of raw.services || []) {
    if (typeof s === "string") {
      if (!KNOWN_SERVICES.includes(s)) {
        errors.push(
          `Unknown CI service "${s}". Known presets: ${KNOWN_SERVICES.join(", ")} — or use a full {name, image} object.`
        );
      }
    } else if (!s || typeof s.name !== "string" || typeof s.image !== "string" || !s.name.trim() || !s.image.trim()) {
      errors.push(`Invalid custom service definition (need {name, image, env?, ports?}): ${JSON.stringify(s).slice(0, 120)}.`);
    }
  }

  const ids = tasks.map((t) => t.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) errors.push(`Duplicate task IDs: ${[...new Set(dupes)].join(", ")}.`);

  const idSet = new Set(ids);
  for (const t of tasks) {
    if (!VALID_ROLES.has(t.role)) {
      errors.push(`[${t.id}] invalid role "${t.role}". Valid: ${[...VALID_ROLES].join(", ")}.`);
    }
    const desc = t.description || "";
    if (desc.trim().split(/\s+/).filter(Boolean).length < 20) {
      warnings.push(`[${t.id}] description is thin (<20 words); subagent will under-deliver.`);
    }
    if (!Array.isArray(t.deliverables) || t.deliverables.length < 2) {
      warnings.push(`[${t.id}] has fewer than 2 deliverables; acceptance criteria unclear.`);
    }
    if (!t.verificationCommand) {
      warnings.push(`[${t.id}] has no verificationCommand; proof of completion unenforceable.`);
    } else if (!isKnownStackCommand(t.verificationCommand)) {
      warnings.push(
        `[${t.id}] verificationCommand "${t.verificationCommand.slice(0, 60)}" matches no known stack toolchain (bun/go/cargo/dotnet/pytest); proof may be unverifiable in CI.`
      );
    }
    if (!t.targetFiles || t.targetFiles.length === 0) {
      warnings.push(`[${t.id}] has no targetFiles; parallel safety cannot be verified.`);
    }
    for (const dep of t.dependencies || []) {
      if (!idSet.has(dep)) errors.push(`[${t.id}] depends on unknown task "${dep}".`);
      if (dep === t.id) errors.push(`[${t.id}] depends on itself.`);
    }
  }

  // Cycle detection (DFS)
  const adj = new Map<string, string[]>();
  for (const t of tasks)
    adj.set(
      t.id,
      (t.dependencies || []).filter((d) => idSet.has(d))
    );
  const color = new Map<string, number>(); // 0=unvisited 1=in-stack 2=done
  const stack: string[] = [];
  const visit = (id: string): boolean => {
    color.set(id, 1);
    stack.push(id);
    for (const dep of adj.get(id) || []) {
      const c = color.get(dep) || 0;
      if (c === 1) {
        errors.push(`Dependency cycle detected: [..., ${dep} -> ... -> ${id} -> ${dep}].`);
        return true;
      }
      if (c === 0 && visit(dep)) return true;
    }
    stack.pop();
    color.set(id, 2);
    return false;
  };
  for (const t of tasks) {
    if ((color.get(t.id) || 0) === 0) visit(t.id);
  }

  // Milestone refs
  const titles = new Set((raw.milestones || []).map((m) => m.title));
  if (titles.size > 0) {
    for (const t of tasks) {
      if (t.milestone && !titles.has(t.milestone)) {
        warnings.push(`[${t.id}] references unknown milestone "${t.milestone}".`);
      }
    }
  }

  // Overlapping targetFiles among dependency-free (parallel) tasks
  const roots = tasks.filter((t) => (t.dependencies || []).length === 0);
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const overlap = (roots[i].targetFiles || []).some((a) => (roots[j].targetFiles || []).some((b) => globOverlap(a, b)));
      if (overlap) {
        warnings.push(`Parallel tasks ${roots[i].id} and ${roots[j].id} have overlapping targetFiles (merge-conflict risk).`);
      }
    }
  }

  // Launch coverage: milestones that serve HTTP (backend/frontend/fullstack/
  // mobile tasks) need a launch-verification task — otherwise nothing ever
  // proves tak-çalıştır (unwired-UI class gaps slip through green reviews).
  const SERVING_ROLES = new Set(["backend", "frontend", "fullstack", "mobile"]);
  for (const m of raw.milestones || []) {
    const mtasks = tasks.filter((t) => t.milestone === m.title);
    if (!mtasks.some((t) => SERVING_ROLES.has(t.role))) continue;
    if (!mtasks.some((t) => t.role === "launch")) {
      warnings.push(`Milestone "${m.title}" serves HTTP but has no launch-verification task; tak-çalıştır is unproven.`);
    }
  }

  // Input→task coverage: every ingested input file should map to ≥1 task,
  // otherwise requirements silently evaporate (thin-plan class). Only the
  // plan path supplies inputFiles; surgical adds skip this check.
  if (raw.inputFiles && raw.inputFiles.length > 0) {
    const cov = raw.coverage && typeof raw.coverage === "object" ? raw.coverage : null;
    if (!cov) {
      warnings.push(
        `Roadmap has no input-coverage map; ${raw.inputFiles.length} input file(s) untracked (requirements may be dropped).`
      );
    } else {
      const idSet = new Set(tasks.map((t) => t.id));
      for (const f of raw.inputFiles) {
        const refs = Array.isArray((cov as Record<string, unknown>)[f]) ? (cov as Record<string, string[]>)[f] : [];
        if (!refs.some((id) => idSet.has(id))) {
          warnings.push(`Input "${f}" is not covered by any task; its requirements may be dropped.`);
        }
      }
    }
  }

  return { errors, warnings };
}

export function formatValidation(r: ValidationResult): string {
  const parts: string[] = [];
  if (r.errors.length > 0) parts.push(`Errors:\n- ${r.errors.join("\n- ")}`);
  if (r.warnings.length > 0) parts.push(`Warnings:\n- ${r.warnings.join("\n- ")}`);
  return parts.join("\n") || "OK";
}

export type { Roadmap };
