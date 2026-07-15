import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  findManifestAuthorityExpansions,
  summarizeManifestAuthorityChanges,
} from "./manifest-authority.ts";

Deno.test("manifest authority: ordinary implementation and function changes are builder-safe", () => {
  const current = {
    name: "Agent",
    functions: { read: { description: "old" } },
    permissions: ["storage:read"],
    network: { allowed_destinations: [{ host: "api.example.com" }] },
  };
  const target = {
    ...current,
    description: "new release",
    functions: {
      read: { description: "new" },
      summarize: { description: "new implementation surface" },
    },
  };

  assertEquals(findManifestAuthorityExpansions(current, target), []);
});

Deno.test("manifest authority: new runtime, network, and cross-Agent powers require owner promotion", () => {
  const expansions = findManifestAuthorityExpansions(
    {
      permissions: ["storage:read"],
      network: { allowed_destinations: ["api.example.com"] },
      external_functions: [{ app: "calendar", functions: ["list"] }],
    },
    {
      permissions: ["storage:read", "storage:write"],
      network: {
        allowed_destinations: [
          { host: "api.example.com" },
          { host: "mail.example.com" },
        ],
      },
      external_functions: [{
        app: "calendar",
        functions: ["list", "delete"],
      }],
    },
  );

  assert(
    expansions.some((path) => path.startsWith("permissions:storage:write")),
  );
  assert(
    expansions.some((path) =>
      path.startsWith("network.allowed_destinations:mail.example.com")
    ),
  );
  assert(
    expansions.some((path) =>
      path.startsWith("external_functions:calendar") && path.endsWith("delete")
    ),
  );
});

Deno.test("manifest authority: exposure, routines, credentials, and loosened limits require owner promotion", () => {
  const expansions = findManifestAuthorityExpansions(
    {
      rate_limit: { calls_per_minute: 10, calls_per_day: 100 },
      flight_recorder: true,
    },
    {
      http: { defaults: { auth: "public" } },
      routines: [{ id: "watch", default_schedule: "*/5 * * * *" }],
      env_vars: {
        API_KEY: {
          credential: {
            destination: "api.example.com",
            inject: { as: "bearer" },
          },
        },
      },
      rate_limit: { calls_per_minute: 50 },
      flight_recorder: false,
    },
  );

  for (
    const path of [
      "http",
      "routines",
      "env_vars.API_KEY.credential",
      "rate_limit.calls_per_minute",
      "rate_limit.calls_per_day",
      "flight_recorder",
    ]
  ) {
    assert(expansions.includes(path), `${path} should require owner promotion`);
  }
});

Deno.test("manifest authority: a vaulted per-user value cannot be reclassified as sandbox-readable config", () => {
  const expansions = findManifestAuthorityExpansions(
    {
      env_vars: {
        ACCESS_TOKEN: {
          scope: "per_user",
          input: "password",
          credential: {
            destination: "api.example.com",
            inject: { as: "bearer" },
          },
        },
      },
    },
    {
      env_vars: {
        ACCESS_TOKEN: {
          scope: "per_user",
          input: "text",
        },
      },
    },
  );

  assert(expansions.includes("env_vars.readable_per_user:ACCESS_TOKEN"));
});

Deno.test("manifest authority: existing readable per-user config remains builder-safe", () => {
  const manifest = {
    env_vars: {
      IMAP_HOST: {
        scope: "per_user",
        input: "text",
      },
    },
  };

  assertEquals(findManifestAuthorityExpansions(manifest, manifest), []);
});

Deno.test("manifest authority: newly declared vaulted per-user keys require owner review", () => {
  const expansions = findManifestAuthorityExpansions(
    { permissions: ["net:connect"] },
    {
      permissions: ["net:connect"],
      env_vars: {
        HISTORIC_TOKEN: {
          scope: "per_user",
          input: "password",
        },
      },
    },
  );

  assert(expansions.includes("env_vars.per_user:HISTORIC_TOKEN"));
});

Deno.test("manifest authority: widget and command-card dependencies require owner promotion", () => {
  const expansions = findManifestAuthorityExpansions(
    {
      widgets: [{
        id: "inbox",
        dependencies: [{ app: "mail", functions: ["list"], access: "read" }],
      }],
    },
    {
      widgets: [{
        id: "inbox",
        dependencies: [{
          app: "mail",
          functions: ["list", "archive"],
          access: "read",
        }],
        cards: [{
          id: "calendar",
          dependencies: [{ app: "calendar", functions: ["list"] }],
        }],
      }],
    },
  );

  assert(
    expansions.some((path) =>
      path.startsWith("widgets.dependencies:mail") && path.endsWith("archive")
    ),
  );
  assert(
    expansions.some((path) =>
      path.startsWith("widgets.dependencies:calendar") && path.endsWith("list")
    ),
  );
});

Deno.test("manifest authority: owner-facing delta is symmetric and strips internal separators", () => {
  const changes = summarizeManifestAuthorityChanges(
    {
      permissions: ["storage:read", "memory:read"],
      external_functions: [{ app: "calendar", functions: ["list"] }],
    },
    {
      permissions: ["storage:read", "storage:write"],
      external_functions: [{ app: "mail", functions: ["send"] }],
    },
  );

  assert(changes.some((item) =>
    item.change === "added" && item.path.includes("storage:write")
  ));
  assert(changes.some((item) =>
    item.change === "removed" && item.path.includes("memory:read")
  ));
  assert(changes.every((item) => !item.path.includes("\0")));
  assert(changes.every((item) => !item.label.includes("\0")));
});
