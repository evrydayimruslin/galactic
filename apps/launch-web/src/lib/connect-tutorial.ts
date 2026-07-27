import type {
  LaunchAgentSummary,
  LaunchApiKeyCreateRequest,
} from "../../../../shared/contracts/launch.ts";

export const CONNECT_TUTORIAL_INTENTS = [
  "connect",
  "agent",
  "interface",
  "function",
  "routine",
] as const;

export type ConnectTutorialIntent = typeof CONNECT_TUTORIAL_INTENTS[number];

export interface ConnectTutorialContext {
  agentSlug?: string;
  intent: ConnectTutorialIntent;
  source?: string;
}

const CONNECT_TUTORIAL_BUILDER_SCOPES = [
  "apps:read",
  "apps:call",
  "agents:build",
  "agents:operate",
];

export function connectTutorialApiKeyRequest(options: {
  agent?: LaunchAgentSummary | null;
  intent: ConnectTutorialIntent;
  suffix: string;
}): LaunchApiKeyCreateRequest {
  const { agent = null, intent, suffix } = options;
  const target = agent?.slug ?? "workspace";
  const targetsExistingAgent = intent === "interface" ||
    intent === "function" || intent === "routine";
  return {
    name: `Connect ${intent} ${target}`.slice(0, 40) + ` ${suffix}`,
    expiresInDays: 30,
    scopes: intent === "connect"
      ? ["apps:read"]
      : [...CONNECT_TUTORIAL_BUILDER_SCOPES],
    ...(targetsExistingAgent && agent ? { appIds: [agent.id] } : {}),
  };
}

export function connectTutorialHeroTitle(
  intent: ConnectTutorialIntent,
  agentName?: string | null,
): string {
  switch (intent) {
    case "connect":
      return "Bring your AI to Galactic.";
    case "agent":
      return "Build your next persistent Agent.";
    case "interface":
      return agentName
        ? `Give ${agentName} a purpose-built interface.`
        : "Give your Agent a purpose-built interface.";
    case "function":
      return agentName
        ? `Extend what ${agentName} can do.`
        : "Extend what your Agent can do.";
    case "routine":
      return agentName
        ? `Give ${agentName} recurring work.`
        : "Give your Agent recurring work.";
  }
}

export function connectTutorialHref({
  agentSlug,
  intent,
  source,
}: ConnectTutorialContext): string {
  const search = new URLSearchParams();
  if (intent !== "connect") search.set("intent", intent);
  if (agentSlug) search.set("agent", agentSlug);
  if (source) search.set("source", source);
  const query = search.toString();
  return query ? `/connect?${query}` : "/connect";
}

export function parseConnectTutorialContext(
  searchValue: string,
): ConnectTutorialContext {
  const search = new URLSearchParams(searchValue);
  const requested = search.get("intent");
  const intent = CONNECT_TUTORIAL_INTENTS.includes(
      requested as ConnectTutorialIntent,
    )
    ? requested as ConnectTutorialIntent
    : "connect";
  const agentSlug = search.get("agent")?.trim() || undefined;
  const source = search.get("source")?.trim() || undefined;
  return { agentSlug, intent, source };
}
