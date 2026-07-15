import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  buildPerUserSettingsStatus,
  validatePerUserSettingsValues,
} from "./user-app-settings.ts";
import { resolveAppEnvSchema } from "./app-settings.ts";

Deno.test("user app settings: builds connected and missing-required status", () => {
  const schema = {
    API_KEY: {
      scope: "per_user",
      required: true,
      description: "Primary API key",
      input: "password",
    },
    REGION: {
      scope: "per_user",
      required: false,
      description: "Optional region override",
      input: "text",
    },
  } as const;

  const result = buildPerUserSettingsStatus(schema, [
    { key: "REGION", updated_at: "2026-04-23T00:00:00.000Z" },
  ]);

  assertEquals(result.connectedKeys, ["REGION"]);
  assertEquals(result.missingRequired, ["API_KEY"]);
  assertEquals(result.fullyConnected, false);
  assertEquals(result.settings, [
    {
      key: "API_KEY",
      label: "API_KEY",
      description: "Primary API key",
      help: null,
      input: "password",
      placeholder: null,
      required: true,
      configured: false,
      updated_at: null,
    },
    {
      key: "REGION",
      label: "REGION",
      description: "Optional region override",
      help: null,
      input: "text",
      placeholder: null,
      required: false,
      configured: true,
      updated_at: "2026-04-23T00:00:00.000Z",
    },
  ]);
});

Deno.test("user app settings: validates declared keys and allows null removals", () => {
  const schema = {
    API_KEY: {
      scope: "per_user",
      required: true,
    },
    REGION: {
      scope: "per_user",
      required: false,
    },
  } as const;

  const result = validatePerUserSettingsValues(schema, {
    API_KEY: "secret-123",
    REGION: null,
    EXTRA: "nope",
  });

  assertEquals(result.allowedKeys, ["API_KEY", "REGION"]);
  assertEquals(result.entries, [
    ["API_KEY", "secret-123"],
    ["REGION", null],
  ]);
  assertEquals(result.errors, [
    "EXTRA: not a declared per-user setting for this app",
  ]);
});

Deno.test("user app settings: rejects non-string values", () => {
  const schema = {
    API_KEY: {
      scope: "per_user",
      required: true,
    },
  } as const;

  const result = validatePerUserSettingsValues(schema, {
    API_KEY: 42,
  });

  assertEquals(result.entries, []);
  assertEquals(result.errors, ["API_KEY: Value must be a string"]);
});

Deno.test("app settings: stored legacy type preserves per-user scope after backfill", () => {
  const schema = resolveAppEnvSchema({
    env_schema: {
      TOKEN: { type: "per_user", required: true },
      REGION: { scope: "universal" },
    },
    manifest: null,
  });
  assertEquals(schema.TOKEN?.scope, "per_user");
  assertEquals(schema.REGION?.scope, "universal");
});
