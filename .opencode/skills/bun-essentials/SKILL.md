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
2. **Verify:** `bun test` (0 failures) before exit; paste real output into `workspace/TASK_PROGRESS.md`. Every new behavior ships success AND error-path cases (invalid input, missing id, unauthorized); suites without an error-path case fail review.
3. **Data access:** connect via env (`DATABASE_URL`, …) to the declared Docker services. Parameterize every query (`db.query("... WHERE id = $1", [id])` on postgres — driver placeholders, never interpolation). No SQLite/InMemory fallback layers — fail fast when a service is unreachable.
4. **HTTP:** prefer lightweight frameworks (Hono, Elysia) with thin handlers OVER services, services over repositories per `backend-structure` — never skip the service layer; `{ data, error }` envelopes; canonical status codes. Every user-facing flow that mutates state ships a Playwright smoke; skipped flows are named with reason in TASK_PROGRESS.md.
5. **Style:** `tsconfig` strict; no `any` drift; no debug leftovers; docs-first for framework APIs (pin version, fetch official docs).

## Depth (vendored ECC reference, MIT © 2026 Affaan Mustafa — read on demand)

- `vendor/ecc/skills/bun-runtime/SKILL.md` (runtime/bundler/test-runner depth, Node migration notes)
- Review checklist: `vendor/ecc/agents/typescript-reviewer.md` (+ `react-reviewer.md` for React work)

- Reloadable staged IDs: `ecc-bun-runtime` (skill tool, on-demand — staged by workflow/runner, never auto-injected)
