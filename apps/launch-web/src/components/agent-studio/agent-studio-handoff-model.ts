export type AgentStudioHandoffIntent =
  | "agent"
  | "interface"
  | "function"
  | "routine"
  | "connect"
  | "signed-out";

export type AuthenticatedAgentStudioHandoffIntent = Exclude<
  AgentStudioHandoffIntent,
  "signed-out"
>;

export interface AgentStudioHandoffTarget {
  id: string;
  name: string;
  slug?: string | null;
  releaseVersion?: string | null;
  functionCount?: number | null;
  capabilityGroupCount?: number | null;
  routineCount?: number | null;
}

export type AgentStudioHandoffCredentialScope =
  | {
    kind: "create-agent";
    maxAgents: 1;
  }
  | {
    agentId: string;
    kind: "agent";
  }
  | {
    kind: "workspace";
  };

export interface AgentStudioHandoffCredentialIssued {
  bearerToken: string;
  expiresAt: string;
  platformMcpUrl: string;
  scope: AgentStudioHandoffCredentialScope;
  sessionId: string;
  status: "issued";
}

export interface AgentStudioHandoffCredentialUnavailable {
  message: string;
  status: "unavailable";
}

export type AgentStudioHandoffCredentialResult =
  | AgentStudioHandoffCredentialIssued
  | AgentStudioHandoffCredentialUnavailable;

export const AGENT_STUDIO_HANDOFF_TTL_SECONDS = 3_600 as const;

export interface AgentStudioHandoffCredentialRequest {
  description: string;
  intent: AuthenticatedAgentStudioHandoffIntent;
  requestedTtlSeconds: typeof AGENT_STUDIO_HANDOFF_TTL_SECONDS;
  targetAgentId: string | null;
}

export type CreateAgentStudioHandoffCredential = (
  request: AgentStudioHandoffCredentialRequest,
) => Promise<AgentStudioHandoffCredentialResult>;

export interface AgentStudioHandoffCopy {
  backLabel: string;
  backResultLabel: string;
  cardTitle: string;
  fieldLabel: string;
  headline: string;
  hint: string;
  optional: boolean;
  placeholder: string;
  subhead: string;
  tabLabel: string;
  thirdBeatTitle: string;
}

export const AGENT_STUDIO_HANDOFF_INTENTS: readonly AgentStudioHandoffIntent[] =
  [
    "agent",
    "interface",
    "function",
    "routine",
    "connect",
    "signed-out",
  ];

export const AGENT_STUDIO_HANDOFF_COPY: Readonly<
  Record<AgentStudioHandoffIntent, AgentStudioHandoffCopy>
