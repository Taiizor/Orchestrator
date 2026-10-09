# Skill: Automated Security Audit & Vulnerability Scanning

Use this skill when auditing, reviewing, or writing security-sensitive logic.

## Security Checklist:
1. **Never commit secrets:** Check for regex patterns of AWS keys, GitHub tokens, OpenAI/Anthropic keys (`sk-ant-*`, `sk-*`, `ghp_*`).
2. **Safe SQLite Queries:**
   - ✅ DO: `db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId)`
   - ❌ NEVER: `db.run(`DELETE FROM tasks WHERE id = '${taskId}'`)`
3. **Safe File Operations:**
   - Always validate paths using `path.resolve` and check that the target path begins with the allowed workspace root (`path.startsWith(workspaceDir)`).
   - Prevent Path Traversal (`../`).
4. **CORS and Headers:**
   - Set sensible security headers if serving web assets (e.g. `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`).
