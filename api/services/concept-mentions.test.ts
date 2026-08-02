import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  extractConceptMentions,
  slugifyIdentifier,
} from "./concept-mentions.ts";

Deno.test("brackets in prose become mentions with their enclosing block", () => {
  const mentions = extractConceptMentions(
    "Guests asking about [[refund-window]] get the standard reply.",
    { blockSplit: "whole" },
  );
  assertEquals(mentions, [{
    slug: "refund-window",
    blockId: "b0",
    blockText: "Guests asking about [[refund-window]] get the standard reply.",
  }]);
});

Deno.test("empty [[]] is never a mention — identity is structural, not prose", () => {
  assertEquals(
    extractConceptMentions("A field note [[]] with empty brackets.", {
      blockSplit: "whole",
    }),
    [],
  );
});

Deno.test("invalid slugs are ignored, never errors — writing stays fearless", () => {
  const mentions = extractConceptMentions(
    "[[Bad Slug]] [[UPPER]] [[a]] [[-lead]] [[ok-slug]]",
    { blockSplit: "whole" },
  );
  assertEquals(mentions.map((m) => m.slug), ["ok-slug"]);
});

Deno.test("fenced code is skipped and block numbering stays stable", () => {
  const text = [
    "Real mention of [[check-out]].",
    "",
    "```js",
    "const x = data[[0]]; // [[not-a-mention]]",
    "```",
    "",
    "Another paragraph with [[parking]].",
  ].join("\n");
  const mentions = extractConceptMentions(text, { blockSplit: "paragraph" });
  // Blanked fences collapse into the paragraph separator: code never merges
  // adjacent prose into one block, and code brackets never become mentions.
  assertEquals(mentions.map((m) => [m.slug, m.blockId]), [
    ["check-out", "b0"],
    ["parking", "b1"],
  ]);
});

Deno.test("paragraph split gives per-block payloads; duplicates dedupe per block", () => {
  const text =
    "First block about [[refund-window]] and again [[refund-window]].\n\n" +
    "- bullet about [[dog-policy]]";
  const mentions = extractConceptMentions(text, { blockSplit: "paragraph" });
  assertEquals(mentions.length, 2);
  assertEquals(mentions[0].slug, "refund-window");
  assert(mentions[1].blockText.includes("dog-policy"));
});

Deno.test("long blocks truncate with a marker, never exceed the cap", () => {
  const text = `[[cap-test]] ${"x".repeat(3000)}`;
  const [mention] = extractConceptMentions(text, { blockSplit: "whole" });
  assertEquals(mention.blockText.length, 2000);
  assert(mention.blockText.endsWith("…"));
});

Deno.test("slugifyIdentifier maps field names the way `concept: true` names them", () => {
  assertEquals(slugifyIdentifier("refund_window"), "refund-window");
  assertEquals(slugifyIdentifier("RefundWindow"), "refundwindow");
  assertEquals(slugifyIdentifier("__amt__"), "amt");
  assertEquals(slugifyIdentifier("a"), "");
  assertEquals(slugifyIdentifier("!!"), "");
});
