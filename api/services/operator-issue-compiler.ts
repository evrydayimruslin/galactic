import type {
  LaunchAgentEvidenceReference,
  LaunchAgentHomeRequirement,
  LaunchOperatorAffectedAgent,
  LaunchOperatorConditionCode,
  LaunchOperatorDiagnosis,
  LaunchOperatorDiagnosisProvenance,
  LaunchOperatorIssue,
  LaunchOperatorItemCandidate,
  LaunchOperatorOrdering,
  LaunchOperatorRecoveryPolicy,
  LaunchOperatorRemediation,
  LaunchOperatorReport,
  LaunchOperatorScope,
} from "../../shared/contracts/launch.ts";
import { assertRegisteredOperatorRemediation } from "./operator-remediation-registry.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CAUSE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const MAX_LABEL_LENGTH = 160;
const MAX_SUMMARY_LENGTH = 240;
const MAX_DETAIL_LENGTH = 2_000;

export type OperatorIssueCompilerErrorCode =
  | "CONFLICTING_CONDITION"
  | "DEPENDENCY_CYCLE"
  | "INVALID_INPUT"
  | "UNSUPPORTED_REQUIREMENT";

export class OperatorIssueCompilerError extends Error {
  readonly code: OperatorIssueCompilerErrorCode;

  constructor(code: OperatorIssueCompilerErrorCode, message: string) {
    super(message);
    this.name = "OperatorIssueCompilerError";
    this.code = code;
  }
}

export interface OperatorIssueAgentReference {
  id: string;
  name: string;
}

interface OperatorIssueCompilerBase {
  detectedAt: string;
  /**
   * Stable order supplied by the trusted source. `compileOperatorItems`
   * defaults this to the input position.
   */
  sourceOrdinal?: number;
  dependsOnConditionKeys?: readonly string[];
}

export interface OperatorSafeDiagnostic {
  causeCode: string | null;
  summary: string | null;
  detail: string | null;
  provenance: LaunchOperatorDiagnosisProvenance;
  /** Already normalized, redacted, owner-safe evidence references. */
  evidence: readonly LaunchAgentEvidenceReference[];
}

export type OperatorIssueCompilerInput =
  | (OperatorIssueCompilerBase & {
    condition: "setup_requirement";
    agent: OperatorIssueAgentReference;
    requirement: LaunchAgentHomeRequirement;
  })
  | (OperatorIssueCompilerBase & {
    condition: "account_byok_missing";
    affectedAgents: readonly OperatorIssueAgentReference[];
  })
  | (OperatorIssueCompilerBase & {
    condition: "routine_paused_after_failures";
    agent: OperatorIssueAgentReference;
    routine: {
      id: string;
      name: string;
    };
    failedAttempts: number;
    latestRunId: string | null;
    diagnostic?: OperatorSafeDiagnostic | null;
  })
  | (OperatorIssueCompilerBase & {
    condition: "routine_usage_exhausted";
    agent: OperatorIssueAgentReference;
    routine: {
      id: string;
      name: string;
    };
    period: "daily" | "monthly";
    spent: number;
    limit: number;
    resetsAt: string;
  })
  | (OperatorIssueCompilerBase & {
    condition: "account_usage_exhausted";
    affectedAgents: readonly OperatorIssueAgentReference[];
    period: "five_hour" | "weekly";
    resetsAt: string;
  });

function invalid(message: string): never {
  throw new OperatorIssueCompilerError("INVALID_INPUT", message);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function trustedIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!IDENTIFIER.test(trimmed)) {
    invalid(`${label} is not a trusted identifier.`);
  }
  return trimmed;
}

function trustedConditionKey(value: string, label: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 600 ||
    containsControlCharacter(trimmed)
  ) {
    invalid(`${label} is not a trusted condition key.`);
  }
  return trimmed;
}

function stableSegment(value: string, label: string): string {
  return encodeURIComponent(trustedIdentifier(value, label));
}

function boundedText(
  value: string | null | undefined,
  label: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    containsControlCharacter(normalized)
  ) {
    invalid(
      `${label} must be non-empty plain text at most ${maxLength} characters.`,
    );
  }
  return normalized;
}

function label(value: string, field: string): string {
  return boundedText(value, field, MAX_LABEL_LENGTH)!;
}

