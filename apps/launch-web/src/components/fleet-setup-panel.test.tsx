import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  LaunchByokProviderOption,
  LaunchFleetSetupResponse,
} from "../../../../shared/contracts/launch.ts";
import { BYOK_PROVIDERS } from "../../../../shared/types/index.ts";
import { ByokCredentialForm } from "./byok-credential-form";
import { FleetSetupPanel } from "./fleet-setup-panel";

function provider(id: "openrouter" | "openai"): LaunchByokProviderOption {
  const entry = BYOK_PROVIDERS[id];
  return {
    id,
    name: entry.name,
    description: entry.description,
    configured: false,
    primary: false,
    defaultModel: entry.defaultModel,
    model: null,
    models: entry.models,
    capabilities: entry.capabilities,
    validation: null,
    apiKeyPrefix: entry.apiKeyPrefix,
    apiKeyUrl: entry.apiKeyUrl,
    docsUrl: entry.docsUrl,
  };
}

describe("post-deployment Fleet setup", () => {
  it("keeps Test and Save separate and uses the approved security/cost copy", () => {
    const markup = renderToStaticMarkup(
      <ByokCredentialForm providerOptions={[provider("openrouter")]} />,
    );
    expect(markup).toContain("Test key");
    expect(markup).toContain("Save key");
    expect(markup).toContain(
      "Encrypted and write-only; Galactic never displays your key.",
    );
    expect(markup).toContain("billed directly by your provider");
    expect(markup).not.toContain("$1–3");
  });

  it("filters providers by every exact release-required operation", () => {
    const markup = renderToStaticMarkup(
      <ByokCredentialForm
        providerOptions={[provider("openrouter"), provider("openai")]}
        requiredOperations={["generate", "embed"]}
      />,
    );
    expect(markup).toContain("OpenRouter");
    expect(markup).not.toContain(">OpenAI<");
  });

  it("renders shared BYOK before per-Agent setup and final activation", () => {
    const setup: LaunchFleetSetupResponse = {
      agents: [{
        agent: { id: "agent-1", slug: "mail", name: "Mail Agent" },
        deploymentState: "setup_required",
        activeReleaseDigest: "release-1",
        homeRevision: "agent-1:1",
        requirements: [{
          id: "setting:GMAIL_TOKEN",
          actionId: "GMAIL_TOKEN",
          kind: "setting",
          label: "Gmail access token",
          description: "Connect the inbox this Agent manages.",
          required: true,
          configured: false,
          blocking: true,
          secret: true,
          settingKey: "GMAIL_TOKEN",
          settingScope: "agent",
          input: "password",
          placeholder: "token",
          help: null,
          group: "Gmail",
          destination: "gmail.googleapis.com",
          updatedAt: null,
          actions: ["set"],
        }],
        canActivate: false,
        syncing: false,
        unavailableReason: null,
      }],
      inference: {
        id: "account:byok",
        required: true,
        operations: ["generate"],
        functions: [{
          agentId: "agent-1",
          agentSlug: "mail",
          agentName: "Mail Agent",
          functionName: "draft_reply",
          operations: ["generate"],
        }],
        compatibleProviderIds: [
          "openrouter",
          "openai",
          "deepseek",
          "nvidia",
          "google",
          "xai",
          "moonshot",
          "zai",
        ],
        configuredProviderId: null,
        readiness: "missing",
      },
      pendingAgentCount: 1,
      readyToActivateCount: 0,
      generatedAt: "2026-08-01T00:00:00.000Z",
    };
    const markup = renderToStaticMarkup(
      <FleetSetupPanel
        navigate={vi.fn()}
        onChanged={vi.fn()}
        setup={setup}
      />,
    );
    expect(markup.indexOf("Connect your model provider")).toBeLessThan(
      markup.indexOf("Mail Agent"),
    );
    expect(markup).toContain("Gmail access token");
    expect(markup).toContain("Review and activate");
    expect(markup).toContain("Open Agent Studio");
    expect(markup).not.toContain("Watch first run");
  });
});
