import { GitManager } from "./git_manager.ts";
import { StateManager } from "./state_manager.ts";
import type { Roadmap } from "./types.ts";

export class IssueManager {
  private static readonly DASHBOARD_TITLE = "🚀 Project Dashboard & Agent Progress Board";

  /** Public dashboard never carries task titles/notes in dual-repo mode. */
  private static isRedacted(): boolean {
    return GitManager.isDataMode();
  }

  /**
   * Find the canonical dashboard issue by exact title match in code.
   * (Server-side `in:title` search with emoji/special chars is unreliable,
   * which previously caused duplicate dashboards.)
   */
  private static async findDashboardIssue(): Promise<number | null> {
    const listRes = await GitManager.run([
      "gh", "issue", "list",
      "--state", "open",
      "--limit", "100",
      "--json", "number,title",
    ]);
    if (listRes.exitCode !== 0 || !listRes.stdout.trim()) return null;
    try {
      const issues = JSON.parse(listRes.stdout);
      const hits = issues.filter((i: any) => i.title === this.DASHBOARD_TITLE);
      if (hits.length > 1) {
        console.warn(`⚠️ Found ${hits.length} dashboard issues; canonical is #${hits[0].number}. Duplicates will be closed.`);
        for (const dupe of hits.slice(1)) {
          await GitManager.run([
            "gh", "issue", "close", String(dupe.number),
            "--comment", `Duplicate of canonical dashboard #${hits[0].number}.`,
          ]);
        }
      }
      return hits.length > 0 ? hits[0].number : null;
    } catch {
      return null;
    }
  }

  /**
   * Find or create the Master Issue Dashboard
   */
  public static async syncDashboardIssue(roadmap: Roadmap): Promise<number | null> {
    let issueNumber: number | null = await this.findDashboardIssue();

    const bodyContent = StateManager.renderProgressMarkdown(roadmap, { redact: this.isRedacted() }) +
      `\n\n### 💬 ChatOps Controls\n` +
      `You can leave comments on this issue to guide the agents:\n` +
      `- \`/pause\`: Pause active execution\n` +
      `- \`/resume\`: Resume task execution\n` +
      `- \`/directive <TASK-ID> "New instruction"\`: Steer or correct an active or pending task\n` +
      `- \`/retry <TASK-ID>\`: Re-queue a failed or stuck task\n` +
      `- \`/status\`: Request an immediate status report comment\n` +
      `- \`/discuss <TASK-ID> "message"\`: Relay a message to the task's agent discussion thread\n`;

    if (issueNumber) {
      // Update existing issue body
      await GitManager.run([
        "gh", "issue", "edit", String(issueNumber),
        "--body", bodyContent
      ]);
      console.log(`📋 Updated Dashboard Issue #${issueNumber}`);
      return issueNumber;
    } else {
      // Create new Dashboard Issue (separate --label flags; comma form creates one bogus label)
      const { ProjectManager } = await import("./project_manager.ts");
      await ProjectManager.ensureLabels();
      const createRes = await GitManager.run([
        "gh", "issue", "create",
        "--title", this.DASHBOARD_TITLE,
        "--body", bodyContent,
        "--label", "dashboard",
        "--label", "agents",
      ]);

      if (createRes.exitCode === 0) {
        const match = createRes.stdout.match(/\/issues\/(\d+)/);
        if (match) {
          issueNumber = parseInt(match[1], 10);
          console.log(`🎉 Created Master Dashboard Issue #${issueNumber}`);
          return issueNumber;
        }
      }
    }

    return null;
  }

