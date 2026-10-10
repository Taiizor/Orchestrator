# Contributing to Orchestrator

Thanks for contributing. This repo is a **working template**: human PRs land here,
and product repos inherit the engine. Keep contributions tight, tested, and documented.

## How to contribute

1. Fork, branch from `main` (`feat/<topic>`, `fix/<topic>`, `chore/<topic>`).
2. Open a PR against `main` using the template (summary, stack/area, test proof).
3. The `🏷️ PR Labeler` tags your PR by changed files; keep diffs scoped so labels stay meaningful.

## Must-haves in every PR

- **Green suite:** `bun test` with 0 failures — paste the output in the PR body.
- **No new fallback/data layers:** Docker-always holds (services via env, fail fast).
  Never add SQLite/InMemory adapters, `npm`/`npx`/`node` usage, or unpinned sources.
- **No secrets** in code, fixtures, logs, or docs (the gate scans for these).
- **Docs sync:** behavior changes update `AGENTS.md` and/or `README.md` plus the
  affected prompt/skill in the same PR. Doc-only drift is a defect here.

## Adding a product stack (checklist)

New runtimes follow the PHP precedent — all of these, or say why not:

- [ ] `orchestrator/stacks.ts`: `STACKS` entry (test/build commands, markers, evidence),
      `STACK_ESSENTIAL_SKILLS`, `STACK_ECC_SKILL_IDS`, `STACK_ECC_REFS`, detection
- [ ] `.opencode/skills/<stack>-essentials/SKILL.md` (+ Depth refs + reloadable IDs)
- [ ] Both workflows: toolchain setup step (pinned action version, verified to exist)
- [ ] `review_gate.ts`: evidence pattern (+ `GATE_VERSION` bump — invalidates old verdicts)
- [ ] `roadmap_validator.ts`: command recognition; `subagents/runner.ts`: test detection
- [ ] Prompts: planner table, `base_agent.md`, `AGENTS.md` §9, launch boot, architect scaffold
- [ ] `tests/stacks.test.ts`: registry, evidence, commands, skill-existence coverage
- [ ] `skill_forger.md` duplicate list + `README.md` skills line

## Skills & prompts

- Skill frontmatter: `name` equals directory, lowercase-hyphen; one-line description.
- 5–8 tight rules per skill; no secrets, keys, URLs, or customer data in skills.
- Never duplicate `vendor/ecc` topics or other skills — point, don't copy.
- Prompts stay stack-generic unless inside a stack-specific block; engine commands
  (`orchestrator/engine.ts`, `subagents/runner.ts`) always stay `bun`.

## Operators

Steering happens via ChatOps on the dashboard issue (`/pause`, `/retry`, `/revise`,
`/add`…) — see `AGENTS.md` §6. The `ORCHESTRATOR_ENABLED=false` repo variable
stands the engine down; never work around it, remove it when done testing.
