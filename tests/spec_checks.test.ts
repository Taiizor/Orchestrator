import { describe, it, expect } from "bun:test";
import { requiredSpecSections, findSpecGaps } from "../orchestrator/spec_checks.ts";

const TEMPLATE = [
  "# Directive",
  "",
  "## 1. Executive Summary & Brand Identity",
  "## 2. Domain Entities & Database Schema",
  "## 3. API Endpoint Contracts Catalog",
  "## 9. QA Acceptance Criteria",
].join("\n");

const pad = (s: string, n = 60) => s + "\n" + "filler text ".repeat(n);

describe("Spec Checks Module", () => {
  it("requiredSpecSections should parse numbered headings", () => {
    expect(requiredSpecSections(TEMPLATE)).toEqual([
      "Executive Summary & Brand Identity",
      "Domain Entities & Database Schema",
      "API Endpoint Contracts Catalog",
      "QA Acceptance Criteria",
    ]);
  });

  it("requiredSpecSections should return [] when template has no numbered sections", () => {
    expect(requiredSpecSections("# Plain\n\nSome text")).toEqual([]);
  });

  it("findSpecGaps should accept a complete document", () => {
    const doc = pad(
      [
        "## 1. Executive Summary & Brand Identity",
        "Mission and brand aesthetics...",
        "## 2. Domain Entities & Database Schema",
        "Tables, columns, indexes...",
        "## 3. API Endpoint Contracts Catalog",
        "POST /api/payments ...",
        "## 9. QA Acceptance Criteria",
        "bun test coverage targets...",
      ].join("\n"),
      60
    );
    expect(findSpecGaps(doc, TEMPLATE, 50)).toEqual([]);
  });

  it("findSpecGaps should flag a missing section", () => {
    const doc = pad("## 1. Executive Summary & Brand Identity\n...\n## 2. Domain Entities & Database Schema\n...", 60);
    const gaps = findSpecGaps(doc, TEMPLATE, 50);
    expect(gaps.some((g) => g.includes("API Endpoint Contracts"))).toBe(true);
  });

  it("findSpecGaps should flag a too-short document", () => {
    const gaps = findSpecGaps("## 1. Executive Summary\nshort", TEMPLATE, 5000);
    expect(gaps.some((g) => g.startsWith("too short"))).toBe(true);
  });

  it("findSpecGaps should flag forbidden ...etc abbreviation", () => {
    const doc = pad("## 1. Executive Summary\nEndpoints: a, b, ...etc\n## 2. Domain\n## 3. API\n## 9. QA", 60);
    const gaps = findSpecGaps(doc, TEMPLATE, 50);
    expect(gaps.some((g) => g.includes("...etc"))).toBe(true);
  });
});
