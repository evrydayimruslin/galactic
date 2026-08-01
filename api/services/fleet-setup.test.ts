import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import type { LaunchAgentHomeResponse } from "../../shared/contracts/launch.ts";
import { buildFleetSetupResponse } from "./fleet-setup.ts";

const HOME = {
  revision: "agent:1",
  setup: { ready: true, requirements: [] },
  actions: { canActivate: true },
} as unknown as LaunchAgentHomeResponse;

Deno.test("Fleet setup groups shared inference once across pending Agents", () => {
  const response = buildFleetSetupResponse({
    agents: [{
      id: "a1",
      slug: "mail",
      name: "Mail",
      deploymentState: "setup_required",
      activeReleaseDigest: "release-1",
      inference: {
        required: true,
        operations: ["generate"],
        functions: [{ name: "draft", operations: ["generate"] }],
      },
      home: HOME,
    }, {
      id: "a2",
      slug: "search",
      name: "Search",
      deploymentState: "setup_required",
      activeReleaseDigest: "release-2",
      inference: {
        required: true,
        operations: ["embed"],
        functions: [{ name: "lookup", operations: ["embed"] }],
      },
      home: HOME,
    }],
    byok: { enabled: false, primaryProvider: null, configs: [] },
    generatedAt: "2026-08-01T00:00:00.000Z",
  });

  assertEquals(response.inference?.operations, ["generate", "embed"]);
  assertEquals(response.inference?.compatibleProviderIds, ["openrouter"]);
  assertEquals(response.inference?.readiness, "missing");
  assertEquals(response.readyToActivateCount, 0);
});

Deno.test("Fleet setup accepts only validation covering every required operation", () => {
  const response = buildFleetSetupResponse({
    agents: [{
      id: "a1",
      slug: "mail",
      name: "Mail",
      deploymentState: "setup_required",
      activeReleaseDigest: "release-1",
      inference: {
        required: true,
        operations: ["generate", "embed"],
        functions: [{ name: "run", operations: ["generate", "embed"] }],
      },
      home: HOME,
    }],
    byok: {
      enabled: true,
      primaryProvider: "openrouter",
      configs: [{
        provider: "openrouter",
        has_key: true,
        model: "openai/gpt-4o-mini",
        added_at: "2026-08-01T00:00:00.000Z",
        validation: {
          policy_version: "launch-byok-v1",
          key_version: "key-1",
          provider: "openrouter",
          model: "openai/gpt-4o-mini",
          operations: ["generate", "embed"],
          validated_at: "2026-08-01T00:00:00.000Z",
        },
      }],
    },
  });

  assertEquals(response.inference?.readiness, "ready");
  assertEquals(response.readyToActivateCount, 1);
});