> = {
  agent: {
    backLabel: "Back to your fleet",
    backResultLabel: "a new Agent",
    cardTitle: "New Agent",
    fieldLabel: "Required · what should this Agent do?",
    headline: "Build a new Agent",
    hint:
      "The key can submit one Agent candidate and is issued only when you copy.",
    optional: false,
    placeholder:
      "Answer reservation email for a small seaside hotel, and hold anything it cannot answer honestly.",
    subhead:
      "Galactic runs Agents but never writes them. Tell your coding agent what this one should own, and it will build a tested candidate for your review. Membership then unlocks your manual Deploy step.",
    tabLabel: "New Agent",
    thirdBeatTitle: "The tested Agent candidate waits in Galactic",
  },
  interface: {
    backLabel: "Back to Interfaces",
    backResultLabel: "a new release",
    cardTitle: "New interface",
    fieldLabel: "Required · what should this screen do?",
    headline: "Add an interface",
    hint: "A key scoped to this exact Agent is issued only when you copy.",
    optional: false,
    placeholder:
      "A queue of drafts I can approve on my phone, oldest first, with the guest’s message beside each one.",
    subhead:
      "Galactic runs this Agent but never rewrites it. Say what the screen should do, and the coding agent that built it will add one.",
    tabLabel: "New interface",
    thirdBeatTitle: "The interface candidate waits in Galactic",
  },
  function: {
    backLabel: "Back to Capabilities",
    backResultLabel: "a new release",
    cardTitle: "New function",
    fieldLabel: "Required · what should it be able to do?",
    headline: "Write a new capability",
    hint:
      "Ask for the narrowest proposed consequence group. Galactic does not enforce that policy yet.",
    optional: false,
    placeholder:
      "Look up whether a room is actually free in the PMS before it quotes a rate.",
    subhead:
      "Functions are the actions this Agent is able to take. Each one is written in code, so this change is a release. The coding agent will propose a consequence group for review without claiming Galactic enforces it yet.",
    tabLabel: "New function",
    thirdBeatTitle: "The capability candidate waits in Galactic",
  },
  routine: {
    backLabel: "Back to Routines",
    backResultLabel: "a new release",
    cardTitle: "New routine",
    fieldLabel: "Required · when should it wake, and what should it do?",
    headline: "Start a routine",
    hint: "A key scoped to this exact Agent is issued only when you copy.",
    optional: false,
    placeholder:
      "Check the inbox every 15 minutes between 7am and 9pm, and never send anything on a Sunday.",
    subhead:
      "Schedules live in the code too. Describe the rhythm you want—including when it should stay asleep—and the coding agent will set it.",
    tabLabel: "New routine",
    thirdBeatTitle: "The routine candidate waits in Galactic",
  },
  connect: {
    backLabel: "Back",
    backResultLabel: "a temporary coding session",
    cardTitle: "Connect to Galactic",
    fieldLabel: "Optional · anything you want it to do first?",
    headline: "Connect your coding agent to Galactic",
    hint:
      "A workspace key is issued only when you copy and expires in 60 minutes.",
    optional: true,
    placeholder:
      "Show me the Galactic build workflow and which safe tools this connection exposes.",
    subhead:
      "Each prompt opens a 60-minute inspection-only session for learning Galactic's build workflow. A purpose-bound Agent handoff is required to stage or submit source; a durable once-per-machine connection is not available yet.",
    tabLabel: "Connect AI",
    thirdBeatTitle: "Open a purpose-bound handoff when you are ready",
  },
  "signed-out": {
    backLabel: "Back",
    backResultLabel: "a new release",
    cardTitle: "Not signed in",
    fieldLabel: "Optional · start describing it now, we will keep it",
    headline: "Connect your coding agent to Galactic",
    hint:
      "Nothing is copied until you sign in. The key is issued to your account, not to this page.",
    optional: true,
    placeholder:
      "Add a page to email-ops where the front desk can see what is waiting.",
    subhead:
      "The prompt carries a purpose-bound key, so Galactic will only write it once it knows who you are. Start describing what you want—it will still be here after you sign in.",
    tabLabel: "Connect AI · signed out",
    thirdBeatTitle: "Review the tested candidate",
  },
};

