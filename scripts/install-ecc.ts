/**
 * Repo-scoped ECC installer (Bun-native, non-interactive).
 *
 * ECC's own installer only supports a HOME-scope `opencode` target
 * (~/.config/opencode) and needs node/npm + a compiled `.opencode/dist`.
 * This script does the repo-scoped subset our orchestrator actually uses:
 * it copies reference content (language rules, depth skills, reviewer
 * checklists) from an ECC source tree into tracked `vendor/ecc/`.
 *
 * Default file set = STACK_ECC_REFS in orchestrator/stacks.ts (single
 * source of truth: everything the prompts/tests reference gets installed).
 *
 * Usage:
 *   bun run scripts/install-ecc.ts [--source DIR | --release v2.2.3] [--dest vendor/ecc]
 *     [--dry-run] [--list] [--force] [--verify] [--all]
 *     [--skills golang-patterns,...] [--agents go-reviewer,...]
 *     [--rules golang/coding-style.md,...]
 *
 * Default file set = STACK_ECC_REFS (curated 39). --all installs the full
 * agent-facing surface (skills/, rules/, agents/) instead.
 * ECC's own dev infrastructure (scripts/, tests/, CI, docs) is never vendored.
 *
 * Source resolution: explicit --source wins; else a local ./ECC-main tree
 * when present; else the pinned GitHub release tarball (disk-cached, so
 * fresh clones need no git submodule and no re-download).
 *
 *   --list      print the installable default set and exit
 *   --dry-run   print what would change, write nothing
 *   --verify    check installed files against vendor/ecc/.manifest.json
 *   --force     rewrite files even when hashes match
 */
