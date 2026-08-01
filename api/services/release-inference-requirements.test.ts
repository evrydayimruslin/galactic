import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import type { AppManifest } from "../../shared/contracts/manifest.ts";
import {
  compatibleInferenceProviders,
  deriveReleaseInferenceRequirements,
  providerSupportsInferenceOperations,
} from "./release-inference-requirements.ts";

function manifest(
  functions: AppManifest["functions"],
  permissions: string[] = [],
): AppManifest {
  return {
    name: "Mail helper",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions,
    permissions,
  };
}

Deno.test("release inference requirements use exact function authority effects", () => {
  const requirements = deriveReleaseInferenceRequirements(manifest(
    {
      draft: {
        description: "Draft a reply",
        authority: {
          level: "read",
          effects: { "inference.generate": { mode: "free" } },
        },
      },
      search: {
        description: "Embed a query",
        authority: {
          level: "read",
          effects: { "inference.embed": { mode: "free" } },
        },
      },
      list: {
        description: "List messages",
        authority: {
          level: "read",
          effects: { "storage.read": { mode: "free" } },
        },
      },
    } as AppManifest["functions"],
  ));

  assertEquals(requirements, {
    required: true,
    operations: ["generate", "embed"],
    functions: [
      { name: "draft", operations: ["generate"] },
      { name: "search", operations: ["embed"] },
    ],
  });
});

Deno.test("release inference requirements preserve legacy manifest fallback", () => {
  assertEquals(
    deriveReleaseInferenceRequirements(manifest({
      run: { description: "Run", uses_inference: true },
    }, ["ai:embed"])),
    {
      required: true,
      operations: ["embed"],
      functions: [{ name: "run", operations: ["embed"] }],
    },
  );
});

Deno.test("provider compatibility is capability-aware", () => {
  assertEquals(
    providerSupportsInferenceOperations("openai", ["generate"]),
    true,
  );
  assertEquals(providerSupportsInferenceOperations("openai", ["embed"]), false);
  assertEquals(compatibleInferenceProviders(["generate", "embed"]), [
    "openrouter",
  ]);
});
