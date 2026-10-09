# 📁 Inputs Directory

Place all information and assets regarding the project you want the Orchestrator and Subagents to build in this directory.

## Directory Structure:
- `spec.md`: The primary specification document. Describe project requirements, user stories, desired tech stack, and scope.
- `assets/`: Place UI mockups, architecture sketches, wireframes, screenshots, or diagram images here.
- `references/`: Place external documentation links, sample JSON/CSV data, API contracts, or existing legacy code here.
- `skills/`: Optional project-specific agent skills (`<role>-<name>/SKILL.md`). The Skill Forger also writes here on `plan`.

## Tips for Best Results:
1. **Be specific about features:** Clear acceptance criteria allow QA subagents to write accurate tests.
2. **Remember CI Services:** Declare infrastructure needs (PostgreSQL, Redis, Mongo, S3, or custom Docker services) in your spec — CI provisions real containers. Anything undeclared falls back to SQLite/InMemory adapters.
