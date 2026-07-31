import { describe, expect, it } from "vitest";

import {
  buildAgentExtensionPrompt,
  buildConnectAiPrompt,
  buildNewAgentPrompt,
  type AgentExtensionKind,
} from "./agent-extension-prompt";

const target = {
  id: "app-email-ops",
  slug: "email-ops",
  name: "Email Operations",
  description: "Triages the shared inbox.",
};

describe("buildAgentExtensionPrompt", () => {
  it.each<AgentExtensionKind>(["interface", "routine", "function"])(
    "builds a credentialed, exact-target %s prompt",
    (kind) => {
      const prompt = buildAgentExtensionPrompt({
        agent: target,
        apiKey: "gx_secret_key",
        kind,
        platformMcpUrl: "https://api.connectgalactic.com/mcp/platform",
      });

      expect(prompt).toContain(`add a new ${kind}`);
      expect(prompt).toContain("Name: Email Operations");
      expect(prompt).toContain("ID: app-email-ops");
      expect(prompt).not.toContain("Slug:");
      expect(prompt).toContain("Authorization: Bearer gx_secret_key");
      expect(prompt).toContain("ask me to describe");
      expect(prompt).toContain("do not create a new Agent");
      expect(prompt).toContain(
        'gx.project({ app_id: "app-email-ops", view: "coding_capsule" })',
      );
      expect(prompt).toContain('gx.download({ app_id: "app-email-ops" })');
      expect(prompt).toContain("gx.stage({ files:");
      expect(prompt).toContain(
        "gx.test({ bundle_id: staged.bundle_id })",
      );
      expect(prompt).toContain(
        'gx.upload({ app_id: "app-email-ops", bundle_id: staged.bundle_id',
      );
      expect(prompt).toContain("test_attestation");
      expect(prompt).toContain("exact bundle tested");
      expect(prompt).toContain("submit a candidate");
      expect(prompt).not.toContain("$GALACTIC_API_KEY");
    },
  );

  it("builds a connection-only prompt", () => {
    const prompt = buildConnectAiPrompt({
      apiKey: "gx_connect_key",
      platformMcpUrl: "https://api.connectgalactic.com/mcp/platform",
    });

    expect(prompt).toContain("Connect this coding agent to my Galactic workspace");
    expect(prompt).toContain("Authorization: Bearer gx_connect_key");
    expect(prompt).toContain('gx.discover({ scope: "tools" })');
    expect(prompt).toContain("inspection-only connection");
    expect(prompt).toContain("Do not enumerate account data or Agents");
    expect(prompt).not.toContain('gx.discover({ scope: "library" })');
  });

  it("builds a new persistent Agent prompt", () => {
    const prompt = buildNewAgentPrompt({
      apiKey: "gx_agent_key",
      platformMcpUrl: "https://api.connectgalactic.com/mcp/platform",
    });

    expect(prompt).toContain("new persistent Galactic Agent");
    expect(prompt).toContain("Agent's name");
    expect(prompt).toContain("reserved ID");
    expect(prompt).toContain("gx.stage");
    expect(prompt).toContain("gx.test");
    expect(prompt).toContain("gx.upload");
    expect(prompt).toContain("bundle_id: staged.bundle_id");
    expect(prompt).toContain("Authorization: Bearer gx_agent_key");
    expect(prompt).toContain("Nothing is deployed by this handoff");
    expect(prompt).not.toContain('gx.discover({ scope: "library" })');
  });
});
