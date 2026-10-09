import { GitManager } from "./git_manager.ts";
import type { TaskItem } from "./types.ts";

/**
 * Agent discussion bridge (GitHub Discussions, GraphQL).
 *
 * Gives subagents a shared place to ask for help, share findings, and read
 * peer/operator replies. Every method is fail-soft: when Discussions are
 * disabled or the token lacks scope, it logs an actionable hint and returns
 * null instead of crashing the agent run.
 */
export class DiscussionManager {
  private static readonly CATEGORY_NAME = process.env.AGENT_DISCUSSION_CATEGORY || "General";
  private static scopeWarned = false;

  /**
   * Per-process caches: repo/category/thread ids never change mid-run, so
   * resolve each once. Saves ~3 GraphQL calls per subagent run (the quota
   * that kept dying). getRecentReplies stays live (freshness matters).
   */
  private static repoIdCache: string | null | undefined = undefined;
  private static catIdCache: string | null | undefined = undefined;
  private static threadCache = new Map<string, { number: number; id: string } | null>();

  /**
   * GraphQL repo variables: the DATA repo in dual-repo mode (discussions
   * carry progress heads, so they stay private), else current-repo
   * placeholders expanded by gh.
   */
  private static repoVars(): [string, string] {
    if (GitManager.isDataMode()) {
      const slug = GitManager.dataRepoSlug();
      if (slug) {
        const [owner, name] = slug.split("/");
        return [`owner=${owner}`, `name=${name}`];
      }
    }
    return ["owner={owner}", "name={repo}"];
  }

  private static scopeHint(stderr: string): boolean {
    if (/scope|forbidden|not found|NOT_FOUND|disabled/i.test(stderr)) {
      if (!this.scopeWarned) {
        this.scopeWarned = true;
        console.warn(
          "⚠️ Discussions unavailable (disabled repo feature or token lacks scope). " +
          "Enable Discussions in repo settings and ensure the token has `discussions: write`."
        );
      }
      return true;
    }
    return false;
  }

  private static async repoId(): Promise<string | null> {
    if (this.repoIdCache !== undefined) return this.repoIdCache;
    const [ownerVar, nameVar] = this.repoVars();
    const res = await GitManager.run([
      "gh", "api", "graphql",
      "-F", ownerVar,
      "-F", nameVar,
      "-f",
      "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}",
    ]);
    if (res.exitCode !== 0) {
      this.scopeHint(res.stderr);
      this.repoIdCache = null;
      return null;
    }
    try {
      this.repoIdCache = JSON.parse(res.stdout).data.repository.id;
      return this.repoIdCache;
    } catch {
      this.repoIdCache = null;
      return null;
    }
  }

  private static async categoryId(): Promise<string | null> {
    if (this.catIdCache !== undefined) return this.catIdCache;
    const [ownerVar, nameVar] = this.repoVars();
    const res = await GitManager.run([
      "gh", "api", "graphql",
      "-F", ownerVar,
      "-F", nameVar,
      "-f",
      "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){discussionCategories(first:20){nodes{id,name}}}}",
    ]);
    if (res.exitCode !== 0) {
      this.scopeHint(res.stderr);
      this.catIdCache = null;
      return null;
    }
    try {
      const nodes = JSON.parse(res.stdout).data.repository.discussionCategories.nodes;
      const hit = nodes.find((c: any) => c.name.toLowerCase() === this.CATEGORY_NAME.toLowerCase())
        || nodes.find((c: any) => c.name.toLowerCase() === "general");
      this.catIdCache = hit ? hit.id : null;
      return this.catIdCache;
    } catch {
      this.catIdCache = null;
      return null;
    }
  }

  /**
   * List recent discussions (title + number) and match a task thread in code.
   * Avoids fragile server-side title search syntax.
   */
  public static async findTaskDiscussion(taskId: string): Promise<{ number: number; id: string } | null> {
    const cached = this.threadCache.get(taskId);
    if (cached !== undefined) return cached;
    const [ownerVar, nameVar] = this.repoVars();
    const res = await GitManager.run([
      "gh", "api", "graphql",
      "-F", ownerVar,
      "-F", nameVar,
      "-f",
      "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){discussions(first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{id,number,title}}}}",
    ]);
    if (res.exitCode !== 0) {
      this.scopeHint(res.stderr);
      return null;
    }
    try {
      const nodes = JSON.parse(res.stdout).data.repository.discussions.nodes;
      const hit = nodes.find((d: any) => String(d.title).startsWith(`[${taskId}]`));
      const found = hit ? { number: hit.number, id: hit.id } : null;
      this.threadCache.set(taskId, found);
      return found;
    } catch {
      return null;
    }
  }

  public static async findOrCreateTaskDiscussion(task: TaskItem): Promise<{ number: number; id: string } | null> {
    const existing = await this.findTaskDiscussion(task.id);
    if (existing) return existing;

    const repositoryId = await this.repoId();
    if (!repositoryId) return null;
    const catId = await this.categoryId();
    if (!catId) return null;

    const title = `[${task.id}] ${task.title} — agent talk`;
    const body =
      `**Role:** \`${task.role}\` | **Branch:** \`${task.branch}\`\n\n` +
      `### Task\n${task.description}\n\n` +
      `---\n*Agents: ask for help, share blockers and findings here. ` +
      `Peers and operators can reply; replies are injected into retry prompts.*`;
    const res = await GitManager.run([
      "gh", "api", "graphql",
      "-F", `repositoryId=${repositoryId}`,
      "-F", `categoryId=${catId}`,
      "-F", `title=${title}`,
      "-F", `body=${body}`,
      "-f",
      "query=mutation($repositoryId:ID!,$categoryId:ID!,$title:String!,$body:String!){createDiscussion(input:{repositoryId:$repositoryId,categoryId:$categoryId,title:$title,body:$body}){discussion{id,number}}}",
    ]);
    if (res.exitCode !== 0) {
      this.scopeHint(res.stderr);
      return null;
    }
    try {
      const d = JSON.parse(res.stdout).data.createDiscussion.discussion;
      console.log(`💬 Created task discussion #${d.number} for [${task.id}]`);
      const created = { number: d.number, id: d.id };
      this.threadCache.set(task.id, created);
      return created;
    } catch {
      return null;
    }
  }

  public static async postComment(discussionId: string, body: string): Promise<boolean> {
    const res = await GitManager.run([
      "gh", "api", "graphql",
      "-F", `discussionId=${discussionId}`,
      "-F", `body=${body}`,
      "-f",
      "query=mutation($discussionId:ID!,$body:String!){addDiscussionComment(input:{discussionId:$discussionId,body:$body}){comment{id}}}",
    ]);
    if (res.exitCode !== 0) {
      this.scopeHint(res.stderr);
      return false;
    }
    return true;
  }

  /** Recent replies (oldest→newest) for prompt injection on retries. */
  public static async getRecentReplies(discussionId: string, limit = 5): Promise<string[]> {
    const res = await GitManager.run([
      "gh", "api", "graphql",
      "-F", `id=${discussionId}`,
      "-F", `n=${String(limit)}`,
      "-f",
      "query=query($id:ID!,$n:Int!){node(id:$id){... on Discussion{comments(last:$n){nodes{body,author{login},createdAt}}}}}",
    ]);
    if (res.exitCode !== 0) {
      this.scopeHint(res.stderr);
      return [];
    }
    try {
      const nodes = JSON.parse(res.stdout).data.node.comments.nodes;
      return nodes.map((c: any) => `@${c.author?.login || "?"} (${c.createdAt}):\n${c.body}`);
    } catch {
      return [];
    }
  }
}
