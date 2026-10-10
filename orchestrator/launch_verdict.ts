/**
 * Launch-verdict protocol (launch verification role ↔ orchestrator tick).
 *
 * The launch agent appends a ```launch-verdict JSON block to its
 * TASK_PROGRESS.md Verification section. The tick parses it here (pure
 * functions — unit tested) and the engine acts: `fail` spawns ONE fix task,
 * `pass`/`skipped` stay quiet. Processed verdicts are recorded on the task
 * (`launchVerdict`) so repeat ticks never double-spawn. Re-launch rounds are
 * bounded by MAX_LAUNCH_ROUNDS; beyond that the engine escalates to humans.
 */
import type { AgentRole } from "./types.ts";

export interface LaunchGap {
  area: string;
  detail: string;
  files?: string[];
  log?: string;
}

export type LaunchVerdictKind = "pass" | "fail" | "skipped";

export interface LaunchVerdict {
  verdict: LaunchVerdictKind;
  gaps: LaunchGap[];
  evidence?: string;
}

/** Maximum auto re-launch rounds per milestone before human escalation. */
export const MAX_LAUNCH_ROUNDS = 2;

/** Marker prefix for auto-spawned fix tasks (counted for round bounding). */
export const LAUNCH_FIX_TITLE_PREFIX = "Fix launch gaps";

export function parseLaunchVerdict(progressMarkdown: string): LaunchVerdict | null {
  const m = (progressMarkdown || "").match(/```launch-verdict([\s\S]*?)```/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1].trim()) as Partial<LaunchVerdict>;
    if (raw.verdict !== "pass" && raw.verdict !== "fail" && raw.verdict !== "skipped") return null;
    const gaps = Array.isArray(raw.gaps)
      ? raw.gaps
          .filter((g) => g && typeof (g as LaunchGap).detail === "string")
          .map((g) => ({
            area: String((g as LaunchGap).area || "general"),
            detail: String((g as LaunchGap).detail),
            files: Array.isArray((g as LaunchGap).files) ? (g as LaunchGap).files!.filter((f) => typeof f === "string") : [],
            log: typeof (g as LaunchGap).log === "string" ? (g as LaunchGap).log!.slice(0, 2000) : "",
          }))
      : [];
    return {
      verdict: raw.verdict,
      gaps,
      evidence: typeof raw.evidence === "string" ? raw.evidence.slice(0, 2000) : "",
    };
  } catch {
    return null;
  }
}

/**
 * Infer the fix-task role from gap text. Frontend/backend on strong
 * signals, fullstack (spans layers) as the safe default — boot, composition
 * and unknown failures are rarely single-layer.
 */
export function inferFixRole(gaps: LaunchGap[]): AgentRole {
  const hay = gaps.map((g) => `${g.area} ${g.detail}`).join("\n");
  if (/page|selector|console|html|css|\bui\b|screen|theme/i.test(hay)) return "frontend";
  if (/endpoint|\bapi\b|contract|migration|\bsql\b|database|ledger|payment/i.test(hay)) return "backend";
  return "fullstack";
}

/** Count prior auto fix rounds for a milestone (by title marker). */
export function countLaunchFixRounds(tasks: { title: string; milestone?: string }[], milestone: string | undefined): number {
  return tasks.filter((t) => t.title.startsWith(LAUNCH_FIX_TITLE_PREFIX) && (t.milestone || "") === (milestone || "")).length;
}