const AGENT_TARGETED_INTENTS = new Set<AgentStudioHandoffIntent>([
  "interface",
  "function",
  "routine",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDOFF_BEARER_TOKEN_PATTERN = /^gx_[0-9a-f]{32}$/;

const HANDOFF_CREDENTIAL_MAX_CLOCK_SKEW_MS = 30_000;
const HANDOFF_CREDENTIAL_RENEWAL_FLOOR_MS = 2 * 60_000;

export function isAgentStudioHandoffTargeted(
  intent: AgentStudioHandoffIntent,
): boolean {
  return AGENT_TARGETED_INTENTS.has(intent);
}

export function isAgentStudioHandoffUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

export function isAgentStudioHandoffBearerToken(value: string): boolean {
  return HANDOFF_BEARER_TOKEN_PATTERN.test(value);
}

export function isAgentStudioHandoffPlatformMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopbackHost = url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    const hostedPlatform =
      url.hostname === "api.connectgalactic.com" ||
      url.hostname === "ultralight-api-staging.rgn4jz429m.workers.dev";
    return (url.protocol === "https:" ||
      (url.protocol === "http:" && loopbackHost)) &&
      (hostedPlatform || loopbackHost) &&
      url.pathname === "/mcp/platform" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {
    return false;
  }
}

export function agentStudioHandoffMcpServerName(sessionId: string): string {
  const normalized = sessionId.trim().toLowerCase();
  if (!isAgentStudioHandoffUuid(normalized)) {
    throw new Error(
      "Galactic returned an invalid handoff session ID. No prompt was copied.",
    );
  }
  return `galactic-handoff-${normalized}`;
}

export function handoffCredentialNeedsRenewal(
  credential: Pick<AgentStudioHandoffCredentialIssued, "expiresAt">,
  now = Date.now(),
): boolean {
  const expiresAt = Date.parse(credential.expiresAt);
  return !Number.isFinite(expiresAt) ||
    expiresAt - now <= HANDOFF_CREDENTIAL_RENEWAL_FLOOR_MS;
}

export function descriptionIsReady(
  intent: AgentStudioHandoffIntent,
  description: string,
): boolean {
  return AGENT_STUDIO_HANDOFF_COPY[intent].optional ||
    description.trim().length > 0;
}

export function credentialRequestFor(
  intent: AuthenticatedAgentStudioHandoffIntent,
  target: AgentStudioHandoffTarget | null,
  description = "",
): AgentStudioHandoffCredentialRequest {
  if (isAgentStudioHandoffTargeted(intent)) {
    if (!target || !isAgentStudioHandoffUuid(target.id)) {
      throw new Error(
        "This change needs the exact Agent UUID before Galactic can issue a scoped key.",
      );
    }
    return {
      description: description.trim(),
      intent,
      requestedTtlSeconds: AGENT_STUDIO_HANDOFF_TTL_SECONDS,
      targetAgentId: target.id,
    };
  }

  return {
    description: description.trim(),
    intent,
    requestedTtlSeconds: AGENT_STUDIO_HANDOFF_TTL_SECONDS,
    targetAgentId: null,
  };
}

export function validateHandoffCredential(
  credential: AgentStudioHandoffCredentialIssued,
  request: AgentStudioHandoffCredentialRequest,
  now = Date.now(),
): void {
  if (!isAgentStudioHandoffBearerToken(credential.bearerToken)) {
    throw new Error("Galactic returned a malformed handoff credential.");
  }
  agentStudioHandoffMcpServerName(credential.sessionId);
  if (!isAgentStudioHandoffPlatformMcpUrl(credential.platformMcpUrl)) {
    throw new Error(
      "Galactic returned an invalid platform MCP endpoint. No prompt was copied.",
    );
  }

  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("Galactic returned an expired handoff credential.");
  }
  if (handoffCredentialNeedsRenewal(credential, now)) {
    throw new Error(
      "Galactic returned a handoff credential too close to expiry. Request a fresh prompt.",
    );
  }
  if (
    expiresAt - now >
      AGENT_STUDIO_HANDOFF_TTL_SECONDS * 1_000 +
        HANDOFF_CREDENTIAL_MAX_CLOCK_SKEW_MS
  ) {
    throw new Error(
      "Galactic returned a long-lived credential. For safety, no prompt was copied.",
    );
  }

  const { scope } = credential;
  switch (request.intent) {
    case "agent":
      if (scope.kind !== "create-agent" || scope.maxAgents !== 1) {
        throw new Error(
          "Galactic returned a credential that cannot be limited to one new Agent.",
        );
      }
      break;
    case "interface":
    case "function":
    case "routine":
      if (
        scope.kind !== "agent" ||
        scope.agentId !== request.targetAgentId
      ) {
        throw new Error(
          "Galactic returned a credential for a different Agent. No prompt was copied.",
        );
      }
      break;
    case "connect":
      if (scope.kind !== "workspace") {
        throw new Error(
          "Galactic returned the wrong credential scope for this connection.",
        );
      }
      break;
  }
}

function mcpConnectionInstructions(
  platformMcpUrl: string,
  bearerToken: string,
  serverName: string,
): string {
  const portableConfig = JSON.stringify({
    mcpServers: {
      [serverName]: {
        headers: { Authorization: `Bearer ${bearerToken}` },
        type: "http",
        url: platformMcpUrl,
      },
    },
  });
  return [
    "Choose the instructions for your MCP client:",
    "Claude Code command (run this in a shell):",
    `claude mcp add --transport http --scope user ${serverName} \\`,
    `  "${platformMcpUrl}" \\`,
    `  --header "Authorization: Bearer ${bearerToken}"`,
    "",
    "Portable HTTP MCP client configuration (add this JSON to the client's MCP settings; do not run it as a shell command):",
    portableConfig,
  ].join("\n");
}

