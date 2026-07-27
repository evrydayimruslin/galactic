export type AgentExtensionKind = "interface" | "routine" | "function";

export interface AgentExtensionPromptTarget {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

function platformMcpConfiguration(
  apiKey: string,
  platformMcpUrl: string,
): {
  claudeCode: string;
  config: string;
} {
  const config = {
    mcpServers: {
      galactic: {
        url: platformMcpUrl,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    },
  };
  return {
    claudeCode:
      `claude mcp add --transport http --scope user galactic ${platformMcpUrl} --header "Authorization: Bearer ${apiKey}"`,
    config: JSON.stringify(config),
  };
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
  const mcp = platformMcpConfiguration(apiKey, platformMcpUrl);

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
    `- Claude Code: ${mcp.claudeCode}`,
    `- Any MCP config file: ${mcp.config}`,
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

export function buildConnectAiPrompt(options: {
  apiKey: string;
  platformMcpUrl: string;
}): string {
  const { apiKey, platformMcpUrl } = options;
  const mcp = platformMcpConfiguration(apiKey, platformMcpUrl);

  return [
    "Connect this coding agent to my Galactic workspace.",
    "",
    "Reuse an existing Galactic platform MCP connection if one is already configured. Otherwise connect it with the provisioned builder key below:",
    `- Claude Code: ${mcp.claudeCode}`,
    `- Any MCP config file: ${mcp.config}`,
    "",
    'After connecting, call gx.discover({ scope: "library" }) to confirm access and summarize the Agents available in my workspace by name and mission.',
    "Do not create, edit, upload, promote, activate, or expand the authority of an Agent yet. Stop after confirming the connection and ask what I want to work on.",
    "",
    "Treat the API key in this prompt as a secret: never echo it back, log it, or commit it anywhere.",
  ].join("\n");
}

export function buildNewAgentPrompt(options: {
  apiKey: string;
  platformMcpUrl: string;
}): string {
  const { apiKey, platformMcpUrl } = options;
  const mcp = platformMcpConfiguration(apiKey, platformMcpUrl);

  return [
    "I want to build a new persistent Galactic Agent with you.",
    "",
    "Reuse an existing Galactic platform MCP connection if one is already configured. Otherwise connect it with the provisioned builder key below:",
    `- Claude Code: ${mcp.claudeCode}`,
    `- Any MCP config file: ${mcp.config}`,
    "",
    "Before changing anything, ask me for the Agent's name, recurring responsibility, success criteria, reporting expectations, and permission or budget boundaries.",
    'Then inspect my existing private Agent library with gx.discover({ scope: "library" }) so we do not duplicate an Agent I already have.',
    "",
    "Once I confirm the plan, scaffold the smallest coherent private Agent, implement it, run gx.test against the exact file set, and stage it with gx.upload using the returned test attestation.",
    "Summarize the new Agent's name, generated ID, mission, functions, routine proposal, tests, and required capabilities. Stop for my explicit review before promotion, activation, visibility changes, or expanded authority.",
    "",
    "Treat the API key in this prompt as a secret: never echo it back, log it, or commit it anywhere.",
  ].join("\n");
}
