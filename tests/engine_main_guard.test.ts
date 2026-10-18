import { describe, it, expect } from "bun:test";
import { join } from "node:path";

/**
 * Regression (found while landing the TASK-060 publish fix): engine.ts used
 * to call main() at module scope with no `import.meta.main` guard, so ANY
 * import of the module — tests/data_persist.test.ts imports unionMirrorDir —
 * silently started a REAL orchestrator tick inside the host process. In the
 * shared test suite the phantom tick could reach plan(), find no inputs/ in
 * a test's cwd, and process.exit(1) the entire runner (observed: silent
 * suite death, exit 1, no summary line). This pins the entry guard:
 * importing the module in a child process must do nothing and exit 0.
 */
describe("engine module import is inert (import.meta.main guard)", () => {
  it("importing orchestrator/engine.ts starts no tick", async () => {
    const proc = Bun.spawn(["bun", "-e", "await import('./orchestrator/engine.ts'); console.log('import-done');"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, ORCHESTRATOR_ENABLED: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    // If the guard regresses, the phantom tick falls down the planning
    // path (fetch --all / LLM call); kill it so the test fails fast.
    const timer = setTimeout(() => proc.kill(), 45_000);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(stdout).toContain("import-done");
    expect(`${stdout}${stderr}`).not.toContain("Orchestrator Tick started");
    expect(exitCode).toBe(0);
  }, 60_000);
});
