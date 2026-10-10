# 📋 Project Directives & Overrides (Optional)

This file is the HIGHEST authority in `inputs/`: on any conflict between this
file and other dropped-in documents, the planner follows THIS file. Leave it
empty (or all-commented, as shipped) and the planner synthesizes 100% of the
scope from the rest of `inputs/`. Uncomment and edit a section ONLY when you
mean it as a binding order — a forgotten example mandate WILL steer the plan
(see: stale single-stack mandates that outlive their reasons).

<!--
## Stack pin (optional — uncomment to bind; delete if undecided)
- **DECIDED stack (owner-approved, binding for all future plans):** <bun | go | rust | dotnet | python | php> — <one line WHY>.
- Split layers (optional): <stack> owns <paths>; <stack> owns <paths>; layers meet at versioned HTTP plus the generated typed client, with a contract task owning `workspace/CONTRACTS.md`.
- To change a recorded stack later, append a dated amendment below (supersedes ...) — never silently edit history.

## Non-goals (optional)
- Out of scope for this roadmap: <...>. Show capability-limited modules as COMING SOON or hide them; never fake them.

## Binding capabilities, not frameworks (optional)
- Requirements no agent may drop or reinterpret: <e.g. integer-minor money math; MFA-capable auth; EU data residency>.
-->