function extensionInstruction(intent: "interface" | "function" | "routine") {
  switch (intent) {
    case "interface":
      return [
        "Ask who uses the screen, what information it should surface, and what actions it should support.",
        "Use existing functions where possible. If one is missing, explain and make the smallest coherent addition.",
      ];
    case "function":
      return [
        "Ask about inputs, outputs, side effects, and when the Agent should call it.",
        'Propose and report the narrowest consequence group that fits: read ("looks"), internal_write ("changes inside Galactic"), external_side_effect ("sends outside"), or spend.',
        "Do not claim that group or an autonomous ask-first policy is enforced until Galactic exposes the release declaration and runtime policy contract. Do not widen any existing authority.",
      ];
    case "routine":
      return [
        "Ask what it may call, how success should be reported, and what it must never do alone.",
        "Use only functions already declared. Do not widen any capability group, and leave the routine paused.",
      ];
  }
}

interface AgentStudioHandoffPromptContent {
  bearerToken: string;
  description: string;
  expiresAt: string | null;
  intent: AuthenticatedAgentStudioHandoffIntent;
  platformMcpUrl: string;
  target: AgentStudioHandoffTarget | null;
}

export function buildAgentStudioHandoffPrompt(
  options: Omit<AgentStudioHandoffPromptContent, "expiresAt"> & {
    expiresAt: string;
    sessionId: string;
  },
): string {
  if (!isAgentStudioHandoffBearerToken(options.bearerToken)) {
    throw new Error("Galactic returned a malformed handoff credential.");
  }
  if (!isAgentStudioHandoffPlatformMcpUrl(options.platformMcpUrl)) {
    throw new Error(
      "Galactic returned an invalid platform MCP endpoint. No prompt was copied.",
    );
  }
  if (!Number.isFinite(Date.parse(options.expiresAt))) {
    throw new Error("Galactic returned an invalid handoff expiry.");
  }
  const { sessionId, ...content } = options;
  return buildAgentStudioHandoffPromptContent(
    content,
    agentStudioHandoffMcpServerName(sessionId),
  );
}

function buildAgentStudioHandoffPromptContent(
  options: AgentStudioHandoffPromptContent,
  serverName: string,
): string {
  const {
    bearerToken,
    description,
    expiresAt,
    intent,
    platformMcpUrl,
    target,
  } = options;
  const request = credentialRequestFor(intent, target, description);
  const desired = description.trim() ||
    (intent === "connect"
      ? "nothing in particular—just connect"
      : "your description goes here");
  const connect = [
    "Connect to Galactic first:",
    mcpConnectionInstructions(platformMcpUrl, bearerToken, serverName),
  ].join("\n");
  const secretRule =
    "Treat the bearer token in this prompt as a secret. Never echo it back, log it, or commit it.";
  const expiryRule = `The bearer token expires ${
    expiresAt ? `at ${expiresAt}` : "60 minutes after issuance"
  }. An MCP server entry saved by the client does not expire automatically, but it cannot authenticate after the token expires. Replace or remove that entry; never treat it as a standing machine credential.`;

  if (intent === "agent") {
    return [
      "Create a new Galactic Agent for me.",
      "Do not modify any Agent that already exists.",
      "",
      "What I want it to do:",
      desired,
      "",
      connect,
      "",
      "Ask what it may reach, what it must bring to me, and what it must never do alone.",
      'Call gx.discover({ scope: "tools" }) to confirm the bounded build tools available to this handoff. Do not attempt to enumerate my account or existing Agents.',
      "Declare every function in the smallest consequence group that works.",
      "",
      "When I approve the plan, stage the complete source with gx.stage({ files }), test that immutable source with gx.test({ bundle_id }), then submit the exact tested bundle as a candidate with gx.upload({ bundle_id, test_attestation }).",
      "Submit release 1.0.0 for owner review. Nothing is deployed by this handoff; stop before payment, manual Deploy, setup, activation, visibility changes, or expanded authority.",
      "",
      expiryRule,
      secretRule,
    ].join("\n");
  }

  if (intent === "connect") {
    return [
      "Open a temporary, inspection-only Galactic machine connection.",
      "",
      connect,
      "",
      'Call gx.discover({ scope: "tools" }), summarize the bounded scaffold and lint workflow available through this connection, and wait for me.',
      "",
      "If I asked for something specific:",
      desired,
      "",
      "Do not enumerate account data or Agents. Do not stage, test, submit, deploy, publish, run, or mutate anything.",
      "If I ask to build or change an Agent, tell me to open the corresponding purpose-bound Agent handoff.",
      expiryRule,
      "Ask me for a new handoff prompt if the token expires.",
      "",
      secretRule,
    ].join("\n");
  }

  if (!target || request.targetAgentId !== target.id) {
    throw new Error("The exact Agent UUID is required.");
  }

  const requestLabel = intent === "interface"
    ? "What I want the screen to do:"
    : intent === "function"
    ? "What I want it to be able to do:"
    : "When it should wake, and what it should do:";
  return [
    `Add a new ${intent} to my Galactic Agent "${target.name}"—`,
    "this exact Agent; do not create a new one.",
    "",
    `  id: ${target.id}`,
    "",
    requestLabel,
    desired,
    "",
    connect,
    "",
    ...extensionInstruction(intent),
    "",
    `Resolve this exact UUID, then call gx.project({ app_id: "${target.id}", view: "coding_capsule" }). Download only the source needed for this change.`,
    `Stage the resolved source with gx.stage({ files }), test that immutable bundle with gx.test({ bundle_id }), then submit the exact tested bundle as a candidate for this same Agent with gx.upload({ app_id: "${target.id}", bundle_id, test_attestation }).`,
    "If the source changes after testing, stage and test a new bundle. Nothing is deployed by this handoff; stop for owner review, payment, manual Deploy, setup, activation, visibility changes, or expanded authority.",
    "",
    expiryRule,
    secretRule,
  ].join("\n");
}

