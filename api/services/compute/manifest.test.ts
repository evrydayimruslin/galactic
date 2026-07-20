import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  ComputeManifestError,
  resolveLiveComputeManifestAuthority,
} from "./manifest.ts";

const app = {
  id: "11111111-1111-4111-8111-111111111111",
  owner_id: "22222222-2222-4222-8222-222222222222",
  current_version: "1.2.3",
  manifest: JSON.stringify({
    name: "Compute Agent",
    version: "1.2.3",
    type: "mcp",
    entry: { functions: "index.ts" },
    permissions: ["compute:exec"],
    compute: {
      profile: "developer-v1",
      tools: ["browser", "shell"],
      secrets: ["ANTHROPIC_API_KEY"],
    },
    functions: {
      developer: { description: "Develop", uses_compute: true },
      status: { description: "Status", uses_compute: false },
    },
  }),
};

Deno.test("Compute manifest authority is exact to owner and caller function", () => {
  assertEquals(resolveLiveComputeManifestAuthority({
    app,
    ownerUserId: app.owner_id,
    callerFunction: "developer",
  }), {
    config: {
      profile: "developer-v1",
      tools: ["browser", "shell"],
      secrets: ["ANTHROPIC_API_KEY"],
    },
    revision: "1.2.3",
    callerFunction: "developer",
  });

  const error = assertThrows(
    () => resolveLiveComputeManifestAuthority({
      app,
      ownerUserId: app.owner_id,
      callerFunction: "status",
    }),
    ComputeManifestError,
  );
  assertEquals(error.code, "COMPUTE_CALLER_NOT_DECLARED");
});

Deno.test("Compute manifest rejects unknown developer-v1 tools", () => {
  const error = assertThrows(
    () => resolveLiveComputeManifestAuthority({
      app: {
        ...app,
        manifest: (app.manifest as string).replace(
          '"browser","shell"',
          '"browser.playwright"',
        ),
      },
      ownerUserId: app.owner_id,
      callerFunction: "developer",
    }),
    ComputeManifestError,
  );
  assertEquals(error.code, "COMPUTE_CEILING_REQUIRED");
});

Deno.test("Compute manifest v1 refuses non-owner execution", () => {
  const error = assertThrows(
    () => resolveLiveComputeManifestAuthority({
      app,
      ownerUserId: "33333333-3333-4333-8333-333333333333",
      callerFunction: "developer",
    }),
    ComputeManifestError,
  );
  assertEquals(error.code, "COMPUTE_OWNER_REQUIRED");
});
