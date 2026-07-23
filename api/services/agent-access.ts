import type {
  LaunchAgentAccessConsumer,
  LaunchAgentAccessGroup,
  LaunchAgentAccessGroupKind,
  LaunchAgentAccessProjection,
  LaunchAgentHomeAuthorityItem,
  LaunchNetworkDisclosure,
} from "../../shared/contracts/launch.ts";
import type { AgentGrantSummary } from "../../shared/contracts/agent-grants.ts";

export interface AgentAccessConsumerBinding {
  groupId?: string;
  authorityId?: string;
  consumer: LaunchAgentAccessConsumer;
}

export interface AgentAccessInput {
  disclosure: LaunchNetworkDisclosure;
  authority: readonly LaunchAgentHomeAuthorityItem[];
  /** Owner-scoped grants used only to focus the matching read-only authority. */
  grants?: readonly AgentGrantSummary[];
  /** Explicit manifest/runtime provenance only; never source-code guesses. */
  consumers?: readonly AgentAccessConsumerBinding[];
}

function groupToken(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase());
}

function authorityKind(
  kind: LaunchAgentHomeAuthorityItem["kind"],
): LaunchAgentAccessGroupKind {
  if (kind === "agent_call") return "agent";
  if (kind === "ai") return "ai";
  if (kind === "storage") return "storage";
  if (kind === "memory") return "memory";
  if (kind === "compute") return "compute";
  if (kind === "reporting") return "reporting";
  return "internal";
}

function uniqueAuthority(
  items: readonly LaunchAgentHomeAuthorityItem[],
): LaunchAgentHomeAuthorityItem[] {
  const byId = new Map<string, LaunchAgentHomeAuthorityItem>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}

function accessAuthority(
  input: AgentAccessInput,
): LaunchAgentHomeAuthorityItem[] {
  return input.authority.map((item) => {
    if (item.kind !== "agent_call" || !item.target) return item;
    const grant = [...(input.grants || [])].sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "pending" ? -1 : 1;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    }).find((candidate) =>
      candidate.targetApp.id === item.target &&
      item.label.endsWith(`.${candidate.targetFunction}`)
    );
    return grant ? { ...item, actionId: grant.id } : item;
  });
}

function consumersFor(
  input: AgentAccessInput,
  groupId: string,
  authority: readonly LaunchAgentHomeAuthorityItem[],
): LaunchAgentAccessConsumer[] {
  const authorityIds = new Set(authority.map((item) => item.id));
  const byKey = new Map<string, LaunchAgentAccessConsumer>();
  for (const binding of input.consumers || []) {
    if (
      binding.groupId !== groupId &&
      (!binding.authorityId || !authorityIds.has(binding.authorityId))
    ) continue;
    const consumer = binding.consumer;
    byKey.set(`${consumer.kind}:${consumer.id}`, { ...consumer });
  }
  return [...byKey.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
  );
}

function configuredFromAuthority(
  authority: readonly LaunchAgentHomeAuthorityItem[],
): boolean {
  return authority.filter((item) => item.required)
    .every((item) => item.approved);
}

function effectiveFromAuthority(
  authority: readonly LaunchAgentHomeAuthorityItem[],
): boolean {
  return authority.filter((item) => item.required)
    .every((item) => item.effective);
}

export function buildAgentAccessProjection(
  input: AgentAccessInput,
): LaunchAgentAccessProjection {
  const groups: LaunchAgentAccessGroup[] = [];
  const consumedAuthorityIds = new Set<string>();
  const effectiveAuthority = accessAuthority(input);

  const destinations = [...input.disclosure.destinations].sort((left, right) =>
    left.host.localeCompare(right.host)
  );
  for (const destination of destinations) {
    const host = destination.host.trim().toLowerCase();
    const groupId = `access:external:${groupToken(host)}`;
    const authority = uniqueAuthority(
      effectiveAuthority.filter((item) =>
        item.kind === "network" &&
        item.target?.trim().toLowerCase() === host
      ),
    );
    authority.forEach((item) => consumedAuthorityIds.add(item.id));
    const credentials = destination.credentials.map((credential) => ({
      key: credential.key,
      label: credential.label,
      required: credential.required,
      configured: credential.connected === true,
    })).sort((left, right) => left.key.localeCompare(right.key));
    const configured = credentials.filter((item) => item.required)
      .every((item) => item.configured) &&
      configuredFromAuthority(authority);
    // A disclosed destination without effective network authority is visible
    // but cannot truthfully be presented as usable.
    const effective = authority.length > 0 && configured &&
      effectiveFromAuthority(authority);
    groups.push({
      id: groupId,
      kind: "external_endpoint",
      label: destination.label || host,
      description: destination.description,
      target: host,
      configured,
      effective,
      credentials,
      settings: [],
      authority,
      consumers: consumersFor(input, groupId, authority),
    });
  }

  const settingsByGroup = new Map<
    string,
    LaunchNetworkDisclosure["general_settings"]
  >();
  for (const setting of input.disclosure.general_settings) {
    const label = setting.group?.trim() || "Configuration";
    const current = settingsByGroup.get(label) || [];
    current.push(setting);
    settingsByGroup.set(label, current);
  }
  for (
    const [label, sourceSettings] of [...settingsByGroup.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )
  ) {
    const groupId = `access:configuration:${groupToken(label)}`;
    const settings = sourceSettings.map((setting) => ({
      key: setting.key,
      label: setting.label,
      required: setting.required,
      configured: setting.connected === true,
      secret: setting.secret,
    })).sort((left, right) => left.key.localeCompare(right.key));
    const configured = settings.filter((item) => item.required)
      .every((item) => item.configured);
    groups.push({
      id: groupId,
      kind: "configuration",
      label,
      description: null,
      target: null,
      configured,
      effective: configured,
      credentials: [],
      settings,
      authority: [],
      consumers: consumersFor(input, groupId, []),
    });
  }

  const remaining = effectiveAuthority.filter((item) =>
    !consumedAuthorityIds.has(item.id)
  );
  const authorityGroups = new Map<string, LaunchAgentHomeAuthorityItem[]>();
  for (const item of remaining) {
    const target = item.target || item.label;
    const key = `${authorityKind(item.kind)}:${target}`;
    const current = authorityGroups.get(key) || [];
    current.push(item);
    authorityGroups.set(key, current);
  }
  for (
    const [key, sourceAuthority] of [...authorityGroups.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )
  ) {
    const authority = uniqueAuthority(sourceAuthority);
    const representative = authority[0]!;
    const kind = authorityKind(representative.kind);
    const target = representative.target || null;
    const groupId = `access:${groupToken(key)}`;
    groups.push({
      id: groupId,
      kind,
      label: representative.label,
      description: representative.purpose,
      target,
      configured: configuredFromAuthority(authority),
      effective: effectiveFromAuthority(authority),
      credentials: [],
      settings: [],
      authority,
      consumers: consumersFor(input, groupId, authority),
    });
  }

  return {
    groups,
    configured: groups.every((group) => group.configured),
    effective: groups.every((group) => group.effective),
  };
}
