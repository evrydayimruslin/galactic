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

  it("scales the eclipse and trefoil from the same 1280px reference width", () => {
    expect(css).toMatch(
      /@media \(min-width: 1281px\) \{[\s\S]*?\.neb-theme-eclipse \{[\s\S]*?width: 68\.75vw;[\s\S]*?height: 68\.75vw;[\s\S]*?\.neb-theme-trefoil \{[\s\S]*?width: 76\.5625vw;[\s\S]*?height: 76\.5625vw;/,
    );
  });
});
