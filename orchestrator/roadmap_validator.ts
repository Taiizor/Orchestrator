import type { Roadmap } from "./types.ts";
import { STACK_IDS, commandStack, effectiveTaskStack, isKnownStackCommand } from "./stacks.ts";

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
    stack?: unknown;
    launchRound?: unknown;
    status?: unknown;
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

  if (
    raw.stack !== undefined &&
    !(typeof raw.stack === "string" && (STACK_IDS as string[]).includes(raw.stack.trim().toLowerCase()))
  ) {
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
  // Task IDs flow into branch names (task/<id>), issue titles and run
  // matching — spaces/slashes/dots break git refs and dispatch correlation.
  for (const t of tasks) {
    if (typeof t.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(t.id)) {
      errors.push(`[${String(t.id).slice(0, 40)}] invalid task ID (use letters/digits/_/- only, must not start with -).`);
    }
  }

  const idSet = new Set(ids);
  for (const t of tasks) {
    if (!VALID_ROLES.has(t.role)) {
      errors.push(`[${t.id}] invalid role "${t.role}". Valid: ${[...VALID_ROLES].join(", ")}.`);
    }
    if (
      t.stack !== undefined &&
      t.stack !== null &&
      !(typeof t.stack === "string" && t.stack.trim() !== "" && (STACK_IDS as string[]).includes(t.stack.trim().toLowerCase()))
    ) {
      // Empty string = inherit roadmap default (same as unset); anything else must be known.
      if (!(typeof t.stack === "string" && t.stack.trim() === "")) {
        errors.push(`[${t.id}] unknown task stack "${String(t.stack).slice(0, 40)}". Known: ${STACK_IDS.join(", ")}.`);
      }
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
    } else if (!isKnownStackCommand(t.verificationCommand) && t.role !== "launch") {
      // Launch tasks run smoke commands (playwright, probe scripts) that
      // match no product toolchain by design — exempt, never warn.
      warnings.push(
        `[${t.id}] verificationCommand "${t.verificationCommand.slice(0, 60)}" matches no known stack toolchain (bun/go/cargo/dotnet/pytest/phpunit); proof may be unverifiable in CI.`
      );
    } else {
      // The proof must come from the task's OWN layer: a go task proving
      // itself with `bun test` silently tests the wrong tree.
      const cmdStack = commandStack(t.verificationCommand);
      const effStack = effectiveTaskStack({ stack: t.stack }, raw.stack);
      if (cmdStack && cmdStack !== effStack) {
        warnings.push(
          `[${t.id}] verificationCommand looks like ${cmdStack} ("${t.verificationCommand.slice(0, 50)}") but the task's effective stack is ${effStack}; proof would exercise the wrong layer.`
        );
      }
    }
    if (!t.targetFiles || t.targetFiles.length === 0) {
      warnings.push(`[${t.id}] has no targetFiles; parallel safety cannot be verified.`);
    }
    for (const dep of t.dependencies || []) {
      if (!idSet.has(dep)) errors.push(`[${t.id}] depends on unknown task "${dep}".`);
      if (dep === t.id) errors.push(`[${t.id}] depends on itself.`);
    }
  }

  // Split layers must meet at a CONSUMED contract: with 2+ effective stacks,
  // at least one task must own workspace/CONTRACTS.md (the planner's contract
  // task), and every override-stack task must depend on it directly.
  // Otherwise the layers evolve against an undocumented boundary (a contract
  // nobody depends on is a demo artifact) or drift apart silently. Errors,
  // not warnings: a defective split must never persist.
  const effStacks = new Set(tasks.map((t) => effectiveTaskStack({ stack: t.stack }, raw.stack)));
  if (effStacks.size > 1) {
    const contractOwners = new Set(
      tasks
        .filter((t) => (t.targetFiles || []).some((f) => f.replace(/\\/g, "/").includes("workspace/CONTRACTS.md")))
        .map((t) => t.id)
    );
    if (contractOwners.size === 0) {
      errors.push(
        `Split-stack roadmap (${[...effStacks].join(" + ")}) has no task owning workspace/CONTRACTS.md; add a contract task (OpenAPI/typed clients + freshness check) that cross-layer tasks depend on.`
      );
    } else {
      for (const t of tasks) {
        const eff = effectiveTaskStack({ stack: t.stack }, raw.stack);
        const isDefaultLayer = eff === effectiveTaskStack({}, raw.stack);
        if (!isDefaultLayer && !contractOwners.has(t.id)) {
          const deps = t.dependencies || [];
          if (!deps.some((d) => contractOwners.has(d))) {
            errors.push(
              `[${t.id}] effective stack is ${eff} but it does not depend on the contract task (${[...contractOwners].join(", ")}); cross-layer tasks must anchor to the contract or they drift into demos.`
            );
          }
        }
      }
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

  // Unscoped collision risk: tasks WITHOUT targetFiles (operator /add,
  // /revise) cannot prove disjointness. Two live unscoped tasks in the same
  // role edit the same tree blind (TASK-025/026 both touched web/bun.lock).
  // The dispatcher serializes them; this warns at plan time so scopes can
  // be assigned instead.
  const live = tasks.filter((t) => (t as any).status !== "COMPLETED");
  const unscopedByRole = new Map<string, string[]>();
  for (const t of live) {
    if (!t.targetFiles || t.targetFiles.length === 0) {
      const list = unscopedByRole.get(t.role) || [];
      list.push(t.id);
      unscopedByRole.set(t.role, list);
    }
  }
  for (const [role, ids] of unscopedByRole) {
    if (ids.length > 1) {
      warnings.push(
        `Unscoped tasks share role '${role}' (${ids.join(", ")}) with no targetFiles: collision risk, dispatch serializes them — assign disjoint scopes to parallelize.`
      );
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

  // Launch discipline: every launch task carries its round (re-launch
  // machinery, watchdog and merge keys depend on it), and a milestone must
  // not hold two launches on the same round (double boot/probe races).
  // Round 2+ is legitimate (auto re-launch after fixes) — only the
  // duplication is an error. COMPLETED launches predate the rule and are
  // history, not plannable work: grandfather them instead of blocking every
  // future /add on old roadmaps.
  for (const t of tasks) {
    if (t.role !== "launch" || t.status === "COMPLETED") continue;
    if (t.launchRound === undefined || t.launchRound === null) {
      errors.push(`[${t.id}] launch task has no launchRound (set 1; re-launches increment).`);
    } else if (typeof t.launchRound !== "number" || !Number.isInteger(t.launchRound) || t.launchRound < 1) {
      errors.push(`[${t.id}] launchRound must be a positive integer, got ${JSON.stringify(t.launchRound)?.slice(0, 20)}.`);
    }
  }
  const rounds = new Map<string, number>();
  for (const t of tasks) {
    if (t.role !== "launch" || typeof t.launchRound !== "number") continue;
    const key = `${t.milestone || ""}::${t.launchRound}`;
    rounds.set(key, (rounds.get(key) || 0) + 1);
  }
  for (const [key, n] of rounds) {
    if (n > 1) {
      const [ms, r] = key.split("::");
      errors.push(`Milestone "${ms}" has ${n} launch tasks on round ${r}; exactly one per round (probe races, double verdicts).`);
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
