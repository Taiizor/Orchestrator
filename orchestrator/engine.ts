import { parseArgs } from "util";
import { existsSync, statSync, mkdirSync, rmSync, cpSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { CONFIG } from "./config.ts";
import { StateManager } from "./state_manager.ts";
import { GitManager } from "./git_manager.ts";
import { OpenCodeClient } from "./opencode_client.ts";
import { IssueManager } from "./issue_manager.ts";
import { ProjectManager } from "./project_manager.ts";
import { GATE_VERSION, hasStructuredProgress, isDefaultProgress, runReviewGate } from "./review_gate.ts";
import { validateRoadmap, formatValidation } from "./roadmap_validator.ts";
import { initializeGitHubAppAuth } from "./github_app.ts";
import type { Roadmap, TaskItem, ReviewResult } from "./types.ts";

export class OrchestratorEngine {
  /**
   * Action: Plan roadmap from inputs
   */
  public static async plan(): Promise<void> {
    console.log("🧭 Planning roadmap from inputs/...");

    // Dual-repo: materialize private inputs before reading them.
    await GitManager.setupGitAuthor();
    await GitManager.run(["git", "fetch", "--all"]);
    if (GitManager.isDataMode()) {
      await GitManager.ensureDataRemote();
      await GitManager.syncDataIn(CONFIG.BASE_BRANCH);
    }

    if (!existsSync(CONFIG.INPUTS_DIR)) {
      console.error(`❌ inputs/ directory does not exist.`);
      process.exit(1);
    }

    const glob = new Bun.Glob("**/*");
    let fullInputContext = "## Project Specifications & Input Documents:\n\n";
    const assetList: string[] = [];
    let fileCount = 0;

    const imageExts = new Set([".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".ico", ".pdf", ".bmp"]);

    for await (const relPath of glob.scan({ cwd: CONFIG.INPUTS_DIR })) {
      if (relPath.endsWith(".gitkeep")) continue;
      // Skip default input guide README
      if (relPath === "README.md") continue;

      const fullPath = `${CONFIG.INPUTS_DIR}/${relPath}`;
      const dotIdx = relPath.lastIndexOf(".");
      const ext = dotIdx !== -1 ? relPath.slice(dotIdx).toLowerCase() : "";

      if (imageExts.has(ext)) {
        assetList.push(relPath);
      } else {
        try {
          const content = await Bun.file(fullPath).text();
          // If spec.md is untouched with only template comments, skip it so it doesn't clutter the context
          if (relPath === "spec.md") {
            const stripped = content
              .replace(/<!--[\s\S]*?-->/g, "")
              .replace(/^#.*$/gm, "")
              .trim();
            if (!stripped) continue;
            fullInputContext =
              `### High-Level Directives & Project Overrides (\`inputs/spec.md\`):\n\`\`\`\n${content}\n\`\`\`\n\n` +
              fullInputContext;
            fileCount++;
            continue;
          }
          if (content.trim()) {
            fullInputContext += `### File: \`inputs/${relPath}\`\n\`\`\`\n${content}\n\`\`\`\n\n`;
            fileCount++;
          }
        } catch (err) {
          console.warn(`Could not read text file inputs/${relPath}:`, err);
        }
      }
    }

    if (fileCount === 0 && assetList.length === 0) {
      console.error(
        "❌ No input specification files found in inputs/ directory. Please drop your project files or folder into inputs/."
      );
      process.exit(1);
    }

    if (assetList.length > 0) {
      fullInputContext += `### Available Visual Assets & Mockups:\n${assetList.map((a) => `- \`inputs/${a}\``).join("\n")}\n\n`;
    }

    console.log(`📂 Ingested ${fileCount} input document(s) and ${assetList.length} visual asset(s) from inputs/`);

    const systemPrompt = await Bun.file("orchestrator/prompts/system.md").text();

    // =========================================================================
    // STAGE 1: Requirements Analyst (Synthesize inputs into COMPILED_SPEC.md)
    // =========================================================================
    console.log("🧐 [Stage 1/3] Running Requirements Analyst to synthesize inputs into canonical specification...");
    let compiledSpecContent = "";

    const analystPromptPath = "orchestrator/prompts/analyst.md";
    if (existsSync(analystPromptPath)) {
      const analystPromptTemplate = await Bun.file(analystPromptPath).text();
      const analystPrompt = `${systemPrompt}\n\n${analystPromptTemplate}\n\n${fullInputContext}\nSynthesize all inputs into the canonical specification (state/COMPILED_SPEC.md) now:`;

      // Attach reference images/files so the analyst SEES mockups instead of
      // bare filenames (multimodal --file; server-side resized). Text inputs
      // are already inlined above; attachments cover the visual assets.
      const analystFiles = assetList.map((a) => `${CONFIG.INPUTS_DIR}/${a}`).filter((p) => existsSync(p));
      if (analystFiles.length > 0) {
        console.log(`🖼️ Attaching ${analystFiles.length} visual asset(s) to the analyst call.`);
      }
      const analystRes = await OpenCodeClient.runWithFallback(analystPrompt, { timeoutMs: 10 * 60 * 1000, files: analystFiles });
      if (analystRes.exitCode === 0 && analystRes.stdout.trim()) {
        compiledSpecContent = analystRes.stdout.trim();
        // Remove markdown code block wrappers if any
        if (compiledSpecContent.startsWith("```markdown")) {
          compiledSpecContent = compiledSpecContent
            .replace(/^```markdown\s*/, "")
            .replace(/```$/, "")
            .trim();
        }
        await Bun.write(CONFIG.COMPILED_SPEC_FILE, compiledSpecContent);
        console.log(
          `✅ [Stage 1/3] Canonical specification synthesized and saved to ${CONFIG.COMPILED_SPEC_FILE} (${compiledSpecContent.length} bytes)!`
        );
        // Quality gate (quality over speed): free-tier analysts often
        // under-generate. Validate against the prompt's own required
        // sections + a length floor; run a single expansion pass on gaps.
        const { findSpecGaps } = await import("./spec_checks.ts");
        let gaps = findSpecGaps(compiledSpecContent, analystPromptTemplate);
        if (gaps.length > 0) {
          console.warn(`⚠️ [Stage 1/3] Spec quality gaps (${gaps.length}): ${gaps.join("; ")}. Running one expansion pass...`);
          const expandPrompt =
            `${systemPrompt}\n\nYou are expanding a thin draft specification. Gaps found:\n- ${gaps.join("\n- ")}` +
            `\n\nCurrent draft:\n${compiledSpecContent}\n\nReturn the COMPLETE merged specification as full markdown ` +
            `(preserve everything already written, fill only the gaps — no "...etc", no placeholders):`;
          const expandRes = await OpenCodeClient.runWithFallback(expandPrompt, { timeoutMs: 10 * 60 * 1000 });
          const expanded = (expandRes.stdout || "").trim();
          if (expandRes.exitCode === 0 && expanded) {
            const regaps = findSpecGaps(expanded, analystPromptTemplate);
            if (regaps.length < gaps.length) {
              compiledSpecContent = expanded;
              gaps = regaps;
              await Bun.write(CONFIG.COMPILED_SPEC_FILE, compiledSpecContent);
              console.log(
                `✅ [Stage 1/3] Expansion closed gaps; spec now ${compiledSpecContent.length} bytes (${regaps.length} gaps remain).`
              );
            } else {
              console.warn(
                `⚠️ [Stage 1/3] Expansion did not improve coverage (${regaps.length} gaps remain); keeping original draft.`
              );
            }
          } else {
            console.warn("⚠️ [Stage 1/3] Expansion pass produced no content; keeping original draft.");
          }
        }
      } else {
        console.warn("⚠️ Analyst run did not return content; falling back to raw inputs for planner.");
      }
    }

    // =========================================================================
    // STAGE 1.5: Skill Forger (project-specific skills into inputs/skills/)
    // =========================================================================
    console.log("🛠️ [Stage 1.5/3] Running Skill Forger to detect stack-specific gaps...");
    try {
      const forgerTemplate = await Bun.file("orchestrator/prompts/skill_forger.md").text();
      const forgerContext = compiledSpecContent
        ? // Full spec: truncating here would waste the quality the Stage-1
          // gate just bought. The 12K guard stays only for the raw-inputs
          // fallback (unbounded ingestion can overflow small contexts).
          `## Synthesized Project Specification:\n${compiledSpecContent}`
        : fullInputContext.slice(0, 12000);
      const forgerPrompt = `${systemPrompt}\n\n${forgerTemplate}\n\n${forgerContext}\n\nWrite the skill files now (reply with a one-line summary per file written, or "NO_NEW_SKILLS"):`;
      const forgerRes = await OpenCodeClient.runWithFallback(forgerPrompt, { timeoutMs: 10 * 60 * 1000 });
      console.log("🛠️ Forger summary:", (forgerRes.stdout || "(no output)").slice(-500));
      await this.collectForgedSkills();
    } catch (err) {
      console.warn("⚠️ Skill forging skipped (non-fatal):", (err as Error)?.message || err);
    }

    // =========================================================================
    // STAGE 2: DAG Planner (Decompose compiled spec into task roadmap DAG)
    // =========================================================================
    console.log("🧭 [Stage 2/3] Running DAG Planner to decompose specification into roadmap.json...");
    const plannerPrompt = await Bun.file("orchestrator/prompts/planner.md").text();

    const specContext = compiledSpecContent
      ? `## Synthesized Project Specification (${CONFIG.COMPILED_SPEC_FILE}):\n${compiledSpecContent}`
      : fullInputContext;

    const fullPrompt = `${systemPrompt}\n\n${plannerPrompt}\n\n${specContext}\nGenerate the complete roadmap JSON now:`;

    const res = await OpenCodeClient.runWithFallback(fullPrompt, { timeoutMs: 10 * 60 * 1000 });

    // Parse JSON block from OpenCode output
    let roadmapData: Roadmap | null = null;
    const jsonMatch = res.stdout.match(/```json([\s\S]*?)```/) || res.stdout.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      try {
        const raw = JSON.parse(jsonMatch[1].trim());
        roadmapData = {
          projectName: raw.projectName || "Generated Project",
          version: raw.version || 1,
          summary: raw.summary || "",
          globalStatus: "IN_PROGRESS",
          milestones: raw.milestones || [],
          services: Array.isArray(raw.services)
            ? raw.services.filter(
                (s: any) => typeof s === "string" || (s && typeof s.name === "string" && typeof s.image === "string")
              )
            : [],
          updatedAt: new Date().toISOString(),
          tasks: (raw.tasks || []).map((t: any, idx: number) => ({
            id: t.id || `TASK-${String(idx + 1).padStart(3, "0")}`,
            title: t.title || "Untitled Task",
            description: t.description || "",
            role: t.role || "backend",
            dependencies: t.dependencies || [],
            targetFiles: t.targetFiles || [],
            deliverables: Array.isArray((t as any).deliverables)
              ? (t as any).deliverables.filter((d: any) => typeof d === "string" && d.trim()).map((d: string) => d.trim())
              : [],
            verificationCommand:
              typeof (t as any).verificationCommand === "string" && (t as any).verificationCommand.trim()
                ? (t as any).verificationCommand.trim()
                : "",
            milestone: t.milestone || (raw.milestones?.[0]?.title ?? "v0.1.0 - Foundation"),
            status: "PENDING",
            branch: t.branch || `task/${t.id || `TASK-${String(idx + 1).padStart(3, "0")}`}`,
            attempts: 0,
            maxAttempts: CONFIG.MAX_TASK_ATTEMPTS,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })),
        };
      } catch (e) {
        console.error("Failed to parse roadmap JSON:", e);
      }
    }

    if (!roadmapData || roadmapData.tasks.length === 0) {
      console.error("❌ Failed to generate valid roadmap tasks from OpenCode output.");
      console.log("Raw output:", res.stdout);
      process.exit(1);
    }

    // Deterministic DAG validation BEFORE persisting (cycles, dupes, bad roles, missing deps)
    const validation = validateRoadmap({
      tasks: roadmapData.tasks.map((t) => ({
        id: t.id,
        role: t.role,
        dependencies: t.dependencies,
        targetFiles: t.targetFiles,
        milestone: t.milestone,
        description: t.description,
        deliverables: t.deliverables,
        verificationCommand: t.verificationCommand,
      })),
      milestones: roadmapData.milestones,
      services: roadmapData.services,
    });
    if (validation.warnings.length > 0) {
      console.warn("⚠️ Roadmap validation warnings:\n" + formatValidation({ errors: [], warnings: validation.warnings }));
    }
    if (validation.errors.length > 0) {
      console.error("❌ Roadmap validation failed:\n" + formatValidation({ errors: validation.errors, warnings: [] }));
      console.error("Aborting plan. Fix the planner output or inputs and retry.");
      process.exit(1);
    }
    console.log("✅ Roadmap DAG validation passed.");
    await this.ensureServiceFiles(roadmapData);

    await StateManager.saveRoadmap(roadmapData);
    console.log(`✅ Roadmap created with ${roadmapData.tasks.length} tasks.`);

    // Initialize GitHub Project (v2), Milestones, and Issues
    if (roadmapData.milestones && roadmapData.milestones.length > 0) {
      await ProjectManager.ensureMilestones(roadmapData.milestones, (t) => this.isMilestoneComplete(roadmapData, t));
    }
    const projectNum = await ProjectManager.ensureProject(roadmapData);
    for (const task of roadmapData.tasks) {
      await ProjectManager.ensureTaskIssue(task, task.milestone);
    }
    if (projectNum) {
      await ProjectManager.syncBoardState(roadmapData, projectNum);
    }
    await StateManager.saveRoadmap(roadmapData);

    // Save and commit synthesized spec, roadmap, and progress BEFORE dispatching.
    // persistRoadmap routes to data/main (private) in dual-repo mode.
    await this.persistRoadmap(roadmapData, "chore(orchestrator): initial plan and synthesized specification");
    await IssueManager.syncDashboardIssue(roadmapData);

    // Keep the integration branch synced — on the CONTENT remote in
    // dual-repo mode (public origin must never receive data branches).
    // Seed only when the remote branch doesn't exist yet: never overwrite
    // real project data with the template tree.
    if (GitManager.isDataMode()) {
      const remote = CONFIG.DATA_REMOTE;
      const seedNeeded = !(await GitManager.remoteHasBranch(remote, CONFIG.INTEGRATION_BRANCH));
      if (seedNeeded) {
        // Seed a CLEAN product tree (workspace skeleton only) without
        // touching the checkout: build the tree in a throwaway index
        // (mktree rejects slashed paths, so update-index + write-tree).
        // Never the checkout HEAD (engine code).
        console.log(`🌱 Seeding ${remote}/${CONFIG.INTEGRATION_BRANCH} with a clean workspace baseline...`);
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const idxFile = join(tmpdir(), `seed-index-${Date.now()}.idx`);
        const idxEnv = { GIT_INDEX_FILE: idxFile };
        let tree = "";
        const ui = await GitManager.run(
          ["git", "update-index", "--add", "--cacheinfo", "100644,e69de29bb2d1d6434b8b29ae775ad8c2e48c5391,workspace/.gitkeep"],
          ".",
          undefined,
          idxEnv
        );
        if (ui.exitCode === 0) {
          const wt = await GitManager.run(["git", "write-tree"], ".", undefined, idxEnv);
          if (wt.exitCode === 0 && /^[0-9a-f]{40}$/.test(wt.stdout.trim())) tree = wt.stdout.trim();
        }
        try {
          (await Bun.file(idxFile).exists()) && (await import("node:fs")).unlinkSync(idxFile);
        } catch {
          /* best-effort */
        }
        if (!/^[0-9a-f]{40}$/.test(tree)) {
          console.warn("⚠️ Seed tree creation failed; skipping develop seed (task forks will fail loudly instead).");
        } else {
          const ct = await GitManager.run([
            "git",
            "-c",
            "user.name=github-actions[bot]",
            "-c",
            "user.email=github-actions[bot]@users.noreply.github.com",
            "commit-tree",
            tree,
            "-m",
            "seed(data): clean workspace baseline",
          ]);
          const sha = ct.stdout.trim();
          if (ct.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
            console.warn("⚠️ Seed commit creation failed; skipping develop seed.");
          } else {
            const push = await GitManager.remoteGit(remote, ["push", remote, `${sha}:refs/heads/${CONFIG.INTEGRATION_BRANCH}`]);
            console.log(
              push.exitCode === 0
                ? `🌱 Seeded ${remote}/${CONFIG.INTEGRATION_BRANCH} @ ${sha.slice(0, 7)}.`
                : `⚠️ Seed push failed: ${push.stderr.slice(0, 200)}`
            );
          }
        }
      } else {
        console.log(`ℹ️ Data branch ${remote}/${CONFIG.INTEGRATION_BRANCH} exists; leaving project data untouched.`);
      }
    } else {
      await GitManager.run(["git", "push", "origin", `HEAD:${CONFIG.INTEGRATION_BRANCH}`]);
    }

    // Dispatch initial batch of independent tasks (now they have the committed state available!)
    await this.dispatchReadyTasks(roadmapData);
    // Persist dispatch markings (IN_PROGRESS/dispatchedAt) so the next tick
    // doesn't re-dispatch the same tasks.
    await this.persistRoadmap(roadmapData, "chore(orchestrator): initial dispatch");
  }

  /**
   * Collect forged project skills: validate frontmatter (name == directory,
   * description present) and commit them immediately so they survive the run
   * in both single-repo and dual-repo modes.
   */
  private static async collectForgedSkills(): Promise<string[]> {
    const valid: string[] = [];
    const cap = CONFIG.MAX_FORGED_SKILLS > 0 ? CONFIG.MAX_FORGED_SKILLS : 20;
    // Built-in skill names win: a forged duplicate would make skill-tool
    // discovery (which requires unique names across locations) ambiguous.
    const builtin = new Set<string>();
    try {
      const bglob = new Bun.Glob(".opencode/skills/*");
      for await (const rel of bglob.scan({ cwd: ".", onlyFiles: false })) {
        const b = rel.split(/[/\\]/).pop() || "";
        if (!b.startsWith(".") && b !== ".gitkeep") builtin.add(b);
      }
    } catch {
      // No builtin skills dir (tests, minimal checkouts) — nothing to collide with.
    }
    try {
      const glob = new Bun.Glob("inputs/skills/*");
      const dirs: string[] = [];
      for await (const rel of glob.scan({ cwd: ".", onlyFiles: false })) {
        const base = rel.split(/[/\\]/).pop() || "";
        if (!base.startsWith(".") && base !== ".gitkeep") dirs.push(rel.replace(/\\/g, "/"));
      }
      for (const dir of dirs.sort().slice(0, cap)) {
        const p = `${dir}/SKILL.md`;
        try {
          const raw = await Bun.file(p).text();
          // Normalize first: forger LLMs emit unquoted ": " in descriptions,
          // which breaks YAML parsers. Quoted output always parses.
          const { normalizeSkillFrontmatter, skillFrontmatterName, skillFrontmatterDescription } =
            await import("./skill_format.ts");
          let clean = normalizeSkillFrontmatter(raw);
          const name = clean ? skillFrontmatterName(clean) : undefined;
          const base = dir.split("/").pop()!;
          if (!clean || name !== base || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
            console.warn(`⚠️ Ignoring malformed forged skill (name must equal directory): ${p}`);
            continue;
          }
          if (builtin.has(base)) {
            console.warn(`⚠️ Ignoring forged skill shadowing built-in skill: ${p}`);
            continue;
          }
          const desc = skillFrontmatterDescription(clean);
          if (desc !== undefined && desc.length > 1024) {
            // Skill discovery requires 1–1024 chars: truncate loudly, keep the skill.
            clean = clean.replace(/^description:\s*".*"$/m, (line) => {
              const open = line.slice(0, line.indexOf('"') + 1);
              return `${open}${desc.slice(0, 1021)}…"`;
            });
            console.warn(`⚠️ Truncated over-long description (${desc.length} chars) in forged skill: ${p}`);
          }
          if (clean !== raw) await Bun.write(p, clean);
          valid.push(base);
        } catch {
          console.warn(`⚠️ Ignoring ${dir} (no readable SKILL.md).`);
        }
      }
      if (dirs.length > cap) {
        console.warn(`⚠️ Forger produced ${dirs.length} skill dirs; keeping first ${cap} alphabetically.`);
      }
    } catch {
      /* no skills directory */
    }
    if (valid.length > 0) {
      console.log(`✅ Collected forged skills: ${valid.join(",")} (committed via persist paths).`);
    } else {
      console.log("ℹ️ No new project skills forged.");
    }
    return valid;
  }

  /**
   * Action: Review tasks waiting in IN_REVIEW
   */
  /** True when a milestone has tasks and all are COMPLETED (reopen guard). */
  public static isMilestoneComplete(roadmap: Roadmap, title: string): boolean {
    const ts = roadmap.tasks.filter((t) => t.milestone === title);
    return ts.length > 0 && ts.every((t) => t.status === "COMPLETED");
  }

  public static async reviewTasks(roadmap: Roadmap): Promise<boolean> {
    let hasChanges = false;

    // Liveness snapshot (one API call): lets the empty-diff guard below tell
    // "agent done early, judge now" apart from "agent may still be working".
    // Runs execute on main so they can't be mapped to tasks — absence of ALL
    // runs + a stale branch tip is the only safe early-judge signal.
    let anyActiveRuns = false;
    try {
      anyActiveRuns = (await GitManager.getActiveSubagentRuns()).length > 0;
    } catch {
      /* conservative: assume active */ anyActiveRuns = true;
    }

    // Auto-detect completed task branches via STRUCTURED progress report
    // (all 4 sections required) AND a branch diff check:
    // - non-empty code diff  -> IN_REVIEW (normal path)
    // - empty diff (already merged into develop) -> COMPLETED directly.
    //   Without the second rule, merged tasks stuck at IN_PROGRESS/PENDING
    //   linger forever: not reviewable, yet never completed.
    for (const task of roadmap.tasks) {
      if (task.status === "COMPLETED" || task.status === "FAILED") continue;
      {
        const branchExists = await GitManager.branchExists(task.branch);
        if (branchExists) {
          const progressContent = await GitManager.showFile(task.branch, `workspace/${CONFIG.TASK_PROGRESS_FILE}`);
          if (progressContent !== null && hasStructuredProgress(progressContent)) {
            const files = await GitManager.getBranchFileList(task.branch, CONFIG.INTEGRATION_BRANCH);
            if (files === null) {
              // Undiffable (e.g. branch shares no history with develop):
              // UNKNOWN, never "empty". Route to review with a clear note
              // instead of auto-completing on a mirage.
              console.log(
                `⚠️ [${task.id}] cannot diff vs ${CONFIG.INTEGRATION_BRANCH} (unrelated histories?); routing to IN_REVIEW.`
              );
              if (task.status !== "IN_REVIEW") {
                task.status = "IN_REVIEW";
                task.reviewNotes =
                  "Branch cannot be diffed against develop (no common ancestor). Needs lineage repair or full-content review.";
                task.updatedAt = new Date().toISOString();
                hasChanges = true;
              }
              continue;
            }
            const realChanges = files.filter((f) => f !== `workspace/${CONFIG.TASK_PROGRESS_FILE}`);
            if (realChanges.length === 0) {
              // Hold only while a run may still be working: recent dispatch
              // AND at least one active run globally. (Runs execute on main,
              // so they can't be mapped to tasks.) Fresh branch commits alone
              // prove nothing — a finished run's push stays "fresh" for 45m
              // after exit, so it must not block judgment.
              const STALE_MS = 45 * 60 * 1000;
              // Computed once, reused by the routing below.
              const uniqueEarly = await GitManager.branchUniqueCommits(task.branch, CONFIG.INTEGRATION_BRANCH);
              if (task.status === "IN_PROGRESS" && task.dispatchedAt) {
                const dispAge = Date.now() - Date.parse(task.dispatchedAt);
                if (!Number.isNaN(dispAge) && dispAge < STALE_MS && anyActiveRuns) {
                  console.log(
                    `ℹ️ [${task.id}] empty diff but dispatched ${Math.round(dispAge / 60000)}m ago with runs active; leaving IN_PROGRESS.`
                  );
                  continue;
                }
                if (!Number.isNaN(dispAge) && dispAge < STALE_MS) {
                  console.log(
                    `ℹ️ [${task.id}] empty diff, dispatched ${Math.round(dispAge / 60000)}m ago but no active runs; judging now.`
                  );
                }
              }
              // Empty diff routing (all require structured progress, checked above):
              // - placeholder report and/or zero unique commits = agent produced
              //   nothing → IN_REVIEW so the gate rejects with feedback + requeues.
              // - real report + unique commits = already integrated → COMPLETED.
              // (uniqueEarly computed above for the hold check — reused here.)
              const unique = uniqueEarly;
              if (!isDefaultProgress(progressContent) && unique > 0) {
                if (task.status !== ("COMPLETED" as string)) {
                  console.log(
                    `✅ [${task.id}] branch already integrated (empty diff, ${unique} unique commits). Marking COMPLETED.`
                  );
                  task.status = "COMPLETED";
                  task.reviewNotes = "Branch diff vs develop is empty; deliverables already integrated.";
                  task.updatedAt = new Date().toISOString();
                  if (roadmap.projectNumber) {
                    await ProjectManager.updateItemStatus(roadmap.projectNumber, task, "Done");
                  }
                  hasChanges = true;
                }
                continue;
              }
              console.log(
                `🔎 [${task.id}] empty diff with no evidence of work (placeholder report or 0 unique commits). Routing to IN_REVIEW for gate feedback.`
              );
              if (task.status === "IN_PROGRESS" || task.status === "PENDING") {
                task.status = "IN_REVIEW";
                task.updatedAt = new Date().toISOString();
                hasChanges = true;
              }
              continue;
            }
            if (task.status === "IN_PROGRESS" || task.status === "PENDING") {
              console.log(
                `🔎 Detected completed deliverables for [${task.id}] on branch ${task.branch}. Transitioning to IN_REVIEW.`
              );
              task.status = "IN_REVIEW";
              task.updatedAt = new Date().toISOString();
              hasChanges = true;
            }
          }
        }
      }
    }

    const tasksInReview = roadmap.tasks.filter((t) => t.status === "IN_REVIEW");
    if (tasksInReview.length === 0) {
      if (hasChanges) await StateManager.saveRoadmap(roadmap);
      return hasChanges;
    }

    console.log(`🔍 Reviewing ${tasksInReview.length} completed tasks...`);
    const reviewerPromptTemplate = await Bun.file("orchestrator/prompts/reviewer.md").text();

    for (const task of tasksInReview) {
      console.log(`🧐 Reviewing deliverables for [${task.id}] on branch ${task.branch}...`);

      // LLM cost saver: identical tip already verdict → skip re-review.
      // (Verdicts always move the task out of IN_REVIEW, so a repeat here
      // with the same tip means a no-op cycle re-queued it.)
      const tipSha = await GitManager.branchTipSha(task.branch);
      if (tipSha && task.lastReviewSha === tipSha && task.lastGateVersion === GATE_VERSION) {
        // Stuck-verdict escape: skipped + provably idle + stale dispatch =
        // nobody will push new content; send back for a genuinely fresh
        // attempt instead of skipping forever (bounded by attempts).
        const dispAge = task.dispatchedAt ? Date.now() - Date.parse(task.dispatchedAt) : NaN;
        if (!Number.isNaN(dispAge) && dispAge >= CONFIG.IDLE_REQUEUE_MINUTES * 60 * 1000 && !anyActiveRuns) {
          console.log(`⏰ [${task.id}] reviewed tip unchanged and idle; re-queuing for a fresh attempt.`);
          task.attempts += 1;
          if (task.attempts >= task.maxAttempts) {
            task.status = "FAILED";
            task.failedAt = new Date().toISOString();
          } else {
            task.status = "PENDING";
          }
          task.lastReviewSha = undefined;
          task.lastGateVersion = undefined;
          task.updatedAt = new Date().toISOString();
          if (roadmap.projectNumber) {
            await ProjectManager.updateItemStatus(roadmap.projectNumber, task, task.status === "FAILED" ? "Failed" : "Todo");
          }
          hasChanges = true;
          continue;
        }
        console.log(`⏭️ [${task.id}] branch unchanged since last review (${tipSha.slice(0, 7)}); skipping re-review.`);
        continue;
      }

      // Get diff against integration branch
      const diff = await GitManager.getBranchDiff(task.branch, CONFIG.INTEGRATION_BRANCH);

      // Attempt to read task progress file from branch (content-remote aware)
      const progressContent = await GitManager.showFile(task.branch, `workspace/${CONFIG.TASK_PROGRESS_FILE}`);
      const taskProgress = progressContent !== null ? progressContent : "No progress file provided.";

      // Step 1: Deterministic pre-LLM gate (no LLM cost on obvious failures)
      const gate = await runReviewGate(task, diff, taskProgress);
      if (gate.warnings.length > 0) {
        console.warn(`⚠️ [${task.id}] gate warnings:\n- ${gate.warnings.join("\n- ")}`);
      }
      const rejectTask = async (notes: string, fixes: string[]) => {
        console.warn(`⚠️ [${task.id}] REJECTED: ${notes}`);
        task.attempts += 1;
        if (tipSha) {
          task.lastReviewSha = tipSha;
          task.lastGateVersion = GATE_VERSION;
        }
        task.reviewNotes = notes + (fixes.length > 0 ? `\nFixes: ${fixes.join(", ")}` : "");
        if (task.attempts >= task.maxAttempts) {
          task.status = "FAILED";
          task.failedAt = new Date().toISOString();
          console.error(`❌ [${task.id}] exceeded maximum attempts (${task.maxAttempts}). Marked as FAILED.`);
        } else {
          task.status = "PENDING";
        }
        if (roadmap.projectNumber) {
          await ProjectManager.updateItemStatus(roadmap.projectNumber, task, task.status === "FAILED" ? "Failed" : "Todo");
          await ProjectManager.postTaskProgressComment(
            task,
            `⚠️ **Review Feedback:** ${task.reviewNotes}\nRe-queuing for correction (${task.attempts}/${task.maxAttempts}).`
          );
        }
        hasChanges = true;
      };

      if (!gate.passed) {
        // Empty branch diff + structured progress = work already integrated
        // into develop (e.g. merged by an earlier tick). Complete silently
        // instead of looping reject → re-dispatch forever.
        const onlyEmptyDiff = gate.failures.length === 1 && gate.failures[0].startsWith("Empty diff");
        if (onlyEmptyDiff) {
          console.log(`✅ [${task.id}] branch already integrated (empty diff). Marking COMPLETED.`);
          task.status = "COMPLETED";
          if (tipSha) {
            task.lastReviewSha = tipSha;
            task.lastGateVersion = GATE_VERSION;
          }
          task.reviewNotes = "Branch diff vs develop is empty; deliverables already integrated.";
          task.updatedAt = new Date().toISOString();
          if (roadmap.projectNumber) {
            await ProjectManager.updateItemStatus(roadmap.projectNumber, task, "Done");
            await ProjectManager.postTaskProgressComment(
              task,
              `✅ **Already Integrated:** empty branch diff, marked COMPLETED without re-merge.`
            );
          }
          hasChanges = true;
          continue;
        }
        await rejectTask(`Deterministic gate failed:\n- ${gate.failures.join("\n- ")}`, gate.failures);
        continue;
      }

      // Review context caps (raised for quality) + truncation transparency:
      // the reviewer must KNOW when it sees a partial picture.
      const shownFiles = gate.fileList.slice(0, 100);
      const filesTruncated = gate.fileList.length > shownFiles.length;
      const MAX_REVIEW_DIFF_CHARS = 30000;
      const diffTruncated = diff.length > MAX_REVIEW_DIFF_CHARS;
      const reviewPrompt =
        `${reviewerPromptTemplate}\n\n` +
        `### Task: [${task.id}] - ${task.title}\n` +
        `**Expected Deliverables:**\n${task.description}\n\n` +
        `### Subagent Progress Report (TASK_PROGRESS.md):\n${taskProgress}\n\n` +
        `### Changed files (${gate.fileList.length}):\n${shownFiles.join("\n")}` +
        (filesTruncated ? `\n⚠️ File list truncated: showing first ${shownFiles.length} of ${gate.fileList.length}.` : "") +
        `\n\n` +
        `### Diff stat:\n\`\`\`\n${gate.diffStat}\n\`\`\`\n\n` +
        `### Gate warnings (already checked, informational):\n${gate.warnings.length > 0 ? gate.warnings.join("\n") : "none"}\n\n` +
        `### Git Diff:\n\`\`\`diff\n${diff.slice(0, MAX_REVIEW_DIFF_CHARS)}\n\`\`\`` +
        (diffTruncated ? `\n⚠️ Diff truncated: showing first ${MAX_REVIEW_DIFF_CHARS} of ${diff.length} chars.` : "") +
        `\n\n` +
        `Evaluate whether to approve or reject this work:`;

      const res = await OpenCodeClient.runWithFallback(reviewPrompt, { timeoutMs: 8 * 60 * 1000 });

      // Robust JSON parse: fenced block, then largest {...} span. Default REJECT on garbage.
      let reviewResult: ReviewResult | null = null;
      const fenced = res.stdout.match(/```json([\s\S]*?)```/);
      const candidates = fenced ? [fenced[1]] : [];
      const greedy = res.stdout.match(/\{[\s\S]*\}/);
      if (greedy) candidates.push(greedy[0]);
      for (const c of candidates) {
        try {
          const parsed = JSON.parse(c.trim());
          if (typeof parsed.approved === "boolean") {
            reviewResult = {
              approved: parsed.approved,
              notes: String(parsed.notes || ""),
              suggestedFixes: Array.isArray(parsed.suggestedFixes) ? parsed.suggestedFixes.map(String) : [],
            };
            break;
          }
        } catch {
          /* try next candidate */
        }
      }
      if (!reviewResult) {
        await rejectTask(`Reviewer output unparseable (no valid {approved, notes} JSON). Raw head: ${res.stdout.slice(0, 300)}`, [
          "Ensure reviewer returns fenced ```json with approved:boolean",
        ]);
        continue;
      }

      if (reviewResult.approved) {
        console.log(`✅ [${task.id}] APPROVED! Integrating branch ${task.branch} into ${CONFIG.INTEGRATION_BRANCH} via PR...`);
        const { PRManager } = await import("./pr_manager.ts");
        let merged = false;
        let viaPR: string | null = null;

        // Preferred path: real PR with review audit trail
        const pr = await PRManager.createOrGetTaskPR(task);
        if (pr) {
          viaPR = `#${pr.number}`;
          await PRManager.postReviewComment(
            pr.number,
            `✅ **Orchestrator review: APPROVED**\n\n${reviewResult.notes || "Requirements met."}\n\nMerging now.`
          );
          merged = await PRManager.mergeTaskPR(pr.number);
          if (!merged) {
            console.warn(`⚠️ PR #${pr.number} not directly mergable; falling back to local merge + AI conflict resolver...`);
            await PRManager.postReviewComment(
              pr.number,
              `⚠️ **Auto-merge failed** (likely conflicts). Falling back to local merge with AI conflict resolution.`
            );
          }
        }
        // Fallback path: local merge (conflict resolver inside)
        if (!merged) {
          merged = await GitManager.mergeTaskBranch(
            task.branch,
            CONFIG.INTEGRATION_BRANCH,
            `chore(merge): integrate approved task ${task.id} (${task.title})`
          );
          if (merged && pr) {
            await PRManager.postReviewComment(
              pr.number,
              `✅ **Integrated** via local merge (conflicts auto-resolved, tests green).`
            );
          }
        }

        if (merged) {
          task.status = "COMPLETED";
          if (tipSha) {
            task.lastReviewSha = tipSha;
            task.lastGateVersion = GATE_VERSION;
          }
          task.reviewNotes = (reviewResult.notes || "Approved and integrated.") + (viaPR ? ` (PR ${viaPR})` : "");
          task.updatedAt = new Date().toISOString();
          if (roadmap.projectNumber) {
            await ProjectManager.updateItemStatus(roadmap.projectNumber, task, "Done");
            await ProjectManager.postTaskProgressComment(
              task,
              `✅ **Approved & Integrated${viaPR ? ` via PR ${viaPR}` : ""}:** ${task.reviewNotes}`
            );
          }
          hasChanges = true;
        } else {
          await rejectTask(
            `Approved but integration failed${viaPR ? ` (PR ${viaPR} unmergable, local merge also failed)` : ""}. Manual inspection needed.`,
            ["Resolve merge conflicts on the task branch and re-queue with /retry"]
          );
        }
      } else {
        await rejectTask(reviewResult.notes || "Rejected by reviewer.", reviewResult.suggestedFixes || []);
        // Traceability: mirror the rejection onto the open PR, if one exists.
        try {
          const { PRManager: PRM } = await import("./pr_manager.ts");
          const openPR = await PRM.getOpenPR(task.branch);
          if (openPR) {
            await PRM.postReviewComment(openPR.number, `⚠️ **Orchestrator review: CHANGES REQUESTED**\n\n${task.reviewNotes}`);
          }
        } catch {
          /* non-fatal */
        }
      }
    }

    if (hasChanges) {
      await StateManager.saveRoadmap(roadmap);
    }
    return hasChanges;
  }

  /**
   * Persist roadmap with merge-on-conflict: concurrent ticks editing
   * roadmap.json must not silently drop each other's decisions (e.g. a
   * COMPLETED flag). On rebase conflict the remote copy is field-merged
   * with ours (terminal states win) instead of aborting and losing updates.
   */
  public static async persistRoadmap(roadmap: Roadmap, message: string): Promise<void> {
    // Forged/hand-added project skills travel with state (tracked files).
    const files = [CONFIG.ROADMAP_FILE, CONFIG.PROGRESS_MD_FILE, CONFIG.COMPILED_SPEC_FILE, "inputs/skills"];
    // Dual-repo: state is private — commit force-added state files onto a
    // local data-state branch tracking data/main, push there. Public main
    // only ever carries engine code (humans).
    if (GitManager.isDataMode()) {
      return this.persistRoadmapToData(roadmap, message, files);
    }
    // State commits belong on BASE_BRANCH (main): review merges leave the
    // checkout on the integration branch — return first so `git push` can't
    // spill content branches to the wrong remote.
    // Mid-job dirt (bun install rewrites bun.lock) aborts both the checkout
    // below and `pull --rebase` in the retry loop — stash tracked edits
    // aside first, restore them on the way out (runners are ephemeral).
    await GitManager.run(["git", "stash", "push", "-m", "orchestrator-state-keepout"]);
    await GitManager.run(["git", "checkout", CONFIG.BASE_BRANCH]);
    // Freshness first: a long tick (slow LLM reviews) may hold a stale copy.
    // Merge remote truth in BEFORE saving so we never wipe fields like
    // projectNumber that another run persisted meanwhile.
    try {
      await GitManager.run(["git", "fetch", "origin"]);
      const show = await GitManager.run(["git", "show", "origin/main:" + CONFIG.ROADMAP_FILE]);
      const remote = JSON.parse(show.stdout) as Roadmap;
      Object.assign(roadmap, StateManager.mergeRoadmaps(roadmap, remote));
    } catch {
      // No remote state (first run) — persist local copy as-is.
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await StateManager.saveRoadmap(roadmap);
      for (const f of files) await GitManager.run(["git", "add", f]);
      await GitManager.run(["git", "commit", "-m", message]);
      const push = await GitManager.run(["git", "push"]);
      if (push.exitCode === 0) {
        await GitManager.run(["git", "stash", "pop"]);
        return;
      }
      const delayMs = attempt * 2000 + Math.floor(Math.random() * 1000);
      console.warn(`⚠️ Push rejected (attempt ${attempt}/3). Backing off for ${delayMs}ms before rebase...`);
      console.warn(`   ↳ push stderr: ${(push.stdout + push.stderr).slice(0, 500)}`);
      await Bun.sleep(delayMs);
      await GitManager.run(["git", "fetch", "origin"]);
      const rebase = await GitManager.run(["git", "pull", "--rebase"]);
      if (rebase.exitCode === 0) continue;
      console.warn("⚠️ Rebase conflict on state files — field-merging roadmaps.");
      await GitManager.run(["git", "rebase", "--abort"]);
      try {
        const show = await GitManager.run(["git", "show", "origin/main:" + CONFIG.ROADMAP_FILE]);
        const remote = JSON.parse(show.stdout) as Roadmap;
        const merged = StateManager.mergeRoadmaps(roadmap, remote);
        Object.assign(roadmap, merged);
      } catch {
        console.warn("⚠️ Could not load remote roadmap; retrying with local copy.");
      }
    }
    await GitManager.run(["git", "stash", "pop"]);
    console.error("❌ persistRoadmap: push failed after 3 attempts; changes remain local.");
  }

  /**
   * Dual-repo state persist: state files are force-added (gitignored) onto a
   * scratch linked worktree tracking data/main and pushed from there.
   * Includes the same freshness-merge as the public path so concurrent ticks
   * can't wipe each other's roadmap fields.
   *
   * The worktree isolation is load-bearing: the main checkout gets dirty
   * mid-job (bun install rewrites bun.lock, runners leave other tracked
   * edits) and `git checkout -B data-state` then aborts to protect local
   * changes — HEAD silently stays on the public history and every push is
   * rejected as non-fast-forward forever. Operating in a scratch worktree
   * keeps the main checkout (and the running engine's sources) untouched.
   */
  private static async persistRoadmapToData(roadmap: Roadmap, message: string, files: string[]): Promise<void> {
    const remote = CONFIG.DATA_REMOTE;
    const tip = `${remote}/${CONFIG.BASE_BRANCH}`;
    const dataMain = await GitManager.remoteHasBranch(remote, CONFIG.BASE_BRANCH);
    const wtDir = join(tmpdir(), `data-state-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const wt = async (args: string[]) => GitManager.run(["git", "-C", wtDir, ...args]);
    const cleanup = async () => {
      try {
        await GitManager.run(["git", "worktree", "remove", "--force", wtDir]);
      } catch {
        // Ephemeral runner; leftovers die with the VM (matters only locally).
      }
      try {
        await GitManager.run(["git", "worktree", "prune"]);
      } catch {
        // Best-effort.
      }
    };
    try {
      await GitManager.run(["git", "worktree", "prune"]);
      rmSync(wtDir, { recursive: true, force: true });
      if (!dataMain) console.log(`🌱 Initializing data state on ${remote}/${CONFIG.BASE_BRANCH}...`);
      const add = dataMain
        ? await GitManager.run(["git", "worktree", "add", "--detach", wtDir, tip])
        : await GitManager.run(["git", "worktree", "add", "--detach", wtDir]);
      if (add.exitCode !== 0) {
        console.warn("⚠️ Data worktree setup failed:", (add.stdout + add.stderr).slice(0, 300));
        return;
      }
      try {
        const show = await GitManager.run(["git", "show", `${tip}:${CONFIG.ROADMAP_FILE}`]);
        const remoteRm = JSON.parse(show.stdout) as Roadmap;
        Object.assign(roadmap, StateManager.mergeRoadmaps(roadmap, remoteRm));
      } catch {
        // No remote state yet — persist local copy as-is.
      }
      // State files every persist must carry (force-added, gitignored).
      const carry = [...files, "inputs/skills"];
      const mirrorIntoWorktree = () => {
        for (const f of carry) {
          const src = join(".", f);
          const dst = join(wtDir, f);
          let st: ReturnType<typeof statSync> | null = null;
          try {
            st = statSync(src);
          } catch {
            continue; // Missing optional inputs (e.g. no skills yet).
          }
          try {
            if (st.isDirectory()) {
              rmSync(dst, { recursive: true, force: true });
              cpSync(src, dst, { recursive: true });
            } else {
              mkdirSync(dirname(dst), { recursive: true });
              copyFileSync(src, dst);
            }
          } catch {
            // Best-effort mirror; the push below reports real failures.
          }
        }
      };
      const botIdentity = [
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=github-actions[bot]@users.noreply.github.com",
      ];
      for (let attempt = 1; attempt <= 5; attempt++) {
        await StateManager.saveRoadmap(roadmap);
        mirrorIntoWorktree();
        await wt(["add", "-f", ...carry]);
        const commit = await wt([...botIdentity, "commit", "-m", message]);
        if (commit.exitCode !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
          console.warn(`⚠️ Data state commit failed: ${(commit.stdout + commit.stderr).slice(0, 300)}`);
        }
        const push = await GitManager.remoteGit(remote, ["push", remote, `HEAD:${CONFIG.BASE_BRANCH}`], wtDir);
        if (push.exitCode === 0) return;
        console.warn(`⚠️ Data state push rejected (attempt ${attempt}/5). Re-syncing...`);
        console.warn(`   ↳ push stderr: ${(push.stdout + push.stderr).slice(0, 500)}`);
        // Back off: the competing writer is usually another tick still
        // working; immediate retries just collide again.
        await new Promise((r) => setTimeout(r, 15000 * attempt));
        await GitManager.remoteGit(remote, ["fetch", remote, CONFIG.BASE_BRANCH], wtDir);
        // Reset only the SCRATCH worktree (never the main checkout) onto
        // the new tip, then re-merge remote state below on next iteration.
        await wt(["reset", "--hard", tip]);
        try {
          const show = await GitManager.run(["git", "show", `${tip}:${CONFIG.ROADMAP_FILE}`]);
          const remoteRm = JSON.parse(show.stdout) as Roadmap;
          Object.assign(roadmap, StateManager.mergeRoadmaps(roadmap, remoteRm));
        } catch {
          // keep local copy
        }
      }
      console.error("❌ persistRoadmapToData: push failed after 5 attempts; changes remain local.");
    } finally {
      await cleanup();
    }
  }

  /**
   * Write workspace/docker-compose.services.yml deterministically from
   * roadmap.services (pure render — same output every run). The workflow's
   * service step starts it; empty service list = no file, legacy behavior.
   */
  public static async ensureServiceFiles(roadmap: Roadmap): Promise<void> {
    const { renderComposeYaml, renderEnvFile, normalizeServices } = await import("./service_manager.ts");
    const picked = normalizeServices(roadmap.services || []);
    const outPath = `${CONFIG.WORKSPACE_DIR}/docker-compose.services.yml`;
    if (picked.length === 0) {
      console.log("ℹ️ No CI services required by roadmap; skipping compose file.");
      return;
    }
    await Bun.write(outPath, renderComposeYaml(picked));
    await Bun.write(`${CONFIG.WORKSPACE_DIR}/.services.env`, renderEnvFile(picked));
    console.log(`🐳 Service compose written (${picked.map((p) => p.name).join(", ")}) → ${outPath}`);
  }

  /**
   * Dispatch pending tasks whose dependencies are resolved up to concurrency limit
   */
  public static async dispatchReadyTasks(roadmap: Roadmap): Promise<void> {
    if (roadmap.globalStatus === "PAUSED") {
      console.log("⏸️ Orchestrator is currently PAUSED. Skipping new task dispatches.");
      return;
    }

    const readyTasks = StateManager.getReadyTasks(roadmap, CONFIG.MAX_CONCURRENT_SUBAGENTS);
    if (readyTasks.length === 0) {
      console.log("ℹ️ No ready tasks to dispatch at this time.");
      return;
    }

    console.log(
      `🚀 Dispatching ${readyTasks.length} parallel subagents (Concurrency limit: ${CONFIG.MAX_CONCURRENT_SUBAGENTS})...`
    );

    for (const task of readyTasks) {
      const dispatched = await GitManager.dispatchSubagentWorkflow(task.id, task.role, task.branch);
      if (dispatched) {
        task.status = "IN_PROGRESS";
        task.updatedAt = new Date().toISOString();
        task.dispatchedAt = new Date().toISOString();
        // Best-effort runId capture for watchdog correlation (dispatch is fire-and-forget)
        try {
          const runId = await GitManager.findRunForBranch(task.branch);
          if (runId) task.runId = runId;
        } catch {
          /* non-fatal */
        }
        if (roadmap.projectNumber) {
          await ProjectManager.updateItemStatus(roadmap.projectNumber, task, "In Progress");
          await ProjectManager.postTaskProgressComment(
            task,
            `⚡ **Subagent Dispatched:** Executing on branch \`${task.branch}\` with role \`${task.role}\`.`
          );
        }
        // Polite pacing: avoid burst workflow dispatches and comment creation
        await Bun.sleep(1000);
      }
    }

    await StateManager.saveRoadmap(roadmap);
  }

  /**
   * Action: Tick (Check status, review completed work, dispatch next jobs)
   */
  public static async tick(): Promise<void> {
    console.log("⏰ Orchestrator Tick started...");
    // Coalesce duplicate ticks (wake + cron landing the same second):
    // when an OLDER orchestrator run is already active, exit — the
    // singleton would only queue a redundant full cycle behind it.
    // REST-only: burns zero GraphQL quota. Older (smaller id) survives.
    const me = process.env.GITHUB_RUN_ID;
    if (me) {
      try {
        const lr = await GitManager.run([
          "gh",
          "run",
          "list",
          "--workflow",
          "orchestrator.yml",
          "--limit",
          "10",
          "--json",
          "databaseId,status",
        ]);
        const runs: any[] = JSON.parse(lr.stdout || "[]");
        const older = runs.filter(
          (r) =>
            (r.status === "in_progress" || r.status === "queued" || r.status === "waiting") && Number(r.databaseId) < Number(me)
        );
        if (older.length > 0) {
          console.log(
            `ℹ️ Coalescing: orchestrator run #${older[0].databaseId} already active; exiting to save a redundant cycle.`
          );
          return;
        }
      } catch {
        /* proceed with tick */
      }
    }
    await GitManager.setupGitAuthor();
    await GitManager.run(["git", "fetch", "--all"]);
    // Dual-repo: register the private data remote so content-remote reads
    // (diffs, progress files) resolve. No-op in single-repo mode.
    if (GitManager.isDataMode()) {
      await GitManager.ensureDataRemote();
    }

    // NOTE: state/roadmap.json is the source of truth — on public main in
    // single-repo mode, on data/main (private) in dual-repo mode.

    // Dual-repo: materialize private state BEFORE loading (local state/
    // holds only a .gitkeep template in this mode).
    if (GitManager.isDataMode()) {
      await GitManager.syncStateIn();
    }

    let roadmap = await StateManager.loadRoadmap();
    if (!roadmap) {
      console.log("⚠️ No active roadmap found. Initiating planning phase...");
      await this.plan();
      return;
    }
    // Board-sync saver: snapshot the status signature now; the end-of-tick
    // drift heal is skipped when nothing changed and the last sync is fresh.
    const statusSigBefore = roadmap.tasks.map((t) => `${t.id}:${t.status}`).join(",");
    await this.ensureServiceFiles(roadmap);

    // Ensure GitHub Milestones and Issues exist for all tasks
    if (roadmap.milestones && roadmap.milestones.length > 0) {
      await ProjectManager.ensureMilestones(roadmap.milestones, (t) => this.isMilestoneComplete(roadmap, t));
    }
    const hasUnsyncedIssues = roadmap.tasks.some((t) => !t.issueNumber);
    if (hasUnsyncedIssues) {
      console.log("📌 Ensuring GitHub Issues exist for all tasks and are attached to Milestones...");
      const projectNum = await ProjectManager.ensureProject(roadmap);
      for (const task of roadmap.tasks) {
        if (!task.issueNumber) {
          await ProjectManager.ensureTaskIssue(task, task.milestone);
        }
      }
      if (projectNum) {
        await ProjectManager.syncBoardState(roadmap, projectNum);
      }
      await StateManager.saveRoadmap(roadmap);
    }

    // Self-healing board linkage: if the roadmap lost its projectNumber
    // (e.g. stale overwrite), rebuild it — otherwise cards/issues drift.
    if (!roadmap.projectNumber) {
      console.log("🔧 Roadmap missing project linkage; rebuilding...");
      const projectNum = await ProjectManager.ensureProject(roadmap);
      if (projectNum) {
        await StateManager.saveRoadmap(roadmap);
      }
    }

    // Step 0: Process ChatOps commands (/pause, /resume, /tick, /directive, /retry, /status)
    const chatOpsChanged = await IssueManager.processChatOps(roadmap);
    if (chatOpsChanged) {
      await StateManager.saveRoadmap(roadmap);
    }

    // Step 0.5: Observe active subagent runs & watchdog monitoring.
    // Half 1 cancels runs older than the stale timeout. Half 2 recovers
    // tasks whose runs died without a trace (job timeout kills, preemption).
    // NOTE: subagent workflow runs execute on main, so run.headBranch NEVER
    // equals a task branch — correlation is by dispatchedAt age + branch-tip
    // freshness, never by branch-name matching.
    const activeRuns = await GitManager.getActiveSubagentRuns();
    const now = Date.now();
    const staleMs = CONFIG.STALE_RUN_TIMEOUT_MINUTES * 60 * 1000;
    if (activeRuns.length > 0) {
      console.log(`👀 Observing ${activeRuns.length} active subagent runs in GitHub Actions:`);
      for (const run of activeRuns) {
        console.log(`   - Run #${run.databaseId}: ${run.name} [${run.status}] on ${run.headBranch}`);
      }
      for (const run of activeRuns) {
        const started = run.createdAt ? Date.parse(run.createdAt) : NaN;
        if (Number.isNaN(started) || now - started < staleMs) continue;
        console.warn(`⏰ Watchdog: cancelling stale run #${run.databaseId} (>${CONFIG.STALE_RUN_TIMEOUT_MINUTES}m old)...`);
        await GitManager.cancelWorkflowRun(run.databaseId);
      }
    }
    // Shared requeue helper: bounded by attempts → FAILED, never infinite.
    // Used by both the fast idle path below and the 40m branch-tip watchdog.
    const requeueStale = async (task: (typeof roadmap.tasks)[number], why: string) => {
      task.attempts += 1;
      if (task.attempts >= task.maxAttempts) {
        task.status = "FAILED";
        task.failedAt = new Date().toISOString();
        console.error(`❌ [${task.id}] ${why}; max attempts reached. Marked FAILED.`);
        task.reviewNotes = `Watchdog (${why}): max attempts reached.`;
      } else {
        task.status = "PENDING";
        console.warn(`⏰ Watchdog (${why}): [${task.id}] re-queued (${task.attempts}/${task.maxAttempts}).`);
        task.reviewNotes = `Watchdog (${why}); re-queued. Previous notes preserved below.\n${task.reviewNotes || ""}`;
      }
      task.updatedAt = new Date().toISOString();
      if (roadmap.projectNumber) {
        await ProjectManager.updateItemStatus(roadmap.projectNumber, task, task.status === "FAILED" ? "Failed" : "Todo");
        await ProjectManager.postTaskProgressComment(
          task,
          `⏰ **Watchdog (${why}):** task re-queued (${task.attempts}/${task.maxAttempts}).`
        );
      }
    };
    // Fast path: global silence + task silent since before its dispatch.
    // (A live worker always has an active run; with none anywhere and no
    // push since dispatch, nobody will ever complete this task.)
    const idleMs = CONFIG.IDLE_REQUEUE_MINUTES * 60 * 1000;
    if (activeRuns.length === 0) {
      for (const task of roadmap.tasks) {
        if (task.status !== "IN_PROGRESS" || !task.dispatchedAt) continue;
        const dispAge = now - Date.parse(task.dispatchedAt);
        if (Number.isNaN(dispAge) || dispAge < idleMs) continue;
        const tip = await GitManager.branchTipTime(task.branch);
        if (tip >= 0 && tip > Date.parse(task.dispatchedAt)) continue;
        await requeueStale(task, "idle worker");
      }
    }
    // Dead-task recovery: IN_PROGRESS + old dispatch + stale branch tip means
    // no live worker (a live one was dispatched recently or pushed recently).
    // Skipped while any run is active AND the tip is unknown (queued dispatch
    // may not have pushed yet). Bounded by attempts → FAILED, never infinite.
    for (const task of roadmap.tasks) {
      if (task.status !== "IN_PROGRESS" || !task.dispatchedAt) continue;
      const dispAge = now - Date.parse(task.dispatchedAt);
      if (Number.isNaN(dispAge) || dispAge < staleMs) continue;
      const tip = await GitManager.branchTipTime(task.branch);
      if (tip < 0 && activeRuns.length > 0) continue;
      if (tip >= 0 && now - tip < staleMs) continue;
      await requeueStale(task, "no worker activity");
    }

    // Step 1: Review any completed subagent tasks
    await this.reviewTasks(roadmap);

    // Step 1.2: Overnight autopilot — resurrect FAILED tasks whose cooldown
    // elapsed, bounded by FAILED_AUTO_RESURRECT_MAX. Pre-dates-failedAt
    // tasks fall back to updatedAt so existing FAILED entries qualify.
    // Human /retry resets the budget (see issue_manager).
    for (const task of roadmap.tasks) {
      if (task.status !== "FAILED") continue;
      const res = task.resurrections || 0;
      if (res >= CONFIG.FAILED_AUTO_RESURRECT_MAX) continue;
      const failMs = Date.parse(task.failedAt || task.updatedAt);
      if (Number.isNaN(failMs) || now - failMs < CONFIG.FAILED_RESURRECT_COOLDOWN_MIN * 60 * 1000) continue;
      task.status = "PENDING";
      task.attempts = 0;
      task.resurrections = res + 1;
      task.lastReviewSha = undefined;
      task.lastGateVersion = undefined;
      task.updatedAt = new Date().toISOString();
      task.reviewNotes = `Auto-resurrect #${res + 1}/${CONFIG.FAILED_AUTO_RESURRECT_MAX} after ${CONFIG.FAILED_RESURRECT_COOLDOWN_MIN}m cooldown (was FAILED). Previous: ${(task.reviewNotes || "-").slice(0, 1000)}`;
      console.log(`🌅 [${task.id}] auto-resurrected to PENDING (${task.resurrections}/${CONFIG.FAILED_AUTO_RESURRECT_MAX}).`);
      if (roadmap.projectNumber) {
        await ProjectManager.updateItemStatus(roadmap.projectNumber, task, "Todo");
        await ProjectManager.postTaskProgressComment(
          task,
          `🌅 **Auto-resurrect #${task.resurrections}:** cool-down elapsed, re-queued without human intervention.`
        );
      }
    }
    // Resurrections ride on the end-of-tick persist (same as watchdog).

    // Step 1.5: Check and close completed intermediate Milestones
    if (roadmap.milestones) {
      for (let i = 0; i < roadmap.milestones.length; i++) {
        const m = roadmap.milestones[i];
        const milestoneTasks = roadmap.tasks.filter((t) => t.milestone === m.title);
        if (milestoneTasks.length > 0 && milestoneTasks.every((t) => t.status === "COMPLETED")) {
          const closed = await IssueManager.closeMilestoneIfCompleted(m.title);
          if (closed) {
            const tag = `v0.${i + 1}.0`;
            console.log(`🎉 Milestone "${m.title}" completed! Publishing release ${tag}...`);
            await IssueManager.createMilestoneRelease(
              tag,
              `Milestone Completed: ${m.title}`,
              `## 🏆 Milestone Achieved: ${m.title}\n\nAll tasks in this milestone were verified and integrated:\n${milestoneTasks.map((t) => `- [x] **[${t.id}]** ${t.title}`).join("\n")}`
            );
          }
        }
      }
    }

    // Step 2: Check for finished roadmap
    const allCompleted = roadmap.tasks.length > 0 && roadmap.tasks.every((t) => t.status === "COMPLETED");
    if (allCompleted) {
      console.log("🎉 ALL TASKS COMPLETED! Target project is fully built and verified.");
      roadmap.globalStatus = "COMPLETED";
      await this.persistRoadmap(roadmap, "chore(orchestrator): all tasks completed");

      // Sync Dashboard Issue & Publish Release Tag
      const issueNum = await IssueManager.syncDashboardIssue(roadmap);
      if (issueNum) {
        await IssueManager.postMilestoneUpdate(
          issueNum,
          "🎉 **All tasks have been successfully completed and verified!** Creating Final Release `v1.0.0`..."
        );
      }
      await IssueManager.createMilestoneRelease(
        "v1.0.0",
        `Release v1.0.0 - ${roadmap.projectName}`,
        `## 🚀 Project Completed: ${roadmap.projectName}\n\nAll tasks implemented, reviewed, audited, and tested.\n\n### Deliverables:\n- Core workspace built in \`workspace/\`\n- 0 test failures on \`bun test\`\n- Security audit clean`
      );
      return;
    }

    // Step 3: Dispatch any tasks unblocked by approvals (unless paused)
    await this.dispatchReadyTasks(roadmap);

    // Board drift heal: sync when statuses moved, or hourly as a backstop
    // for human edits on the board. Idle ticks skip the snapshot entirely
    // (GraphQL saver) — event-driven writes already covered live changes.
    if (roadmap.projectNumber) {
      const sigNow = roadmap.tasks.map((t) => `${t.id}:${t.status}`).join(",");
      const lastSync = Date.parse(roadmap.lastBoardSyncAt || "");
      const stale = Number.isNaN(lastSync) || Date.now() - lastSync > 60 * 60 * 1000;
      if (sigNow !== statusSigBefore || stale) {
        await ProjectManager.syncBoardState(roadmap, roadmap.projectNumber);
        roadmap.lastBoardSyncAt = new Date().toISOString();
      } else {
        console.log("ℹ️ Board in sync (no status drift); skipping snapshot.");
      }
    }

    // Save, sync dashboard issue, and commit progress (merge-safe persist)
    await this.persistRoadmap(roadmap, "chore(orchestrator): update progress roadmap");
    await IssueManager.syncDashboardIssue(roadmap);

    console.log("💤 Orchestrator run completed. Exiting to conserve runner minutes.");
  }
}