function validIso(value: string, field: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    invalid(`${field} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function validOrdinal(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("sourceOrdinal must be a non-negative safe integer.");
  }
  return value;
}

function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    invalid(`${field} must be a finite non-negative number.`);
  }
  return value;
}

function ordering(
  input: OperatorIssueCompilerBase,
  fallbackOrdinal: number,
): LaunchOperatorOrdering {
  return {
    sourceOrdinal: validOrdinal(input.sourceOrdinal ?? fallbackOrdinal),
    dependsOnConditionKeys: [
      ...new Set(
        (input.dependsOnConditionKeys ?? []).map((key) =>
          trustedConditionKey(key, "dependsOnConditionKey")
        ),
      ),
    ],
  };
}

function affectedAgent(
  agent: OperatorIssueAgentReference,
  blocking: boolean,
): LaunchOperatorAffectedAgent {
  return {
    agentId: trustedIdentifier(agent.id, "agent.id"),
    blocking,
  };
}

function issue(
  input: {
    conditionKey: string;
    scope: LaunchOperatorScope;
    severity: "warning" | "critical";
    diagnosis: LaunchOperatorDiagnosis;
    affectedAgents: LaunchOperatorAffectedAgent[];
    remediations: LaunchOperatorRemediation[];
    requiresDecision: boolean;
    ordering: LaunchOperatorOrdering;
    recovery: LaunchOperatorRecoveryPolicy;
    detectedAt: string;
  },
): LaunchOperatorIssue<null> {
  if (input.remediations.length === 0) {
    invalid(`Issue ${input.conditionKey} must have at least one remediation.`);
  }
  return {
    id: null,
    itemClass: "issue",
    conditionKey: input.conditionKey,
    scope: input.scope,
    severity: input.severity,
    diagnosis: input.diagnosis,
    affectedAgents: input.affectedAgents,
    remediations: input.remediations,
    requiresAction: true,
    requiresDecision: input.requiresDecision,
    ordering: input.ordering,
    recovery: input.recovery,
    detectedAt: input.detectedAt,
  };
}

function report(
  input: {
    conditionKey: string;
    scope: LaunchOperatorScope;
    diagnosis: LaunchOperatorDiagnosis;
    affectedAgents: LaunchOperatorAffectedAgent[];
    ordering: LaunchOperatorOrdering;
    detectedAt: string;
  },
): LaunchOperatorReport<null> {
  return {
    id: null,
    itemClass: "report",
    conditionKey: input.conditionKey,
    scope: input.scope,
    severity: "info",
    diagnosis: input.diagnosis,
    affectedAgents: input.affectedAgents,
    remediations: [],
    requiresAction: false,
    requiresDecision: false,
    ordering: input.ordering,
    recovery: {
      mode: "automatic_reset",
      mayRecoverAutomatically: true,
      resumesScheduledWork: false,
    },
    detectedAt: input.detectedAt,
  };
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type OperatorRemediationDefinition = WithoutId<LaunchOperatorRemediation>;

function remediation(
  conditionKey: string,
  value: OperatorRemediationDefinition,
): LaunchOperatorRemediation {
  const compiled = {
    id: `${conditionKey}:remediation:${value.key}`,
    ...value,
  } as LaunchOperatorRemediation;
  assertRegisteredOperatorRemediation(compiled);
  return compiled;
}

function revalidateRecovery(): LaunchOperatorRecoveryPolicy {
  return {
    mode: "revalidate_condition",
    mayRecoverAutomatically: true,
    resumesScheduledWork: false,
  };
}

function setupConditionKey(agentId: string, requirementId: string): string {
  return `agent:${stableSegment(agentId, "agent.id")}:requirement:${
    stableSegment(requirementId, "requirement.id")
  }`;
}

function setupDiagnosis(
  code: LaunchOperatorConditionCode,
  summary: string,
  detail: string,
): LaunchOperatorDiagnosis {
  return {
    code,
    causeCode: null,
    summary: boundedText(summary, "diagnosis.summary", MAX_SUMMARY_LENGTH)!,
    detail: boundedText(detail, "diagnosis.detail", MAX_DETAIL_LENGTH),
    provenance: "platform",
    evidence: [],
  };
}

function compileByokIssue(
  affectedAgents: readonly OperatorIssueAgentReference[],
  detectedAt: string,
  issueOrdering: LaunchOperatorOrdering,
): LaunchOperatorIssue<null> {
  if (affectedAgents.length === 0) {
    invalid("account_byok_missing must affect at least one Agent.");
  }
  const conditionKey = "account:byok";
  return issue({
    conditionKey,
    scope: { kind: "account" },
    severity: "warning",
    diagnosis: setupDiagnosis(
      "ACCOUNT_BYOK_MISSING",
      "Configure an inference provider",
      "At least one Agent uses AI and needs an account provider API key.",
    ),
    affectedAgents: affectedAgents.map((agent) => affectedAgent(agent, true)),
    remediations: [
      remediation(conditionKey, {
        key: "configure_provider",
        label: "Configure provider",
        description:
          "Add a provider API key once, then recheck every affected Agent.",
        presentation: "inline",
        requiredAuthority: "account_session",
        sideEffect: "configuration_write",
        target: {
          kind: "account_provider",
          provider: null,
        },
      }),
    ],
    requiresDecision: false,
    ordering: issueOrdering,
    recovery: revalidateRecovery(),
    detectedAt,
  });
}

function compileSetupRequirement(
  input: Extract<
    OperatorIssueCompilerInput,
    { condition: "setup_requirement" }
  >,
  fallbackOrdinal: number,
): LaunchOperatorItemCandidate | null {
  const detectedAt = validIso(input.detectedAt, "detectedAt");
  const agentId = trustedIdentifier(input.agent.id, "agent.id");
  label(input.agent.name, "agent.name");
  const requirement = input.requirement;
  const requirementId = trustedIdentifier(requirement.id, "requirement.id");
  const issueOrdering = ordering(input, fallbackOrdinal);

  if (requirement.configured) return null;
  if (!requirement.blocking && requirement.actions.length === 0) return null;

  if (requirementId === "inference:byok") {
    return compileByokIssue([input.agent], detectedAt, issueOrdering);
  }

  const conditionKey = setupConditionKey(agentId, requirementId);
  const requirementLabel = label(requirement.label, "requirement.label");
  const affectedAgents = [affectedAgent(input.agent, requirement.blocking)];
  const setupTarget = {
    kind: "agent_setup_requirement" as const,
    agentId,
    requirementId,
  };

  if (requirement.kind === "routine") {
    return issue({
      conditionKey,
      scope: { kind: "agent", agentId },
      severity: "warning",
      diagnosis: setupDiagnosis(
        "AGENT_PRIMARY_ROUTINE_MISSING",
        "Create a primary routine",
        "This Agent needs a routine before it can run on a schedule.",
      ),
      affectedAgents,
      remediations: [
        remediation(conditionKey, {
          key: "configure_routine",
          label: "Create routine",
          description:
            "Define what this Agent should do and when it should run.",
          presentation: "inline",
          requiredAuthority: "account_session",
          sideEffect: "configuration_write",
          target: setupTarget,
        }),
      ],
      requiresDecision: false,
      ordering: issueOrdering,
      recovery: revalidateRecovery(),
      detectedAt,
    });
  }

  if (requirement.kind === "setting") {
    const settingKey = requirement.settingKey
      ? trustedIdentifier(requirement.settingKey, "requirement.settingKey")
      : invalid("A setting requirement must include settingKey.");
    const settingScope = requirement.settingScope ??
      invalid("A setting requirement must include settingScope.");
    const secret = requirement.secret;
    return issue({
      conditionKey,
      scope: { kind: "agent", agentId },
      severity: "warning",
      diagnosis: setupDiagnosis(
        secret ? "AGENT_SECRET_MISSING" : "AGENT_SETTING_MISSING",
        `Configure ${requirementLabel}`,
        `${requirementLabel} is required before this Agent can run.`,
      ),
      affectedAgents,
      remediations: [
        remediation(conditionKey, {
          key: secret ? "configure_secret" : "configure_setting",
          label: `Add ${requirementLabel}`,
          description: secret
            ? "The value is write-only and never appears in issue data."
            : `Set ${requirementLabel}, then recheck this Agent.`,
          presentation: "inline",
          requiredAuthority: "account_session",
          sideEffect: "configuration_write",
          target: {
            kind: "agent_setting",
            agentId,
            settingKey,
            settingScope,
          },
        }),
      ],
      requiresDecision: false,
      ordering: issueOrdering,
      recovery: revalidateRecovery(),
      detectedAt,
    });
  }

  if (requirementId === "reporting:galactic_inbox") {
    return issue({
      conditionKey,
      scope: { kind: "agent", agentId },
      severity: "warning",
      diagnosis: setupDiagnosis(
        "AGENT_REPORTING_NOT_CONFIGURED",
        "Add Galactic inbox reporting",
        "The live release must allow this Agent to report milestones and anomalies.",
      ),
      affectedAgents,
      remediations: [
        remediation(conditionKey, {
          key: "review_release",
          label: "Review release configuration",
          description: "Review the live release capability configuration.",
          presentation: "navigate",
          requiredAuthority: "account_session",
          sideEffect: "none",
          target: {
            kind: "agent_release",
            agentId,
            releaseId: null,
          },
        }),
      ],
      requiresDecision: false,
      ordering: issueOrdering,
      recovery: revalidateRecovery(),
      detectedAt,
    });
  }

  if (requirement.kind === "capability") {
    const actionId = requirement.actionId
      ? trustedIdentifier(requirement.actionId, "requirement.actionId")
      : null;
    const canApprove = actionId !== null &&
      requirement.actions.includes("approve");
    return issue({
      conditionKey,
      scope: { kind: "agent", agentId },
      severity: "warning",
      diagnosis: setupDiagnosis(
        "AGENT_CAPABILITY_APPROVAL_REQUIRED",
        `Approve ${requirementLabel}`,
        "This Agent is waiting for an owner-approved capability.",
      ),
      affectedAgents,
      remediations: [
        remediation(conditionKey, {
          key: canApprove ? "approve_capability" : "review_access",
          label: canApprove ? `Approve ${requirementLabel}` : "Review access",
          description: canApprove
            ? "Approve only the bounded capability shown in Agent Access."
            : "Review the missing or invalid capability in Agent Access.",
          presentation: canApprove ? "inline" : "navigate",
          requiredAuthority: "account_session",
          sideEffect: canApprove ? "bounded_approval" : "none",
          target: {
            kind: "agent_access_item",
            agentId,
            itemId: canApprove ? `capability:${actionId}` : requirementId,
          },
        }),
      ],
      requiresDecision: canApprove,
      ordering: issueOrdering,
      recovery: revalidateRecovery(),
      detectedAt,
    });
  }

  if (requirement.kind === "grant") {
    const actionId = requirement.actionId
      ? trustedIdentifier(requirement.actionId, "requirement.actionId")
      : null;
    const canApprove = actionId !== null &&
      requirement.actions.includes("approve");
    return issue({
      conditionKey,
      scope: { kind: "agent", agentId },
      severity: "warning",
      diagnosis: setupDiagnosis(
        "AGENT_GRANT_REQUIRED",
        canApprove
          ? `Approve ${requirementLabel}`
          : `Review ${requirementLabel}`,
        "This Agent is waiting for valid, bounded downstream access.",
      ),
      affectedAgents,
      remediations: [
        remediation(conditionKey, {
          key: canApprove ? "approve_grant" : "review_access",
          label: canApprove ? `Approve ${requirementLabel}` : "Review access",
          description: canApprove
            ? "Approve only the bounded grant shown in Agent Access."
            : "Review the invalid target or missing grant in Agent Access.",
          presentation: canApprove ? "inline" : "navigate",
          requiredAuthority: "account_session",
          sideEffect: canApprove ? "bounded_approval" : "none",
          target: {
            kind: "agent_access_item",
            agentId,
            itemId: canApprove ? `grant:${actionId}` : requirementId,
          },
        }),
      ],
      requiresDecision: canApprove,
      ordering: issueOrdering,
      recovery: revalidateRecovery(),
      detectedAt,
    });
  }

  if (requirement.kind === "release") {
    const releaseId = requirement.actionId
      ? trustedIdentifier(requirement.actionId, "requirement.actionId")
      : null;
    return issue({
      conditionKey,
      scope: { kind: "agent", agentId },
      severity: "warning",
      diagnosis: setupDiagnosis(
        "AGENT_RELEASE_REVIEW_REQUIRED",
        `Review ${requirementLabel}`,
        "This release requests authority that requires owner review.",
      ),
      affectedAgents,
      remediations: [
        remediation(conditionKey, {
          key: "review_release",
          label: "Review release",
          description: "Review the exact authority changes before promotion.",
          presentation: "navigate",
          requiredAuthority: "account_session",
          sideEffect: "none",
          target: {
            kind: "agent_release",
            agentId,
            releaseId,
          },
        }),
      ],
      requiresDecision: true,
      ordering: issueOrdering,
      recovery: revalidateRecovery(),
      detectedAt,
    });
  }

  throw new OperatorIssueCompilerError(
    "UNSUPPORTED_REQUIREMENT",
    `Unsupported setup requirement ${requirementId}.`,
  );
}

function compilePausedRoutine(
  input: Extract<
    OperatorIssueCompilerInput,
    { condition: "routine_paused_after_failures" }
  >,
  fallbackOrdinal: number,
): LaunchOperatorIssue<null> {
  const detectedAt = validIso(input.detectedAt, "detectedAt");
  const agentId = trustedIdentifier(input.agent.id, "agent.id");
  const routineId = trustedIdentifier(input.routine.id, "routine.id");
  const routineName = label(input.routine.name, "routine.name");
  const failedAttempts = finiteNonNegative(
    input.failedAttempts,
    "failedAttempts",
  );
  if (!Number.isSafeInteger(failedAttempts) || failedAttempts < 1) {
    invalid("failedAttempts must be a positive safe integer.");
  }
  const runId = input.latestRunId
    ? trustedIdentifier(input.latestRunId, "latestRunId")
    : null;
  const conditionKey = `routine:${stableSegment(agentId, "agent.id")}:${
    stableSegment(routineId, "routine.id")
  }:paused_after_failures`;
  const diagnostic = input.diagnostic ?? null;
  const causeCode =
    diagnostic?.causeCode && CAUSE_CODE.test(diagnostic.causeCode)
      ? diagnostic.causeCode
      : null;
  const diagnosticSummary = boundedText(
    diagnostic?.summary,
    "diagnostic.summary",
    MAX_SUMMARY_LENGTH,
  );
  const diagnosticDetail = boundedText(
    diagnostic?.detail,
    "diagnostic.detail",
    MAX_DETAIL_LENGTH,
  );
  const evidence = diagnostic?.evidence ? [...diagnostic.evidence] : [];
  const provenance: LaunchOperatorDiagnosisProvenance = diagnostic
    ? diagnostic.provenance === "platform" ? "platform" : "combined"
    : "platform";
  const remediations: LaunchOperatorRemediation[] = [];

  if (runId) {
    remediations.push(
      remediation(conditionKey, {
        key: "inspect_run",
        label: "View failed run",
        description: "Review the safe failure summary and execution evidence.",
        presentation: "navigate",
        requiredAuthority: "agent_operate",
        sideEffect: "none",
        target: {
          kind: "routine_run",
          agentId,
          routineId,
          runId,
        },
      }),
      remediation(conditionKey, {
        key: "open_logs",
        label: "Open logs",
        description: "Inspect owner-visible redacted logs for this run.",
        presentation: "navigate",
        requiredAuthority: "agent_operate",
        sideEffect: "none",
        target: {
          kind: "routine_logs",
          agentId,
          routineId,
          runId,
        },
      }),
    );
  }
  remediations.push(
    remediation(conditionKey, {
      key: "open_routine",
      label: "Open routine",
      description: "Review this routine's code and configuration.",
      presentation: "navigate",
      requiredAuthority: "agent_operate",
      sideEffect: "none",
      target: {
        kind: "routine",
        agentId,
        routineId,
      },
    }),
    remediation(conditionKey, {
      key: "run_once",
      label: "Run once",
      description:
        "Runs real work and uses usage, but leaves scheduled execution paused.",
      presentation: "execute",
      requiredAuthority: "agent_operate",
      sideEffect: "routine_execution",
      target: {
        kind: "routine",
        agentId,
        routineId,
      },
    }),
  );

  return issue({
    conditionKey,
    scope: { kind: "routine", agentId, routineId },
    severity: "critical",
    diagnosis: {
      code: "ROUTINE_PAUSED_AFTER_FAILURES",
      causeCode,
      summary: diagnosticSummary ??
        `${routineName} paused after repeated failures`,
      detail: diagnosticDetail ??
        `${failedAttempts} consecutive attempts failed. Review the latest run before testing a fix.`,
      provenance,
      evidence,
    },
    affectedAgents: [affectedAgent(input.agent, true)],
    remediations,
    requiresDecision: false,
    ordering: ordering(input, fallbackOrdinal),
    recovery: {
      mode: "successful_verification",
      mayRecoverAutomatically: true,
      resumesScheduledWork: false,
    },
    detectedAt,
  });
}

function compileRoutineUsageReport(
  input: Extract<
    OperatorIssueCompilerInput,
    { condition: "routine_usage_exhausted" }
  >,
  fallbackOrdinal: number,
): LaunchOperatorReport<null> {
  const detectedAt = validIso(input.detectedAt, "detectedAt");
  const resetsAt = validIso(input.resetsAt, "resetsAt");
  const agentId = trustedIdentifier(input.agent.id, "agent.id");
  const routineId = trustedIdentifier(input.routine.id, "routine.id");
  const routineName = label(input.routine.name, "routine.name");
  const spent = finiteNonNegative(input.spent, "spent");
  const limit = finiteNonNegative(input.limit, "limit");
  const conditionKey = `routine:${stableSegment(agentId, "agent.id")}:${
    stableSegment(routineId, "routine.id")
  }:usage:${input.period}:${encodeURIComponent(resetsAt)}`;
  const periodLabel = input.period === "daily" ? "daily" : "monthly";
  return report({
    conditionKey,
    scope: { kind: "routine", agentId, routineId },
    diagnosis: {
      code: "ROUTINE_USAGE_EXHAUSTED",
      causeCode: null,
      summary: `${routineName} reached its ${periodLabel} usage limit`,
      detail:
        `Usage is ${spent}/${limit}. Runs resume after the window resets.`,
      provenance: "platform",
      evidence: [],
    },
    affectedAgents: [affectedAgent(input.agent, true)],
    ordering: ordering(input, fallbackOrdinal),
    detectedAt,
  });
}

function compileAccountUsageReport(
  input: Extract<
    OperatorIssueCompilerInput,
    { condition: "account_usage_exhausted" }
  >,
  fallbackOrdinal: number,
): LaunchOperatorReport<null> {
  if (input.affectedAgents.length === 0) {
    invalid("account_usage_exhausted must affect at least one Agent.");
  }
  const detectedAt = validIso(input.detectedAt, "detectedAt");
  const resetsAt = validIso(input.resetsAt, "resetsAt");
  const periodLabel = input.period === "five_hour" ? "five-hour" : "weekly";
  const conditionKey = `account:usage:${input.period}:${
    encodeURIComponent(resetsAt)
  }`;
  return report({
    conditionKey,
    scope: { kind: "account" },
    diagnosis: {
      code: "ACCOUNT_USAGE_EXHAUSTED",
      causeCode: null,
      summary: `Account ${periodLabel} usage limit reached`,
      detail: "Affected runs wait until account usage resets.",
      provenance: "platform",
      evidence: [],
    },
    affectedAgents: input.affectedAgents.map((agent) =>
      affectedAgent(agent, true)
    ),
    ordering: ordering(input, fallbackOrdinal),
    detectedAt,
  });
}

function compileOne(
  input: OperatorIssueCompilerInput,
  fallbackOrdinal: number,
): LaunchOperatorItemCandidate | null {
  if (input.condition === "setup_requirement") {
    return compileSetupRequirement(input, fallbackOrdinal);
  }
  if (input.condition === "account_byok_missing") {
    return compileByokIssue(
      input.affectedAgents,
      validIso(input.detectedAt, "detectedAt"),
      ordering(input, fallbackOrdinal),
    );
  }
  if (input.condition === "routine_paused_after_failures") {
    return compilePausedRoutine(input, fallbackOrdinal);
  }
  if (input.condition === "routine_usage_exhausted") {
    return compileRoutineUsageReport(input, fallbackOrdinal);
  }
  return compileAccountUsageReport(input, fallbackOrdinal);
}

function comparableItem(item: LaunchOperatorItemCandidate): string {
  return JSON.stringify({
    itemClass: item.itemClass,
    scope: item.scope,
    severity: item.severity,
    diagnosis: {
      code: item.diagnosis.code,
      causeCode: item.diagnosis.causeCode,
      summary: item.diagnosis.summary,
      detail: item.diagnosis.detail,
      provenance: item.diagnosis.provenance,
    },
    remediations: item.remediations,
    requiresAction: item.requiresAction,
    requiresDecision: item.requiresDecision,
    recovery: item.recovery,
  });
}

function mergeAffectedAgents(
  left: readonly LaunchOperatorAffectedAgent[],
  right: readonly LaunchOperatorAffectedAgent[],
): LaunchOperatorAffectedAgent[] {
  const merged = new Map<string, LaunchOperatorAffectedAgent>();
  for (const candidate of [...left, ...right]) {
    const existing = merged.get(candidate.agentId);
    merged.set(candidate.agentId, {
      agentId: candidate.agentId,
      blocking: candidate.blocking || existing?.blocking === true,
    });
  }
  return [...merged.values()];
}

function mergeEvidence(
  left: readonly LaunchAgentEvidenceReference[],
  right: readonly LaunchAgentEvidenceReference[],
): LaunchAgentEvidenceReference[] {
  const merged = new Map<string, LaunchAgentEvidenceReference>();
  for (const evidence of [...left, ...right]) {
    const key = `${evidence.kind}:${evidence.sourceId}`;
    if (!merged.has(key)) merged.set(key, evidence);
  }
  return [...merged.values()];
}

function mergeCandidates(
  left: LaunchOperatorItemCandidate,
  right: LaunchOperatorItemCandidate,
): LaunchOperatorItemCandidate {
  if (comparableItem(left) !== comparableItem(right)) {
    throw new OperatorIssueCompilerError(
      "CONFLICTING_CONDITION",
      `Condition ${left.conditionKey} compiled to conflicting definitions.`,
    );
  }
  const detectedAt = Date.parse(left.detectedAt) <= Date.parse(right.detectedAt)
    ? left.detectedAt
    : right.detectedAt;
  const dependsOnConditionKeys = [
    ...new Set([
      ...left.ordering.dependsOnConditionKeys,
      ...right.ordering.dependsOnConditionKeys,
    ]),
  ];
  const shared = {
    ...left,
    affectedAgents: mergeAffectedAgents(
      left.affectedAgents,
      right.affectedAgents,
    ),
    diagnosis: {
      ...left.diagnosis,
      evidence: mergeEvidence(
        left.diagnosis.evidence,
        right.diagnosis.evidence,
      ),
    },
    ordering: {
      sourceOrdinal: Math.min(
        left.ordering.sourceOrdinal,
        right.ordering.sourceOrdinal,
      ),
      dependsOnConditionKeys,
    },
    detectedAt,
  };
  return shared as LaunchOperatorItemCandidate;
}

/**
 * Orders blockers by actual dependency, then by the trusted producer's stable
 * source order. Item type never affects priority.
 */
export function orderOperatorItems(
  items: readonly LaunchOperatorItemCandidate[],
): LaunchOperatorItemCandidate[] {
  const byKey = new Map(items.map((item) => [item.conditionKey, item]));
  if (byKey.size !== items.length) {
    invalid("orderOperatorItems requires unique condition keys.");
  }
  const remaining = new Set(byKey.keys());
  const emitted = new Set<string>();
  const ordered: LaunchOperatorItemCandidate[] = [];
  const stable = [...items].sort((left, right) =>
    left.ordering.sourceOrdinal - right.ordering.sourceOrdinal ||
    left.conditionKey.localeCompare(right.conditionKey)
  );

  while (remaining.size > 0) {
    let progressed = false;
    for (const item of stable) {
      if (!remaining.has(item.conditionKey)) continue;
      const blockedByPresentDependency = item.ordering.dependsOnConditionKeys
        .some((dependency) =>
          byKey.has(dependency) && !emitted.has(dependency)
        );
      if (blockedByPresentDependency) continue;
      ordered.push(item);
      remaining.delete(item.conditionKey);
      emitted.add(item.conditionKey);
      progressed = true;
    }
    if (!progressed) {
      throw new OperatorIssueCompilerError(
        "DEPENDENCY_CYCLE",
        `Operator issue dependencies contain a cycle: ${
          [...remaining].sort().join(", ")
        }.`,
      );
    }
  }

  return ordered;
}

export function compileOperatorItem(
  input: OperatorIssueCompilerInput,
): LaunchOperatorItemCandidate | null {
  return compileOne(input, 0);
}

/**
 * Compiles, coalesces shared conditions, and orders the resulting card model.
 * Equal condition keys must produce the same server definition; only affected
 * Agents, evidence, dependencies, and detection time may merge.
 */
export function compileOperatorItems(
  inputs: readonly OperatorIssueCompilerInput[],
): LaunchOperatorItemCandidate[] {
  const merged = new Map<string, LaunchOperatorItemCandidate>();
  inputs.forEach((input, index) => {
    const candidate = compileOne(input, index);
    if (!candidate) return;
    const existing = merged.get(candidate.conditionKey);
    merged.set(
      candidate.conditionKey,
      existing ? mergeCandidates(existing, candidate) : candidate,
    );
  });
  return orderOperatorItems([...merged.values()]);
}
