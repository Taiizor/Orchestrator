import type { Roadmap } from "./types.ts";

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
]);

function globOverlap(a: string, b: string): boolean {
  // Conservative overlap: same prefix or one is prefix of the other
  const na = a.replace(/\/\*\*$/, "/").replace(/\/\*$/, "/");
  const nb = b.replace(/\/\*\*$/, "/").replace(/\/\*$/, "/");
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

/** Validate planner-generated roadmap before persisting. */
export function validateRoadmap(raw: {
  tasks: { id: string; role: string; dependencies: string[]; targetFiles: string[]; milestone?: string }[];
  milestones?: { title: string }[];
  services?: string[];
}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tasks = raw.tasks || [];

  if (tasks.length === 0) errors.push("Roadmap has zero tasks.");

  const KNOWN_SERVICES = ["postgres", "redis", "mongo", "minio"];
  for (const s of raw.services || []) {
    if (!KNOWN_SERVICES.includes(s)) {
      errors.push(`Unknown CI service "${s}". Known: ${KNOWN_SERVICES.join(", ")}.`);
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
  for (const t of tasks) adj.set(t.id, (t.dependencies || []).filter((d) => idSet.has(d)));
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
      const overlap = (roots[i].targetFiles || []).some((a) =>
        (roots[j].targetFiles || []).some((b) => globOverlap(a, b))
      );
      if (overlap) {
        warnings.push(
          `Parallel tasks ${roots[i].id} and ${roots[j].id} have overlapping targetFiles (merge-conflict risk).`
        );
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