  /**
   * Process ChatOps commands left on the Dashboard issue
   */
  public static async processChatOps(roadmap: Roadmap): Promise<boolean> {
    const dashboardNumber = await this.findDashboardIssue();
    if (!dashboardNumber) return false;

    // Fetch recent comments on dashboard issue
    const commentsRes = await GitManager.run([
      "gh", "issue", "view", String(dashboardNumber),
      "--json", "comments"
    ]);

    if (commentsRes.exitCode !== 0 || !commentsRes.stdout) return false;

    let comments: any[] = [];
    try {
      const data = JSON.parse(commentsRes.stdout);
      comments = data.comments || [];
    } catch {
      return false;
    }

    if (comments.length === 0) return false;

    let hasChanges = false;
    // Check recent comments (last 5)
    const recentComments = comments.slice(-5);

    for (const comment of recentComments) {
      const body = (comment.body || "").trim();
      const commentId = comment.id || comment.databaseId;

      // Skip comments by bot itself
      if (comment.author?.login === "github-actions[bot]") continue;
      // Skip if already processed (marked with rocket or thumbs up)
      if (comment.reactionGroups?.some((r: any) => (r.content === "ROCKET" || r.content === "THUMBS_UP") && r.users?.totalCount > 0)) {
        continue;
      }

      // Check command patterns
      if (body.startsWith("/pause")) {
        console.log("⏸️ ChatOps command received: /pause");
        roadmap.globalStatus = "PAUSED";
        hasChanges = true;
        await this.acknowledgeComment(dashboardNumber, commentId, "⏸️ **Orchestrator Paused:** Active subagents will finish current runs, but no new tasks will be dispatched until `/resume` is received.");
      } else if (body.startsWith("/resume")) {
        console.log("▶️ ChatOps command received: /resume");
        roadmap.globalStatus = "IN_PROGRESS";
        hasChanges = true;
        await this.acknowledgeComment(dashboardNumber, commentId, "▶️ **Orchestrator Resumed:** Task scheduling and dispatching resumed.");
      } else if (body.startsWith("/retry")) {
        const match = body.match(/\/retry\s+([A-Za-z0-9_-]+)/);
        if (match) {
          const taskId = match[1];
          const task = roadmap.tasks.find(t => t.id === taskId);
          if (task) {
            console.log(`🔄 ChatOps command received: /retry ${taskId}`);
            task.status = "PENDING";
            task.attempts = 0;
            hasChanges = true;
            await this.acknowledgeComment(dashboardNumber, commentId, `🔄 **Task [${taskId}] Re-queued:** Reset attempts to 0 and marked status as PENDING.`);
          } else {
            await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ **Task Not Found:** No task found with ID \`${taskId}\`.`);
          }
        }
      } else if (body.startsWith("/directive")) {
        const match = body.match(/\/directive\s+([A-Za-z0-9_-]+)\s+([\s\S]+)/);
        if (match) {
          const taskId = match[1];
          const directive = match[2].trim().replace(/^["']|["']$/g, "");
          const task = roadmap.tasks.find(t => t.id === taskId);
          if (task) {
            console.log(`🎯 ChatOps command received: /directive for ${taskId}: ${directive}`);
            task.reviewNotes = `[OPERATOR DIRECTIVE]: ${directive}`;
            
            // If task is currently active in a workflow, cancel the run and reset to PENDING
            const activeRuns = await GitManager.getActiveSubagentRuns();
            const taskRun = activeRuns.find(r => r.headBranch === task.branch);
            if (taskRun) {
              console.log(`🛑 Cancelling active run #${taskRun.databaseId} to apply new directive...`);
              await GitManager.cancelWorkflowRun(taskRun.databaseId);
            }

            task.status = "PENDING";
            hasChanges = true;
            await this.acknowledgeComment(dashboardNumber, commentId, `🎯 **Directive Applied to [${taskId}]:**\n> "${directive}"\n\nTask re-steered and queued for execution.`);
          } else {
            await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ **Task Not Found:** No task with ID \`${taskId}\`.`);
          }
        }
      } else if (body.startsWith("/status")) {
        console.log("📊 ChatOps command received: /status");
        const summary = StateManager.renderProgressMarkdown(roadmap, { redact: this.isRedacted() });
        await this.acknowledgeComment(dashboardNumber, commentId, `📊 **Current Status Report:**\n\n${summary}`);
      } else if (body.startsWith("/discuss")) {
        const match = body.match(/\/discuss\s+([A-Za-z0-9_-]+)\s+([\s\S]+)/);
        if (match) {
          const taskId = match[1];
          const message = match[2].trim().replace(/^["']|["']$/g, "");
          const task = roadmap.tasks.find(t => t.id === taskId);
          if (task) {
            const { DiscussionManager } = await import("./discussion_manager.ts");
            const thread = await DiscussionManager.findOrCreateTaskDiscussion(task);
            if (thread) {
              await DiscussionManager.postComment(thread.id, `**🧑‍💼 Operator:**\n${message}`);
              await this.acknowledgeComment(dashboardNumber, commentId, `💬 **Relayed to [${taskId}] discussion #${thread.number}.** The agent will see it on its next retry.`);
            } else {
              await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ **Discussions unavailable** — could not relay to [${taskId}].`);
            }
          } else {
            await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ **Task Not Found:** No task with ID \`${taskId}\`.`);
          }
        }
      }
    }

    return hasChanges;
  }

  /**
   * Add reaction and reply to an acknowledged ChatOps comment.
   * Uses GraphQL addReaction: `gh issue view` only exposes the global node
   * ID (IC_...), which the REST reactions endpoint rejects — that silent 404
   * used to leave commands unmarked, reprocessing them on every tick.
   */
  private static async acknowledgeComment(issueNumber: number, commentId: string | number, replyText: string): Promise<void> {
    if (commentId && typeof commentId === "string" && commentId.startsWith("IC_")) {
      await GitManager.run([
        "gh", "api", "graphql",
        "-F", `subjectId=${commentId}`,
        "-F", "content=ROCKET",
        "-f",
        "query=mutation($subjectId:ID!,$content:ReactionContent!){addReaction(input:{subjectId:$subjectId,content:$content}){reaction{content}}}",
      ]);
    }
    await GitManager.run([
      "gh", "issue", "comment", String(issueNumber),
      "--body", replyText
    ]);
  }

  /**
   * Check and close completed GitHub Milestone
   */
  public static async closeMilestoneIfCompleted(milestoneTitle: string): Promise<boolean> {
    // Match the title in code: --jq interpolation breaks on quotes/& in titles.
    const listRes = await GitManager.run([
      "gh", "api", "repos/:owner/:repo/milestones?state=open&per_page=100",
    ]);

    if (listRes.exitCode === 0 && listRes.stdout.trim()) {
      try {
        const items = JSON.parse(listRes.stdout);
        const list = Array.isArray(items) ? items : [items];
        const m = list.find((x: any) => x.title === milestoneTitle);
        if (m) {
          console.log(`🏷️ Closing completed Milestone: "${milestoneTitle}" (#${m.number})...`);
          await GitManager.run([
            "gh", "api", `repos/:owner/:repo/milestones/${m.number}`,
            "-X", "PATCH",
            "-f", "state=closed"
          ]);
          return true;
        }
      } catch {}
    }
    return false;
  }

  /**
   * Post a milestone comment on the dashboard
   */
  public static async postMilestoneUpdate(issueNumber: number, comment: string): Promise<void> {
    await GitManager.run([
      "gh", "issue", "comment", String(issueNumber),
      "--body", comment
    ]);
  }

  /**
   * Create a Git Tag and GitHub Release upon project milestone or completion
   */
  public static async createMilestoneRelease(tag: string, title: string, notes: string): Promise<boolean> {
    console.log(`🏷️ Creating Git Tag ${tag} and GitHub Release...`);
    await GitManager.run(["git", "tag", "-a", tag, "-m", title]);
    await GitManager.run(["git", "push", "origin", tag]);

    const res = await GitManager.run([
      "gh", "release", "create", tag,
      "--title", title,
      "--notes", notes
    ]);

    if (res.exitCode === 0) {
      console.log(`📦 GitHub Release ${tag} successfully published!`);
      return true;
    }
    return false;
  }
}
