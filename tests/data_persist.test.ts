import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { unionMirrorDir } from "../orchestrator/engine.ts";

describe("unionMirrorDir (dual-repo persist)", () => {
  it("adds src files without deleting dst-only files", async () => {
    const root = join(tmpdir(), `orch-union-${process.pid}-${Date.now()}`);
    const src = join(root, "src");
    const dst = join(root, "dst");
    mkdirSync(join(src, "sub"), { recursive: true });
    mkdirSync(join(dst, "data-only"), { recursive: true });
    await Bun.write(join(src, "a.md"), "from engine checkout\n");
    await Bun.write(join(src, "sub", "b.md"), "nested\n");
    await Bun.write(join(dst, "data-only", "forged.md"), "forged skill, data-only\n");
    await Bun.write(join(dst, "shared.md"), "old\n");
    await Bun.write(join(src, "shared.md"), "new\n");

    unionMirrorDir(src, dst);

    // src content arrived (new + nested)…
    expect(await Bun.file(join(dst, "a.md")).text()).toBe("from engine checkout\n");
    expect(await Bun.file(join(dst, "sub", "b.md")).text()).toBe("nested\n");
    // …src wins on shared paths…
    expect(await Bun.file(join(dst, "shared.md")).text()).toBe("new\n");
    // …and dst-only files SURVIVE (the Fayn forged-skills deletion).
    expect(await Bun.file(join(dst, "data-only", "forged.md")).text()).toBe("forged skill, data-only\n");
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a missing destination tree", async () => {
    const root = join(tmpdir(), `orch-union-mk-${process.pid}-${Date.now()}`);
    const src = join(root, "src");
    const dst = join(root, "deep", "dst");
    mkdirSync(src, { recursive: true });
    await Bun.write(join(src, "x.md"), "x\n");
    unionMirrorDir(src, dst);
    expect(await Bun.file(join(dst, "x.md")).text()).toBe("x\n");
    rmSync(root, { recursive: true, force: true });
  });
});
