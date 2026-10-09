# 📁 Inputs Directory

Place all information and assets regarding the project you want the Orchestrator and Subagents to build in this directory.

## Directory Structure:
- `spec.md`: The primary specification document. Describe project requirements, user stories, desired tech stack, and scope.
- `assets/`: Place UI mockups, architecture sketches, wireframes, screenshots, or diagram images here.
- `references/`: Place external documentation links, sample JSON/CSV data, API contracts, or existing legacy code here.

## Tips for Best Results:
1. **Be specific about features:** Clear acceptance criteria allow QA subagents to write accurate tests.
2. **Remember CI Constraints:** The system automatically uses **SQLite** for any database requirements to ensure 100% compatibility with GitHub Actions.
