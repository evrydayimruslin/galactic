import type {
  LaunchAttentionReadSource,
  LaunchGlobalAttentionResponse,
  LaunchOperatorAttentionAgentCount,
  LaunchOperatorAttentionEntry,
  LaunchOperatorAttentionProjection,
  LaunchOperatorRemediation,
} from "../../../../shared/contracts/launch.ts";

export interface OperatorAttentionEnvelope {
  readSource?: LaunchAttentionReadSource;
  operatorItems?: LaunchOperatorAttentionProjection;
}

export type OperatorAttentionAgent = LaunchOperatorAttentionAgentCount["agent"];

export function canonicalOperatorAttention(
  value: OperatorAttentionEnvelope | null | undefined,
): LaunchOperatorAttentionProjection | null {
  return value?.readSource === "canonical" &&
      value.operatorItems?.available === true
    ? value.operatorItems
    : null;
}

export function globalAttentionOpenCount(
  value: LaunchGlobalAttentionResponse,
): number | null {
  const canonical = canonicalOperatorAttention(value);
  if (canonical) return canonical.openCount;
  return value.available ? value.openCount : null;
}

export function appendOperatorAttentionPage(
  current: LaunchOperatorAttentionProjection,
  next: LaunchOperatorAttentionProjection,
): LaunchOperatorAttentionProjection {
  const byId = new Map(
    current.items.map((entry) => [entry.item.id, entry]),
  );
  for (const entry of next.items) {
    if (!byId.has(entry.item.id)) byId.set(entry.item.id, entry);
  }
  return {
    ...next,
    items: [...byId.values()],
  };
}

export function operatorAttentionAgentMap(
  projection: LaunchOperatorAttentionProjection,
): Map<string, OperatorAttentionAgent> {
  return new Map(
    projection.agentCounts.map(({ agent }) => [agent.id, agent]),
  );
}

export function operatorAttentionEntryMatches(
  entry: LaunchOperatorAttentionEntry,
  query: string,
  agents: ReadonlyMap<string, OperatorAttentionAgent>,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const item = entry.item;
  return [
    item.diagnosis.summary,
    item.diagnosis.detail,
    item.diagnosis.code,
    item.diagnosis.causeCode,
    ...item.diagnosis.evidence.map((evidence) => evidence.label),
    ...item.remediations.flatMap((remediation) => [
      remediation.label,
      remediation.description,
    ]),
    ...item.affectedAgents.flatMap(({ agentId }) => {
      const agent = agents.get(agentId);
      return agent ? [agent.name, agent.slug] : [];
    }),
  ].filter(Boolean).join(" ").toLowerCase().includes(normalized);
}

function agentRoute(
  agent: OperatorAttentionAgent,
  pane: string,
  itemId?: string | null,
): string {
  const query = new URLSearchParams({ pane });
  if (itemId) query.set("item", itemId);
  return `/agents/${encodeURIComponent(agent.slug)}?${query.toString()}`;
}

/**
 * Translate a server-owned semantic target into this client's route model.
 * No URL, title, diagnosis text, or developer payload participates.
 */
export function operatorRemediationHref(
  remediation: LaunchOperatorRemediation,
  agents: ReadonlyMap<string, OperatorAttentionAgent>,
): string | null {
  const target = remediation.target;
  switch (target.kind) {
    case "account_provider":
      return "/account?pane=byok";
    case "agent_setting": {
      const agent = agents.get(target.agentId);
      return agent
        ? agentRoute(agent, "access", `setting:${target.settingKey}`)
        : null;
    }
    case "agent_access_item": {
      const agent = agents.get(target.agentId);
      return agent ? agentRoute(agent, "access", target.itemId) : null;
    }
    case "agent_release": {
      const agent = agents.get(target.agentId);
      return agent
        ? agentRoute(
          agent,
          "settings",
          target.releaseId ? `release:${target.releaseId}` : null,
        )
        : null;
    }
    case "routine": {
      const agent = agents.get(target.agentId);
      return agent ? agentRoute(agent, "routines", target.routineId) : null;
    }
    case "routine_run": {
      const agent = agents.get(target.agentId);
      return agent
        ? agentRoute(agent, "routines", `run:${target.runId}`)
        : null;
    }
    case "routine_logs": {
      const agent = agents.get(target.agentId);
      if (!agent) return null;
      return target.runId
        ? agentRoute(agent, "routines", `run-logs:${target.runId}`)
        : agentRoute(agent, "routines", target.routineId);
    }
    default:
      return null;
  }
}

export function resolveOperatorAttentionEntry(
  entries: readonly LaunchOperatorAttentionEntry[],
  itemId: string | null | undefined,
): LaunchOperatorAttentionEntry | null {
  const normalized = itemId?.trim();
  if (!normalized) return null;
  return entries.find(({ item }) =>
    item.id === normalized || item.conditionKey === normalized
  ) ?? null;
}
