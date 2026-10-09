import { GitManager } from "./git_manager.ts";
import { CONFIG } from "./config.ts";
import { StateManager } from "./state_manager.ts";
import type { Roadmap } from "./types.ts";

export class IssueManager {
  private static readonly DASHBOARD_TITLE = "🚀 Project Dashboard & Agent Progress Board";

  /** Levenshtein distance for ChatOps typo tolerance. */
  private static editDistance(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[m][n];
  }

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
   * Pin the dashboard issue above the repo issues list (max 3 pinned).
   * Best-effort: already-pinned or quota-full must never fail the tick.
   */
  private static async pinDashboardIssue(issueNumber: number): Promise<void> {
    const res = await GitManager.run(["gh", "issue", "pin", String(issueNumber)]);
    if (res.exitCode !== 0) {
      console.warn(`⚠️ Could not pin Dashboard Issue #${issueNumber}:`, res.stderr.slice(0, 300));
    } else {
      console.log(`📌 Pinned Dashboard Issue #${issueNumber}`);
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
      `- \`/tick\`: Trigger an immediate orchestration cycle\n` +
      `- \`/directive <TASK-ID> "New instruction"\`: Steer or correct an active or pending task\n` +
      `- \`/retry <TASK-ID>\`: Re-queue a failed or stuck task\n` +
      `- \`/status\`: Request an immediate status report comment\n` +
      `- \`/discuss <TASK-ID> "message"\`: Relay a message to the task's agent discussion thread\n` +
      `- \`/setup [public|data|all]\`: Audit & repair repo features (issues/wiki/projects/discussions)\n` +
      `- \`/ask <question>\`: Answer from live roadmap state\n` +
      `- \`/add <role> "title" -- "description" [deps:A,B] [milestone:M]\`: Queue a validated PENDING task\n` +
      `- \`/log <TASK-ID>\`: Tail of recent subagent run logs\n` +
      `- \`/revise <TASK-ID> "change"\`: Rework a finished task + cascade-rebuild dependents\n`;

    if (issueNumber) {
      // Update existing issue body
      await GitManager.run([
        "gh", "issue", "edit", String(issueNumber),
        "--body", bodyContent
      ]);
      console.log(`📋 Updated Dashboard Issue #${issueNumber}`);
      await this.pinDashboardIssue(issueNumber);
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
          await this.pinDashboardIssue(issueNumber);
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
      let body = (comment.body || "").trim();
      const commentId = comment.id || comment.databaseId;

      // Skip comments by bot itself (login varies: github-actions[bot] vs github-actions)
      if (/github-actions/i.test(comment.author?.login || "")) continue;
      // Skip if already processed (marked with rocket or thumbs up)
      if (comment.reactionGroups?.some((r: any) => (r.content === "ROCKET" || r.content === "THUMBS_UP") && r.users?.totalCount > 0)) {
        continue;
      }
      if (!body.startsWith("/")) continue;

      // Typo tolerance: /staus, /pausse, /statuss... (edit distance ≤ 2).
      // Unknown commands get the help text instead of silence.
      const KNOWN = ["pause", "resume", "tick", "retry", "directive", "revise", "status", "discuss", "setup", "ask", "add", "log"];
      const wordMatch = body.match(/^\/([A-Za-z]+)/);
      if (wordMatch) {
        const word = wordMatch[1].toLowerCase();
        if (!KNOWN.includes(word)) {
          const close = KNOWN.map((k) => ({ k, d: this.editDistance(word, k) }))
            .filter((x) => x.d <= 2)
            .sort((a, b) => a.d - b.d)[0];
          if (close) {
            console.log(`🔤 Interpreting /${word} as /${close.k} (typo tolerance).`);
            body = `/${close.k}` + body.slice(wordMatch[0].length);
            await this.acknowledgeComment(dashboardNumber, commentId, `🔤 Understood \`/${word}\` as \`/${close.k}\` — processing.`);
          } else {
            await this.acknowledgeComment(
              dashboardNumber, commentId,
              `❓ Unknown command \`/${word}\`.\n\nAvailable: ${KNOWN.map((k) => `\`/${k}\``).join(", ")}`
            );
            continue;
          }
        }
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
      } else if (body.startsWith("/tick")) {
        // /tick — request an immediate orchestration cycle via
        // workflow_dispatch (default action=tick). Dedupe like the
        // subagent wake: skip when a run is already queued/active.
        console.log("🔔 ChatOps command received: /tick");
        const pending = await GitManager.run(["gh", "run", "list", "--workflow", "orchestrator.yml", "--limit", "5", "--json", "status", "--jq", '[.[] | select(.status == "queued" or .status == "in_progress" or .status == "waiting" or .status == "requested")] | length']);
        const count = parseInt(pending.stdout.trim(), 10);
        if (!Number.isNaN(count) && count > 0) {
          await this.acknowledgeComment(dashboardNumber, commentId, `🔔 **Tick already queued/running** (${count}) — skipping duplicate wake.`);
        } else {
          const trig = await GitManager.run(["gh", "workflow", "run", "orchestrator.yml"]);
          if (trig.exitCode === 0) {
            await this.acknowledgeComment(dashboardNumber, commentId, "🔔 **Tick requested:** orchestration cycle dispatched, results land on this board.");
          } else {
            await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ **Tick dispatch failed:** ${trig.stderr.slice(0, 200)}`);
          }
        }
      } else if (body.startsWith("/retry")) {
        // Stacked retries in one comment are all honored (/retry A \n /retry B).
        const targets = [...body.matchAll(/\/retry\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
        if (targets.length === 0) {
          await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ Usage: \`/retry <TASK-ID>\` (one per line, several allowed).`);
        }
        for (const taskId of targets) {
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
      } else if (body.startsWith("/revise")) {
        // /revise <TASK-ID> "instruction" — surgical rework as a FOCUSED task.
        // Unlike cascade resets (which avalanche-rebuild dependents), this
        // queues ONE task depending on the target: it audits every workspace
        // change related to the topic, applies the fix, and re-verifies.
        // Originals stay COMPLETED (history preserved); downstream owners get
        // an FYI list for optional follow-up revises.
        const match = body.match(/\/revise\s+([A-Za-z0-9_-]+)\s+([\s\S]+)/);
        if (!match) {
          await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ Usage: \`/revise <TASK-ID> "what to change"\`.`);
        } else {
          const taskId = match[1];
          const instruction = match[2].trim().replace(/^["']|["']$/g, "");
          const task = roadmap.tasks.find(t => t.id === taskId);
          if (!task) {
            await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ **Task Not Found:** No task with ID \`${taskId}\`.`);
          } else {
            console.log(`🔁 ChatOps command received: /revise for ${taskId}: ${instruction}`);
            const { validateRoadmap, formatValidation } = await import("./roadmap_validator.ts");
            const { CONFIG } = await import("./config.ts");
            const nums = roadmap.tasks.map((t) => parseInt((t.id.match(/(\d+)/) || ["0", "0"])[1], 10) || 0);
            const nextId = `TASK-${String(Math.max(0, ...nums) + 1).padStart(3, "0")}`;
            const downstream = roadmap.tasks.filter((t) => t.dependencies.includes(taskId)).map((t) => t.id);
            const check = validateRoadmap({
              tasks: [...roadmap.tasks.map((t) => ({ id: t.id, role: t.role, dependencies: t.dependencies, targetFiles: t.targetFiles, milestone: t.milestone })), { id: nextId, role: task.role, dependencies: [taskId], targetFiles: [], milestone: task.milestone }],
              milestones: roadmap.milestones,
            });
            if (check.errors.length > 0) {
              await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ **Revision rejected by DAG validation:**\n${formatValidation(check)}`);
            } else {
              const now = new Date().toISOString();
              roadmap.tasks.push({
                id: nextId,
                title: `Revise [${taskId}]: ${instruction.slice(0, 80)}`,
                description:
                  `Surgical revision of completed task [${taskId}] (${task.title}).\n\n` +
                  `Operator instruction (highest priority): ${instruction}\n\n` +
                  `Scope: audit EVERY workspace change related to this topic (it may span files owned by other tasks), apply the fix, keep unrelated behavior intact. ` +
                  `Update workspace/CONTRACTS.md if any contract changes. ` +
                  `Re-run the verifications that cover the touched behavior (including downstream areas: ${downstream.length > 0 ? downstream.map((d) => `\`${d}\``).join(", ") : "none downstream"}). ` +
                  `Provide bun test proof in TASK_PROGRESS.md.`,
                role: task.role,
                dependencies: [taskId],
                targetFiles: [],
                status: "PENDING",
                branch: `task/${nextId}`,
                milestone: task.milestone,
                attempts: 0,
                maxAttempts: CONFIG.MAX_TASK_ATTEMPTS,
                reviewNotes: `[REVISION of ${taskId}] Unscoped task — reviewer judges file relevance. Original [${taskId}] stays COMPLETED.`,
                createdAt: now,
                updatedAt: now,
              });
              hasChanges = true;
              const fyi = downstream.length > 0
                ? `\n\nDownstream FYI (verify, revise only if broken): ${downstream.map((d) => `\`${d}\``).join(", ")}.`
                : "";
              await this.acknowledgeComment(
                dashboardNumber, commentId,
                `🔁 **Revision [${nextId}] queued** (depends on \`${taskId}\`, role \`${task.role}\`). Issue + board sync on next tick.${fyi}`
              );
            }
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
      } else if (body.startsWith("/setup")) {
        // /setup [public|data|all] — one-shot repo settings audit & repair
        // from ChatOps. Writes need an admin PAT; otherwise reports only.
        console.log("🔧 ChatOps command received: /setup");
        const scope = (body.match(/^\/setup\s*(public|data|all)?/) || [])[1] || "all";
        const { RepoSetup } = await import("./repo_setup.ts");
        const { ProjectManager } = await import("./project_manager.ts");
        const { CONFIG } = await import("./config.ts");
        const publicFeatures = RepoSetup.parseFeatures(CONFIG.PUBLIC_FEATURES, RepoSetup.defaultFeatures("public"));
        const dataFeatures = RepoSetup.parseFeatures(CONFIG.DATA_FEATURES, RepoSetup.defaultFeatures("data"));
        const out: string[] = [];
        const wantPublic = scope === "public" || scope === "all";
        const wantData = scope === "data" || scope === "all";
        if (wantPublic) {
          const repo = await GitManager.run(["gh", "repo", "view", "--json", "owner,name", "--jq", "[.owner.login, .name] | join(\"/\")"]);
          if (repo.exitCode === 0 && repo.stdout.includes("/")) {
            const [o, n] = repo.stdout.trim().split("/");
            const r = await RepoSetup.ensureRepoSettings(o, n, CONFIG.PROJECT_TOKEN, publicFeatures);
            out.push(`### ${r.repo}\n${r.lines.join("\n")}`);
          } else {
            out.push(`⚠️ Could not determine current repository.`);
          }
        }
        if (wantData) {
          if (GitManager.isDataMode()) {
            const slug = GitManager.dataRepoSlug();
            if (slug) {
              const [o, n] = slug.split("/");
              const r = await RepoSetup.ensureRepoSettings(o, n, GitManager.dataPat(), dataFeatures);
              out.push(`### ${r.repo}\n${r.lines.join("\n")}`);
            }
          } else {
            out.push(`ℹ️ No data repo configured (DATA_REPO empty) — nothing to check.`);
          }
        }
        await this.acknowledgeComment(dashboardNumber, commentId, `🔧 **Setup Report (${scope}):**\n\n${out.join("\n\n")}`);
      } else if (body.startsWith("/ask")) {
        // /ask <question> — answer from live roadmap state via one LLM call.
        const question = body.replace(/^\/ask\s*/, "").trim();
        if (!question) {
          await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ Usage: \`/ask <question about project state>\`.`);
        } else {
          console.log("❓ ChatOps command received: /ask");
          const { OpenCodeClient } = await import("./opencode_client.ts");
          const digest = roadmap.tasks.map((t) =>
            `- [${t.id}] ${t.title} | ${t.role} | ${t.status} | deps:[${t.dependencies.join(",") || "-"}] | attempts:${t.attempts}/${t.maxAttempts}` +
            (t.reviewNotes ? ` | notes: ${t.reviewNotes.slice(0, 200)}` : "")
          ).join("\n");
          const answer = await OpenCodeClient.runWithFallback(
            `You are the orchestrator of an autonomous coding team. Answer the operator's question using ONLY the live roadmap below. Be concise, cite task IDs.\n\nRoadmap (${roadmap.projectName}, ${roadmap.globalStatus}):\n${digest}\n\nOperator question: ${question}`,
            { timeoutMs: 4 * 60 * 1000 }
          );
          const text = answer.stdout.trim().slice(0, 3000) || "(empty model response)";
          await this.acknowledgeComment(dashboardNumber, commentId, `❓ **Answer:**\n\n${text}`);
        }
      } else if (body.startsWith("/add")) {
        // /add <role> "title" -- "description" [deps:A,B] [milestone:M]
        // Appends a PENDING task after DAG validation. Issues/board sync on next tick.
        console.log("➕ ChatOps command received: /add");
        const parsed = body.match(/^\/add\s+([A-Za-z]+)\s+"([^"]+)"\s+--\s+"([^"]+)"(?:\s+deps:([A-Za-z0-9_,-]+))?(?:\s+milestone:(.+))?/);
        if (!parsed) {
          await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ Usage: \`/add <role> "title" -- "description" [deps:TASK-001,TASK-002] [milestone:v1.0.0]\`\nRoles: architect|backend|frontend|qa|security|tracker|reviewer|fullstack.`);
        } else {
          const [, role, title, description, depStr, milestone] = parsed;
          const { validateRoadmap, formatValidation } = await import("./roadmap_validator.ts");
          const { CONFIG } = await import("./config.ts");
          const nums = roadmap.tasks.map((t) => parseInt((t.id.match(/(\d+)/) || ["0", "0"])[1], 10) || 0);
          const nextId = `TASK-${String(Math.max(0, ...nums) + 1).padStart(3, "0")}`;
          const deps = depStr ? depStr.split(",").map((d) => d.trim()).filter(Boolean) : [];
          const candidate = {
            id: nextId, role, dependencies: deps, targetFiles: [] as string[],
            milestone: (milestone || "").trim() || undefined,
          };
          const check = validateRoadmap({
            tasks: [...roadmap.tasks.map((t) => ({ id: t.id, role: t.role, dependencies: t.dependencies, targetFiles: t.targetFiles, milestone: t.milestone })), candidate],
            milestones: roadmap.milestones,
          });
          if (check.errors.length > 0) {
            await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ **Task rejected by DAG validation:**\n${formatValidation(check)}`);
          } else {
            const now = new Date().toISOString();
            roadmap.tasks.push({
              id: nextId, title, description, role: role as any, dependencies: deps,
              targetFiles: [], status: "PENDING", branch: `task/${nextId}`,
              milestone: candidate.milestone || roadmap.milestones?.[0]?.title,
              attempts: 0, maxAttempts: CONFIG.MAX_TASK_ATTEMPTS,
              reviewNotes: "[OPERATOR ADDED] via /add. NOTE: no targetFiles scoping — planner normally assigns disjoint paths; watch for conflicts.",
              createdAt: now, updatedAt: now,
            });
            hasChanges = true;
            const warn = check.warnings.length > 0 ? `\n\nWarnings:\n${formatValidation({ errors: [], warnings: check.warnings })}` : "";
            await this.acknowledgeComment(dashboardNumber, commentId, `➕ **Task [${nextId}] queued as PENDING.** Issue + board sync on next tick.${warn}`);
          }
        }
      } else if (body.startsWith("/log")) {
        // /log <TASK-ID> — tail of the latest subagent run for that task.
        const match = body.match(/\/log\s+([A-Za-z0-9_-]+)/);
        if (!match) {
          await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ Usage: \`/log <TASK-ID>\`.`);
        } else {
          const taskId = match[1];
          const task = roadmap.tasks.find(t => t.id === taskId);
          if (!task) {
            await this.acknowledgeComment(dashboardNumber, commentId, `⚠️ **Task Not Found:** No task with ID \`${taskId}\`.`);
          } else {
            console.log(`📜 ChatOps command received: /log ${taskId}`);
            let tail = "";
            const runIds: number[] = [];
            if (task.runId) runIds.push(task.runId);
            // Subagent runs execute on main, so per-task correlation isn't
            // available — use the stored runId, else the newest runs.
            const probe = await GitManager.run([
              "gh", "run", "list", "--workflow", "subagent.yml",
              "--limit", "20", "--json", "databaseId,headBranch,createdAt",
            ]);
            if (probe.exitCode === 0) {
              try {
                const all = JSON.parse(probe.stdout);
                for (const r of all) {
                  if (typeof r.databaseId === "number" && !runIds.includes(r.databaseId)) {
                    runIds.push(r.databaseId);
                    if (runIds.length >= 3) break;
                  }
                }
              } catch { /* ignore */ }
            }
            for (const id of runIds.slice(0, 2)) {
              const chunk = await GitManager.getRunLogs(id);
              if (chunk) {
                tail = `--- run #${id} ---\n${chunk}\n${tail}`;
                break;
              }
            }
            if (!tail) {
              tail = `No retrievable logs (no stored runId, no recent subagent runs).`;
            }
            await this.acknowledgeComment(dashboardNumber, commentId, `📜 **Run log tail for [${taskId}]:**\n\`\`\`\n${tail.slice(-2500) || "(empty)"}\n\`\`\``);
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
   * Create a Git Tag and GitHub Release upon project milestone or completion.
   * Dual-repo mode: the product (workspace/) lives in the private data repo,
   * so the tag and release go there (data develop tip), never to the public
   * skeleton. Single-repo fallback keeps the old origin behavior.
   */
  public static async createMilestoneRelease(tag: string, title: string, notes: string): Promise<boolean> {
    console.log(`🏷️ Creating Git Tag ${tag} and GitHub Release...`);
    if (GitManager.isDataMode()) {
      const remote = GitManager.contentRemote();
      const slug = GitManager.dataRepoSlug();
      if (!slug) {
        console.warn(`⚠️ DATA_REPO unparseable; skipping release ${tag}.`);
        return false;
      }
      // Ambient GITHUB_TOKEN cannot see the private data repo; run gh
      // under the data PAT (same pattern as RepoSetup.runAs).
      const pat = GitManager.dataPat();
      const ghEnv = pat ? { GH_TOKEN: pat, GITHUB_TOKEN: pat } : undefined;
      // Idempotency: milestone close/open thrash (or a manual backfill) must
      // never 422 — an existing release for this tag counts as success.
      const existing = await GitManager.run(["gh", "release", "view", tag, "--repo", slug], ".", undefined, ghEnv);
      if (existing.exitCode === 0) {
        console.log(`ℹ️ Release ${tag} already exists on ${slug}; skipping.`);
        return true;
      }
      // Tag the data integration-branch tip (NOT this checkout's HEAD,
      // which is engine code). Refresh the ref first; the tick may hold a
      // stale fetch.
      const branch = CONFIG.INTEGRATION_BRANCH;
      await GitManager.remoteGit(remote, ["fetch", remote, branch]);
      const tip = await GitManager.run(["git", "rev-parse", `${remote}/${branch}`]);
      const sha = tip.stdout.trim();
      if (tip.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
        console.warn(`⚠️ Cannot resolve ${remote}/${branch} tip; skipping release ${tag}.`);
        return false;
      }
      const tagExists = await GitManager.remoteGit(remote, ["ls-remote", remote, `refs/tags/${tag}`]);
      if (tagExists.exitCode !== 0 || !tagExists.stdout.trim()) {
        await GitManager.run(["git", "tag", "-a", tag, sha, "-m", title]);
        const push = await GitManager.remoteGit(remote, ["push", remote, tag]);
        if (push.exitCode !== 0) {
          console.warn(`⚠️ Tag push failed for ${tag}:`, push.stderr.slice(0, 200));
          return false;
        }
      } else {
        console.log(`ℹ️ Tag ${tag} already on ${remote}; reusing for release.`);
      }
      const res = await GitManager.run(
        ["gh", "release", "create", tag, "--repo", slug, "--title", title, "--notes", notes],
        ".",
        undefined,
        ghEnv
      );
      if (res.exitCode === 0) {
        console.log(`📦 GitHub Release ${tag} successfully published to ${slug}!`);
        return true;
      }
      console.warn(`⚠️ Release create failed for ${tag}:`, res.stderr.slice(0, 200));
      return false;
    }
    const already = await GitManager.run(["gh", "release", "view", tag]);
    if (already.exitCode === 0) {
      console.log(`ℹ️ Release ${tag} already exists; skipping.`);
      return true;
    }
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
