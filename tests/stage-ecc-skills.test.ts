import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stageEccSkills } from "../scripts/stage-ecc-skills.ts";

async function makeFixture(): Promise<string> {
  const src = join(tmpdir(), `ecc-stage-src-${process.pid}-${Date.now()}`).replace(/\\/g, "/");
  await Bun.write(`${src}/alpha/SKILL.md`, "---\nname: alpha\n---\n\n# Alpha\n");
  await Bun.write(`${src}/alpha/REF.md`, "# Ref\n");
  await Bun.write(`${src}/beta/SKILL.md`, "---\nname: beta\n---\n\n# Beta\n");
  return src;
}

describe("ECC skill staging", () => {
  it("stages with prefix, rewrites frontmatter, and skips when fresh", async () => {
    const src = await makeFixture();
    const dest = join(tmpdir(), `ecc-stage-dst-${process.pid}-${Date.now()}`).replace(/\\/g, "/");

    const first = await stageEccSkills({ src, dest, prefix: "t-" });
    expect(first.skipped).toBe(false);
    expect(first.skills.sort()).toEqual(["t-alpha", "t-beta"]);
    expect(await Bun.file(`${dest}/t-alpha/SKILL.md`).exists()).toBe(true);
    expect(await Bun.file(`${dest}/t-alpha/REF.md`).exists()).toBe(true);
    const staged = await Bun.file(`${dest}/t-alpha/SKILL.md`).text();
    expect(staged.split("\n")[1]).toBe("name: t-alpha");
    expect(await Bun.file(`${dest}/.ecc-staged.json`).exists()).toBe(true);

    const second = await stageEccSkills({ src, dest, prefix: "t-" });
    expect(second.skipped).toBe(true);

    const forced = await stageEccSkills({ src, dest, prefix: "t-", force: true });
    expect(forced.skipped).toBe(false);
    expect(forced.staged).toBe(2);
  });

  it("fails soft when the source is missing", async () => {
    const dest = join(tmpdir(), `ecc-stage-miss-${process.pid}-${Date.now()}`).replace(/\\/g, "/");
    const res = await stageEccSkills({ src: join(tmpdir(), "ecc-nope-missing"), dest });
    expect(res.skipped).toBe(true);
    expect(res.skills).toEqual([]);
  });

  it("denylists skills that route at pruned commands/", async () => {
    const src = join(tmpdir(), `ecc-stage-deny-${process.pid}-${Date.now()}`).replace(/\\/g, "/");
    await Bun.write(`${src}/recipes/SKILL.md`, "---\nname: recipes\n---\n\n# Recipes\n");
    await Bun.write(`${src}/alpha/SKILL.md`, "---\nname: alpha\n---\n\n# Alpha\n");
    const dest = join(tmpdir(), `ecc-stage-denydst-${process.pid}-${Date.now()}`).replace(/\\/g, "/");
    const res = await stageEccSkills({ src, dest, prefix: "t-", force: true });
    expect(res.skipped).toBe(false);
    expect(res.skills).toEqual(["t-alpha"]);
    expect(await Bun.file(`${dest}/t-recipes/SKILL.md`).exists()).toBe(false);
    expect(await Bun.file(`${dest}/t-alpha/SKILL.md`).exists()).toBe(true);
  });
});
