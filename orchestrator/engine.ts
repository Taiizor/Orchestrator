import { parseArgs } from "util";
import { existsSync, statSync, mkdirSync, rmSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { CONFIG, isEngineEnabled } from "./config.ts";
import { StateManager } from "./state_manager.ts";
import { GitManager } from "./git_manager.ts";
import { OpenCodeClient } from "./opencode_client.ts";
import { IssueManager } from "./issue_manager.ts";
import { ProjectManager } from "./project_manager.ts";
import {
  GATE_VERSION,
  hasStructuredProgress,
  isDefaultProgress,
  runReviewGate,
  classifyGateFailure,
  isAllowedFile,
  isGeneratedJunkPath,
  priorFixRounds,
  parseReviewOutput,
} from "./review_gate.ts";
import type { GateFailureKind } from "./review_gate.ts";
import { validateRoadmap, formatValidation, sanitizeCoverage } from "./roadmap_validator.ts";
import { STACKS, normalizeStackId, effectiveTaskStack } from "./stacks.ts";
import type { StackId } from "./stacks.ts";
import { initializeGitHubAppAuth } from "./github_app.ts";
import * as GhQuota from "./gh_quota.ts";
import type { Roadmap, TaskItem, ReviewResult } from "./types.ts";

/** Consecutive deferred reviews before the engine posts an advisory needs-human note. */
const REVIEW_DEFERRAL_ALERT_AT = 6;

/**
 * Recursively copy src dir into dst WITHOUT deleting dst-only files (union).
 * Used by dual-repo persist: src is the engine checkout (template files),
 * dst is the data worktree that may hold data-only files (forged skills)
 * absent from src. A replace (rm + cp) committed those as deletions.
 */
export function unionMirrorDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      unionMirrorDir(s, d);
    } else if (entry.isFile()) {
      copyFileSync(s, d);
    }
  }
}

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
    const binaryExts = new Set([
      ".ttf",
      ".otf",
      ".woff",
      ".woff2",
      ".eot",
      ".fon",
      ".fig",
      ".zip",
      ".tar",
      ".gz",
      ".7z",
      ".rar",
      ".dll",
      ".exe",
      ".so",
      ".dylib",
      ".bin",
      ".dat",
      ".db",
      ".sqlite",
      ".iso",
    ]);
    const binaryAssetList: string[] = [];

    for await (const relPath of glob.scan({ cwd: CONFIG.INPUTS_DIR })) {
      if (relPath.endsWith(".gitkeep")) continue;
      // Skip default input guide README
      if (relPath === "README.md") continue;

      const fullPath = `${CONFIG.INPUTS_DIR}/${relPath}`;
      const dotIdx = relPath.lastIndexOf(".");
      const ext = dotIdx !== -1 ? relPath.slice(dotIdx).toLowerCase() : "";

      if (imageExts.has(ext)) {
        assetList.push(relPath);
      } else if (binaryExts.has(ext)) {
        binaryAssetList.push(relPath);
      } else {
        try {
          // Guard: skip unusually large text files (> 500 KB) to prevent context window explosion
          const stat = statSync(fullPath);
          if (stat.size > 500 * 1024) {
            console.warn(`⚠️ Skipping oversized text file inputs/${relPath} (${(stat.size / 1024).toFixed(0)}KB > 500KB cap)`);
            binaryAssetList.push(relPath);
            continue;
          }

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

    if (fileCount === 0 && assetList.length === 0 && binaryAssetList.length === 0) {
      console.error(
        "❌ No input specification files found in inputs/ directory. Please drop your project files or folder into inputs/."
      );
      process.exit(1);
    }

    if (assetList.length > 0) {
      fullInputContext += `### Available Visual Assets & Mockups:\n${assetList.map((a) => `- \`inputs/${a}\``).join("\n")}\n\n`;
    }

    if (binaryAssetList.length > 0) {
      fullInputContext += `### Available Project Binary Assets & Fonts:\n${binaryAssetList.map((a) => `- \`inputs/${a}\``).join("\n")}\n\n`;
    }

    console.log(
      `📂 Ingested ${fileCount} input document(s), ${assetList.length} visual asset(s), and ${binaryAssetList.length} binary/font asset(s) from inputs/`
    );

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
      const rawAnalystFiles = assetList.map((a) => `${CONFIG.INPUTS_DIR}/${a}`).filter((p) => existsSync(p));
      const { kept: analystFiles, skipped } = await OpenCodeClient.filterAttachableFiles(rawAnalystFiles);
      if (skipped.length > 0) {
        console.warn(
          `⚠️ Skipped ${skipped.length} file(s) exceeding 10MB attachment limit (prevents SseEventTooLarge): ${skipped.map((s) => `${s.path} (${(s.bytes / 1024 / 1024).toFixed(1)}MB)`).join(", ")}`
        );
      }
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
          const expandTimeoutMs = CONFIG.SPEC_EXPANSION_TIMEOUT_MINUTES * 60 * 1000;
          const expandRes = await OpenCodeClient.runWithFallback(expandPrompt, { timeoutMs: expandTimeoutMs });
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
        ? // Bounded input: the forger needs TOPICS, not the full text. A thick
          // spec (tens of KB) would overflow small-context free models; 40K
          // chars carry every section header plus substance. The raw-inputs
          // fallback keeps the legacy 12K guard.
          `## Synthesized Project Specification:\n${compiledSpecContent.slice(0, 40000)}`
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
        const stack = normalizeStackId((raw as Record<string, unknown>).stack, "bun");
        roadmapData = {
          projectName: raw.projectName || "Generated Project",
          version: raw.version || 1,
          summary: raw.summary || "",
          globalStatus: "IN_PROGRESS",
          milestones: raw.milestones || [],
          coverage: sanitizeCoverage((raw as Record<string, unknown>).coverage),
          services: Array.isArray(raw.services)
            ? raw.services.filter(
                (s: any) => typeof s === "string" || (s && typeof s.name === "string" && typeof s.image === "string")
              )
            : [],
          stack,
          updatedAt: new Date().toISOString(),
          tasks: (raw.tasks || []).map((t: any, idx: number) => ({
            id: t.id || `TASK-${String(idx + 1).padStart(3, "0")}`,
            title: t.title || "Untitled Task",
            description: t.description || "",
            role: t.role || "backend",
            dependencies: t.dependencies || [],
            targetFiles: t.targetFiles || [],
            // Per-task stack override (split layers); undefined = inherit roadmap.stack.
            stack: typeof t.stack === "string" && t.stack.trim() ? (t.stack.trim().toLowerCase() as any) : undefined,
            // Launch round survives planning (validator requires it on launch
            // tasks); invalid values stay undefined so validation flags them.
            launchRound:
              typeof t.launchRound === "number" && Number.isInteger(t.launchRound) && t.launchRound >= 1
                ? t.launchRound
                : undefined,
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
    // Coverable inputs for the input→task coverage check (docs + assets;
    // generated skills and template files excluded).
    const coverableInputs: string[] = [];
    try {
      const iglob = new Bun.Glob("inputs/**/*");
      for await (const rel of iglob.scan({ cwd: ".", onlyFiles: true })) {
        const norm = rel.replace(/\\/g, "/");
        if (/(^|\/)README\.md$/.test(norm) || norm.endsWith(".gitkeep") || norm.startsWith("inputs/skills/")) continue;
        coverableInputs.push(norm.startsWith("inputs/") ? norm : `inputs/${norm}`);
      }
    } catch {
      // No inputs dir — coverage check stays silent.
    }
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
        stack: (t as any).stack,
        status: (t as any).status,
        launchRound: (t as any).launchRound,
      })),
      milestones: roadmapData.milestones,
      services: roadmapData.services,
      stack: (roadmapData as Roadmap).stack,
      inputFiles: coverableInputs,
      coverage: roadmapData.coverage,
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

    // Dashboard FIRST: operators watch planning live and ChatOps (/tick,
    // /directive, /ask) needs the issue to exist. Upsert is idempotent —
    // the end-of-plan sync below refreshes the body with issue/board links.
    await IssueManager.syncDashboardIssue(roadmapData);

    // Initialize GitHub Project (v2), Milestones, and Issues
    if (roadmapData.milestones && roadmapData.milestones.length > 0) {
      await ProjectManager.ensureMilestones(roadmapData.milestones, (t) => this.isMilestoneComplete(roadmapData, t));
    }
    const projectNum = await ProjectManager.ensureProject(roadmapData);
    // One batched issue index for the whole loop (1 call replaces up to 2
    // `gh issue view` per task). Null → per-task fallback inside ensure.
    const planIssueIndex = await ProjectManager.fetchIssueIndex();
    for (const task of roadmapData.tasks) {
      await ProjectManager.ensureTaskIssue(task, task.milestone, planIssueIndex);
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
            const push = await GitManager.pushWithAuthRetry(remote, [remote, `${sha}:refs/heads/${CONFIG.INTEGRATION_BRANCH}`], {
              maxRetries: 2,
            });
            console.log(
              push.ok
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
    const cap = CONFIG.MAX_FORGED_SKILLS > 0 ? CONFIG.MAX_FORGED_SKILLS : Number.POSITIVE_INFINITY;
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

  /**
   * Step 1.3: consume launch-verification verdicts.
   * - COMPLETED launch task, verdict unprocessed → read its TASK_PROGRESS
   *   verdict block: `fail` spawns ONE fix task (role inferred from gaps),
   *   bounded by MAX_LAUNCH_ROUNDS (then the launch is FAILED + escalated
   *   so false celebration can't fire); `pass`/`skipped` stay quiet.
   * - COMPLETED launch-fix task with no linked re-launch and no active
   *   launch in its milestone → queue ONE re-launch (round+1).
   */
  private static async processLaunchVerdicts(roadmap: Roadmap): Promise<boolean> {
    const { parseLaunchVerdict, inferFixRole, countLaunchFixRounds, MAX_LAUNCH_ROUNDS, LAUNCH_FIX_TITLE_PREFIX } =
      await import("./launch_verdict.ts");
    let changed = false;
    const now = new Date().toISOString();
    let nextNum = Math.max(0, ...roadmap.tasks.map((t) => parseInt((t.id.match(/(\d+)/) || ["0", "0"])[1], 10) || 0)) + 1;
    const takeId = () => `TASK-${String(nextNum++).padStart(3, "0")}`;
    const milestoneLaunchesActive = (milestone: string | undefined) =>
      roadmap.tasks.some(
        (t) =>
          t.role === "launch" &&
          (t.milestone || "") === (milestone || "") &&
          ["PENDING", "IN_PROGRESS", "IN_REVIEW"].includes(t.status)
      );

    for (const task of roadmap.tasks) {
      // A. Consume fresh launch verdicts exactly once.
      if (task.role === "launch" && task.status === "COMPLETED" && !task.launchVerdict) {
        let progress: string | null = null;
        try {
          progress = await GitManager.showFile(task.branch, `workspace/${CONFIG.TASK_PROGRESS_FILE}`);
        } catch {
          // Branch gone — nothing to parse.
        }
        const verdict = progress ? parseLaunchVerdict(progress) : null;
        if (!verdict) {
          console.warn(`⚠️ [${task.id}] launch completed without a parseable verdict block; marking skipped (no auto-fix).`);
          task.launchVerdict = "skipped";
          task.updatedAt = now;
          changed = true;
          continue;
        }
        task.launchVerdict = verdict.verdict;
        task.updatedAt = now;
        changed = true;
        if (verdict.verdict !== "fail") {
          console.log(`✅ [${task.id}] launch verdict: ${verdict.verdict}.`);
          continue;
        }
        const rounds = countLaunchFixRounds(roadmap.tasks, task.milestone);
        if (rounds >= MAX_LAUNCH_ROUNDS) {
          if (!task.reviewNotes?.includes("[launch-escalated]")) {
            console.error(`🚨 [${task.id}] launch failed after ${rounds} auto-fix rounds; escalating to humans.`);
            task.status = "FAILED";
            task.failedAt = now;
            task.reviewNotes =
              `${task.reviewNotes || ""}\n[launch-escalated] Auto rounds exhausted after repeated launch failures; human needed.`.trim();
            task.updatedAt = now;
            if (roadmap.projectNumber) {
              await ProjectManager.updateItemStatus(roadmap.projectNumber, task, "Failed");
            }
            const issueNum = await IssueManager.syncDashboardIssue(roadmap);
            if (issueNum) {
              await IssueManager.postMilestoneUpdate(
                issueNum,
                `🚨 **Launch verification needs a human:** [${task.id}] failed ${rounds + 1} launch round(s) with auto-fixes exhausted (milestone \`${task.milestone || "?"}\`). Latest gaps: ${
                  verdict.gaps
                    .slice(0, 5)
                    .map((g) => `[${g.area}] ${g.detail}`)
                    .join("; ") || "see task progress"
                }.`
              );
            }
          }
          continue;
        }
        const role = inferFixRole(verdict.gaps);
        const fixId = takeId();
        const gapText = verdict.gaps
          .map(
            (g, i) =>
              `${i + 1}. [${g.area}] ${g.detail}${g.files?.length ? ` (likely: ${g.files.join(", ")})` : ""}${g.log ? `\n   log: ${g.log.slice(0, 500)}` : ""}`
          )
          .join("\n");
        // Inherit the failed launch's layer: a split-stack fix dispatched on
        // the roadmap default instead of the failing layer's stack is a
        // guaranteed fail (go breakage fixed with bun). Gap files scope the
        // fix; empty when the verdict names none (reviewer judges relevance).
        const gapFiles = [
          ...new Set(
            verdict.gaps
              .flatMap((g) => g.files || [])
              .filter((f) => typeof f === "string" && f.startsWith("workspace/"))
              .slice(0, 12)
          ),
        ];
        roadmap.tasks.push({
          id: fixId,
          title: `${LAUNCH_FIX_TITLE_PREFIX} (round ${rounds + 1})`,
          description:
            `[LAUNCH-FIX round=${rounds + 1} for ${task.id}] The launch verification failed — fix the gaps below, then prove with tests. Do NOT re-verify full boot here; a re-launch is queued automatically when you complete.\n\n` +
            `Failing gaps:\n${gapText || "(no gap details reported)"}\n\nEvidence:\n${(verdict.evidence || "").slice(0, 1000)}`,
          role,
          dependencies: [],
          targetFiles: gapFiles,
          stack: (task as any).stack,
          deliverables: [
            `Fix the ${verdict.gaps.length || "reported"} launch gap(s) in ${gapFiles.length > 0 ? gapFiles.join(", ") : "the failing areas"}`,
            `Prove the fix with ${(task as any).verificationCommand || "the layer toolchain tests"} (0 failures, real output in TASK_PROGRESS.md)`,
          ],
          verificationCommand:
            typeof (task as any).verificationCommand === "string" && (task as any).verificationCommand.trim()
              ? (task as any).verificationCommand.trim()
              : undefined,
          status: "PENDING",
          branch: `task/${fixId}`,
          milestone: task.milestone,
          attempts: 0,
          maxAttempts: CONFIG.MAX_TASK_ATTEMPTS,
          reviewNotes: `[LAUNCH-FIX] Auto-spawned from ${task.id} fail verdict. Unscoped — reviewer judges file relevance.`,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`🔧 [${task.id}] launch failed → queued fix ${fixId} (role ${role}).`);
        continue;
      }
      // B. Completed launch-fix → ONE bounded re-launch (unless one is active).
      if (task.status === "COMPLETED" && task.title.startsWith(LAUNCH_FIX_TITLE_PREFIX)) {
        const linked = roadmap.tasks.some((t) => t.role === "launch" && t.dependencies.includes(task.id));
        if (linked || milestoneLaunchesActive(task.milestone)) continue;
        const roundMatch = (task.description || "").match(/\[LAUNCH-FIX round=(\d+)/);
        const nextRound = (roundMatch ? parseInt(roundMatch[1], 10) : 1) + 1;
        const template = roadmap.tasks.find((t) => t.role === "launch" && (t.milestone || "") === (task.milestone || ""));
        const relaunchId = takeId();
        roadmap.tasks.push({
          id: relaunchId,
          title: `Re-launch verification (round ${nextRound})`,
          description: `Re-run launch verification for milestone \`${task.milestone || "?"}\` after fix ${task.id}. Same protocol as the launch role: boot, probe, verdict block.`,
          role: "launch",
          dependencies: [task.id],
          targetFiles: template?.targetFiles ? [...template.targetFiles] : [],
          stack: (template as any)?.stack,
          verificationCommand: (template as any)?.verificationCommand,
          status: "PENDING",
          branch: `task/${relaunchId}`,
          milestone: task.milestone,
          launchRound: nextRound,
          attempts: 0,
          maxAttempts: CONFIG.MAX_TASK_ATTEMPTS,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`🚀 [${task.id}] fix completed → queued re-launch ${relaunchId} (round ${nextRound}).`);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Action: Adopt an existing workspace into management (brownfield bootstrap).
   * Triggered manually (Actions → action=adopt), NOT from ChatOps — there is
   * no dashboard issue yet. Surveys workspace/, backfills a roadmap of
   * COMPLETED baseline tasks (one per area), reverse-engineers CONTRACTS.md
   * when missing, then wires board + dashboard. Refuses when a roadmap
   * already exists (use /add or /revise instead) and when workspace/ is
   * empty (use plan instead). Never creates issues for adopted tasks.
   */
  public static async adopt(): Promise<void> {
    console.log("🧭 Adopting existing workspace/ into management...");

    await GitManager.setupGitAuthor();
    await GitManager.run(["git", "fetch", "--all"]);
    if (GitManager.isDataMode()) {
      const remoteOk = await GitManager.ensureDataRemote();
      if (!remoteOk) {
        console.error("❌ Data remote unreachable — adopt cannot read workspace or persist state. Aborting.");
        process.exit(1);
      }
      await GitManager.syncDataIn(CONFIG.INTEGRATION_BRANCH);
      // Refuse to overwrite a live roadmap (history lives in data branches).
      try {
        const show = await GitManager.run(["git", "show", `${CONFIG.DATA_REMOTE}/${CONFIG.BASE_BRANCH}:${CONFIG.ROADMAP_FILE}`]);
        const remote = JSON.parse(show.stdout) as Roadmap;
        if (remote && Array.isArray(remote.tasks) && remote.tasks.length > 0) {
          console.error(
            `❌ Roadmap already exists on ${CONFIG.DATA_REMOTE}/${CONFIG.BASE_BRANCH} (${remote.tasks.length} tasks). Adopt refuses to overwrite it — use /add or /revise for changes, or delete it to re-adopt.`
          );
          process.exit(1);
        }
      } catch {
        // No remote state — safe to adopt.
      }
    } else {
      const local = await StateManager.loadRoadmap();
      if (local && local.tasks.length > 0) {
        console.error(`❌ Local roadmap already exists (${local.tasks.length} tasks). Adopt refuses to overwrite it.`);
        process.exit(1);
      }
    }

    // Survey: what actually exists in workspace/ (no LLM yet — facts first).
    const survey: string[] = [];
    try {
      const glob = new Bun.Glob("workspace/**/*");
      let files = 0;
      const dirs = new Set<string>();
      const topFiles: string[] = [];
      for await (const rel of glob.scan({ cwd: ".", onlyFiles: true })) {
        const norm = rel.replace(/\\/g, "/");
        const base = norm.split("/").pop() || "";
        if (base === ".gitkeep" || base === ".gitignore") continue;
        files++;
        const parts = norm.split("/");
        if (parts.length > 2) dirs.add(parts.slice(0, 3).join("/"));
        if (parts.length <= 3 && topFiles.length < 40) topFiles.push(norm);
      }
      survey.push(`workspace files: ${files}`);
      survey.push(`key dirs: ${[...dirs].sort().slice(0, 40).join(", ") || "(none)"}`);
      survey.push(`top-level files: ${topFiles.join(", ") || "(none)"}`);
      if (files === 0) {
        console.error("❌ workspace/ is empty — nothing to adopt. Run plan instead.");
        process.exit(1);
      }
    } catch {
      console.error("❌ workspace/ is missing or unreadable — nothing to adopt. Run plan instead.");
      process.exit(1);
    }
    try {
      const pkg = JSON.parse(await Bun.file("workspace/package.json").text());
      survey.push(
        `package: ${pkg.name || "?"}@${pkg.version || "?"} scripts=[${Object.keys(pkg.scripts || {}).join(",")}] deps=[${Object.keys(
          { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
        )
          .slice(0, 20)
          .join(",")}]`
      );
    } catch {
      survey.push("package.json: absent/unparseable");
    }
    try {
      const contracts = await Bun.file("workspace/CONTRACTS.md").text();
      survey.push(`CONTRACTS.md present (${contracts.length} chars)`);
    } catch {
      survey.push("CONTRACTS.md: MISSING (will reverse-engineer)");
    }
    console.log(`📋 Workspace survey:\n- ${survey.join("\n- ")}`);

    const systemPrompt = await Bun.file("orchestrator/prompts/system.md").text();
    const adoptPrompt =
      `${systemPrompt}\n\nYou are adopting an EXISTING codebase into management. Do NOT propose scaffolding, rewrites, or new features. ` +
      `Survey facts:\n- ${survey.join("\n- ")}\n\n` +
      `Return ONLY a JSON block enclosed in \`\`\`json \`\`\` with this structure (no prose outside the block):\n` +
      `\`\`\`json\n{\n  "projectName": "string",\n  "version": 1,\n  "summary": "what exists today (stack, areas, maturity)",\n` +
      `  "milestones": [{ "title": "v1.0.0 - Adopted Baseline", "description": "as-built state at adoption" }],\n` +
      `  "services": [],\n` +
      `  "stack": "bun | go | rust | dotnet | python | php (detect from survey markers: go.mod → go, Cargo.toml → rust, *.sln/*.csproj → dotnet, pyproject.toml/requirements.txt → python, composer.json → php, else bun)",\n` +
      `  "tasks": [{\n    "id": "TASK-001",\n    "title": "Area name (as-built)",\n    "milestone": "v1.0.0 - Adopted Baseline",\n` +
      `    "description": "REQUIRED, min ~80 words: what EXISTS (files, interfaces, behaviors), exact paths",\n` +
      `    "role": "architect | backend | frontend | mobile | qa | security",\n` +
      `    "dependencies": [],\n    "targetFiles": ["workspace/src/..."],\n` +
      `    "branch": "task/TASK-001-adopted-area",\n` +
      `    "deliverables": ["existing file 1", "existing behavior 2"],\n` +
      `    "verificationCommand": "the adopted stack's test command (bun test | go test ./... | cargo test | dotnet test | python -m pytest -q | php vendor/bin/phpunit)"\n  }]\n}\`\`\`\n` +
      `Rules: one task per coherent area (api slices, services, ui areas, db/schema, tests, contracts). Every task documents AS-BUILT reality, never aspirations. Min 3 tasks for a real codebase.`;
    const res = await OpenCodeClient.runWithFallback(adoptPrompt, { timeoutMs: 10 * 60 * 1000 });
    const jsonMatch = res.stdout.match(/```json([\s\S]*?)```/) || res.stdout.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      console.error("❌ Adopt failed: no roadmap JSON in model output.");
      process.exit(1);
    }
    let raw: any;
    try {
      raw = JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      console.error("Failed to parse adopted roadmap JSON:", e);
      process.exit(1);
    }
    const now = new Date().toISOString();
    const adoptedStack = normalizeStackId((raw as Record<string, unknown>).stack, "bun");
    // Cross-check against workspace markers (LLM mislabels happen): markers win.
    // Mixed trees (go API + bun UI) have no single truthful default — keep the
    // survey's stack as default and warn: future tasks must pin task.stack.
    let detectedStack: StackId = "bun";
    let detectedStacks: StackId[] = [];
    try {
      const { detectWorkspaceStack, detectWorkspaceStacks } = await import("./stacks.ts");
      detectedStack = await detectWorkspaceStack(".");
      detectedStacks = await detectWorkspaceStacks(".");
    } catch {
      /* survey-only fallback */
    }
    if (detectedStacks.length > 1) {
      console.warn(
        `⚠️ Mixed workspace detected (${detectedStacks.join(" + ")}): keeping survey stack '${adoptedStack}' as roadmap default. ` +
          `Future tasks MUST pin their layer via task.stack (planner) or /add stack:X — unset tasks inherit '${adoptedStack}'.`
      );
    }
    const roadmap: Roadmap = {
      projectName: raw.projectName || "Adopted Project",
      version: raw.version || 1,
      summary: raw.summary || "",
      // COMPLETED from birth: adopted history must never trigger the final
      // celebration or milestone releases on subsequent ticks (steady-state).
      globalStatus: "COMPLETED",
      milestones:
        Array.isArray(raw.milestones) && raw.milestones.length > 0
          ? raw.milestones
          : [{ title: "v1.0.0 - Adopted Baseline", description: "as-built state at adoption" }],
      services: [],
      stack: detectedStacks.length > 1 ? adoptedStack : detectedStack !== "bun" ? detectedStack : adoptedStack,
      updatedAt: now,
      tasks: ((raw.tasks || []) as any[]).map((t: any, idx: number) => ({
        id: t.id || `TASK-${String(idx + 1).padStart(3, "0")}`,
        title: t.title || "Adopted area",
        description: t.description || "",
        role: t.role || "backend",
        dependencies: [],
        targetFiles: t.targetFiles || [],
        status: "COMPLETED",
        branch: t.branch || `task/${t.id || `TASK-${String(idx + 1).padStart(3, "0")}`}-adopted`,
        milestone: t.milestone || "v1.0.0 - Adopted Baseline",
        attempts: 0,
        maxAttempts: CONFIG.MAX_TASK_ATTEMPTS,
        deliverables: Array.isArray(t.deliverables) ? t.deliverables.filter((d: any) => typeof d === "string") : [],
        verificationCommand: typeof t.verificationCommand === "string" ? t.verificationCommand : "",
        reviewNotes: "[ADOPTED] Backfilled from as-built survey; not agent-executed.",
        createdAt: now,
        updatedAt: now,
      })),
    };
    if (roadmap.tasks.length === 0) {
      console.error("❌ Adopt produced zero tasks — refusing to persist an empty roadmap.");
      process.exit(1);
    }
    const validation = validateRoadmap({
      tasks: roadmap.tasks.map((t) => ({
        id: t.id,
        role: t.role,
        dependencies: t.dependencies,
        targetFiles: t.targetFiles,
        milestone: t.milestone,
        description: t.description,
        deliverables: t.deliverables,
        verificationCommand: t.verificationCommand,
        stack: (t as any).stack,
        status: (t as any).status,
        launchRound: (t as any).launchRound,
      })),
      milestones: roadmap.milestones,
      services: roadmap.services,
      stack: roadmap.stack,
    });
    if (validation.errors.length > 0) {
      console.error(`❌ Adopted roadmap invalid:\n${formatValidation(validation)}`);
      process.exit(1);
    }
    if (validation.warnings.length > 0) {
      console.warn("⚠️ Adopt validation warnings:\n" + formatValidation({ errors: [], warnings: validation.warnings }));
    }

    // Seed the content branch FIRST (plan parity): future task branches fork
    // from data/develop, so the adopted tree must live there — not just
    // state. Must run BEFORE the CONTRACTS publish below: the seed mirrors
    // the runner workdir (which has no CONTRACTS.md yet) via rm+copy, so a
    // later seed would delete an earlier-published CONTRACTS.md.
    if (GitManager.isDataMode()) {
      const seeded = await GitManager.publishWorkspaceTree(
        CONFIG.INTEGRATION_BRANCH,
        "chore(adopt): seed adopted workspace content"
      );
      console.log(
        seeded
          ? `🌱 Adopted workspace content published to data/${CONFIG.INTEGRATION_BRANCH}.`
          : "⚠️ Workspace content publish failed; task branches may lack a fork point."
      );
    }

    // Reverse-engineer CONTRACTS.md when the codebase lacks one.
    try {
      await Bun.file("workspace/CONTRACTS.md").text();
    } catch {
      console.log("📜 No CONTRACTS.md — reverse-engineering from code...");
      const contractsPrompt =
        `${systemPrompt}\n\nSurvey facts:\n- ${survey.join("\n- ")}\n\n` +
        `Write workspace/CONTRACTS.md for this EXISTING codebase: every API route + method actually present in workspace/src (read the route files), request/response shapes, and domain entities. ` +
        `Document ONLY what exists — no aspirations, no TODOs. Return ONLY the markdown document, no wrapper.`;
      const contractsRes = await OpenCodeClient.runWithFallback(contractsPrompt, { timeoutMs: 10 * 60 * 1000 });
      const doc = (contractsRes.stdout || "").trim();
      // Hallucination tripwire: a real contracts doc references workspace
      // paths and has section structure — a fluent generic essay has neither.
      const headings = (doc.match(/^##\s+.+$/gm) || []).length;
      const grounded = doc.includes("workspace/");
      if (contractsRes.exitCode === 0 && doc.length > 500 && headings >= 2 && grounded) {
        if (GitManager.isDataMode()) {
          const ok = await GitManager.publishFileToData(
            "workspace/CONTRACTS.md",
            doc,
            "docs(adopt): reverse-engineered CONTRACTS.md from as-built code"
          );
          // Mirror into the runner workdir too: later tree publishes mirror
          // from here, and must not regress the file into a deletion.
          try {
            await Bun.write("workspace/CONTRACTS.md", doc);
          } catch {
            /* publish already succeeded; workdir copy is best-effort */
          }
          console.log(
            ok
              ? `✅ CONTRACTS.md reverse-engineered (${doc.length} chars) and published.`
              : "⚠️ CONTRACTS.md generated but publish failed; content logged below for manual commit."
          );
          if (!ok) console.log(doc.slice(0, 2000));
        } else {
          // Single-repo: the checkout IS the product repo (humans own main,
          // but adopt is an explicit bootstrap like the initial state commit).
          await Bun.write("workspace/CONTRACTS.md", doc);
          await GitManager.run(["git", "add", "-f", "workspace/CONTRACTS.md"]);
          await GitManager.run([
            "git",
            "-c",
            "user.name=github-actions[bot]",
            "-c",
            "user.email=github-actions[bot]@users.noreply.github.com",
            "commit",
            "-m",
            "docs(adopt): reverse-engineered CONTRACTS.md from as-built code",
          ]);
          let pushed = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            const push = await GitManager.run(["git", "push", "origin", CONFIG.BASE_BRANCH]);
            if (push.exitCode === 0) {
              pushed = true;
              break;
            }
            if (attempt < 3) {
              await Bun.sleep(attempt * 2000);
              await GitManager.run(["git", "fetch", "origin"]);
              await GitManager.run(["git", "pull", "--rebase"]);
            } else {
              console.warn("⚠️ CONTRACTS push failed after 3 attempts:", push.stderr.slice(0, 300));
            }
          }
          console.log(
            pushed
              ? `✅ CONTRACTS.md reverse-engineered (${doc.length} chars) and committed.`
              : "⚠️ CONTRACTS.md written locally but push failed; commit it manually."
          );
        }
      } else {
        console.warn("⚠️ CONTRACTS reverse-engineering produced no usable document; skipping.");
      }
    }

    await this.persistRoadmap(roadmap, "chore(orchestrator): adopt existing workspace");
    if (roadmap.milestones && roadmap.milestones.length > 0) {
      await ProjectManager.ensureMilestones(roadmap.milestones, (t) => OrchestratorEngine.isMilestoneComplete(roadmap, t));
    }
    const projectNum = await ProjectManager.ensureProject(roadmap);
    if (projectNum) roadmap.projectNumber = projectNum;
    // Deliberately NO per-task issues: adopted tasks are history, not work.
    // Issues (and board cards) appear for future PENDING tasks only.
    await IssueManager.syncDashboardIssue(roadmap);
    await this.persistRoadmap(roadmap, "chore(orchestrator): adopt project linkage");
    console.log(
      `✅ Adopted ${roadmap.tasks.length} areas as COMPLETED into ${projectNum ? `board #${projectNum}` : "roadmap (board unavailable)"}. ` +
        `Add new work via /add, fix existing via /revise.`
    );
  }

  public static async reviewTasks(roadmap: Roadmap): Promise<boolean> {
    let hasChanges = false;

    // Liveness snapshot (one API call): lets the empty-diff guard below tell
    // "agent done early, judge now" apart from "agent may still be working".
    // Runs execute on main, but their name carries the task id
    // ("Subagent: TASK-066 (frontend)") — map it so a task whose subagent is
    // still mid-flight is never judged on a half-written branch (TASK-066,
    // 2026-10-17: a tick reviewed stale, already-rejected content while its
    // rework run was active).
    let anyActiveRuns = false;
    const activeTaskIds = new Set<string>();
    try {
      const activeRuns = await GitManager.getActiveSubagentRuns();
      anyActiveRuns = activeRuns.length > 0;
      for (const run of activeRuns) {
        const match = `${run.name ?? ""} ${run.displayTitle ?? ""}`.match(/TASK-[0-9]+/i);
        if (match) activeTaskIds.add(match[0].toUpperCase());
      }
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
              // AND at least one active run globally. Fresh branch commits
              // alone prove nothing — a finished run's push stays "fresh"
              // for 45m after exit, so it must not block judgment.
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
              // Launch tasks must prove fresh probe execution: an empty diff
              // with no fresh verdict block means the agent never ran probes.
              // Stay IN_REVIEW — never auto-complete, never recycle an old
              // verdict (docs/autonomous-remediation-plan.md §3.5).
              if (task.role === "launch") {
                const { parseLaunchVerdict } = await import("./launch_verdict.ts");
                if (!parseLaunchVerdict(progressContent)) {
                  if (task.status !== "IN_REVIEW") {
                    task.status = "IN_REVIEW";
                    task.reviewNotes =
                      "Launch task has no fresh probe verdict block on its branch; run probes and report before review.";
                    task.updatedAt = new Date().toISOString();
                    hasChanges = true;
                  }
                  continue;
                }
              }
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
              // An active run for THIS task means the branch is still being
              // written: the tip can move at any moment (rework pushes
              // mid-flight), so judging now would verdict stale content and
              // race the agent. The completion wake brings the next tick,
              // which reviews the settled branch (reviewer infra failures
              // defer instead of burning attempts).
              if (activeTaskIds.has(task.id)) {
                console.log(
                  `⏸️ [${task.id}] deliverables on branch but its subagent run is still active; holding review until the run completes.`
                );
                continue;
              }
              // If this branch tip was already reviewed and rejected, do not re-transition
              // to IN_REVIEW until the subagent pushes a new commit (fresh tip).
              const currentTip = await GitManager.branchTipSha(task.branch);
              if (currentTip && task.lastReviewSha === currentTip && task.lastGateVersion === GATE_VERSION) {
                continue;
              }

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

    // Limit review to 1 task per tick to avoid oversized cycles and long queue stalls.
    // If more tasks remain IN_REVIEW, downstream logic will re-wake the engine immediately.
    // Prioritize tasks with fresh/unreviewed commits over stale rejected tips.
    const tasksWithTips = await Promise.all(
      tasksInReview.map(async (t) => ({
        task: t,
        tip: await GitManager.branchTipSha(t.branch),
      }))
    );
    const freshEntry = tasksWithTips.find((entry) => !entry.task.lastReviewSha || entry.task.lastReviewSha !== entry.tip);
    const taskToProcess = freshEntry ? freshEntry.task : tasksInReview[0];
    console.log(
      tasksInReview.length > 1
        ? `🔍 Found ${tasksInReview.length} tasks IN_REVIEW; reviewing 1 task ([${taskToProcess.id}]) in this cycle.`
        : `🔍 Reviewing deliverables for [${taskToProcess.id}]...`
    );
    const reviewerPromptTemplate = await Bun.file("orchestrator/prompts/reviewer.md").text();

    for (const task of [taskToProcess]) {
      console.log(`🧐 Reviewing deliverables for [${task.id}] on branch ${task.branch}...`);

      // LLM cost saver: identical tip already verdict → skip re-review.
      // (Verdicts always move the task out of IN_REVIEW, so a repeat here
      // with the same tip means a no-op cycle re-queued it.)
      let tipSha = await GitManager.branchTipSha(task.branch);
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
          task.launchVerdict = undefined;
          task.updatedAt = new Date().toISOString();
          if (roadmap.projectNumber) {
            await ProjectManager.updateItemStatus(roadmap.projectNumber, task, task.status === "FAILED" ? "Failed" : "Todo");
          }
          hasChanges = true;
          continue;
        }
        console.log(`⏭️ [${task.id}] branch unchanged since last review (${tipSha.slice(0, 7)}); skipping re-review.`);
        // Rejected-but-unmoved: the redispatch pushed nothing new, so the
        // rejection notes were never addressed. Sitting silent until the idle
        // timeout wastes cycles — re-queue promptly (bounded by attempts) so
        // the agent retries WITH the feedback already in its prompt. Approval
        // notes are excluded: those tasks were completed, not rejected.
        const wasRejected =
          !!task.reviewNotes &&
          !task.reviewNotes.startsWith("Approved and integrated.") &&
          task.reviewNotes !== "Branch diff vs develop is empty; deliverables already integrated.";
        if (wasRejected) {
          console.log(`🔁 [${task.id}] prior rejection unaddressed (same tip); re-queuing for a feedback-guided attempt.`);
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
        }
        continue;
      }

      // Get diff against integration branch
      let diff = await GitManager.getBranchDiff(task.branch, CONFIG.INTEGRATION_BRANCH);

      // Attempt to read task progress file from branch (content-remote aware)
      const progressContent = await GitManager.showFile(task.branch, `workspace/${CONFIG.TASK_PROGRESS_FILE}`);
      let taskProgress = progressContent !== null ? progressContent : "No progress file provided.";

      // Step 1: Deterministic pre-LLM gate (no LLM cost on obvious failures)
      let gate = await runReviewGate(task, diff, taskProgress);
      if (gate.warnings.length > 0) {
        console.warn(`⚠️ [${task.id}] gate warnings:\n- ${gate.warnings.join("\n- ")}`);
      }
      const rejectTask = async (notes: string, fixes: string[], opts?: { burnAttempt?: boolean }) => {
        console.warn(`⚠️ [${task.id}] REJECTED: ${notes}`);
        // Infra failures (unmergable branch, push races) must not consume the
        // agent's attempt budget — the work was approved, only delivery broke.
        const burn = opts?.burnAttempt !== false;
        if (burn) task.attempts += 1;
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
        // Autonomous remediation (docs/autonomous-remediation-plan.md §3.2):
        // diagnose the gate failure BEFORE blind retry. Mechanical fixes
        // (scope widening, junk surgery) re-run the gate once in-tick and
        // continue to review; agent rounds requeue PENDING with attempts
        // frozen; humans only on budget exhaustion or secrets. Plain reject
        // (attempt burned) is the last resort below.
        {
          const remediation = await OrchestratorEngine.remediateGateFailure(task, roadmap, gate, diff);
          if (remediation === "requeued" || remediation === "escalated") {
            hasChanges = true;
            continue;
          }
          if (remediation === "regated") {
            hasChanges = true;
            const newTip = await GitManager.branchTipSha(task.branch);
            if (newTip) tipSha = newTip;
            diff = await GitManager.getBranchDiff(task.branch, CONFIG.INTEGRATION_BRANCH);
            const freshProgress = await GitManager.showFile(task.branch, `workspace/${CONFIG.TASK_PROGRESS_FILE}`);
            if (freshProgress !== null) taskProgress = freshProgress;
            gate = await runReviewGate(task, diff, taskProgress);
            if (gate.warnings.length > 0) {
              console.warn(`⚠️ [${task.id}] re-gate warnings:\n- ${gate.warnings.join("\n- ")}`);
            }
            if (!gate.passed) {
              await rejectTask(`Deterministic gate failed:\n- ${gate.failures.join("\n- ")}`, gate.failures);
              continue;
            }
          }
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

      const res = await OpenCodeClient.runWithFallback(reviewPrompt, {
        timeoutMs: 10 * 60 * 1000,
        // Explicit session title (parity with subagent runs, which pass one
        // and keep working on CI): keeps sessions identifiable in
        // `session list` and avoids the fresh-session internal
        // title-generation helper call, which free-tier abuse checks have
        // been rejecting with `provider.auth` 403s (anomalyco/opencode#49592).
        title: `Review [${task.id}] ${task.title}`,
      });

      // Robust JSON parse: fenced blocks, unescaped strings, and regex fallback.
      const reviewResult = parseReviewOutput(res.stdout);
      if (!reviewResult) {
        // Infra-level reviewer failures (gateway 403s such as the free-tier
        // "can only be used from within OpenCode" abuse check, provider
        // outages, CLI timeouts) are NOT task quality signals. Rejecting here
        // burns an attempt and can FAIL an otherwise complete deliverable
        // (TASK-064, 2026-10-17: a transient outage cost the whole task).
        // Defer in place instead — stay IN_REVIEW with attempts untouched and
        // re-review on a later tick. lastReviewSha is not advanced, so the
        // unchanged tip still qualifies for review next time.
        const reviewerInfraFailure = res.exitCode !== 0 || res.stdout.trim().length === 0;
        if (reviewerInfraFailure) {
          task.reviewDeferrals = (task.reviewDeferrals ?? 0) + 1;
          task.updatedAt = new Date().toISOString();
          const detail = res.errorDetail || res.stderr || `exit ${res.exitCode}`;
          console.warn(
            `⏸️ [${task.id}] reviewer LLM unavailable; review deferred (${task.reviewDeferrals} consecutive), attempts NOT burned. Detail: ${detail.slice(0, 200)}`
          );
          if (task.reviewDeferrals === REVIEW_DEFERRAL_ALERT_AT) {
            console.warn(
              `🚨 [${task.id}] reviewer LLM unavailable for ${task.reviewDeferrals} consecutive reviews — posting advisory for humans (reviews keep retrying).`
            );
            if (roadmap.projectNumber) {
              await ProjectManager.postTaskProgressComment(
                task,
                `🚨 **Needs a human (advisory):** reviewer LLM unavailable for ${task.reviewDeferrals} consecutive reviews — last error: ${detail.slice(0, 300)}. Deliverables remain IN_REVIEW; reviews keep retrying automatically.`
              );
            }
          }
          hasChanges = true;
          continue;
        }
        await rejectTask(`Reviewer output unparseable (no valid {approved, notes} JSON). Raw head: ${res.stdout.slice(0, 300)}`, [
          "Ensure reviewer returns fenced ```json with approved:boolean",
        ]);
        continue;
      }
      if (task.reviewDeferrals) task.reviewDeferrals = 0;
      // Reviewer-output floor: an approval with a one-word note ("lgtm")
      // carries zero checklist evidence — fail closed, same as garbage.
      if (reviewResult.approved && reviewResult.notes.trim().length < 20) {
        await rejectTask(
          `Reviewer approval has no substantive notes (${reviewResult.notes.trim().length} chars; checklist evidence required). Raw head: ${res.stdout.slice(0, 200)}`,
          ["Ensure reviewer covers all 4 checklist areas in notes"]
        );
        continue;
      }
      // Approval WITH fixes is incoherent: findings must be addressed, not
      // merged alongside. Convert to rejection so the fixes get worked.
      if (reviewResult.approved && reviewResult.suggestedFixes.length > 0) {
        await rejectTask(
          `Reviewer approved but listed ${reviewResult.suggestedFixes.length} finding(s): ${reviewResult.notes}`,
          reviewResult.suggestedFixes
        );
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
            ["Resolve merge conflicts on the task branch and re-queue with /retry"],
            { burnAttempt: false }
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
    const co = await GitManager.run(["git", "checkout", CONFIG.BASE_BRANCH]);
    if (co.exitCode !== 0) {
      console.error("❌ State persist: checkout failed, refusing to commit on the wrong branch.");
      await GitManager.run(["git", "stash", "pop"]);
      return;
    }
    // Freshness first: a long tick (slow LLM reviews) may hold a stale copy.
    // Merge remote truth in BEFORE saving so we never wipe fields like
    // projectNumber that another run persisted meanwhile.
    try {
      await GitManager.run(["git", "fetch", "origin"]);
      const show = await GitManager.run(["git", "show", `origin/${CONFIG.BASE_BRANCH}:${CONFIG.ROADMAP_FILE}`]);
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
        const show = await GitManager.run(["git", "show", `origin/${CONFIG.BASE_BRANCH}:${CONFIG.ROADMAP_FILE}`]);
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
   * Remove regenerable paths from a task branch via an isolated linked
   * worktree (never the main checkout). Returns false on any failure —
   * callers fall back to the normal reject path.
   */
  private static async surgicallyRemove(branch: string, paths: string[]): Promise<boolean> {
    const remote = GitManager.contentRemote();
    const wtDir = join(tmpdir(), `gate-fix-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const wt = async (args: string[]) => GitManager.run(["git", "-C", wtDir, ...args]);
    const cleanup = async () => {
      try {
        await GitManager.run(["git", "worktree", "remove", "--force", wtDir]);
      } catch {
        /* ephemeral runner; leftovers die with the VM */
      }
      try {
        await GitManager.run(["git", "worktree", "prune"]);
      } catch {
        /* best-effort */
      }
    };
    try {
      await GitManager.run(["git", "worktree", "prune"]);
      rmSync(wtDir, { recursive: true, force: true });
      const add = await GitManager.run(["git", "worktree", "add", "--detach", wtDir, `${remote}/${branch}`]);
      if (add.exitCode !== 0) return false;
      const rm = await wt(["rm", "-r", "-q", "--", ...paths]);
      if (rm.exitCode !== 0) return false;
      const commit = await wt([
        "git",
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=github-actions[bot]@users.noreply.github.com",
        "commit",
        "-m",
        `chore(gate-fix): drop regenerable paths from ${branch}`,
      ]);
      if (commit.exitCode !== 0) return false;
      const push = await GitManager.pushWithAuthRetry(remote, [`HEAD:refs/heads/${branch}`], { cwd: wtDir, maxRetries: 2 });
      return push.ok;
    } catch {
      return false;
    } finally {
      await cleanup();
    }
  }

  /** Dashboard visibility for fix rounds (never breaks the tick). */
  private static async noteFixDashboard(roadmap: Roadmap, msg: string): Promise<void> {
    try {
      if (!roadmap.projectNumber) return;
      const issueNum = await IssueManager.syncDashboardIssue(roadmap);
      if (issueNum) await IssueManager.postMilestoneUpdate(issueNum, msg);
    } catch {
      /* visibility must never break the tick */
    }
  }

  /**
   * Autonomous gate remediation (docs/autonomous-remediation-plan.md §3.2).
   * Diagnoses deterministic-gate failures BEFORE blind retry:
   * - "regated": mechanical fix applied (scope widened / junk surgically
   *   removed) — caller re-runs the gate once and continues review.
   * - "requeued": agent round queued (PENDING, attempts frozen) with a
   *   prescription directive — caller skips normal reject (no burn).
   * - "escalated": FAILED + human note — caller skips normal reject.
   * - null: not handled — caller takes the normal reject path (burn).
   */
  private static async remediateGateFailure(
    task: TaskItem,
    roadmap: Roadmap,
    gate: { failures: string[]; fileList: string[]; lineageBroken?: boolean },
    diff: string
  ): Promise<"regated" | "requeued" | "escalated" | null> {
    // File-level attribution is impossible without shared history.
    if (gate.lineageBroken) return null;
    const oos = gate.fileList.filter((f) => !isAllowedFile(task, f));
    const diagnoses = classifyGateFailure(gate.failures, { diff, outOfScope: oos });
    const actionable = diagnoses.filter((d) => d.kind !== "empty-diff");
    if (actionable.length !== 1) return null;
    const d = actionable[0];
    const now = new Date().toISOString();

    const escalate = async (why: string): Promise<"escalated"> => {
      task.status = "FAILED";
      task.failedAt = now;
      task.reviewNotes = `[NEEDS-HUMAN] ${why}\n${task.reviewNotes || ""}`.trim().slice(0, 2000);
      task.updatedAt = now;
      if (roadmap.projectNumber) {
        await ProjectManager.updateItemStatus(roadmap.projectNumber, task, "Failed");
      }
      await OrchestratorEngine.noteFixDashboard(roadmap, `🚨 **Needs a human:** [${task.id}] ${why}`);
      return "escalated";
    };
    const prior = priorFixRounds(task.reviewNotes);
    if (d.kind === "secret") {
      return escalate("secret-leak flag needs human triage (never auto-touched)");
    }
    if (prior.includes(d.kind)) {
      return escalate(`repeat [FIX-ROUND: ${d.kind}] — fix budget exhausted`);
    }
    const mark = `[FIX-ROUND: ${d.kind}]`;

    // Zero-LLM mechanical fix: widen scope to cover required test files,
    // then re-gate in-tick (no agent round, no attempt burned).
    if (d.kind === "test-scope") {
      task.targetFiles = [...new Set([...(task.targetFiles || []), ...d.files])];
      task.reviewNotes = `${mark} Scope widened to cover required test files (${d.files.length}); re-running gate.`.slice(
        0,
        2000
      );
      task.updatedAt = now;
      await OrchestratorEngine.noteFixDashboard(
        roadmap,
        `🔧 **[FIX-ROUND: test-scope]** [${task.id}]: widened targetFiles (${d.files.length} test path(s)); re-running gate.`
      );
      return "regated";
    }
    // Zero-LLM mechanical fix: surgically remove regenerable paths from the
    // branch, then re-gate in-tick.
    if (d.kind === "build-output" || d.kind === "vendor-junk") {
      const junk = oos.filter((f) => isGeneratedJunkPath(f));
      if (junk.length === 0 || junk.length !== oos.length) return null;
      const ok = await OrchestratorEngine.surgicallyRemove(task.branch, junk);
      if (!ok) return null;
      task.reviewNotes = `${mark} Removed ${junk.length} regenerable path(s) from branch; re-running gate.`.slice(0, 2000);
      task.updatedAt = now;
      await OrchestratorEngine.noteFixDashboard(
        roadmap,
        `🧹 **[FIX-ROUND: ${d.kind}]** [${task.id}]: removed ${junk.length} regenerable path(s); re-running gate.`
      );
      return "regated";
    }
    // Agent round on the same branch: PENDING with attempts FROZEN (no burn)
    // plus a prescription directive the agent prompt surfaces.
    if (d.kind === "unstamped-proof" || d.kind === "sql-false-positive") {
      const why =
        d.kind === "sql-false-positive"
          ? "Scanner residual flag looks like an engine false positive; re-run tests via the runner to refresh proof."
          : "Re-run the task's test command via the runner so the report carries a stamped proof block.";
      task.status = "PENDING";
      task.lastReviewSha = undefined;
      task.lastGateVersion = undefined;
      task.launchVerdict = undefined;
      task.reviewNotes = `${mark} ${why}\nPrevious gate feedback preserved below:\n${task.reviewNotes || "-"}`.slice(0, 2000);
      task.updatedAt = now;
      if (roadmap.projectNumber) {
        await ProjectManager.updateItemStatus(roadmap.projectNumber, task, "Todo");
      }
      await OrchestratorEngine.noteFixDashboard(
        roadmap,
        `🔁 **[FIX-ROUND: ${d.kind}]** [${task.id}] queued for agent round (attempts frozen).`
      );
      return "requeued";
    }
    // Unknown: one bounded reviewer call constrained to a prescription
    // shape (diagnose only, never approve), then reuse the paths above.
    if (d.kind === "unknown") {
      const rx = await OrchestratorEngine.diagnoseUnknown(task, gate);
      if (!rx || rx.kind === "human" || prior.includes(rx.kind)) {
        return escalate(
          rx && rx.kind === "human"
            ? `reviewer diagnosis: human needed (${(rx.prescription || "no detail").slice(0, 200)})`
            : "unknown gate failure; reviewer diagnosis unusable"
        );
      }
      if (rx.kind === "test-scope") {
        task.targetFiles = [...new Set([...(task.targetFiles || []), ...rx.files])];
        task.reviewNotes = `${mark} Scope widened per reviewer diagnosis; re-running gate.`.slice(0, 2000);
        task.updatedAt = now;
        return "regated";
      }
      if (rx.kind === "build-output" || rx.kind === "vendor-junk") {
        const junk = rx.files.filter((f) => isGeneratedJunkPath(f));
        if (junk.length === 0) return escalate("reviewer diagnosis named no removable paths");
        const ok = await OrchestratorEngine.surgicallyRemove(task.branch, junk);
        if (!ok) return null;
        task.reviewNotes = `${mark} Removed reviewer-flagged paths; re-running gate.`.slice(0, 2000);
        task.updatedAt = now;
        return "regated";
      }
      // Reviewer-named sql/unstamped kinds ride the agent round with marker.
      task.status = "PENDING";
      task.lastReviewSha = undefined;
      task.lastGateVersion = undefined;
      task.launchVerdict = undefined;
      task.reviewNotes =
        `${mark} Reviewer diagnosis: ${rx.prescription}\nPrevious gate feedback preserved below:\n${task.reviewNotes || "-"}`.slice(
          0,
          2000
        );
      task.updatedAt = now;
      if (roadmap.projectNumber) {
        await ProjectManager.updateItemStatus(roadmap.projectNumber, task, "Todo");
      }
      return "requeued";
    }
    return null;
  }

  /**
   * One bounded reviewer call that may ONLY return a prescription
   * ({kind, files[], prescription} or {kind:"human"}) — diagnose, never
   * approve. Unparseable output escalates (handled by caller).
   */
  private static async diagnoseUnknown(
    task: TaskItem,
    gate: { failures: string[]; fileList: string[] }
  ): Promise<{ kind: GateFailureKind | "human"; files: string[]; prescription: string } | null> {
    let template: string;
    try {
      template = await Bun.file("orchestrator/prompts/reviewer.md").text();
    } catch {
      return null;
    }
    const prompt =
      `${template}\n\nYou are diagnosing a deterministic-gate failure, NOT approving work. ` +
      `Do not evaluate deliverables. Task [${task.id}] ${task.title} failed:\n- ${gate.failures.join("\n- ")}\n\n` +
      `Changed files (${gate.fileList.length}):\n${gate.fileList.slice(0, 100).join("\n")}\n\n` +
      `Return ONLY a JSON block enclosed in \`\`\`json \`\`\` with exactly this shape (no prose outside the block):\n` +
      `\`\`\`json\n{"kind": "test-scope | build-output | vendor-junk | sql-false-positive | unstamped-proof | human", ` +
      `"files": ["paths the prescription acts on"], "prescription": "one concrete fix instruction"}\n\`\`\`\`\n` +
      `Rules: "human" when secrets, destructive scope, or genuine uncertainty. Never approve, never waive the gate.`;
    const res = await OpenCodeClient.runWithFallback(prompt, { timeoutMs: 4 * 60 * 1000 });
    const jsonMatch = res.stdout.match(/```json([\s\S]*?)```/) || res.stdout.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) return null;
    try {
      const raw = JSON.parse(jsonMatch[1].trim());
      const kind = String(raw.kind || "");
      const files = Array.isArray(raw.files) ? raw.files.filter((f: unknown) => typeof f === "string") : [];
      const prescription = typeof raw.prescription === "string" ? raw.prescription : "";
      const allowed = ["test-scope", "build-output", "vendor-junk", "sql-false-positive", "unstamped-proof", "human"];
      if (!allowed.includes(kind)) return null;
      return { kind: kind as GateFailureKind | "human", files, prescription };
    } catch {
      return null;
    }
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
              // UNION merge, never replace: src lives on the ENGINE checkout
              // (template files) while dst may hold DATA-only files (forged
              // skills) absent from src. Replace (rm+cp) deleted them on
              // every tick — data loss committed by the bot itself.
              unionMirrorDir(src, dst);
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
      const prepare = async (): Promise<void> => {
        await StateManager.saveRoadmap(roadmap);
        mirrorIntoWorktree();
        // Stage only paths that actually exist in the scratch worktree: a
        // single missing path fails the whole `git add` atomically, leaving
        // nothing staged (adopt has no PROGRESS/COMPILED yet).
        const present = carry.filter((f) => existsSync(join(wtDir, f)));
        if (present.length === 0) {
          console.warn("⚠️ Data state: nothing to stage (no state files present); skipping commit.");
        } else {
          await wt(["add", "-f", ...present]);
        }
        const commit = await wt([...botIdentity, "commit", "-m", message]);
        if (commit.exitCode !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
          console.warn(`⚠️ Data state commit failed: ${(commit.stdout + commit.stderr).slice(0, 300)}`);
        }
      };
      await prepare();
      const push = await GitManager.pushWithAuthRetry(remote, [remote, `HEAD:refs/heads/${CONFIG.BASE_BRANCH}`], {
        cwd: wtDir,
        maxRetries: 5,
        betweenAttempts: async (attempt) => {
          console.warn(`⚠️ Data state push rejected (attempt ${attempt}/5). Re-syncing...`);
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
          await prepare();
        },
      });
      if (!push.ok) {
        console.error(`❌ persistRoadmapToData: push failed after 5 attempts; changes remain local.`, push.stderr.slice(0, 500));
      }
    } finally {
      await cleanup();
    }
  }

  /**
   * Auto-adopt agent-requested Docker services (durable from run #2).
   *
   * Agents that need an undeclared container at runtime start it themselves
   * for their own run and append `{name, image, env?, ports?}` to
   * workspace/services.request.json. This consumes that file from the content
   * integration branch: valid entries merge into roadmap.services (canonical
   * compose is re-rendered by ensureServiceFiles later this tick), the
   * payload hash lands in roadmap.consumedServiceRequests so each request
   * processes exactly once. Rejections (unpinned image, bad shape, cap hit)
   * are reported on the dashboard — fail-closed, never silently dropped.
   */
  public static async adoptRequestedServices(roadmap: Roadmap): Promise<boolean> {
    const { parseServiceRequests, normalizeServices, SERVICE_REQUEST_FILE } = await import("./service_manager.ts");
    let rawText: string | null = null;
    try {
      rawText = await GitManager.showFile(CONFIG.INTEGRATION_BRANCH, SERVICE_REQUEST_FILE);
    } catch {
      return false;
    }
    if (!rawText || !rawText.trim()) return false;
    const hash = String(Bun.hash(rawText));
    const consumed = Array.isArray(roadmap.consumedServiceRequests) ? roadmap.consumedServiceRequests : [];
    if (consumed.includes(hash)) return false;

    let changed = false;
    const notes: string[] = [];
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      notes.push(`⚠️ Unparseable ${SERVICE_REQUEST_FILE} — request ignored (fix the JSON and re-commit to re-request).`);
    }
    if (parsed !== null) {
      const { valid, rejected } = parseServiceRequests(parsed);
      const declared = new Set(normalizeServices(roadmap.services || []).map((s) => s.name));
      for (const svc of valid) {
        if (declared.has(svc.name)) continue; // idempotent re-run
        if (CONFIG.MAX_SERVICES > 0 && normalizeServices([...(roadmap.services || []), svc]).length > CONFIG.MAX_SERVICES) {
          notes.push(`⚠️ Service "${svc.name}" rejected: service cap reached (MAX_SERVICES=${CONFIG.MAX_SERVICES}).`);
          continue;
        }
        roadmap.services = [...(roadmap.services || []), svc];
        declared.add(svc.name);
        notes.push(`🐳 Service "${svc.name}" auto-adopted (\`${svc.image}\`) — live in compose from this tick.`);
        changed = true;
      }
      for (const r of rejected) notes.push(`⚠️ Service "${r.name}" rejected: ${r.reason}.`);
    }
    roadmap.consumedServiceRequests = [...consumed, hash];
    roadmap.updatedAt = new Date().toISOString();
    await this.persistRoadmap(roadmap, `chore(orchestrator): adopt requested services (${notes.length} note(s))`);
    const issueNum = await IssueManager.syncDashboardIssue(roadmap);
    if (issueNum && notes.length > 0) {
      await IssueManager.postMilestoneUpdate(issueNum, `**Service auto-adopt:**\n${notes.map((n) => `- ${n}`).join("\n")}`);
    } else {
      console.log(notes.join("\n") || "ℹ️ Service request consumed (all duplicates).");
    }
    return changed;
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
    // Unscoped mutual exclusion: tasks WITHOUT targetFiles (operator /add,
    // /revise) cannot prove disjointness, so two of them must never run
    // concurrently — parallel unscoped workers edit the same tree blind
    // (TASK-025/026 both touched web/bun.lock + progress). Scoped tasks
    // still parallelize freely; unscoped ones serialize among themselves,
    // INCLUDING within one dispatch batch (a batch would otherwise launch
    // N unscoped workers atomically before any of them shows IN_PROGRESS).
    const isUnscoped = (t: (typeof roadmap.tasks)[number]) => !t.targetFiles || t.targetFiles.length === 0;
    let unscopedBusy = roadmap.tasks.some((t) => t.status === "IN_PROGRESS" && isUnscoped(t));
    const dispatchable: typeof readyTasks = [];
    let heldCount = 0;
    for (const t of readyTasks) {
      if (isUnscoped(t)) {
        if (unscopedBusy) {
          heldCount++;
          continue;
        }
        unscopedBusy = true;
      }
      dispatchable.push(t);
    }
    if (heldCount > 0) {
      console.log(
        `⏳ Holding ${heldCount} unscoped task(s): another unscoped task is IN_PROGRESS or dispatched ahead in this batch (collision guard).`
      );
    }
    if (dispatchable.length === 0) {
      console.log("ℹ️ No ready tasks to dispatch at this time.");
      return;
    }

    console.log(
      `🚀 Dispatching ${dispatchable.length} parallel subagents (Concurrency limit: ${CONFIG.MAX_CONCURRENT_SUBAGENTS})...`
    );

    for (const task of dispatchable) {
      const dispatched = await GitManager.dispatchSubagentWorkflow(
        task.id,
        task.role,
        task.branch,
        effectiveTaskStack(task, roadmap.stack)
      );
      if (dispatched) {
        task.status = "IN_PROGRESS";
        task.updatedAt = new Date().toISOString();
        task.dispatchedAt = new Date().toISOString();
        // Best-effort runId capture for watchdog correlation (dispatch verified materialization; see dispatchSubagentWorkflow)
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
    // Quota probe (1 call): when the shared installation budget is nearly
    // spent, cosmetic API work degrades for this tick while git-based work
    // (dispatch, merge, persist) proceeds untouched. See gh_quota.ts.
    try {
      await GhQuota.checkQuota();
    } catch {
      /* probe failure must never block a tick */
    }
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
    // Steady-state persist guard: review/watchdog/escalation can flip task
    // fields on an already-COMPLETED roadmap (e.g. empty-diff COMPLETED
    // marking). The quiet branch below must persist those instead of
    // dropping them with the ephemeral runner.
    const loadedSig = JSON.stringify(roadmap.tasks.map((t) => [t.id, t.status, t.updatedAt, t.reviewNotes]));
    // Board-sync saver: snapshot the status signature now; the end-of-tick
    // drift heal is skipped when nothing changed and the last sync is fresh.
    const statusSigBefore = roadmap.tasks.map((t) => `${t.id}:${t.status}`).join(",");
    // Service auto-adopt BEFORE rendering compose: agent-requested containers
    // become durable roadmap.services this tick, live for the next dispatch.
    await this.adoptRequestedServices(roadmap);
    await this.ensureServiceFiles(roadmap);

    // Ensure GitHub Milestones and Issues exist for all tasks
    if (roadmap.milestones && roadmap.milestones.length > 0) {
      await ProjectManager.ensureMilestones(roadmap.milestones, (t) => this.isMilestoneComplete(roadmap, t));
    }
    const needsIssue = (t: (typeof roadmap.tasks)[number]) => !t.issueNumber && !t.reviewNotes?.includes("[ADOPTED]");
    const hasUnsyncedIssues = roadmap.tasks.some(needsIssue);
    if (hasUnsyncedIssues) {
      console.log("📌 Ensuring GitHub Issues exist for all tasks and are attached to Milestones...");
      const projectNum = await ProjectManager.ensureProject(roadmap);
      // Batched index: 1 call replaces per-task searches/views below.
      const tickIssueIndex = await ProjectManager.fetchIssueIndex();
      for (const task of roadmap.tasks) {
        if (needsIssue(task)) {
          await ProjectManager.ensureTaskIssue(task, task.milestone, tickIssueIndex);
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
        task.reviewNotes = `Watchdog (${why}); re-queued. Previous notes preserved below.\n${task.reviewNotes || ""}`.slice(
          0,
          2000
        );
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
        // A recorded verdict on an unchanged, still-reviewable tip belongs to
        // Step 1: its skip-review path re-queues with the feedback and burns
        // exactly ONE attempt. Re-queuing here too would double-charge the
        // same tick — idle watchdog (+1) then review (+1) → spurious FAILED.
        if (tip >= 0 && task.lastReviewSha) {
          const progress = await GitManager.showFile(task.branch, `workspace/${CONFIG.TASK_PROGRESS_FILE}`);
          if (progress !== null && hasStructuredProgress(progress)) continue;
        }
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

    // Step 1.3: Consume launch-verification verdicts (fail → ONE fix task;
    // fix completion → ONE bounded re-launch). Processed verdicts are
    // recorded so repeat ticks never double-spawn.
    await this.processLaunchVerdicts(roadmap);

    // Step 1.2: Overnight autopilot — resurrect FAILED tasks whose cooldown
    // elapsed, bounded by FAILED_AUTO_RESURRECT_MAX. Pre-dates-failedAt
    // tasks fall back to updatedAt so existing FAILED entries qualify.
    // Human /retry resets the budget (see issue_manager).
    for (const task of roadmap.tasks) {
      if (task.status !== "FAILED") continue;
      // Human-escalated failures stay parked: resurrecting them would
      // re-dispatch agents into secrets or exhausted fix budgets.
      if ((task.reviewNotes || "").includes("[NEEDS-HUMAN]")) continue;
      const res = task.resurrections || 0;
      if (res >= CONFIG.FAILED_AUTO_RESURRECT_MAX) continue;
      const failMs = Date.parse(task.failedAt || task.updatedAt);
      if (Number.isNaN(failMs) || now - failMs < CONFIG.FAILED_RESURRECT_COOLDOWN_MIN * 60 * 1000) continue;
      task.status = "PENDING";
      task.attempts = 0;
      task.resurrections = res + 1;
      task.lastReviewSha = undefined;
      task.lastGateVersion = undefined;
      task.launchVerdict = undefined;
      task.reviewDeferrals = 0;
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
        // Adopted baselines are history, not achievements: closing them would
        // spend real version tags (v0.N.0) and publish releases for work the
        // orchestrator never did.
        if (milestoneTasks.length > 0 && milestoneTasks.every((t) => t.reviewNotes?.includes("[ADOPTED]"))) continue;
        if (milestoneTasks.length > 0 && milestoneTasks.every((t) => t.status === "COMPLETED")) {
          const tag = `v0.${i + 1}.0`;
          // Release is tied to TAG existence, not to this tick's close call:
          // close-then-release is not atomic, and a crash between them (or
          // an already-closed milestone) used to lose the release forever.
          const tagExists = await IssueManager.milestoneTagExists(tag);
          await IssueManager.closeMilestoneIfCompleted(m.title);
          if (!tagExists) {
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
    if (allCompleted && roadmap.globalStatus !== "COMPLETED") {
      console.log("🎉 ALL TASKS COMPLETED! Target project is fully built and verified.");
      // Idempotent celebration: the release call reports created/existed/
      // failed, and the announcement goes out ONLY on a fresh creation.
      // A repeat tick after a failed persist must stay quiet instead of
      // celebrating twice.
      const layerStacks = [...new Set(roadmap.tasks.map((t) => effectiveTaskStack(t, (roadmap as Roadmap).stack, "bun")))];
      const stackTest = layerStacks.map((s) => STACKS[s].testCommand).join(" + ");
      const stackLabel = layerStacks.join(" + ");
      const outcome = await IssueManager.createMilestoneRelease(
        "v1.0.0",
        `Release v1.0.0 - ${roadmap.projectName}`,
        `## 🚀 Project Completed: ${roadmap.projectName}\n\nAll tasks implemented, reviewed, audited, and tested.\n\n### Deliverables:\n- Core workspace built in \`workspace/\` (${stackLabel} stack${layerStacks.length > 1 ? "s" : ""})\n- 0 test failures on \`${stackTest}\`\n- Security audit clean`
      );
      if (outcome !== "failed") {
        roadmap.globalStatus = "COMPLETED";
        await this.persistRoadmap(roadmap, "chore(orchestrator): all tasks completed");
      }
      // Sync Dashboard Issue & Publish Release Tag
      const issueNum = await IssueManager.syncDashboardIssue(roadmap);
      if (issueNum && outcome === "created") {
        await IssueManager.postMilestoneUpdate(
          issueNum,
          "🎉 **All tasks have been successfully completed and verified!** Creating Final Release `v1.0.0`..."
        );
      } else {
        console.log(`ℹ️ Final release v1.0.0 outcome: ${outcome}; celebration skipped.`);
      }
      return;
    }
    if (allCompleted) {
      // Steady state: celebrated and released before — stay quiet, BUT persist
      // first if this tick changed anything (review transitions on late
      // arrivals must not die with the runner).
      const loadedSigNow = JSON.stringify(roadmap.tasks.map((t) => [t.id, t.status, t.updatedAt, t.reviewNotes]));
      if (loadedSigNow !== loadedSig) {
        console.log("ℹ️ Steady state with in-tick changes; persisting before exit.");
        await this.persistRoadmap(roadmap, "chore(orchestrator): steady-state review updates");
        await IssueManager.syncDashboardIssue(roadmap);
      } else {
        console.log("ℹ️ Roadmap already COMPLETED and released; nothing to do.");
      }
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

    // FAILED propagation alarm: dependents of a FAILED task sit PENDING
    // forever (getReadyTasks needs COMPLETED deps) with no signal except a
    // counter. Escalate ONCE per failed task (marker in reviewNotes) with an
    // operator call-to-action; never auto-fail dependents (the fix might be
    // a /revise away, and mass-FAILED would nuke recoverable roadmaps).
    const blocked = roadmap.tasks.filter(
      (t) =>
        t.status === "FAILED" &&
        !(t.reviewNotes || "").includes("[ESCALATED-dependents]") &&
        roadmap.tasks.some((d) => d.dependencies.includes(t.id) && d.status !== "COMPLETED" && d.status !== "FAILED")
    );
    if (blocked.length > 0) {
      const issueNum = await IssueManager.syncDashboardIssue(roadmap);
      if (issueNum) {
        const stuck = blocked.flatMap((t) =>
          roadmap.tasks
            .filter((d) => d.dependencies.includes(t.id) && d.status !== "COMPLETED" && d.status !== "FAILED")
            .map((d) => `\`${d.id}\``)
        );
        await IssueManager.postMilestoneUpdate(
          issueNum,
          `🚨 **Blocked downstream:** ${blocked.map((t) => `\`[${t.id}]\``).join(", ")} FAILED with dependents stuck PENDING (${[...new Set(stuck)].join(", ")}). ` +
            `Fix with \`/retry <TASK-ID>\` (fresh attempt) or \`/revise <TASK-ID> "change"\` (surgical rework), then tick.`
        );
        for (const t of blocked) {
          t.reviewNotes = `${t.reviewNotes || ""}\n[ESCALATED-dependents] Operator notified on dashboard.`.trim();
          t.updatedAt = new Date().toISOString();
        }
      }
    }

    // Save, sync dashboard issue, and commit progress (merge-safe persist)
    await this.persistRoadmap(roadmap, "chore(orchestrator): update progress roadmap");
    await IssueManager.syncDashboardIssue(roadmap);

    // Immediate wake-up for remaining IN_REVIEW tasks:
    // If more completed tasks are waiting in review, re-trigger Orchestrator immediately
    // without waiting for the 15-minute cron (unless another cycle is already queued).
    const remainingInReview = roadmap.tasks.filter((t) => t.status === "IN_REVIEW");
    if (remainingInReview.length > 0) {
      console.log(
        `🔔 ${remainingInReview.length} task(s) still waiting IN_REVIEW (${remainingInReview.map((t) => t.id).join(", ")}). Checking queue status...`
      );
      try {
        const queuedCheck = await GitManager.run([
          "gh",
          "run",
          "list",
          "--workflow",
          CONFIG.ORCHESTRATOR_WORKFLOW,
          "--status",
          "queued",
          "--limit",
          "1",
        ]);
        const alreadyQueued = queuedCheck.stdout.trim().length > 0;
        if (!alreadyQueued) {
          console.log("🚀 No queued cycle detected; waking Orchestrator immediately for next review...");
          await GitManager.run(["gh", "workflow", "run", CONFIG.ORCHESTRATOR_WORKFLOW]);
        } else {
          console.log("ℹ️ An Orchestrator cycle is already queued; skipping duplicate trigger.");
        }
      } catch (err: any) {
        console.warn(`⚠️ Immediate wake-up check/trigger failed (non-fatal): ${err?.message || err}`);
      }
    }

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

  // Repo-level kill switch: ORCHESTRATOR_ENABLED=0/false/no/off stands the
  // engine down (template repos with no project). Exit 0 — disabled is a
  // state, not a failure. Checked before auth so nothing billable happens.
  if (!isEngineEnabled()) {
    console.log("⏸️ Engine disabled via ORCHESTRATOR_ENABLED — standing down (no auth, no dispatch, no review).");
    return;
  }

  // Optional: Authenticate via GitHub App if CLIENT_ID / APP_PRIVATE_KEY are provided
  await initializeGitHubAppAuth();

  switch (action) {
    case "plan":
      await OrchestratorEngine.plan();
      break;
    case "adopt":
      await OrchestratorEngine.adopt();
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

// Only execute when run directly (`bun run orchestrator/engine.ts ...`).
// Without this guard, ANY import of this module silently started a REAL
// tick in the host process — tests/data_persist.test.ts imports
// unionMirrorDir — and in the shared test suite the phantom tick could
// reach plan(), find no inputs/ in a test's cwd, and process.exit(1) the
// whole runner (observed as a silent suite death, exit 1, no summary).
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error in orchestrator engine:", err);
    process.exit(1);
  });
}
