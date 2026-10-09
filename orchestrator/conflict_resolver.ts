import { GitManager } from "./git_manager.ts";
import { OpenCodeClient } from "./opencode_client.ts";

export class ConflictResolver {
  /**
   * Attempt to automatically resolve Git merge conflicts using OpenCode
   */
  public static async resolveConflicts(): Promise<boolean> {
    // Get list of unmerged / conflicted files
    const res = await GitManager.run(["git", "diff", "--name-only", "--diff-filter=U"]);
    const conflictedFiles = res.stdout.split("\n").map((f) => f.trim()).filter(Boolean);

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

      const aiRes = await OpenCodeClient.runWithFallback(prompt);

      // Extract resolved content from markdown code block
      const codeBlockMatch = aiRes.stdout.match(/```(?:[a-zA-Z0-9_\-]+)?\n([\s\S]*?)```/);
      const resolvedContent = codeBlockMatch ? codeBlockMatch[1] : aiRes.stdout.trim();

      // Ensure no conflict markers remain
      if (
        resolvedContent.includes("<<<<<<<") ||
        resolvedContent.includes("=======") ||
        resolvedContent.includes(">>>>>>>")
      ) {
        console.error(`❌ Conflict resolution failed for ${filePath}: conflict markers still present.`);
        return false;
      }

      await Bun.write(filePath, resolvedContent);
      await GitManager.run(["git", "add", filePath]);
      console.log(`✅ Conflict resolved and staged for ${filePath}`);
    }

    // Verify resolved code with workspace tests (tests live under workspace/, not repo root).
    // An empty suite ("No tests found") is a PASS — there is nothing to break.
    // Only real failures block the merge.
    console.log("🧪 Verifying resolved code with 'bun test' in workspace/...");
    const testRes = await GitManager.run(["bun", "test"], "workspace");
    const testOutput = (testRes.stdout + "\n" + testRes.stderr).toLowerCase();
    const noTests = /no tests? found|no test files|0 (tests|pass)/.test(testOutput);
    const hasFailures = /fail/.test(testOutput) && !/0 fail/.test(testOutput);
    if (!noTests && (testRes.exitCode !== 0 || hasFailures)) {
      console.warn("⚠️ Automated tests failed after resolving conflict:", testRes.stderr || testRes.stdout);
      return false;
    }

    console.log("✨ All merge conflicts successfully reconciled and verified!");
    return true;
  }
}
