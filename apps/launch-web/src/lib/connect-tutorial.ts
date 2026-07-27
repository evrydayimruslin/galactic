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
