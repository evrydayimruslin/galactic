import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../src/components/nebula-fleet.css", import.meta.url),
  "utf8",
);

describe("warm theme design contracts", () => {
  it("preserves the exact light handoff tokens", () => {
    expect(css).toContain("--ground: #efe9e1;");
    expect(css).toContain("--ink-soft: #71624f;");
    expect(css).toContain("--ink-faint: #7c6f58;");
    expect(css).toContain("--accent-text: #8e5c22;");
    expect(css).toContain("--line-hairline: #e2d9cc;");
    expect(css).toContain(
      "--shadow-control: -4px -4px 10px rgba(255, 255, 255, 0.8), 5px 6px 12px rgba(93, 78, 60, 0.14);",
    );
  });

  it("keeps light controls exact without changing dark theme assignments", () => {
    expect(css).toMatch(
      /html\[data-theme="light"\] \.nebula-root \.neb-hero-alerts-btn,[\s\S]*?background: transparent;[\s\S]*?color: var\(--accent-text\);/,
    );
    expect(css).toMatch(
      /html\[data-theme="light"\] \.nebula-root \.neb-hero-cta\.secondary,[\s\S]*?border-color: var\(--line-hairline\);[\s\S]*?box-shadow: var\(--shadow-control\);[\s\S]*?color: var\(--ink-soft\);/,
    );
    expect(css).toMatch(
      /html\[data-theme="light"\] \.nebula-root \.neb-add-agent-card \{[\s\S]*?border-color: transparent;[\s\S]*?border-style: solid;[\s\S]*?color: var\(--ink-faint\);/,
    );
    expect(css).toContain(
      'html[data-theme="dark"] .neb-theme-eclipse { display: block; }',
    );
  });

  it("keeps dark Fleet CTAs on the exact handoff swatches at rest and hover", () => {
    expect(css).toMatch(
      /html\[data-theme="dark"\] \.nebula-root \.neb-hero-alerts-btn,[\s\S]*?\.neb-hero-alerts-btn:hover \{[\s\S]*?border-color: #d4a94f;[\s\S]*?background: rgba\(212, 169, 79, 0\.09\);[\s\S]*?color: #e9c97c;/,
    );
    expect(css).toContain(
      'html[data-theme="dark"] .nebula-root .neb-hero-alerts-dot { background: #d4a94f; }',
    );
    expect(css).toMatch(
      /html\[data-theme="dark"\] \.nebula-root \.neb-hero-cta\.secondary,[\s\S]*?\.neb-hero-cta\.secondary:hover \{[\s\S]*?border-color: rgba\(243, 233, 216, 0\.22\);[\s\S]*?background: #17140f;[\s\S]*?box-shadow: none;[\s\S]*?color: #c0ae93;/,
    );
  });

  it("scales the eclipse and trefoil from the same 1280px reference width", () => {
    expect(css).toMatch(
      /@media \(min-width: 1281px\) \{[\s\S]*?\.neb-theme-eclipse \{[\s\S]*?width: 68\.75vw;[\s\S]*?height: 68\.75vw;[\s\S]*?\.neb-theme-trefoil \{[\s\S]*?width: 76\.5625vw;[\s\S]*?height: 76\.5625vw;/,
    );
  });

  it("keeps non-selected Search and Settings text on the exact soft swatches", () => {
    expect(css).toContain(
      ".nebula-root .neb-rail-btn { color: var(--ink-soft); }",
    );
    expect(css).toContain(
      ".nebula-root .neb-cmdk-item { color: var(--ink-soft); }",
    );
    expect(css).toContain("--ink-soft: #c0ae93;");
    expect(css).toContain("--ink-soft: #71624f;");
  });

  it("keeps alert cards neutral while retaining the short accent stub", () => {
    expect(css).toMatch(
      /\.neb-operator-attention-card\.incident,[\s\S]*?\.neb-agent-attention-card\.incident,[\s\S]*?\.neb-operator-issue-card\.issue \{[\s\S]*?border-color: var\(--line-hairline\);[\s\S]*?background: var\(--surface-subtle\);/,
    );
    expect(css).toMatch(
      /\.neb-operator-issue-card\.unread::before,[\s\S]*?\.neb-agent-attention-card\.unread::before,[\s\S]*?\.neb-operator-attention-card\.unread::before \{[\s\S]*?width: 2px;[\s\S]*?height: 22px;[\s\S]*?background: var\(--accent\);/,
    );
  });
});
