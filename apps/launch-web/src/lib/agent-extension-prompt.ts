export type AgentExtensionKind = "interface" | "routine" | "function";

export interface AgentExtensionPromptTarget {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

const clarification: Record<AgentExtensionKind, string> = {
  interface:
    "Ask what information the screen should surface, what actions it should support, who will use it, and what the ideal workflow should feel like.",
  routine:
    "Ask what outcome it should produce, what event or schedule should trigger it, how success should be reported, and what permissions or budget boundaries it needs.",
  function:
    "Ask what it should do, its inputs and outputs, whether it has side effects, and when the Agent should call it.",
};

const implementationGoal: Record<AgentExtensionKind, string> = {
  interface:
    "Build the interface against this Agent's existing functions where possible. If a missing function is required, explain and implement the smallest necessary addition before wiring the interface to it.",
  routine:
    "Add the routine to this Agent with the requested trigger and bounded authority. Test one representative wake, but leave activation and any new capability approval to me.",
  function:
    "Add a typed, narrowly scoped function to this Agent, document its behavior and side effects, and test both a representative success and a safe failure.",
};

export function buildAgentExtensionPrompt(options: {
  agent: AgentExtensionPromptTarget;
  apiKey: string;
  kind: AgentExtensionKind;
  platformMcpUrl: string;
}): string {
  const { agent, apiKey, kind, platformMcpUrl } = options;
  const mcpConfig = {
    mcpServers: {
      galactic: {
        url: platformMcpUrl,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    },
  };

  return [
    `I want to add a new ${kind} to my existing Galactic Agent "${agent.name}".`,
    "",
    "Target Agent — update this exact Agent; do not create a new Agent:",
    `- Name: ${agent.name}`,
    `- Slug: ${agent.slug}`,
    `- ID: ${agent.id}`,
    ...(agent.description ? [`- Current mission: ${agent.description}`] : []),
    "",
    "First, reuse an existing Galactic platform MCP connection if one is already configured. Otherwise connect it with the provisioned builder key below:",
    `- Claude Code: claude mcp add --transport http --scope user galactic ${platformMcpUrl} --header "Authorization: Bearer ${apiKey}"`,
    `- Any MCP config file: ${JSON.stringify(mcpConfig)}`,
    "",
    `Before changing anything, ask me to describe the ${kind} I want. ${clarification[kind]}`,
    "",
    `Resolve and inspect only this target UUID with gx.discover({ scope: "inspect", app_id: "${agent.id}" }), then download its current source with gx.download({ app_id: "${agent.id}" }). Do not select an Agent by name or slug when a UUID is accepted.`,
    "Inspect its current manifest, source, functions, and related configuration before proposing the smallest coherent change. Preserve its existing behavior unless my request requires otherwise.",
    implementationGoal[kind],
    "",
    `Implement the change, run gx.test against the exact changed file set, then upload it as a staged candidate for this same Agent with gx.upload({ app_id: "${agent.id}", files: <exact tested files>, test_attestation: <gx.test attestation> }). Never omit app_id; omitting it creates a new Agent.`,
    "Summarize what changed, the tests you ran, and any permissions, variables, or grants it needs. Stop for my explicit review before promotion, activation, visibility changes, or expanded authority.",
    "",
    "Treat the API key in this prompt as a secret: never echo it back, log it, or commit it anywhere.",
  ].join("\n");
}
