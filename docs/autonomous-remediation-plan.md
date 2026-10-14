# Autonomous Gate-Remediation Loop — Design Plan

## 1. Problem

Today a deterministic-gate failure triggers a **blind retry**: the same task
re-runs with the same prompt up to `MAX_TASK_ATTEMPTS` (3), then goes FAILED
and waits for a human. Observed cases (Street Beacon Hunt, Oct 2026):

| # | Gate message | Root cause | Blind retries | Human fix | Status |
|---|--------------|-----------|---------------|-----------|--------|
| 1 | `Possible SQL injection` on `$n`-parameterized lines | Regex matched the diff `+` marker (false positive) | 3× TASK-002/004 | Engine fix (marker stripped in `scanSqlInjection`, pinned by diff-marker regression tests) | REMEDIATED |
| 2 | `Out-of-scope files: workspace/tests/*.test.ts` | Planner demanded tests but scoped them to QA | 3× TASK-002 | Manual revise | CONFIRMED |
| 3 | `Out-of-scope files: workspace/dist/**` (~95 files) | Agent committed build output; publish scrub lacked `dist/` | 3× TASK-003 | Manual revise | CONFIRMED |
| 4 | `Approved but integration failed` (merge) | Every task rewrites `workspace/TASK_PROGRESS.md` → conflict | 3× TASK-007/015 | Manual merge | CONFIRMED |
| 5 | Infra crash (`Exit: 130` × N models) | UNCONFIRMED — two open theories: (a) quotaWatcher hair-trigger killing healthy runs on benign words (repro-proven dangerous, but local repro yields exit 143, not 130); (b) opencode 2.0.28 regression. Settle via the kill-trigger snippet log before building on either theory | 3× TASK-016 | Pin revert (unverified) | UNCONFIRMED |
| 6 | `Test evidence present but no [runner-executed] stamp` | Agents pasted real output without the exact stamp token; runner only stamped reports it wrote itself | 3× TASK-007 | Runner auto-stamp fix | REMEDIATED (keep as regression test) |
| 7 | Dependency trees / runtime junk committed (`vendor/`, `storage/logs`, `.nuxt/`) | `add -f` overrides product `.gitignore`; exclusion list incomplete | 2× TASK-007 | Publish exclusions + manual branch surgery | REMEDIATED (keep as regression test) |

Every row needed a human to **diagnose first, then act**. The retries never
could have succeeded: same conditions, same outcome.

## 2. Goals / Non-goals

**Goals**
- G1: Every gate failure is **diagnosed before the next attempt** (no blind retries).
- G2: Known failure classes auto-convert to **scoped fix directives**, not full re-runs.
- G3: Contradictory plans (deliverables vs `targetFiles`) are rejected **at plan time**.
- G4: Guards stay hard — nothing is ever auto-approved; violations get **fixed by bounded agents**, never waived.
- G5: Human escalation only after fix budget exhausts, with the diagnosis attached.

**Non-goals**
- No changes to reviewer LLM behavior, merge strategy, or model cascade.
- No auto-merging, no verdict fabrication, no scope widening by agents.

## 3. Design

### 3.1 Failure classifier (pure, unit-tested)

New pure function in `orchestrator/review_gate.ts` (next to the scanners):

```ts
export interface FailureDiagnosis {
  kind: "sql-false-positive" | "test-scope" | "build-output" | "secret" | "empty-diff" | "unstamped-proof" | "vendor-junk" | "progress-conflict" | "unknown";
  files: string[];
  prescription: string; // concrete fix instruction for the agent
}
export function classifyGateFailure(
  failures: string[],
  opts?: { diff?: string; outOfScope?: string[] } // full untruncated file lists beat message parsing; diff re-tests SQL hits
): FailureDiagnosis[]
```

