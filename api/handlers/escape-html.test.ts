import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { escapeHtml } from "./app.ts";

Deno.test("escapeHtml: escapes all five HTML-significant characters", () => {
  assertEquals(escapeHtml("&"), "&amp;");
  assertEquals(escapeHtml("<"), "&lt;");
  assertEquals(escapeHtml(">"), "&gt;");
  assertEquals(escapeHtml('"'), "&quot;");
  assertEquals(escapeHtml("'"), "&#39;");
});

Deno.test("escapeHtml: blocks attribute-breakout in an OG content attribute", () => {
  // A malicious agent name trying to break out of content="..." and inject a tag.
  const name = '"><script>alert(1)</script>';
  const escaped = escapeHtml(name);
  // The double-quote that would close the attribute is neutralized...
  assertEquals(escaped.includes('"'), false);
  // ...and the injected tag cannot form.
  assertEquals(escaped.includes("<script>"), false);
  assertEquals(
    escaped,
    "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
  );
});

Deno.test("escapeHtml: ampersand escaped first (no double-encoding)", () => {
  assertEquals(escapeHtml('Tom & "Jerry"'), "Tom &amp; &quot;Jerry&quot;");
});
