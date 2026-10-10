/**
 * Quality checks for the Stage-1 compiled specification.
 * The analyst prompt template is the single source of truth: required
 * `## N. Title` sections are parsed from it, so prompt and gate can never
 * drift apart. Pure functions — safe to unit test.
 */

/** Backstop length floor (chars). The prompt itself demands far more. */
export const MIN_SPEC_CHARS = 5000;

/**
 * Extract required section titles (`## 1. Foo` headings) from a prompt
 * template. Returns [] when the template has no numbered sections — callers
 * then enforce only the length floor.
 */
export function requiredSpecSections(template: string): string[] {
  const titles: string[] = [];
  for (const line of (template || "").split(/\r?\n/)) {
    const m = line.match(/^##\s*\d+\.\s*(.+?)\s*$/);
    if (m) titles.push(m[1].trim());
  }
  return titles;
}

/**
 * List coverage gaps in a draft spec: length floor, one entry per required
 * section whose distinctive words never appear, and forbidden "...etc"
 * abbreviations the prompt explicitly bans. Empty array = acceptable.
 */
export function findSpecGaps(content: string, template: string, minChars = MIN_SPEC_CHARS): string[] {
  const gaps: string[] = [];
  const body = content || "";
  if (body.trim().length < minChars) {
    gaps.push(`too short (${body.trim().length} < ${minChars} chars)`);
  }
  const lower = body.toLowerCase();
  for (const title of requiredSpecSections(template)) {
    const keys = title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 3);
    if (keys.length > 0 && !keys.some((k) => lower.includes(k))) {
      gaps.push(`missing section: ${title}`);
    }
  }
  if (/\.\.\.etc/i.test(body)) {
    gaps.push('contains "...etc" abbreviation (prompt forbids it)');
  }
  return gaps;
}
