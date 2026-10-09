# Skill: Rigorous Code Review & Verification

Use this skill when reviewing pull requests or evaluating subagent task completion.

## Review Dimensions:
1. **Functional Correctness:** Does the code solve the problem outlined in the task description?
2. **Edge Cases:** Are empty strings, null values, malformed inputs, and non-existent IDs handled gracefully?
3. **No Flaky Tests:** Are unit tests deterministic and isolated from external networks?
4. **Code Cleanliness:** Are variables well-named? Is dead code or excessive debug console logging removed?
5. **No Regressions:** Did this change break any existing test suites or files?
