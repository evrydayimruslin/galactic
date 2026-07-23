export interface OperatorFunctionItem {
  inputSchema?: {
    properties?: Record<string, unknown>;
  } | null;
  name: string;
}

export interface OperatorFunctionItemTarget {
  fieldName: string | null;
  functionName: string;
}

export interface OperatorAccessAuthorityItem {
  actionId: string | null;
  id: string;
}

export interface OperatorAccessSettingItem {
  key: string;
}

export interface OperatorAccessGroupItem {
  authority: readonly OperatorAccessAuthorityItem[];
  credentials: readonly OperatorAccessSettingItem[];
  id: string;
  settings: readonly OperatorAccessSettingItem[];
}

export type OperatorAccessItemTarget =
  | { id: string; kind: "group" }
  | { id: string; kind: "authority" }
  | { id: string; kind: "setting"; settingKey: string };

export interface OperatorSettingsRelease {
  candidate: { version: string } | null;
  live: { version: string } | null;
}

export type OperatorSettingsItemTarget =
  | { kind: "rate-limits" }
  | { kind: "release"; version: string }
  | { kind: "history" }
  | { kind: "identity" }
  | { kind: "connection" };

function schemaFieldNames(item: OperatorFunctionItem): string[] {
  const properties = item.inputSchema?.properties;
  return properties && typeof properties === "object" &&
      !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}

/**
 * Search indexes Function fields as granular objects while the UI opens their
 * parent Function. Resolve only published schema fields; prefix guesses never
 * open an unrelated Function.
 */
export function resolveOperatorFunctionItem(
  functions: readonly OperatorFunctionItem[],
  itemId: string | null | undefined,
): OperatorFunctionItemTarget | null {
  const normalized = itemId?.trim();
  if (!normalized) return null;
  const exact = functions.find((item) => item.name === normalized);
  if (exact) {
    return { functionName: exact.name, fieldName: null };
  }
  for (const item of [...functions].sort((left, right) =>
    right.name.length - left.name.length
  )) {
    const field = schemaFieldNames(item).find((fieldName) =>
      normalized === `${item.name}.${fieldName}` ||
      normalized === `${item.name}:${fieldName}` ||
      normalized === `${item.name}/${fieldName}`
    );
    if (field) {
      return { functionName: item.name, fieldName: field };
    }
  }
  return null;
}

/**
 * Normalizes the item conventions produced by Search and Attention into one
 * focus target. A setting is editable; groups and authorities are read-only.
 */
export function resolveOperatorAccessItem(
  groups: readonly OperatorAccessGroupItem[],
  itemId: string | null | undefined,
): OperatorAccessItemTarget | null {
  const normalized = itemId?.trim();
  if (!normalized) return null;
  const settingKey = normalized.startsWith("setting:")
    ? normalized.slice("setting:".length)
    : normalized;
  for (const group of groups) {
    if (
      [...group.credentials, ...group.settings].some((item) =>
        item.key === settingKey
      )
    ) {
      return { id: settingKey, kind: "setting", settingKey };
    }
  }
  const group = groups.find((item) => item.id === normalized);
  if (group) return { id: group.id, kind: "group" };

  const grantId = normalized.startsWith("grant:")
    ? normalized.slice("grant:".length)
    : null;
  for (const item of groups) {
    const authority = item.authority.find((entry) =>
      entry.id === normalized ||
      entry.actionId === normalized ||
      (grantId !== null &&
        (entry.id === grantId || entry.actionId === grantId))
    );
    if (authority) {
      return { id: authority.id, kind: "authority" };
    }
  }
  return null;
}

/**
 * Settings uses prefixed release targets so a version can never collide with
 * a static section id. Raw matching versions remain readable for one
 * compatibility window while persisted Search documents are reprojected.
 */
export function resolveOperatorSettingsItem(
  release: OperatorSettingsRelease | null | undefined,
  itemId: string | null | undefined,
): OperatorSettingsItemTarget | null {
  const normalized = itemId?.trim();
  if (!normalized) return null;
  if (
    normalized === "rate-limits" ||
    normalized === "history" ||
    normalized === "identity" ||
    normalized === "connection"
  ) {
    return { kind: normalized };
  }

  const version = normalized.startsWith("release:")
    ? normalized.slice("release:".length).trim()
    : normalized;
  if (!version) return null;
  const publishedVersions = new Set(
    [release?.live?.version, release?.candidate?.version].filter(
      (value): value is string => Boolean(value),
    ),
  );
  return publishedVersions.has(version)
    ? { kind: "release", version }
    : null;
}
