import { describe, it, expect } from "bun:test";
import { GitManager } from "../orchestrator/git_manager.ts";

describe("progressMergeDriverContent", () => {
  it("writes a fresh file when absent", () => {
    for (const existing of [null, "", "   \n  "]) {
      const out = GitManager.progressMergeDriverContent(existing);
      expect(out).not.toBeNull();
      expect(out!).toContain(GitManager.PROGRESS_MERGE_RULE);
      expect(out!).toContain("* text=auto");
    }
  });
  it("returns null when the rule is already present", () => {
    const withRule = `# stuff\n* text=auto\n${GitManager.PROGRESS_MERGE_RULE}\n`;
    expect(GitManager.progressMergeDriverContent(withRule)).toBeNull();
    const crlf = withRule.replace(/\n/g, "\r\n");
    expect(GitManager.progressMergeDriverContent(crlf)).toBeNull();
  });
  it("appends the rule to other content without duplicating", () => {
    const out = GitManager.progressMergeDriverContent("# Auto detect\n* text=auto\n");
    expect(out).not.toBeNull();
    expect(out!).toContain("* text=auto");
    expect(out!.split(GitManager.PROGRESS_MERGE_RULE).length).toBe(2);
  });
});
