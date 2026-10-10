/**
 * Stage ECC skills where agents natively look (Bun-native, non-interactive).
 *
 * Copies vendor/ecc/skills/<id>/* to .opencode/skills/ecc-<id>/* so the
 * `skill` tool and the runner's skill loader resolve them by ID. The `ecc-`
 * prefix avoids collisions with our own skills (e.g. `api-design` exists in
 * both). Frontmatter `name:` is rewritten to the staged ID for consistency.
 *
 * Idempotent: skips work when vendor/ecc/.manifest.json is unchanged since
 * the last staging (marker at .opencode/.ecc-staged.json).
 *
 * Usage:
 *   bun run scripts/stage-ecc-skills.ts [--src vendor/ecc/skills]
 *     [--dest .opencode/skills] [--prefix ecc-] [--force] [--dry-run]
 */
import { parseArgs } from "util";
import { mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const MARKER = ".ecc-staged.json";

/**
 * Source skill dirs NEVER staged: their docs route agents at a pruned
 * surface. ECC `commands/` is deliberately excluded (774 files — the
 * orchestrator is the multi-agent authority), so `recipes` would advertise
 * dead ends ("route to the command itself", live `commands/` reads).
 */
const STAGE_DENYLIST = new Set(["recipes"]);

/** Bump when staging rules change so existing checkouts restage once. */
const STAGE_RULES_VERSION = 1;

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function usage(): void {
  console.log(
    "Usage: bun run scripts/stage-ecc-skills.ts [--src DIR] [--dest DIR] [--prefix P] [--force] [--dry-run]\n" +
      "Defaults: --src vendor/ecc/skills --dest .opencode/skills --prefix ecc-."
  );
}

async function stageSkill(srcDir: string, dstDir: string, stagedId: string, dryRun: boolean): Promise<number> {
  let files = 0;
  const walk = async (src: string, dst: string): Promise<void> => {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
      const s = join(src, entry);
      const d = join(dst, entry);
      if (statSync(s).isDirectory()) {
        await walk(s, d);
      } else {
        let content = await Bun.file(s).text();
        if (entry === "SKILL.md") {
          content = content.replace(/^name:\s*\S+/m, `name: ${stagedId}`);
        }
        if (!dryRun) await Bun.write(d, content);
        files++;
      }
    }
  };
  await walk(srcDir, dstDir);
  return files;
}

export interface StageResult {
  staged: number;
  skipped: boolean;
  skills: string[];
}

export async function stageEccSkills(opts: {
  src?: string;
  dest?: string;
  prefix?: string;
  force?: boolean;
  dryRun?: boolean;
} = {}): Promise<StageResult> {
  const src = (opts.src || "vendor/ecc/skills").replace(/\\/g, "/");
  const dest = (opts.dest || ".opencode/skills").replace(/\\/g, "/");
  const prefix = opts.prefix ?? "ecc-";
  const markerPath = `${dest.replace(/\/$/, "")}/${MARKER}`;

  let vendorHash = "";
  try {
    vendorHash = sha256((await Bun.file("vendor/ecc/.manifest.json").text()) + `|rules:${STAGE_RULES_VERSION}`);
  } catch {
    vendorHash = "no-manifest";
  }
  if (!opts.force && !opts.dryRun) {
    // NOTE: exists() first — awaiting .json() on a missing file can settle
    // silently (empty loop exit), same quirk as in install-ecc.ts.
    if (await Bun.file(markerPath).exists()) {
      try {
        const marker = (await Bun.file(markerPath).json()) as { vendorHash?: string };
        if (marker.vendorHash === vendorHash) return { staged: 0, skipped: true, skills: [] };
      } catch {
        /* corrupt marker → restage */
      }
    }
  }

  let names: string[] = [];
  try {
    names = readdirSync(src).filter((n) => {
      try {
        return statSync(join(src, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    console.error(`❌ Skill source missing: ${src} (run ecc:install first).`);
    return { staged: 0, skipped: true, skills: [] };
  }

  let files = 0;
  const skills: string[] = [];
  for (const name of names.sort()) {
    if (STAGE_DENYLIST.has(name)) {
      console.log(`⏭️ Skipping denylisted skill '${name}' (routes at pruned commands/).`);
      continue;
    }
    // Skip our own essentials-style names if ever vendored without prefix.
    const stagedId = name.startsWith(prefix) ? name : `${prefix}${name}`;
    if (!opts.dryRun) rmSync(join(dest, stagedId), { recursive: true, force: true });
    files += await stageSkill(join(src, name), join(dest, stagedId), stagedId, Boolean(opts.dryRun));
    skills.push(stagedId);
    if (opts.dryRun) console.log(`would stage: ${stagedId} (${files} files so far)`);
  }
  if (!opts.dryRun) {
    await Bun.write(markerPath, JSON.stringify({ vendorHash, skills, stagedAt: new Date().toISOString() }, null, 2) + "\n");
  }
  return { staged: skills.length, skipped: false, skills };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv,
    options: {
      src: { type: "string" },
      dest: { type: "string" },
      prefix: { type: "string" },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) {
    usage();
    return;
  }
  const dryRun = Boolean(values["dry-run"]);
  const res = await stageEccSkills({ src: values.src, dest: values.dest, prefix: values.prefix, force: values.force, dryRun });
  if (dryRun) {
    console.log(`Dry run: ${res.skills.length} skills would stage.`);
  } else if (res.skipped) {
    console.log("♻️ ECC skills already staged (vendor manifest unchanged).");
  } else {
    console.log(`✅ Staged ${res.staged} ECC skills → ${values.dest || ".opencode/skills"}/ (prefix '${values.prefix || "ecc-"}').`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error in ECC skill staging:", err);
    process.exit(1);
  });
}
