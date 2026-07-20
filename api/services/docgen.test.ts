import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import type { ParseResult } from "./parser.ts";
import { generateEmbeddingText, generateSkillsMd } from "./docgen.ts";

Deno.test("docgen: generated markdown uses actionable copy for empty function lists", () => {
  const parseResult: ParseResult = {
    functions: [],
    types: {},
    permissions: [],
    parseErrors: [],
    parseWarnings: [],
  };

  const markdown = generateSkillsMd("Starter App", parseResult);

  assertStringIncludes(
    markdown,
    "<!-- Generated from the current app source. Keep manual edits aligned with code changes. -->",
  );
  assertStringIncludes(
    markdown,
    "No exported functions were detected in the entry file. Add at least one exported function to publish app capabilities.",
  );
  assert(!markdown.includes("Edit with caution."));
  assert(!markdown.includes("*No exported functions found.*"));
});

Deno.test("docgen: generated markdown includes declared HTTP routes", () => {
  const parseResult: ParseResult = {
    functions: [{
      name: "webhook",
      description: "Receive provider webhooks",
      parameters: [],
      returns: {
        type: "Promise<object>",
        description: "",
        schema: { type: "object" },
      },
      examples: [],
      permissions: [],
      isAsync: true,
    }],
    types: {},
    permissions: [],
    parseErrors: [],
    parseWarnings: [],
  };

  const markdown = generateSkillsMd("Webhook App", parseResult, {
    httpRoutes: [{
      function_name: "webhook",
      path: "/http/app-123/webhook",
      auth: "public",
      methods: ["POST"],
      billing: "owner",
      data_scope: "app",
    }],
  });

  assertStringIncludes(markdown, "## Direct HTTP Routes");
  assertStringIncludes(markdown, "`POST /http/app-123/webhook`");
  assertStringIncludes(markdown, "public, owner-billed, app data scope");
  assertStringIncludes(markdown, "GET /http/{appId}/_ui");
});

Deno.test("docgen: compute permission has an explicit capability disclosure", () => {
  const text = generateEmbeddingText(
    "Builder",
    "Builds projects",
    {
      functions: [],
      permissions: [{ permission: "compute:exec", required: true }],
    },
  );

  assertStringIncludes(
    text,
    "can start disposable developer compute jobs with explicitly declared tools and secrets",
  );
});