import { parseArgs } from "util";
import { mkdirSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { STACK_ECC_REFS } from "../orchestrator/stacks.ts";

const MANIFEST_NAME = ".manifest.json";
const ATTRIBUTION =
  "# Attribution\n\nFiles under `vendor/ecc/` are excerpted from ECC (MIT License, (c) 2026 Affaan Mustafa), installed repo-scoped via `scripts/install-ecc.ts`. They are on-demand language reference for product-stack skills; see `STACK_ECC_REFS` in `orchestrator/stacks.ts`.\n";

/** Pinned fallback when no local ECC tree is available (fresh clones). */
export const DEFAULT_ECC_RELEASE = "v2.2.3";

export function buildReleaseUrl(tag: string): string {
  return `https://github.com/affaan-m/ECC/archive/refs/tags/${tag.trim()}.tar.gz`;
}

function eccCacheDir(): string {
  const base = process.env.LOCALAPPDATA || join(homedir(), ".cache");
  return join(base, "orchestrator-ecc").replace(/\\/g, "/");
}

/**
 * Ensure a release source tree: download the tag tarball once (disk cache),
 * extract, return the tree root. Reuses cache unless forced.
 */
export async function ensureReleaseSource(tag: string, force: boolean): Promise<string> {
  const cache = eccCacheDir();
  mkdirSync(cache, { recursive: true });
  const tgz = `${cache}/ecc-${tag}.tar.gz`;
  const root = `${cache}/ecc-${tag}`;
  const hasVersion = async (dir: string) => await Bun.file(`${dir}/VERSION`).exists();
  if (!force && (await Bun.file(tgz).exists()) && (await hasVersion(root))) {
    console.log(`♻️ Using cached ECC ${tag} (${cache}).`);
    return root;
  }
  if (force) rmSync(root, { recursive: true, force: true });
  if (force || !(await Bun.file(tgz).exists())) {
    console.log(`⬇️ Downloading ECC ${tag}...`);
    const res = await fetch(buildReleaseUrl(tag));
    if (!res.ok) throw new Error(`release download failed: HTTP ${res.status} for tag ${tag}`);
    await Bun.write(tgz, res);
  }
  const tmp = `${cache}/x-${process.pid}-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  const tar = Bun.spawnSync(["tar", "-xzf", tgz, "-C", tmp]);
  if (tar.exitCode !== 0) throw new Error(`extract failed (is 'tar' installed?): ${(tar.stderr || "").toString().slice(0, 200)}`);
  const entries = [...new Bun.Glob("*").scanSync({ cwd: tmp, onlyFiles: false })];
  rmSync(root, { recursive: true, force: true });
  if (entries.length === 1) {
    renameSync(join(tmp, entries[0]), root);
    rmSync(tmp, { recursive: true, force: true });
  } else {
    rmSync(root, { recursive: true, force: true });
    renameSync(tmp, root);
  }
  if (!(await hasVersion(root))) throw new Error(`extracted tree has no VERSION file (${root})`);
  // Fail-closed: the tag must describe its own content (tag vX.Y.Z ↔ VERSION X.Y.Z).
  const gotVersion = (await Bun.file(`${root}/VERSION`).text()).trim();
  if (gotVersion !== tag.replace(/^v/, "")) {
    throw new Error(`release content mismatch: tag ${tag} contains VERSION "${gotVersion}"`);
  }
  return root;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function usage(): void {
  console.log(
    "Usage: bun run scripts/install-ecc.ts [--source DIR | --release TAG] [--dest DIR]\n" +
      "       [--dry-run] [--list] [--force] [--verify] [--all] [--skills id,...] [--agents id,...] [--rules lang/file,...]\n" +
      `Defaults: local ./ECC-main when present, else release ${DEFAULT_ECC_RELEASE} (cached); --dest vendor/ecc; set = STACK_ECC_REFS unless --all.`
  );
}

async function readVersion(source: string): Promise<string> {
  try {
    return (await Bun.file(join(source, "VERSION")).text()).trim().slice(0, 32);
  } catch {
    return "unknown";
  }
}

/** Pinned source commit (best-effort): ties vendor content to a submodule SHA. */
async function readSourceCommit(source: string): Promise<string> {
  try {
    const proc = Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"]);
    const out = (await new Response(proc.stdout).text()).trim();
    return /^[0-9a-f]{5,40}$/.test(out) ? out : "";
  } catch {
    return "";
  }
}

/** Agent-facing ECC surface for --all (dev infrastructure excluded).
 * NOTE: commands/ (interactive slash-commands) is deliberately OUT — our
 * headless agents never invoke slash commands; ChatOps is a separate system.
 * What agents consume: skills (reloadable depth) + rules + agents (review). */
const ALL_SURFACE_DIRS = ["skills", "rules", "agents"];

/** Expand --all: every file under the agent-facing dirs, paths preserved. */
async function allJobs(source: string, dest: string): Promise<{ srcRel: string; dstRel: string }[]> {
  const normDest = dest.replace(/\\/g, "/").replace(/\/$/, "");
  const jobs: { srcRel: string; dstRel: string }[] = [];
  for (const dir of ALL_SURFACE_DIRS) {
    try {
      const glob = new Bun.Glob(`${dir}/**/*`);
      for await (const rel of glob.scan({ cwd: source, onlyFiles: true })) {
        const norm = rel.replace(/\\/g, "/");
        jobs.push({ srcRel: norm, dstRel: `${normDest}/${norm}` });
      }
    } catch {
      /* dir absent in source — skip silently */
    }
  }
  return jobs;
}

/** Default set: STACK_ECC_REFS holds installed (dest-rooted) paths. */
const DEFAULT_DEST_ROOT = "vendor/ecc";
function defaultJobs(dest: string): { srcRel: string; dstRel: string }[] {
  const normDest = dest.replace(/\\/g, "/").replace(/\/$/, "");
  const jobs: { srcRel: string; dstRel: string }[] = [];
  for (const refs of Object.values(STACK_ECC_REFS)) {
    for (const ref of refs) {
      const norm = ref.replace(/\\/g, "/");
      const rel = norm.startsWith(normDest + "/")
        ? norm.slice(normDest.length + 1)
        : norm.startsWith(DEFAULT_DEST_ROOT + "/")
          ? norm.slice(DEFAULT_DEST_ROOT.length + 1)
          : norm.replace(/^ECC-main\//, "");
      jobs.push({ srcRel: rel, dstRel: `${normDest}/${rel}` });
    }
  }
  return jobs;
}

function extraJobs(
  dest: string,
  kind: "skills" | "agents" | "rules",
  ids: string[]
): { srcRel: string; dstRel: string }[] {
  return ids.map((id) => {
    const clean = id.trim().replace(/\.md$/, "");
    const rel = kind === "agents" ? `agents/${clean}.md` : kind === "rules" ? `rules/${clean}.md` : `skills/${clean}/SKILL.md`;
    return { srcRel: rel, dstRel: `${dest}/${rel}` };
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv,
    options: {
      source: { type: "string" },
      release: { type: "string", default: DEFAULT_ECC_RELEASE },
      dest: { type: "string", default: "vendor/ecc" },
      all: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      skills: { type: "string" },
      agents: { type: "string" },
      rules: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) {
    usage();
    return;
  }
  const dest = String(values.dest).replace(/\\/g, "/");

  // --list is pure for the default set (no source touched). --all --list
  // needs the tree, so it falls through to source resolution below.
  if (values.list && !values.all) {
    for (const j of defaultJobs(dest)) console.log(`${j.srcRel} -> ${j.dstRel}`);
    return;
  }

  // Source resolution: explicit --source > local ./ECC-main tree > release.
  let source: string;
  if (typeof values.source === "string" && values.source.trim()) {
    source = values.source;
    if (!(await Bun.file(join(source, "VERSION")).exists())) {
      console.error(`❌ Source is not an ECC tree (no VERSION file): ${source}.`);
      process.exit(1);
    }
  } else if (await Bun.file(join("ECC-main", "VERSION")).exists()) {
    source = "ECC-main";
  } else {
    const tag = String(values.release || DEFAULT_ECC_RELEASE);
    try {
      source = await ensureReleaseSource(tag, Boolean(values.force));
    } catch (err: any) {
      console.error(`❌ Could not fetch ECC release ${tag}: ${err?.message || err}`);
      process.exit(1);
    }
  }

  // --verify: installed tree must match the manifest (drift detector).
  if (values.verify) {
    const manifestFile = Bun.file(`${dest}/${MANIFEST_NAME}`);
    if (!(await manifestFile.exists())) {
      console.error(`❌ No manifest at ${dest}/${MANIFEST_NAME} — nothing to verify (run install first).`);
      process.exit(1);
    }
    const manifest = (await manifestFile.json()) as { files: Record<string, string> };
    let bad = 0;
    for (const [rel, hash] of Object.entries(manifest.files || {})) {
      const f = Bun.file(rel);
      if (!(await f.exists())) {
        console.error(`❌ Missing: ${rel}`);
        bad++;
        continue;
      }
      if (sha256(await f.text()) !== hash) {
        console.error(`❌ Drifted: ${rel}`);
        bad++;
      }
    }
    console.log(bad === 0 ? `✅ Verified ${Object.keys(manifest.files || {}).length} files (ECC ${manifest.eccVersion}).` : `❌ ${bad} problem(s). Re-run install (or --force).`);
    process.exit(bad === 0 ? 0 : 1);
  }

  let jobs = values.all ? await allJobs(source, dest) : defaultJobs(dest);
  if (values.list && values.all) {
    for (const j of jobs) console.log(`${j.srcRel} -> ${j.dstRel}`);
    return;
  }
  if (values.skills) jobs.push(...extraJobs(dest, "skills", String(values.skills).split(",")));
  if (values.agents) jobs.push(...extraJobs(dest, "agents", String(values.agents).split(",")));
  if (values.rules) jobs.push(...extraJobs(dest, "rules", String(values.rules).split(",")));
  jobs = [...new Map(jobs.map((j) => [j.dstRel, j])).values()];

  const eccVersion = await readVersion(source);
  const manifest: { eccVersion: string; eccCommit: string; installedAt: string; files: Record<string, string> } = {
    eccVersion,
    eccCommit: await readSourceCommit(source),
    installedAt: new Date().toISOString(),
    files: {},
  };
  // Preserve a previous manifest's hashes for unchanged-file detection when
  // not forcing (idempotent re-runs stay no-ops). NOTE: exists() first —
  // awaiting .json() on a missing file can settle silently (empty loop exit).
  let prev: Record<string, string> = {};
  const prevManifest = `${dest}/${MANIFEST_NAME}`;
  if (await Bun.file(prevManifest).exists()) {
    try {
      const old = (await Bun.file(prevManifest).json()) as { files: Record<string, string> };
      prev = old.files || {};
    } catch {
      /* corrupt manifest → treat as first install */
    }
  }

  let wrote = 0;
  let skipped = 0;
  let planned = 0;
  for (const j of jobs) {
    const srcFile = Bun.file(join(source, j.srcRel));
    if (!(await srcFile.exists())) {
      console.warn(`⚠️ Source missing, skipped: ${j.srcRel}`);
      continue;
    }
    const content = await srcFile.text();
    manifest.files[j.dstRel] = sha256(content);
    const dstFile = Bun.file(j.dstRel);
    if (!values.force && (await dstFile.exists()) && prev[j.dstRel] === manifest.files[j.dstRel] && sha256(await dstFile.text()) === manifest.files[j.dstRel]) {
      skipped++;
      continue;
    }
    if (values["dry-run"]) {
      console.log(`would write: ${j.dstRel}`);
      planned++;
      continue;
    }
    mkdirSync(dirname(j.dstRel), { recursive: true });
    await Bun.write(j.dstRel, content);
    wrote++;
  }
  if (values["dry-run"]) {
    console.log(`Dry run: ${planned} would write, ${skipped} unchanged.`);
    return;
  }
  mkdirSync(dest, { recursive: true });
  if (Object.keys(manifest.files).length === 0) {
    console.error("❌ Installed zero files — check --source (ECC tree with VERSION?) and selectors. Nothing written.");
    process.exit(1);
  }
  await Bun.write(`${dest}/${MANIFEST_NAME}`, JSON.stringify(manifest, null, 2) + "\n");
  await Bun.write(`${dest}/ATTRIBUTION.md`, ATTRIBUTION);
  console.log(`✅ ECC ${eccVersion} installed repo-scoped → ${dest}/ (${wrote} wrote, ${skipped} unchanged). Manifest: ${dest}/${MANIFEST_NAME}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error in ECC installer:", err);
    process.exit(1);
  });
}