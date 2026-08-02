import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { extractManifestConceptSurfaces } from "./concept-promotion.ts";

const MANIFEST = {
  name: "email-ops",
  functions: {
    issue_refund: {
      description: "Issues refunds inside the [[refund-window]].",
      args: {
        properties: {
          refund_window: {
            type: "string",
            description: "The window in which refunds are honored.",
            concept: true,
          },
          amt: {
            type: "number",
            description: "Refund amount in EUR.",
            concept: "refund-amount",
          },
          note: {
            type: "string",
            description: "Free text; may reference [[billing-dispute]].",
          },
          bad: { type: "string", concept: "Bad Slug!" },
        },
      },
    },
    check_inbox: { description: "No brackets here." },
  },
};

Deno.test("manifest extraction: descriptions, identities, string form, warnings", () => {
  const extraction = extractManifestConceptSurfaces(MANIFEST, "rel-1");

  const fnSurface = extraction.surfaces.find(
    (s) => s.surfaceType === "function_description",
  );
  assertEquals(fnSurface?.surfaceId, "issue_refund");
  assertEquals(fnSurface?.mentions[0].slug, "refund-window");
  assertEquals(fnSurface?.mentions[0].releaseId, "rel-1");

  const identity = extraction.surfaces
    .flatMap((s) => s.mentions)
    .find((m) => m.identity && m.slug === "refund-window");
  assert(identity, "concept: true must assert a self-named identity");
  assertEquals(identity.fieldPath, "args.refund_window");

  const renamed = extraction.surfaces
    .flatMap((s) => s.mentions)
    .find((m) => m.identity && m.slug === "refund-amount");
  assert(renamed, "concept: \"slug\" must assert identity with that name");
  assertEquals(renamed.fieldPath, "args.amt");

  const prose = extraction.surfaces
    .flatMap((s) => s.mentions)
    .find((m) => m.slug === "billing-dispute");
  assert(prose && !prose.identity, "description brackets stay associations");

  // Only concept: true seeds (the field IS the concept, so its description
  // is the concept's first draft); the string form names a DIFFERENT
  // concept, whose page the field description does not own.
  assertEquals(extraction.seeds, [{
    slug: "refund-window",
    description: "The window in which refunds are honored.",
  }]);

  assertEquals(extraction.warnings.length, 1);
  assert(extraction.warnings[0].includes("bad"));
});

Deno.test("unknown shapes are skipped, never thrown", () => {
  assertEquals(extractManifestConceptSurfaces(null, null).surfaces, []);
  assertEquals(
    extractManifestConceptSurfaces({ functions: "nope" }, null).surfaces,
    [],
  );
  assertEquals(
    extractManifestConceptSurfaces(
      { functions: { f: { args: { properties: { p: 42 } } } } },
      null,
    ).surfaces,
    [],
  );
});
