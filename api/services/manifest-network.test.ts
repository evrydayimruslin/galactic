import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  type AppManifest,
  resolveManifestEnvSchema,
  validateManifest,
} from "../../shared/contracts/manifest.ts";

function baseManifest(overrides: Record<string, unknown> = {}): AppManifest {
  return {
    name: "Network App",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: { run: { description: "Do a thing" } },
    ...overrides,
  } as AppManifest;
}

Deno.test("manifest network: normalizes allowed_destinations (bare strings + objects, lowercased)", () => {
  const manifest = baseManifest({
    network: {
      allowed_destinations: [
        "API.OpenAI.com",
        { host: "imap.gmail.com:993", label: "Gmail IMAP" },
        "*.example.com",
      ],
    },
  });

  const result = validateManifest(manifest);

  assertEquals(result.valid, true, JSON.stringify(result.errors));
  assertEquals(manifest.network?.allowed_destinations, [
    { host: "api.openai.com", label: undefined, description: undefined },
    { host: "imap.gmail.com:993", label: "Gmail IMAP", description: undefined },
    { host: "*.example.com", label: undefined, description: undefined },
  ]);
});

Deno.test("manifest network: rejects a destination with a scheme or path", () => {
  const result = validateManifest(baseManifest({
    network: { allowed_destinations: ["https://api.openai.com/v1"] },
  }));

  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((e) => e.path === "network.allowed_destinations.0.host"),
    true,
  );
});

Deno.test("manifest network: rejects duplicate destinations (case-insensitive)", () => {
  const result = validateManifest(baseManifest({
    network: { allowed_destinations: ["api.openai.com", "API.OPENAI.COM"] },
  }));

  assertEquals(result.valid, false);
});

Deno.test("manifest credential: accepts a per-user credential bound to a declared host and carries it into the env schema", () => {
  const manifest = baseManifest({
    network: { allowed_destinations: ["api.openai.com"] },
    env_vars: {
      OPENAI_KEY: {
        scope: "per_user",
        credential: { destination: "API.OpenAI.com", inject: { as: "bearer" } },
      },
    },
  });

  const result = validateManifest(manifest);

  assertEquals(result.valid, true, JSON.stringify(result.errors));
  // normalized (lowercased destination) on the stored manifest
  assertEquals(manifest.env_vars?.OPENAI_KEY?.credential, {
    destination: "api.openai.com",
    inject: { as: "bearer" },
  });
  // and flows into the runtime-consumed env schema (Phase 3 reads this)
  const schema = resolveManifestEnvSchema(manifest);
  assertEquals(schema.OPENAI_KEY.credential, {
    destination: "api.openai.com",
    inject: { as: "bearer" },
  });
});

Deno.test("manifest credential: rejects a destination not declared in allowed_destinations", () => {
  const result = validateManifest(baseManifest({
    network: { allowed_destinations: ["api.openai.com"] },
    env_vars: {
      KEY: {
        scope: "per_user",
        credential: { destination: "evil.com", inject: { as: "bearer" } },
      },
    },
  }));

  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((e) =>
      e.path === "env_vars.KEY.credential.destination"
    ),
    true,
  );
});

Deno.test("manifest credential: rejects an unsupported inject shape", () => {
  const result = validateManifest(baseManifest({
    network: { allowed_destinations: ["api.example.com"] },
    env_vars: {
      KEY: {
        scope: "per_user",
        credential: {
          destination: "api.example.com",
          inject: { as: "cookie" },
        },
      },
    },
  }));

  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((e) => e.path === "env_vars.KEY.credential.inject.as"),
    true,
  );
});

Deno.test("manifest credential: header inject requires a valid header name", () => {
  const result = validateManifest(baseManifest({
    network: { allowed_destinations: ["api.example.com"] },
    env_vars: {
      KEY: {
        scope: "per_user",
        credential: {
          destination: "api.example.com",
          inject: { as: "header", name: "Bad Header!" },
        },
      },
    },
  }));

  assertEquals(result.valid, false);
});

Deno.test("manifest: absent network/credential stays valid (back-compat)", () => {
  const result = validateManifest(baseManifest());
  assertEquals(result.valid, true, JSON.stringify(result.errors));
});
