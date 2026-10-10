---
name: bun-essentials
description: Bun+TypeScript product discipline — test/build commands, formatting, parameterized data access, Docker-always services. Use when the product stack is bun.
license: MIT
compatibility: opencode
---

## What I do

- Keep Bun+TypeScript products consistent: one toolchain, real Docker services, no fallbacks.

## When to use me

Use on every task whose effective stack (`task.stack` ?? `roadmap.stack`, or workspace markers) is `bun`.

## Rules

1. **Toolchain only:** `bun add <pkg>` / `bun run <file>` / `bun test` / `bun run build`. NEVER `npm`/`npx`/`yarn`/`pnpm`/`node`. Reproducible installs: `bun install --frozen-lockfile` in CI.
2. **Verify:** `bun test` (0 failures) before exit; paste real output into `workspace/TASK_PROGRESS.md`.
3. **Data access:** connect via env (`DATABASE_URL`, …) to the declared Docker services. Parameterize every query (`db.query("... WHERE id = ?")`); never interpolate user input. No SQLite/InMemory fallback layers — fail fast when a service is unreachable.
4. **HTTP:** prefer lightweight frameworks (Hono, Elysia) with thin handlers over layered services; `{ data, error }` envelopes; canonical status codes. E2E on critical flows: Playwright.
5. **Style:** `tsconfig` strict; no `any` drift; no debug leftovers; docs-first for framework APIs (pin version, fetch official docs).

## Depth (vendored ECC reference, MIT © 2026 Affaan Mustafa — read on demand)

- `vendor/ecc/skills/bun-runtime/SKILL.md` (runtime/bundler/test-runner depth, Node migration notes)
- Review checklist: `vendor/ecc/agents/typescript-reviewer.md` (+ `react-reviewer.md` for React work)

- Reloadable staged IDs: `ecc-bun-runtime` (skill tool, on-demand — staged by workflow/runner, never auto-injected)