export function buildSignedOutHandoffPreview(
  description: string,
  platformMcpUrl = "https://api.connectgalactic.com/mcp/platform",
  continuationIntent: AuthenticatedAgentStudioHandoffIntent = "interface",
): string {
  const request = continuationIntent === "agent"
    ? "Create a new Galactic Agent for me"
    : continuationIntent === "interface"
    ? "Add a new interface to my Galactic Agent"
    : continuationIntent === "function"
    ? "Add a new function to my Galactic Agent"
    : continuationIntent === "routine"
    ? "Add a new routine to my Galactic Agent"
    : "Open a temporary Galactic coding-agent handoff";
  const targetLines = continuationIntent === "connect"
    ? []
    : continuationIntent === "agent"
    ? ["", "  new Agent id: assigned only after a safe create handoff exists"]
    : ["", "  exact existing Agent id: ————————————————————————"];
  const closing = continuationIntent === "connect"
    ? [
      "Inspect the builder tools, scaffold, and lint guidance this temporary connection exposes, then wait for me.",
      "Do not enumerate Agents or account data, and do not stage, test, submit, deploy, or change anything.",
    ]
    : continuationIntent === "agent"
    ? [
      "Ask me what it may reach and what it must never do alone.",
      "Do not modify any existing Agent.",
    ]
    : [
      "Ask me anything else you need before writing code.",
      "Inspect the exact Agent, propose the smallest coherent change,",
      "and upload a tested release candidate only when I approve.",
    ];
  return [
    "# This prompt is not ready yet.",
    "# Sign in and Galactic will fill in the scoped connection details.",
    "",
    `${request} ——————`,
    ...targetLines,
    "",
    "What I want:",
    description.trim() || "your description can start here",
    "",
    "Connect to Galactic first:",
    mcpConnectionInstructions(
      platformMcpUrl,
      "————————",
      "galactic-handoff-session",
    ),
    "",
    ...closing,
  ].join("\n");
}

export function buildRedactedHandoffPreview(options: {
  description: string;
  intent: AuthenticatedAgentStudioHandoffIntent;
  platformMcpUrl: string;
  target: AgentStudioHandoffTarget | null;
}): string {
  return buildAgentStudioHandoffPromptContent({
    ...options,
    bearerToken: "[issued securely when you copy]",
    expiresAt: null,
  }, "galactic-handoff-session");
}