Mapping (regex on the gate's own failure strings — stable contract):

| Gate failure matches | kind | prescription |
|---|---|---|
| `Possible SQL concatenation in <f>` AND the flagged line uses only `$n` placeholders (re-test content with `SQL_CONCAT_STRICT`, see §3.3) | `sql-false-positive` | none needed — flag engine bug, do not retry task |
| `Out-of-scope files` listing only `workspace/tests/**` | `test-scope` | relocate the listed tests to a QA-owned task or widen the task's `targetFiles` via planner; NEVER delete coverage to satisfy the gate. Preferred executor is the engine itself: widening `targetFiles` is deterministic state surgery (zero LLM cost) — spawn an agent task only when the relocation needs judgment |
| `Out-of-scope files` listing only build-output (`dist|build|coverage|out|storybook-static`) | `build-output` | `git rm -r` the listed dirs; never emit build output inside `workspace/` (use `$RUNNER_TEMP`) |
| `Out-of-scope files` listing only dependency trees or runtime junk (`vendor|node_modules|.nuxt|storage/logs|bootstrap/cache`) | `vendor-junk` | `git rm -r` the listed paths; extend the publish exclusion list so `add -f` can never stage them again |
| `Test evidence present but no [runner-executed] stamp` | `unstamped-proof` | attach the runner's stamped proof (already automated in the runner); do not retry for content |
| merge conflict confined to `workspace/TASK_PROGRESS.md` | `progress-conflict` | keep the integration-branch copy: the `.gitattributes merge=ours` driver (ensured before every merge) prevents it; the `--ours` code fallback in `mergeTaskBranch` covers driver-less branches |
| `Out-of-scope files` otherwise | `unknown` | → reviewer agent once (see §3.2) |
| `Potential secret leak` | `secret` | → human immediately (never auto-touch secrets) |
| `Empty diff` | `empty-diff` | mark COMPLETED (already integrated) — current behavior, keep |

### 3.2 In-place fix round (no separate fix task)

A separate fix task is WRONG here and was removed from this design:
a fix task forks from `develop`, where the original's unmerged code does
not exist (branch lineage), and with `dependencies: []` plus a PENDING
original, the dispatcher would serve both — the fix working blind on a
clean fork, the original rerunning unchanged (double-dispatch). The
runner already checks out the existing remote task branch when present
(`runner.ts`, `checkout -B branch remote/branch`), so the fix round runs
in place:

On gate failure with a known-kind diagnosis (exactly one kind, no `secret`):

1. Engine writes `[FIX-ROUND: <kind>] <prescription + file list>` into the
   original task's `reviewNotes` (operator-priority directive) and returns
   it to PENDING with its attempt counter FROZEN — the watchdog/retry paths
   increment attempts on every requeue, so the freeze needs an explicit
   marker that exempts exactly one requeue, otherwise the budget math
   silently double-counts and the task starves.
2. Mechanical kinds skip the agent entirely (zero LLM cost): `test-scope`
   widening is deterministic state surgery by the engine;
   `progress-conflict` resolves with `--ours` in the merge path;
   `unstamped-proof` attaches the runner's stamped proof.
3. The agent re-runs on its own branch, applies only the prescription, and
   pushes; next tick re-reviews.
4. On fix-round FAIL → escalate to human with both transcripts.
5. Budget: max 1 auto-fix per (task, failure-signature). Repeat of the same
   signature → human. Prevents fix-loops.

`unknown` kind: single reviewer call constrained to output a prescription in
the same shape (or `human`). The prescription then feeds either an
engine-side fix or one in-place round — never a separate task. Reviewer
never approves; it only diagnoses. `secret` and budget-exhausted
escalations mark FAILED with `[NEEDS-HUMAN]`, which the overnight
auto-resurrect skips — escalated tasks stay parked for a human.

Visibility: no per-fix board card exists by design (single task), so the
engine posts a dashboard comment per fix round (`[FIX-ROUND: <kind>]`
started/passed/failed) to keep the trail auditable.

### 3.3 SQL scanner: already hardened (regression pin only)

Row 1's root cause is GONE from the engine: `scanSqlInjection`
(`review_gate.ts`) already strips the diff marker before testing, with a
comment citing exactly the TASK-002/TASK-004 class, and
`review_gate.test.ts` pins it ("does not flag indented parameterized SQL").
No regex split is needed — implementing `SQL_CONCAT_STRICT` now would be
busywork on a fixed scanner. What remains: keep the regression pins green,
and the classifier treats any residual `$n`-only hit as an engine-bug
signal (reopen, do not add rules).

### 3.4 Plan-time contradiction validator

Extend `orchestrator/roadmap_validator.ts` (runs on `plan` and `/add`):

- If a task's `deliverables`/`description` require test files (`tests/**`,
  `*.test.*`) but `targetFiles` excludes them → validation ERROR naming both.
