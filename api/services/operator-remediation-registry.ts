import type {
  LaunchOperatorRemediation,
  LaunchOperatorRemediationAuthority,
  LaunchOperatorRemediationKey,
  LaunchOperatorRemediationPresentation,
  LaunchOperatorRemediationSideEffect,
  LaunchOperatorSemanticTarget,
} from "../../shared/contracts/launch.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const MAX_LABEL_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 500;

interface OperatorRemediationRegistryEntry {
  presentation: LaunchOperatorRemediationPresentation;
  requiredAuthority: LaunchOperatorRemediationAuthority;
  sideEffect: LaunchOperatorRemediationSideEffect;
  targetKind: LaunchOperatorSemanticTarget["kind"];
}

/**
 * The server-owned remediation registry.
 *
 * A client may choose how to present these intents, but neither a client nor a
 * developer payload may widen their authority, side effects, or target kind.
 */
export const OPERATOR_REMEDIATION_REGISTRY = {
  adjust_capacity: {
    presentation: "inline",
    requiredAuthority: "account_session",
    sideEffect: "configuration_write",
    targetKind: "routine",
  },
  approve_capability: {
    presentation: "inline",
    requiredAuthority: "account_session",
    sideEffect: "bounded_approval",
    targetKind: "agent_access_item",
  },
  approve_grant: {
    presentation: "inline",
    requiredAuthority: "account_session",
    sideEffect: "bounded_approval",
    targetKind: "agent_access_item",
  },
  configure_provider: {
    presentation: "inline",
    requiredAuthority: "account_session",
    sideEffect: "configuration_write",
    targetKind: "account_provider",
  },
  configure_routine: {
    presentation: "inline",
    requiredAuthority: "account_session",
    sideEffect: "configuration_write",
    targetKind: "agent_setup_requirement",
  },
  configure_secret: {
    presentation: "inline",
    requiredAuthority: "account_session",
    sideEffect: "configuration_write",
    targetKind: "agent_setting",
  },
  configure_setting: {
    presentation: "inline",
    requiredAuthority: "account_session",
    sideEffect: "configuration_write",
    targetKind: "agent_setting",
  },
  enable_routine: {
    presentation: "execute",
    requiredAuthority: "agent_operate",
    sideEffect: "schedule_change",
    targetKind: "routine",
  },
  inspect_run: {
    presentation: "navigate",
    requiredAuthority: "agent_operate",
    sideEffect: "none",
    targetKind: "routine_run",
  },
  open_logs: {
    presentation: "navigate",
    requiredAuthority: "agent_operate",
    sideEffect: "none",
    targetKind: "routine_logs",
  },
  open_routine: {
    presentation: "navigate",
    requiredAuthority: "agent_operate",
    sideEffect: "none",
    targetKind: "routine",
  },
  review_access: {
    presentation: "navigate",
    requiredAuthority: "account_session",
    sideEffect: "none",
    targetKind: "agent_access_item",
  },
  review_release: {
    presentation: "navigate",
    requiredAuthority: "account_session",
    sideEffect: "none",
    targetKind: "agent_release",
  },
  resume_routine: {
    presentation: "execute",
    requiredAuthority: "agent_operate",
    sideEffect: "schedule_change",
    targetKind: "routine",
  },
  run_once: {
    presentation: "execute",
    requiredAuthority: "agent_operate",
    sideEffect: "routine_execution",
    targetKind: "routine",
  },
  verify_connection: {
    presentation: "execute",
    requiredAuthority: "agent_operate",
    sideEffect: "none",
    targetKind: "routine",
  },
} as const satisfies Record<
  LaunchOperatorRemediationKey,
  OperatorRemediationRegistryEntry
>;

export class OperatorRemediationRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorRemediationRegistryError";
  }
}

function invalid(message: string): never {
  throw new OperatorRemediationRegistryError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    invalid(`${label} contains unsupported fields.`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    invalid(`${label} is not a trusted identifier.`);
  }
  return value;
}

function optionalIdentifier(value: unknown, label: string): string | null {
  if (value === null) return null;
  return identifier(value, label);
}

function boundedText(
  value: unknown,
  label: string,
  maxLength: number,
  nullable = false,
): string | null {
  const hasControl = typeof value === "string" &&
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    });
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    hasControl
  ) {
    invalid(`${label} is not bounded operator-safe text.`);
  }
  return value;
}

