import { GitManager } from "./git_manager.ts";
import { OpenCodeClient } from "./opencode_client.ts";
import { detectWorkspaceStack, verifyWorkspace } from "./stacks.ts";

export class ConflictResolver {
  /**
   * Attempt to automatically resolve Git merge conflicts using OpenCode
   */
  public static async resolveConflicts(): Promise<boolean> {
    // Get list of unmerged / conflicted files
    const res = await GitManager.run(["git", "diff", "--name-only", "--diff-filter=U"]);
    const conflictedFiles = res.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    if (conflictedFiles.length === 0) {
      return true;
    }

    console.log(`⚠️ Detected ${conflictedFiles.length} conflicted files: ${conflictedFiles.join(", ")}`);
    const promptTemplate = await Bun.file("orchestrator/prompts/conflict_resolver.md").text();

    for (const filePath of conflictedFiles) {
      console.log(`🔧 AI resolving merge conflict in: ${filePath}...`);
      let fileContent = "";
      try {
        fileContent = await Bun.file(filePath).text();
      } catch (err) {
        console.error(`Could not read conflicted file ${filePath}:`, err);
        return false;
      }

      const prompt = `${promptTemplate}\n\nFile Path: ${filePath}\n\nConflicted Content:\n\`\`\`\n${fileContent}\n\`\`\`\n\nProvide the resolved file content now:`;

      const aiRes = await OpenCodeClient.runWithFallback(prompt, { timeoutMs: 8 * 60 * 1000 });

      // Extract resolved content from markdown code block
      const codeBlockMatch = aiRes.stdout.match(/```(?:[a-zA-Z0-9_\-]+)?\n([\s\S]*?)```/);
      const resolvedContent = codeBlockMatch ? codeBlockMatch[1] : aiRes.stdout.trim();

      // Ensure no conflict markers remain
      if (resolvedContent.includes("<<<<<<<") || resolvedContent.includes("=======") || resolvedContent.includes(">>>>>>>")) {
        console.error(`❌ Conflict resolution failed for ${filePath}: conflict markers still present.`);
        return false;
      }

      await Bun.write(filePath, resolvedContent);
      await GitManager.run(["git", "add", filePath]);
      console.log(`✅ Conflict resolved and staged for ${filePath}`);
    }

    // Verify resolved code with the workspace stack's tests (tests live under
    // workspace/, not repo root). An empty suite ("No tests found") is a
    // PASS — there is nothing to break. Only real failures block the merge.
    // The stack is detected from workspace markers (go.mod, Cargo.toml,
    // *.csproj, pyproject.toml); default is Bun.
    const stack = await detectWorkspaceStack(".");
    if (!(await verifyWorkspace(stack, "workspace"))) {
      return false;
    }

    console.log("✨ All merge conflicts successfully reconciled and verified!");
    return true;
  }
}