- If a non-QA, non-launch task's `verificationCommand` needs suites it may not write →
  ERROR (either widen scope or drop the deliverable; launch exempt like the toolchain warning).
- If `targetFiles` is non-empty yet excludes `workspace/CONTRACTS.md` while
  the task touches data-model/API/service areas (any product layout, e.g.
  `src/api/**`, `src/db/**`, `src/services/**`, `workspace/<layer>/**`)
  → ERROR. Empty-`targetFiles` operator tasks (`/add`, `/revise`) are
  EXEMPT — they carry no scope contract by design, and flagging them would
  reject every operator-created task (the 014–032 lesson). Unscoped tasks
  stay warnings for the reviewer to judge.

Planner must fix and re-validate before dispatch. This kills failure classes
at zero runtime cost.

### 3.5 Launch-loop guard (same principle, smaller)

Re-launch tasks must **always execute probes and report a fresh verdict
block**, even with zero file changes. Empty diff + no fresh probe output →
task stays IN_REVIEW (do not COMPLETED, do not recycle the old verdict).
One-line change in the launch review path + prompt line in `launch.md`.

## 4. Acceptance criteria

- AC1: Seeded fixtures reproducing §1 rows 2–4 plus vendor-junk and
  unstamped-proof fail the gate and classify to the right kind with the
  right prescription (unit tests). Row 1 (SQL marker) stays green via the
  existing regression pins — assert no new rules were added for it.
- AC2: `bun test` full engine suite green (both template and one product repo).
- AC3: Roadmap validator rejects a plan with test-demanding/non-QA-scoped
  task (unit test with the exact contradiction).
- AC4: End-to-end dry run on a scratch repo: injected `dist/` + stray test
  file on a task branch → in-place fix round cleans and re-reviews →
  merged without human comments.
- AC5: `secret` kind never auto-fixes (test asserts human-escalation path).
- AC6: Fix-budget cap: same signature twice → human escalation, no third
  auto-fix (unit test on the budget check).
- AC7: Instant multi-model death tripwire: a run where every model exits
  within seconds must surface the kill-trigger snippet in the log (regression
  test feeds the watcher benign chatter + a real quota error and asserts only
  the latter aborts).

## 5. Rollout

1. Template first (`orchestrator/`, `tests/`, no workflow changes):
   classifier + validator rules + launch no-op guard (SQL scanner already
   hardened — regression pins only).
2. `bun test` + `bunx prettier --check` in template.
3. Product repos pick it up via template-sync (or cherry-pick); bump
   `GATE_VERSION` (the strict scanner changes the fail-set, and review-skip
   logic keys on it — shipping a new fail-set under the old version lets
   stale approvals skip re-review under the new gate).
4. Observe one live roadmap: count blind retries before/after (expect ~0).

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Wrong prescription → agent breaks good code | Fix tasks are scoped + reviewed by the same gate; budget cap + human fallback |
| Classifier regex drift vs gate messages | Gate messages are the contract: unit tests pin both sides; add a test asserting every gate failure string classifies (no silent `unknown` regressions — `unknown` is allowed but logged) |
| Secret mishandling by auto-fix | `secret` kind is human-only by construction (AC5) |
| Launch agents gaming "fresh verdict" | Verdict requires `[runner-executed]` stamps (existing anti-fabrication rule) |
