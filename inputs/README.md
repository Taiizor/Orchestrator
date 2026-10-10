# 📁 Inputs Directory

Place all information and assets regarding the project you want the Orchestrator and Subagents to build in this directory.

## Directory Structure:
- `spec.md`: The primary specification document. Describe project requirements, user stories, desired tech stack, and scope.
- `assets/`: Place UI mockups, architecture sketches, wireframes, screenshots, or diagram images here.
- `references/`: Place external documentation links, sample JSON/CSV data, API contracts, or existing legacy code here.
- `skills/`: Optional project-specific agent skills (`<role>-<name>/SKILL.md`). The Skill Forger also writes here on `plan`.

## Tips for Best Results:
1. **Be specific about features:** Clear acceptance criteria allow QA subagents to write accurate tests.
2. **Remember Docker Services:** Declare infrastructure needs (PostgreSQL, Redis, Mongo, S3, or ANY custom Docker image) in your spec — the orchestrator provisions real containers locally and in CI. Anything undeclared doesn't exist: agents fail fast instead of inventing fallbacks.