function validateTarget(
  key: LaunchOperatorRemediationKey,
  targetValue: unknown,
): void {
  if (!isRecord(targetValue)) {
    invalid(`Remediation ${key} has an invalid target.`);
  }
  const entry = OPERATOR_REMEDIATION_REGISTRY[key];
  if (targetValue.kind !== entry.targetKind) {
    invalid(`Remediation ${key} has an unregistered target kind.`);
  }

  switch (targetValue.kind) {
    case "account_provider":
      exactKeys(targetValue, ["kind", "provider"], "account provider target");
      optionalIdentifier(targetValue.provider, "target.provider");
      return;
    case "account_usage":
      exactKeys(targetValue, ["kind"], "account usage target");
      return;
    case "agent_setup_requirement":
      exactKeys(
        targetValue,
        ["kind", "agentId", "requirementId"],
        "Agent setup target",
      );
      identifier(targetValue.agentId, "target.agentId");
      identifier(targetValue.requirementId, "target.requirementId");
      return;
    case "agent_setting":
      exactKeys(
        targetValue,
        ["kind", "agentId", "settingKey", "settingScope"],
        "Agent setting target",
      );
      identifier(targetValue.agentId, "target.agentId");
      identifier(targetValue.settingKey, "target.settingKey");
      if (
        targetValue.settingScope !== "agent" &&
        targetValue.settingScope !== "per_user"
      ) {
        invalid("target.settingScope is invalid.");
      }
      return;
    case "agent_access_item":
      exactKeys(
        targetValue,
        ["kind", "agentId", "itemId"],
        "Agent access target",
      );
      identifier(targetValue.agentId, "target.agentId");
      identifier(targetValue.itemId, "target.itemId");
      return;
    case "agent_release":
      exactKeys(
        targetValue,
        ["kind", "agentId", "releaseId"],
        "Agent release target",
      );
      identifier(targetValue.agentId, "target.agentId");
      optionalIdentifier(targetValue.releaseId, "target.releaseId");
      return;
    case "routine":
      exactKeys(
        targetValue,
        ["kind", "agentId", "routineId"],
        "routine target",
      );
      identifier(targetValue.agentId, "target.agentId");
      identifier(targetValue.routineId, "target.routineId");
      return;
    case "routine_run":
      exactKeys(
        targetValue,
        ["kind", "agentId", "routineId", "runId"],
        "routine run target",
      );
      identifier(targetValue.agentId, "target.agentId");
      identifier(targetValue.routineId, "target.routineId");
      identifier(targetValue.runId, "target.runId");
      return;
    case "routine_logs":
      exactKeys(
        targetValue,
        ["kind", "agentId", "routineId", "runId"],
        "routine logs target",
      );
      identifier(targetValue.agentId, "target.agentId");
      identifier(targetValue.routineId, "target.routineId");
      optionalIdentifier(targetValue.runId, "target.runId");
      return;
    default:
      invalid(`Remediation ${key} has an unsupported target.`);
  }
}

export function assertRegisteredOperatorRemediation(
  value: LaunchOperatorRemediation,
): void {
  if (!isRecord(value)) invalid("Remediation must be an object.");
  exactKeys(
    value,
    [
      "id",
      "key",
      "label",
      "description",
      "presentation",
      "requiredAuthority",
      "sideEffect",
      "target",
    ],
    "Remediation",
  );
  const key = value.key;
  if (
    typeof key !== "string" ||
    !(key in OPERATOR_REMEDIATION_REGISTRY)
  ) {
    invalid("Remediation key is not registered.");
  }
  const typedKey = key as LaunchOperatorRemediationKey;
  const entry = OPERATOR_REMEDIATION_REGISTRY[typedKey];
  boundedText(value.id, "remediation.id", 800);
  boundedText(value.label, "remediation.label", MAX_LABEL_LENGTH);
  boundedText(
    value.description,
    "remediation.description",
    MAX_DESCRIPTION_LENGTH,
    true,
  );
  if (
    value.presentation !== entry.presentation ||
    value.requiredAuthority !== entry.requiredAuthority ||
    value.sideEffect !== entry.sideEffect
  ) {
    invalid(`Remediation ${typedKey} attempts to widen registry policy.`);
  }
  validateTarget(typedKey, value.target);
}
