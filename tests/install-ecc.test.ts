import { describe, it, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { STACK_ECC_REFS } from "../orchestrator/stacks.ts";
import { buildReleaseUrl, DEFAULT_ECC_RELEASE } from "../scripts/install-ecc.ts";

/** Local ECC tree (manual checkout) — absent on fresh clones (release mode covers it). */
const HAS_ECC = existsSync(join(".", "ECC-main", "VERSION"));
/** Set ECC_LIVE_TEST=1 to exercise the real release download (network). */
const LIVE = process.env.ECC_LIVE_TEST === "1";

async function runInstaller(args: string[], cwd = "."): Promise<{ exit: number; out: string }> {
  const proc = Bun.spawn(["bun", "scripts/install-ecc.ts", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { exit: await proc.exited, out };
}

describe("repo-scoped ECC installer", () => {
  it("--list covers every STACK_ECC_REFS file", async () => {
    const { exit, out } = await runInstaller(["--list"]);
    expect(exit).toBe(0);
    const expected = Object.values(STACK_ECC_REFS).flat().length;
    expect(out.trim().split("\n").filter(Boolean).length).toBe(expected);
  });

  it("installs to a scratch dest, verifies, and re-runs as a no-op", async () => {
    const dest = join(tmpdir(), `ecc-install-test-${process.pid}-${Date.now()}`).replace(/\\/g, "/");
    const first = await runInstaller(["--source", "tests/fixtures/ecc", "--dest", dest,
      "--rules", "demo-rule", "--skills", "demo-skill", "--agents", "demo-agent"]);
    expect(first.exit).toBe(0);
    expect(first.out).toMatch(/3 wrote/);

    const manifest = (await Bun.file(`${dest}/.manifest.json`).json()) as {
      eccVersion: string;
      files: Record<string, string>;
    };
    expect(manifest.eccVersion).toBe("0.0.0-test");
    expect(Object.keys(manifest.files).length).toBe(3);
    expect(await Bun.file(`${dest}/ATTRIBUTION.md`).exists()).toBe(true);

    const verify = await runInstaller(["--source", "tests/fixtures/ecc", "--dest", dest, "--verify"]);
    expect(verify.exit).toBe(0);
    expect(verify.out).toMatch(/Verified 3 files/);

    const rerun = await runInstaller(["--source", "tests/fixtures/ecc", "--dest", dest,
      "--rules", "demo-rule", "--skills", "demo-skill", "--agents", "demo-agent"]);
    expect(rerun.exit).toBe(0);
    expect(rerun.out).toMatch(/3 unchanged/);
  }, 60000);

  it("builds the pinned release URL", () => {
    expect(DEFAULT_ECC_RELEASE).toBe("v2.2.3");
    expect(buildReleaseUrl("v2.2.3")).toBe("https://github.com/affaan-m/ECC/archive/refs/tags/v2.2.3.tar.gz");
  });

  it("--all installs the whole fixture surface", async () => {
    const dest = join(tmpdir(), `ecc-all-test-${process.pid}-${Date.now()}`).replace(/\\/g, "/");
    const res = await runInstaller(["--source", "tests/fixtures/ecc", "--dest", dest, "--all"]);
    expect(res.exit).toBe(0);
    expect(res.out).toMatch(/3 wrote/);
    const manifest = (await Bun.file(`${dest}/.manifest.json`).json()) as { files: Record<string, string> };
    expect(Object.keys(manifest.files).sort()).toEqual(
      ["agents/demo-agent.md", "rules/demo-rule.md", "skills/demo-skill/SKILL.md"].map((p) => `${dest}/${p}`).sort()
    );
  });

  // Full default-set install against a local ECC tree (skipped on fresh
  // clones — fixture mechanics above run everywhere).
  test.skipIf(!HAS_ECC)("installs the full STACK_ECC_REFS set from a local tree", async () => {
    const dest = join(tmpdir(), `ecc-full-test-${process.pid}-${Date.now()}`).replace(/\\/g, "/");
    const expected = Object.values(STACK_ECC_REFS).flat().length;
    const first = await runInstaller(["--dest", dest]);
    expect(first.exit).toBe(0);
    expect(first.out).toMatch(new RegExp(`${expected} wrote`));
    const verify = await runInstaller(["--dest", dest, "--verify"]);
    expect(verify.exit).toBe(0);
  }, 120000);

  // Live release download (network; opt-in only — never in CI).
  test.skipIf(!LIVE)("installs from the release tarball", async () => {
    const dest = join(tmpdir(), `ecc-live-test-${process.pid}-${Date.now()}`).replace(/\\/g, "/");
    const expected = Object.values(STACK_ECC_REFS).flat().length;
    const first = await runInstaller(["--release", DEFAULT_ECC_RELEASE, "--dest", dest]);
    expect(first.exit).toBe(0);
    expect(first.out).toMatch(new RegExp(`${expected} wrote`));
    const manifest = (await Bun.file(`${dest}/.manifest.json`).json()) as { eccVersion: string };
    expect("v" + manifest.eccVersion).toBe(DEFAULT_ECC_RELEASE);
  }, 300000);

  it("refuses a non-ECC source", async () => {
    const { exit, out } = await runInstaller(["--source", ".", "--dest", join(tmpdir(), "ecc-nope").replace(/\\/g, "/")]);
    expect(exit).toBe(1);
    expect(out).toMatch(/not an ECC tree/);
  });
});
