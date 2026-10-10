/**
 * SKILL.md frontmatter normalization (deterministic, no YAML dependency).
 * Forged descriptions routinely contain unquoted ": " which breaks YAML
 * parsers ("mapping values are not allowed in this context"). Every scalar
 * value is re-emitted double-quoted (internal backslashes/quotes escaped),
 * so the committed file always parses.
 */
export function normalizeSkillFrontmatter(raw: string): string | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const out: string[] = ["---"];
  for (const line of m[1].split("\n")) {
    const t = line.replace(/\r$/, "");
    if (!t.trim() || t.trim().startsWith("#")) continue;
    const ci = t.indexOf(":");
    if (ci < 0) return null;
    const key = t.slice(0, ci).trim();
    let val = t.slice(ci + 1).trim();
    if (!key || !val) return null;
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) {
      val = val.slice(1, -1);
    }
    out.push(`${key}: "${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }
  out.push("---");
  return out.join("\n") + "\n" + raw.slice(m[0].length);
}

/** Extract the `name` scalar from (possibly unnormalized) frontmatter. */
export function skillFrontmatterName(raw: string): string | undefined {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const line = m && m[1].split("\n").find((l) => /^\s*name\s*:/.test(l));
  const v =
    line &&
    line
      .slice(line.indexOf(":") + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  return v || undefined;
}
