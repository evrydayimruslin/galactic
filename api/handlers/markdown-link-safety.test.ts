import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { isSafeMarkdownLinkUrl } from "./app.ts";

Deno.test("markdown link guard: active-content schemes are rejected", () => {
  for (
    const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "javascript\t:alert(1)", // control char between scheme chars and ':'
      "java\nscript:alert(1)",
    ]
  ) {
    assertEquals(isSafeMarkdownLinkUrl(url), false, `should reject: ${JSON.stringify(url)}`);
  }
});

Deno.test("markdown link guard: safe schemes and relative refs are allowed", () => {
  for (
    const url of [
      "https://example.com/x",
      "http://example.com",
      "mailto:hi@example.com",
      "/relative/path",
      "./sibling",
      "../parent",
      "#anchor",
      "docs/readme.md",
    ]
  ) {
    assertEquals(isSafeMarkdownLinkUrl(url), true, `should allow: ${JSON.stringify(url)}`);
  }
});

Deno.test("markdown link guard: empty/whitespace is rejected", () => {
  assertEquals(isSafeMarkdownLinkUrl(""), false);
  assertEquals(isSafeMarkdownLinkUrl("   "), false);
});