// CLI Execution Entrypoint
async function main() {
  const { values } = parseArgs({
    args: Bun.argv,
    options: {
      action: { type: "string", default: "tick" },
    },
    strict: true,
    allowPositionals: true,
  });

  const action = values.action || "tick";

  // Optional: Authenticate via GitHub App if CLIENT_ID / APP_PRIVATE_KEY are provided
  await initializeGitHubAppAuth();

  switch (action) {
    case "plan":
      await OrchestratorEngine.plan();
      break;
    case "review": {
      const roadmap = await StateManager.loadRoadmap();
      if (roadmap) {
        await OrchestratorEngine.reviewTasks(roadmap);
        await OrchestratorEngine.persistRoadmap(roadmap, "chore(orchestrator): review pass");
      }
      break;
    }
    case "project": {
      // Repair action: (re)build Projects v2 board + milestone/issue links
      // without touching task statuses. Safe to run any time.
      await GitManager.setupGitAuthor();
      await GitManager.run(["git", "fetch", "--all"]);
      if (GitManager.isDataMode()) {
        await GitManager.ensureDataRemote();
        await GitManager.syncStateIn();
      }
      const roadmap = await StateManager.loadRoadmap();
      if (!roadmap) {
        console.error("❌ No roadmap found; run plan first.");
        process.exit(1);
      }
      if (roadmap.milestones && roadmap.milestones.length > 0) {
        await ProjectManager.ensureMilestones(roadmap.milestones, (t) => OrchestratorEngine.isMilestoneComplete(roadmap, t));
      }
      const projectNum = await ProjectManager.ensureProject(roadmap);
      for (const task of roadmap.tasks) {
        await ProjectManager.ensureTaskIssue(task, task.milestone);
      }
      if (projectNum) {
        await ProjectManager.syncBoardState(roadmap, projectNum);
      }
      await OrchestratorEngine.persistRoadmap(roadmap, "chore(orchestrator): repair project board links");
      console.log(
        projectNum ? `✅ Project board ready: #${projectNum}` : "⚠️ Project board still unavailable — see scope hint above."
      );
      break;
    }
    case "setup": {
      // One-shot repo settings audit & repair (NOT a loop step — run once
      // per repo; settings rarely change). Inspects the public repo and,
      // in dual-repo mode, the private data repo. Applies fixes only when
      // an admin PAT is configured, otherwise reports what to flip manually.
      // Makes no commits and touches no branches.
      const { RepoSetup } = await import("./repo_setup.ts");
      const { ProjectManager } = await import("./project_manager.ts");
      const me = await ProjectManager.getOwner();
      const here = (CONFIG.GITHUB_REPOSITORY || "").split("/");
      const publicFeatures = RepoSetup.parseFeatures(CONFIG.PUBLIC_FEATURES, RepoSetup.defaultFeatures("public"));
      const dataFeatures = RepoSetup.parseFeatures(CONFIG.DATA_FEATURES, RepoSetup.defaultFeatures("data"));
      const reports = [];
      if (here.length === 2) {
        reports.push(await RepoSetup.ensureRepoSettings(here[0], here[1], CONFIG.PROJECT_TOKEN, publicFeatures));
      } else {
        const repo = await GitManager.run([
          "gh",
          "repo",
          "view",
          "--json",
          "owner,name",
          "--jq",
          '[.owner.login, .name] | join("/")',
        ]);
        if (repo.exitCode === 0 && repo.stdout.includes("/")) {
          const [o, n] = repo.stdout.trim().split("/");
          reports.push(await RepoSetup.ensureRepoSettings(o, n, CONFIG.PROJECT_TOKEN));
        } else {
          console.error("❌ Cannot determine current repository; run inside a checkout.");
        }
      }
      if (GitManager.isDataMode()) {
        const slug = GitManager.dataRepoSlug();
        if (slug) {
          const [o, n] = slug.split("/");
          reports.push(await RepoSetup.ensureRepoSettings(o, n, GitManager.dataPat(), dataFeatures));
        }
      }
      for (const r of reports) {
        console.log(`\n### ${r.repo}\n${r.lines.join("\n")}`);
      }
      break;
    }
    case "services": {
      // Lightweight prep for the workflow service step: regenerate the
      // compose file from the roadmap (no LLM, no dispatch). The compose
      // file itself is ephemeral and never committed.
      await GitManager.setupGitAuthor();
      if (GitManager.isDataMode()) {
        await GitManager.ensureDataRemote();
        await GitManager.syncStateIn();
      }
      {
        const roadmap = await StateManager.loadRoadmap();
        if (!roadmap) {
          console.log("ℹ️ No roadmap yet; skipping service files.");
          break;
        }
        await OrchestratorEngine.ensureServiceFiles(roadmap);
      }
      break;
    }
    case "chatops": {
      // Fast lane: process dashboard ChatOps commands ONLY (no reviews,
      // dispatches, merges or releases). Runs in its own concurrency group
      // so operator commands answer in ~1 min even when a long tick holds
      // the main singleton. Shares persistRoadmap, so concurrent writers
      // merge instead of clobbering. Rocket-reaction idempotency prevents
      // double-processing when a tick overlaps this run.
      await GitManager.setupGitAuthor();
      await GitManager.run(["git", "fetch", "--all"]);
      if (GitManager.isDataMode()) {
        await GitManager.ensureDataRemote();
        await GitManager.syncStateIn();
      }
      {
        const roadmap = await StateManager.loadRoadmap();
        if (!roadmap) {
          console.error("❌ No roadmap found; run plan first.");
          process.exit(1);
        }
        const changed = await IssueManager.processChatOps(roadmap);
        if (changed) {
          await OrchestratorEngine.persistRoadmap(roadmap, "chore(orchestrator): chatops command");
        } else {
          await StateManager.saveRoadmap(roadmap);
        }
        await IssueManager.syncDashboardIssue(roadmap);
      }
      console.log("💬 ChatOps run completed.");
      break;
    }
    case "tick":
    default:
      await OrchestratorEngine.tick();
      break;
  }
}

main().catch((err) => {
  console.error("Fatal error in orchestrator engine:", err);
  process.exit(1);
});
