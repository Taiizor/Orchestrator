import { existsSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { CONFIG } from "./config.ts";
import type { Roadmap, TaskItem, TaskStatus } from "./types.ts";

export class StateManager {
  /** Safely write to a temporary file first, then atomically rename into place. */
  private static async atomicWrite(targetPath: string, content: string): Promise<void> {
    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmp = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await Bun.write(tmp, content);
    renameSync(tmp, targetPath);
  }

  /**
   * Load roadmap from state file. Returns null if not initialized yet.
   */
  public static async loadRoadmap(): Promise<Roadmap | null> {
    if (!existsSync(CONFIG.ROADMAP_FILE)) {
      return null;
    }
    try {
      const content = await Bun.file(CONFIG.ROADMAP_FILE).text();
      return JSON.parse(content) as Roadmap;
    } catch (err) {
      console.error(`Failed to parse roadmap file at ${CONFIG.ROADMAP_FILE}:`, err);
      return null;
    }
  }

  /**
   * Save roadmap to JSON and auto-generate state/PROGRESS.md atomically.
   */
  public static async saveRoadmap(roadmap: Roadmap): Promise<void> {
    roadmap.updatedAt = new Date().toISOString();
    await this.atomicWrite(CONFIG.ROADMAP_FILE, JSON.stringify(roadmap, null, 2));
    await this.updateProgressMarkdown(roadmap);
  }

  /**
   * Find tasks whose dependencies are fully COMPLETED and currently PENDING
   */
  public static getReadyTasks(roadmap: Roadmap, maxCount: number): TaskItem[] {
    const completedTaskIds = new Set(roadmap.tasks.filter((t) => t.status === "COMPLETED").map((t) => t.id));

    const inProgressCount = roadmap.tasks.filter((t) => t.status === "IN_PROGRESS" || t.status === "IN_REVIEW").length;

    const availableSlots = Math.max(0, maxCount - inProgressCount);
    if (availableSlots <= 0) {
      return [];
    }

    const ready: TaskItem[] = [];
    for (const task of roadmap.tasks) {
      if (task.status !== "PENDING") continue;

      const allDepsMet = task.dependencies.every((depId) => completedTaskIds.has(depId));
      if (allDepsMet) {
        ready.push(task);
        if (ready.length >= availableSlots) break;
      }
    }

    return ready;
  }

  /**
   * Generate human & AI readable master progress report in Markdown.
   * Redacted mode (dual-repo public dashboard) drops titles, notes and
   * branches — IDs, roles, statuses and dependencies only.
   */
  public static renderProgressMarkdown(roadmap: Roadmap, opts?: { redact?: boolean }): string {
    const redact = !!opts?.redact;
    const total = roadmap.tasks.length;
    const completed = roadmap.tasks.filter((t) => t.status === "COMPLETED").length;
    const inProgress = roadmap.tasks.filter((t) => t.status === "IN_PROGRESS").length;
    const inReview = roadmap.tasks.filter((t) => t.status === "IN_REVIEW").length;
    const pending = roadmap.tasks.filter((t) => t.status === "PENDING").length;
    const failed = roadmap.tasks.filter((t) => t.status === "FAILED").length;

    const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

    const statusBadge = (s: TaskStatus) => {
      switch (s) {
        case "COMPLETED":
          return "✅ COMPLETED";
        case "IN_PROGRESS":
          return "⚡ IN_PROGRESS";
        case "IN_REVIEW":
          return "🔍 IN_REVIEW";
        case "PENDING":
          return "⏳ PENDING";
        case "FAILED":
          return "❌ FAILED";
      }
    };

    let md = `# 🚀 Project Progress: ${roadmap.projectName}\n\n`;
    md += `> **Status:** \`${roadmap.globalStatus}\` | **Updated:** ${new Date(roadmap.updatedAt).toLocaleString()}\n\n`;
    md += `### 📊 Milestone Overview\n`;
    md += `- **Progress:** ${completed} / ${total} tasks (${pct}%)\n`;
    md += `- **Active:** ${inProgress} in progress, ${inReview} in review\n`;
    md += `- **Queue:** ${pending} pending, ${failed} failed\n\n`;

    md += `### 📋 Task Breakdown\n\n`;
    if (redact) {
      md += `| ID | Role | Status | Dependencies |\n`;
      md += `| :--- | :--- | :--- | :--- |\n`;
    } else {
      md += `| ID | Title | Role | Status | Branch | Dependencies | Notes |\n`;
      md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    }

    for (const task of roadmap.tasks) {
      if (redact) {
        const deps = task.dependencies.length > 0 ? task.dependencies.map((d) => `\`${d}\``).join(", ") : "-";
        md += `| \`${task.id}\` | \`${task.role}\` | ${statusBadge(task.status)} | ${deps} |\n`;
        continue;
      }
      const deps = task.dependencies.length > 0 ? task.dependencies.join(", ") : "-";
      const notes = task.reviewNotes ? task.reviewNotes.replace(/[\r\n]+/g, " ") : "-";
      md += `| \`${task.id}\` | **${task.title}** | \`${task.role}\` | ${statusBadge(task.status)} | \`${task.branch}\` | ${deps} | ${notes} |\n`;
    }

    md += `\n---\n*Auto-generated by OpenCode Orchestrator Engine*\n`;
    return md;
  }

  public static async updateProgressMarkdown(roadmap: Roadmap): Promise<void> {
    const md = this.renderProgressMarkdown(roadmap);
    await this.atomicWrite(CONFIG.PROGRESS_MD_FILE, md);
  }

  /**
   * Field-wise merge of two roadmaps (concurrent-tick conflict resolution).
   * Terminal states (COMPLETED/FAILED) always win — a stale copy must never
   * resurrect finished tasks. All other tasks go to the newer updatedAt.
   * Top-level metadata follows remote, except missing project linkage which
   * is backfilled from local.
   */
  public static mergeRoadmaps(local: Roadmap, remote: Roadmap): Roadmap {
    const timeOf = (t: TaskItem): number => Date.parse((t as any).updatedAt || "") || 0;
    // Duplicate-ID guard: concurrent writers (tick + chatops fast-lane) both
    // derive TASK-max+1 from stale snapshots and can birth two DIFFERENT
    // tasks under one ID — the merge would silently keep one and drop the
    // other. Same id + different createdAt/title = collision: rename the
    // LOCAL copy to a fresh id (local is the writer being persisted).
    const usedIds = new Set<string>(remote.tasks.map((t) => t.id));
    for (const t of local.tasks) usedIds.add(t.id);
    const freshId = (): string => {
      const nums = [...usedIds].map((id) => parseInt((String(id).match(/(\d+)/) || ["0", "0"])[1], 10) || 0);
      const id = `TASK-${String(Math.max(0, ...nums) + 1).padStart(3, "0")}`;
      usedIds.add(id);
      return id;
    };
    for (const lt of local.tasks) {
      const rt = remote.tasks.find((r) => r.id === lt.id);
      if (
        rt &&
        (rt.createdAt !== lt.createdAt || rt.title !== lt.title) &&
        (rt.branch !== lt.branch || (rt.description || "") !== (lt.description || ""))
      ) {
        const nid = freshId();
        console.warn(`⚠️ Task-ID collision on ${lt.id} (concurrent writers); renaming local copy → ${nid}.`);
        if (!lt.branch || lt.branch === `task/${lt.id}` || lt.branch.startsWith(`task/${lt.id}-`)) {
          lt.branch = `task/${nid}`;
        }
        lt.id = nid;
        lt.updatedAt = new Date().toISOString();
      }
    }
    // Linkage fields are set once by different writers (dispatch stamps
    // dispatchedAt/runId, issue-sync stamps issueNumber/url) — a whole-task
    // newer-wins replace drops the other writer's fields (double dispatch,
    // orphaned issues). Non-empty wins, tie broken by newer updatedAt.
    const mergeLinkage = (lt: TaskItem, rt: TaskItem): Partial<TaskItem> => {
      const out: Partial<TaskItem> = {};
      const newerFirst = timeOf(lt) >= timeOf(rt);
      const first = newerFirst ? lt : rt;
      const second = newerFirst ? rt : lt;
      for (const k of [
        "issueNumber",
        "issueUrl",
        "projectItemId",
        "launchVerdict",
        "launchRound",
        "dispatchedAt",
        "runId",
      ] as const) {
        const v = (first as any)[k] ?? (second as any)[k];
        if (v !== undefined) (out as any)[k] = v;
      }
      return out;
    };
    const merged = new Map<string, TaskItem>();
    for (const rt of remote.tasks) merged.set(rt.id, { ...rt });
    for (const lt of local.tasks) {
      const rt = merged.get(lt.id);
      if (!rt) {
        merged.set(lt.id, { ...lt });
        continue;
      }
      const terminal = (s: string) => s === "COMPLETED" || s === "FAILED";
      if (terminal(rt.status) || terminal(lt.status)) {
        const ltTime = Date.parse(lt.updatedAt || "") || 0;
        const rtTime = Date.parse(rt.updatedAt || "") || 0;
        const newer = ltTime >= rtTime ? lt : rt;
        // Resurrection wins: a NEWER non-terminal state (/retry, watchdog or
        // auto-resurrect) overrides an older terminal one. Stale copies still
        // lose — an OLDER non-terminal never beats a newer terminal.
        if (!terminal(newer.status)) {
          merged.set(lt.id, { ...newer, ...mergeLinkage(lt, rt) });
          continue;
        }
        merged.set(lt.id, {
          ...(terminal(lt.status) ? lt : rt),
          ...mergeLinkage(lt, rt),
          reviewNotes: newer.reviewNotes,
          attempts: Math.max(lt.attempts, rt.attempts),
          resurrections: Math.max(lt.resurrections || 0, rt.resurrections || 0),
          failedAt: newer.failedAt ?? (terminal(lt.status) ? lt : rt).failedAt,
          updatedAt: newer.updatedAt,
        });
        continue;
      }
      const ltTime2 = Date.parse(lt.updatedAt || "") || 0;
      const rtTime2 = Date.parse(rt.updatedAt || "") || 0;
      const newerFirst = ltTime2 >= rtTime2;
      merged.set(lt.id, { ...(newerFirst ? lt : rt), ...mergeLinkage(lt, rt) });
    }
    const ordered = [
      ...remote.tasks.map((t) => merged.get(t.id)!),
      ...[...merged.values()].filter((t) => !remote.tasks.some((r) => r.id === t.id)),
    ];
    // Top-level ledger fields must union, not clobber: consumedServiceRequests
    // dropped by {...remote} re-ran service auto-adopt every tick (+ dashboard
    // spam); a dropped lastBoardSyncAt forced full snapshots; dropped
    // coverage keys re-flagged mapped inputs as uncovered. Milestones union by
    // title for the same reason: a ChatOps /add registers its milestone on
    // the local copy, and a freshness-merge against a remote snapshot
    // predating the registration silently dropped it (tasks survived via
    // id-union while v1.2.0/v1.3.0 vanished, breaking every issue creation).
    const unionMilestones = (
      ...lists: ({ title: string; description?: string }[] | undefined)[]
    ): { title: string; description?: string }[] => {
      const out = new Map<string, { title: string; description?: string }>();
      for (const l of lists) {
        if (!Array.isArray(l)) continue;
        for (const m of l) {
          if (!m || typeof m.title !== "string") continue;
          if (!out.has(m.title)) out.set(m.title, { ...m });
        }
      }
      return [...out.values()];
    };
    const unionStrings = (...lists: (string[] | undefined)[]): string[] => [
      ...new Set(lists.flatMap((l) => (Array.isArray(l) ? l : []))),
    ];
    const unionCoverage = (...maps: (Record<string, string[]> | undefined)[]): Record<string, string[]> | undefined => {
      const out: Record<string, string[]> = {};
      for (const m of maps) {
        if (!m || typeof m !== "object") continue;
        for (const [k, v] of Object.entries(m)) {
          out[k] = unionStrings(out[k], Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
        }
      }
      return Object.keys(out).length > 0 ? out : undefined;
    };
    const mergedMilestones = unionMilestones(remote.milestones, local.milestones);
    return {
      ...remote,
      projectNumber: remote.projectNumber ?? local.projectNumber,
      projectUrl: remote.projectUrl ?? local.projectUrl,
      services: remote.services ?? local.services,
      // Terminal project status sticks: a local COMPLETED (just celebrated)
      // must survive the freshness-merge against a stale IN_PROGRESS remote.
      // Without this, every finale persist reverted itself and globalStatus
      // stayed IN_PROGRESS forever despite a cut v1.0.0 release.
      globalStatus:
        local.globalStatus === "COMPLETED" || remote.globalStatus === "COMPLETED"
          ? "COMPLETED"
          : (local.globalStatus ?? remote.globalStatus),
      consumedServiceRequests:
        unionStrings(remote.consumedServiceRequests, local.consumedServiceRequests).length > 0
          ? unionStrings(remote.consumedServiceRequests, local.consumedServiceRequests)
          : undefined,
      lastBoardSyncAt:
        (remote.lastBoardSyncAt || "") >= (local.lastBoardSyncAt || "") ? remote.lastBoardSyncAt : local.lastBoardSyncAt,
      coverage: unionCoverage(remote.coverage, local.coverage),
      milestones: mergedMilestones.length > 0 ? mergedMilestones : undefined,
      tasks: ordered,
      updatedAt: new Date().toISOString(),
    };
  }
}
