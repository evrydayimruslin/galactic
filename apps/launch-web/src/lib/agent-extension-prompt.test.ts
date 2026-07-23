import { describe, expect, it } from "vitest";

import {
  buildAgentExtensionPrompt,
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
      expect(prompt).toContain("Slug: email-ops");
      expect(prompt).toContain("ID: app-email-ops");
      expect(prompt).toContain("Authorization: Bearer gx_secret_key");
      expect(prompt).toContain("ask me to describe");
      expect(prompt).toContain("do not create a new Agent");
      expect(prompt).toContain('gx.discover({ scope: "inspect", app_id: "app-email-ops" })');
      expect(prompt).toContain('gx.download({ app_id: "app-email-ops" })');
      expect(prompt).toContain('gx.upload({ app_id: "app-email-ops"');
      expect(prompt).toContain("test_attestation");
      expect(prompt).toContain("staged candidate");
      expect(prompt).not.toContain("$GALACTIC_API_KEY");
    },
  );
});
