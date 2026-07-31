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
    `- ID: ${agent.id}`,
    ...(agent.description ? [`- Current mission: ${agent.description}`] : []),
    "",
    "First, reuse an existing Galactic platform MCP connection if one is already configured. Otherwise connect it with the provisioned builder key below:",
    `- Claude Code: ${mcp.claudeCode}`,
    `- Any MCP config file: ${mcp.config}`,
    "",
    `Before changing anything, ask me to describe the ${kind} I want. ${clarification[kind]}`,
    "",
    `Resolve this exact target UUID, then request its compact coding snapshot with gx.project({ app_id: "${agent.id}", view: "coding_capsule" }). Use that capsule to understand the current directive, release delta, schemas, authority, routines, and recent failures before downloading source with gx.download({ app_id: "${agent.id}" }). Do not select an Agent by name or slug when a UUID is accepted.`,
    "Inspect the downloaded manifest and only the source required for the change. Preserve existing behavior unless my request requires otherwise.",
    implementationGoal[kind],
    "",
    `Implement the change, upload the complete resolved source once with staged = gx.stage({ files: <complete source files> }), test that immutable source with tested = gx.test({ bundle_id: staged.bundle_id }), then submit a candidate for this same Agent with gx.upload({ app_id: "${agent.id}", bundle_id: staged.bundle_id, test_attestation: tested.test_attestation }). Never omit or change app_id; this handoff is bound to the exact target above.`,
    "If you revise the source after testing, create a new incremental gx.stage bundle against the prior base_bundle_id and test the new bundle. Never upload a bundle that was not the exact bundle tested.",
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
    'After connecting, call gx.discover({ scope: "tools" }) and summarize the bounded scaffold and lint workflow available through this inspection-only connection.',
    "Do not enumerate account data or Agents. Do not stage, test, submit, deploy, publish, run, or mutate anything. Stop after confirming the connection and ask what I want to work on.",
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
    'Then call gx.discover({ scope: "tools" }) to confirm the bounded build tools available to this handoff. Do not attempt to enumerate my account or existing Agents.',
    "",
    "Once I confirm the plan, scaffold the smallest coherent private Agent and implement it. Upload the complete source once with staged = gx.stage({ files: <complete source files> }), test that immutable source with tested = gx.test({ bundle_id: staged.bundle_id }), and submit the private candidate with gx.upload({ bundle_id: staged.bundle_id, test_attestation: tested.test_attestation, ... }).",
    "Summarize the new Agent's name, reserved ID, mission, functions, routine proposal, tests, and required capabilities. Nothing is deployed by this handoff; stop for my explicit review, payment, manual Deploy, and setup before activation, visibility changes, or expanded authority.",
    "",
    "Treat the API key in this prompt as a secret: never echo it back, log it, or commit it anywhere.",
  ].join("\n");
}
