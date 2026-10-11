/**
 * GitHub API quota awareness (gh_quota.ts).
 *
 * The installation token shares ONE ~5k/hr budget across every repo action.
 * A single busy evening (plan + ticks + subagents + chatops) can burn it,
 * and then board writes, PR opens and dispatches fail mid-run while
 * git-based work (merge, persist) would still succeed. This module makes
 * quota visible and lets expensive-but-cosmetic calls degrade instead of
 * failing noisily:
 *
 * - noteApiResult() — every GitManager.run feeds stderr through here;
 *   429/rate-limit text opens a cooldown window (no extra API call needed).
 * - checkQuota() — ONE `gh api rate_limit` probe per tick; when the core
 *   budget drops below floor, the cooldown opens until the reset epoch.
 * - isLimited() — consulted by projectGh (board ops fail fast, zero calls)
 *   and postTaskProgressComment (cosmetic, skipped while limited).
 * - Dispatch, merge and persist are git-based and NEVER gated here.
 *
 * No imports from GitManager (would cycle): the probe spawns gh directly.
 */

const COOLDOWN_MS = 20 * 60 * 1000;
const QUOTA_FLOOR = 150;

let limitedUntil = 0;
let warnedThisWindow = false;

function nowMs(): number {
  return Date.now();
}

/** True while a rate-limit cooldown is open. */
export function isLimited(): boolean {
  return nowMs() < limitedUntil;
}

/** Seconds until the cooldown lifts (0 when not limited). */
export function cooldownRemainingSec(): number {
  return Math.max(0, Math.ceil((limitedUntil - nowMs()) / 1000));
}

/** Test seam: reset module state. */
export function resetQuotaForTests(): void {
  limitedUntil = 0;
  warnedThisWindow = false;
}

function openCooldown(ms: number, why: string): void {
  const until = nowMs() + ms;
  if (until > limitedUntil) {
    limitedUntil = until;
    warnedThisWindow = false;
  }
  if (!warnedThisWindow) {
    warnedThisWindow = true;
    console.warn(`⚠️ GitHub API quota pressure (${why}) — cosmetic board/comment calls deferred, git-based work continues.`);
  }
}

/**
 * Feed every gh call result through here. Opens a cooldown on explicit
 * rate-limit evidence only (exit≠0 + limit text) — never on generic errors.
 */
export function noteApiResult(stderr: string, exitCode: number): void {
  if (exitCode === 0) return;
  const s = stderr || "";
  if (/rate limit|429|quota|exceeded/i.test(s)) {
    openCooldown(COOLDOWN_MS, "429/rate-limit response");
  }
}

/**
 * One-call quota probe (`gh api rate_limit`). Returns remaining core budget
 * (-1 when the probe itself fails). Opens a cooldown until the reset epoch
 * when remaining budgets are below floor.
 */
export async function checkQuota(): Promise<{ core: number; graphql: number; limited: boolean }> {
  const out = { core: -1, graphql: -1, limited: isLimited() };
  try {
    const proc = Bun.spawn(["gh", "api", "rate_limit"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0 || !stdout.trim()) return out;
    const data = JSON.parse(stdout);
    const core = data?.resources?.core;
    const gql = data?.resources?.graphql;
    if (typeof core?.remaining === "number") out.core = core.remaining;
    if (typeof gql?.remaining === "number") out.graphql = gql.remaining;
    const lowCore = typeof core?.remaining === "number" && core.remaining < QUOTA_FLOOR;
    const lowGql = typeof gql?.remaining === "number" && gql.remaining < QUOTA_FLOOR;
    if (lowCore || lowGql) {
      const resetEpoch = Math.max(Number(core?.reset || 0), Number(gql?.reset || 0));
      const ms = resetEpoch > 0 ? Math.max(60_000, resetEpoch * 1000 - nowMs()) : COOLDOWN_MS;
      openCooldown(ms, `budget low (core=${out.core}, graphql=${out.graphql})`);
      out.limited = true;
    }
    if (!out.limited) {
      console.log(`🔋 GitHub API budget: core=${out.core}, graphql=${out.graphql}.`);
    }
    return out;
  } catch {
    return out;
  }
}

/** Test seam: parse a `gh api rate_limit` payload without spawning gh. */
export function quotaFromPayload(payload: unknown): { core: number; graphql: number; low: boolean } {
  const data = (payload || {}) as any;
  const core = typeof data?.resources?.core?.remaining === "number" ? data.resources.core.remaining : -1;
  const graphql = typeof data?.resources?.graphql?.remaining === "number" ? data.resources.graphql.remaining : -1;
  return { core, graphql, low: (core >= 0 && core < QUOTA_FLOOR) || (graphql >= 0 && graphql < QUOTA_FLOOR) };
}
