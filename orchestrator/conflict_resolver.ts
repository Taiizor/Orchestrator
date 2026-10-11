import { GitManager } from "./git_manager.ts";
import { OpenCodeClient } from "./opencode_client.ts";
import { verifyAllWorkspaceStacks } from "./stacks.ts";

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

      // Extract resolved content from markdown code blocks. The model wraps
      // the file in ONE fence, but resolved CONTENT may itself contain
      // fences (markdown docs, READMEs) — a non-greedy first-close match
      // would silently truncate the file mid-content. Prefer the LAST
      // closing fence; fall back to raw output only when no fence exists.
      // A resolved file suspiciously smaller than the conflicted input is
      // rejected outright (truncation is data loss that tests may not catch).
      let resolvedContent: string;
      const openIdx = aiRes.stdout.search(/```(?:[a-zA-Z0-9_-]+)?\n/);
      const closeIdx = aiRes.stdout.lastIndexOf("\n```");
      if (openIdx >= 0 && closeIdx > openIdx) {
        const openEnd = aiRes.stdout.indexOf("\n", openIdx) + 1;
        resolvedContent = aiRes.stdout.slice(openEnd, closeIdx);
      } else {
        // No fence pair: strip a lone leading/trailing fence line if the
        // model fenced sloppily, else take the raw output as-is.
        resolvedContent = aiRes.stdout
          .trim()
          .replace(/^```(?:[a-zA-Z0-9_-]+)?\n/, "")
          .replace(/\n```$/, "");
      }
      if (resolvedContent.length < fileContent.length * 0.3) {
        console.error(
          `❌ Conflict resolution for ${filePath} suspiciously short (${resolvedContent.length} vs ${fileContent.length} chars); refusing to commit a truncation.`
        );
        return false;
      }

      // Ensure no conflict markers remain
      if (resolvedContent.includes("<<<<<<<") || resolvedContent.includes("=======") || resolvedContent.includes(">>>>>>>")) {
        console.error(`❌ Conflict resolution failed for ${filePath}: conflict markers still present.`);
        return false;
      }

      await Bun.write(filePath, resolvedContent);
      await GitManager.run(["git", "add", filePath]);
      console.log(`✅ Conflict resolved and staged for ${filePath}`);
    }

    // Verify resolved code with every workspace stack's tests (tests live
    // under workspace/, not repo root). An empty suite ("No tests found")
    // is a PASS — there is nothing to break. Only real failures block.
    // Mixed trees verify each layer so one green suite can't mask another's
    // breakage. Stacks are detected from workspace markers.
    if (!(await verifyAllWorkspaceStacks())) {
      return false;
    }

    console.log("✨ All merge conflicts successfully reconciled and verified!");
    return true;
  }
}
