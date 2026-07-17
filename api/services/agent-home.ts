import {
  AGENT_HOME_CONTRACT_VERSION,
  type LaunchAgentHomeAuthorityItem,
  type LaunchAgentHomeBudget,
  type LaunchAgentHomeExecutionState,
  type LaunchAgentHomeHealth,
  type LaunchAgentHomeLifecycleState,
  type LaunchAgentHomeRelease,
  type LaunchAgentHomeRequirement,
  type LaunchAgentHomeResponse,
  type LaunchCapacityResponse,
  type LaunchAgentRoutineBlocker,
  type LaunchAgentRoutineOverview,
  type LaunchFunctionSummary,
  type LaunchNetworkDisclosure,
} from "../../shared/contracts/launch.ts";
import type { AppManifest } from "../../shared/contracts/manifest.ts";
import type { AgentGrantSummary } from "../../shared/contracts/agent-grants.ts";
import type { VersionMetadata } from "../../shared/types/index.ts";

export interface AgentHomeBudgetUsage {
  lastRun: number;
  lastRunCalls: number;
  daily: number;
  monthly: number;
  dayStartedAt: string;
  monthStartedAt: string;
}

export interface AgentHomeReleaseInput {
  versions: string[];
  currentVersion: string | null;
  versionMetadata: VersionMetadata[];
  promotedAt: string | null;
  executedVersion: string | null;
  integrity: "verified" | "unverified" | "unknown";
  candidateAuthorityChanges: NonNullable<
    LaunchAgentHomeRelease["candidate"]
  >["authorityChanges"];
  candidateManifestAvailable: boolean;
  candidatePreflightReady: boolean;
}

export interface AgentHomeSettingStatus {
  key: string;
  scope: "agent" | "per_user";
  label: string;
  description: string | null;
  help: string | null;
  input: string;
  placeholder: string | null;
  group: string | null;
  required: boolean;
  configured: boolean;
  secret: boolean;
  destination: string | null;
  updatedAt: string | null;
}

export interface AgentHomeBuildInput {
  now: Date;
  revision: string;
  agent: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
  };
  manifest: AppManifest | null;
  effectivePermissions: string[];
  ignoredPermissions: string[];
  functions: LaunchFunctionSummary[];
  dependencies: Array<{
    app: string;
    functions: string[];
    access: "read" | "write";
  }>;
  callTargets: ReadonlyMap<string, {
    valid: boolean;
    targetAppId: string | null;
  }>;
  grants: AgentGrantSummary[];
  routine: LaunchAgentRoutineOverview | null;
  settings: AgentHomeSettingStatus[];
  disclosure: LaunchNetworkDisclosure;
  budgetUsage: AgentHomeBudgetUsage | null;
  callsByRun: ReadonlyMap<string, number>;
  capacity?: LaunchCapacityResponse | null;
  byokConfigured?: boolean;
  release: AgentHomeReleaseInput;
}

export function agentHomeCallTargetKey(
  appRef: string,
  functionName: string,
): string {
  return `${encodeURIComponent(appRef)}:${encodeURIComponent(functionName)}`;
}

function callTarget(
  input: AgentHomeBuildInput,
  appRef: string,
  functionName: string,
): { valid: boolean; targetAppId: string | null } {
  return input.callTargets.get(agentHomeCallTargetKey(appRef, functionName)) || {
    valid: false,
    targetAppId: null,
  };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function sameUtcMonth(periodStart: string, now: Date): boolean {
  const start = new Date(periodStart);
  return !Number.isNaN(start.getTime()) &&
    start.getUTCFullYear() === now.getUTCFullYear() &&
    start.getUTCMonth() === now.getUTCMonth();
}

function grantWithinMonthlyCap(
  grant: AgentGrantSummary,
  now: Date,
): boolean {
  if (grant.monthlyCapCredits === null) return true;
  const currentSpend = sameUtcMonth(grant.periodStart, now)
    ? grant.spentCreditsPeriod
    : 0;
  return currentSpend < grant.monthlyCapCredits;
}

function resolveRoutineGrant(
  grants: AgentGrantSummary[],
  input: {
    callerAppId: string;
    targetAppId: string | null;
    targetAppRef: string;
    targetFunction: string;
    now: Date;
  },
): { grant: AgentGrantSummary | null; effective: boolean } {
  const matching = grants.filter((grant) =>
    grant.mode === "call" &&
    grant.callerApp.id === input.callerAppId &&
    // Scheduled routines execute outside a specific exported function. A grant
    // narrowed to callerFunction must not authorize that ambient execution.
    grant.callerFunction === null &&
    (input.targetAppId
      ? grant.targetApp.id === input.targetAppId
      : grant.targetApp.id === input.targetAppRef ||
        grant.targetApp.slug === input.targetAppRef) &&
    grant.targetFunction === input.targetFunction
  );
  const active = matching.find((grant) => grant.status === "active") || null;
  if (active) {
    return {
      grant: active,
      effective: grantWithinMonthlyCap(active, input.now),
    };
  }
  return {
    grant: matching.find((grant) => grant.status === "pending") || null,
    effective: false,
  };
}

function lifecycleState(
  routine: LaunchAgentRoutineOverview | null,
  blockers: LaunchAgentRoutineBlocker[],
): LaunchAgentHomeLifecycleState {
  if (!routine) return "needs_setup";
  if (routine.status === "active") return "active";
  if (routine.status === "disabled") return "disabled";
  if (blockers.length > 0) return "needs_setup";
  if (routine.status === "paused" && !routine.lastRunAt) return "ready";
  return "paused";
}

function executionState(
  routine: LaunchAgentRoutineOverview | null,
): LaunchAgentHomeExecutionState {
  const statuses = routine?.recentRuns.map((run) => run.status) || [];
  return statuses.includes("running")
    ? "running"
    : statuses.includes("queued")
    ? "queued"
    : "idle";
}

function healthState(
  routine: LaunchAgentRoutineOverview | null,
): LaunchAgentHomeHealth {
  if (!routine || routine.recentRuns.length === 0) return "unknown";
  if (routine.status === "error" || routine.autoPauseReason || routine.errorReason) {
    return "failing";
  }
  const terminal = routine.recentRuns.filter((run) =>
    run.status === "succeeded" || run.status === "failed" ||
    run.status === "skipped"
  );
  if (terminal.length === 0) return "unknown";
  if (terminal[0]?.status === "failed" || routine.failureCount > 0) {
    return "degraded";
  }
  if (terminal[0]?.status === "skipped") return "unknown";
  return "healthy";
}

function permissionAuthority(
  permission: string,
  effectivePermissions: ReadonlySet<string>,
): LaunchAgentHomeAuthorityItem {
  const effective = effectivePermissions.has(permission);
  const [namespace, action = "execute"] = permission.split(":", 2);
  const kind = namespace === "ai"
    ? "ai"
    : namespace === "storage"
    ? "storage"
    : namespace === "memory"
    ? "memory"
    : namespace === "notify"
    ? "reporting"
    : namespace === "app"
    ? "agent_call"
    : namespace === "net"
    ? "network"
    : namespace === "gpu"
    ? "compute"
    : "other";
  const access = action === "read"
    ? "read"
    : action === "write" || action === "delete"
    ? "write"
    : "execute";
  const badges: LaunchAgentHomeAuthorityItem["badges"] = kind === "ai"
    ? ["AI"]
    : access === "read"
    ? ["Read"]
    : ["Write"];
  return {
    id: `manifest:${permission}`,
    actionId: null,
    kind,
    direction: kind === "reporting" || kind === "network" ||
        kind === "agent_call"
      ? "outbound"
      : "internal",
    label: permission,
    target: null,
    access,
    source: "manifest",
    requested: true,
    approved: effective,
    approvalBasis: effective ? "live_release" : "pending",
    effective,
    required: true,
    purpose: null,
    badges,
  };
}

function functionAuthority(fn: LaunchFunctionSummary): LaunchAgentHomeAuthorityItem {
  const readOnly = fn.annotations?.readOnlyHint === true;
  const badges: LaunchAgentHomeAuthorityItem["badges"] = [
    readOnly ? "Read" : "Write",
    ...(fn.usesInference ? ["AI" as const] : []),
  ];
  return {
    id: `function:${fn.name}`,
    actionId: null,
    kind: "function",
    direction: "inbound",
    label: fn.name,
    target: fn.name,
    access: readOnly ? "read" : "write",
    source: "manifest",
    requested: true,
    approved: true,
    approvalBasis: "live_release",
    effective: true,
    required: true,
    purpose: fn.description || null,
    badges,
  };
}

function authorityItems(input: AgentHomeBuildInput): LaunchAgentHomeAuthorityItem[] {
  const permissions = Array.isArray(input.manifest?.permissions)
    ? input.manifest!.permissions!.filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    )
    : [];
  const items: LaunchAgentHomeAuthorityItem[] = [
    ...input.functions.map(functionAuthority),
    ...permissions.map((permission) =>
      permissionAuthority(permission, new Set(input.effectivePermissions))
    ),
  ];
  const hasNetworkPermission = input.effectivePermissions.includes("net:fetch") ||
    input.effectivePermissions.includes("net:connect");
  for (const destination of input.disclosure.destinations) {
    items.push({
      id: `network:${destination.host}`,
      actionId: null,
      kind: "network",
      direction: "outbound",
      label: destination.label || destination.host,
      target: destination.host,
      access: "execute",
      source: "manifest",
      requested: true,
      approved: hasNetworkPermission,
      approvalBasis: "live_release",
      effective: hasNetworkPermission,
      required: true,
      purpose: destination.description,
      badges: ["Write"],
    });
  }
  for (const capability of input.routine?.capabilities || []) {
    const targetRef = capability.appId || capability.appRef;
    const target = callTarget(input, targetRef, capability.functionName);
    const resolvedGrant = resolveRoutineGrant(input.grants, {
      callerAppId: input.agent.id,
      targetAppId: target.targetAppId || capability.appId,
      targetAppRef: capability.appRef,
      targetFunction: capability.functionName,
      now: input.now,
    });
    const effective = capability.approved && target.valid &&
      resolvedGrant.effective;
    items.push({
      id: `routine:${capability.id}`,
      actionId: capability.id,
      kind: "agent_call",
      direction: "outbound",
      label: `${capability.appRef}.${capability.functionName}`,
      target: target.targetAppId || capability.appId,
      access: capability.access,
      source: "routine",
      requested: true,
      approved: capability.approved,
      approvalBasis: capability.approved
        ? "owner_capability_approval"
        : "pending",
      effective,
      required: capability.required,
      purpose: capability.purpose,
      badges: [capability.access === "read" ? "Read" : "Write"],
    });
  }
  if (!items.some((item) => item.kind === "reporting")) {
    const effective = input.effectivePermissions.includes("notify:owner");
    items.push({
      id: "platform:galactic_inbox",
      actionId: null,
      kind: "reporting",
      direction: "outbound",
      label: "Report to Galactic inbox",
      target: "galactic_inbox",
      access: "write",
      source: "platform",
      requested: false,
      approved: effective,
      approvalBasis: effective ? "platform_policy" : "pending",
      effective,
      required: true,
      purpose: "Meaningful milestones, anomalies, and automatic pause notices.",
      badges: ["Write"],
    });
  }
  for (const dependency of input.dependencies) {
    for (const functionName of dependency.functions) {
      const target = callTarget(input, dependency.app, functionName);
      const resolvedGrant = resolveRoutineGrant(input.grants, {
        callerAppId: input.agent.id,
        targetAppId: target.targetAppId,
        targetAppRef: dependency.app,
        targetFunction: functionName,
        now: input.now,
      });
      const matchingGrant = resolvedGrant.grant;
      items.push({
        id: `dependency:${dependency.app}:${functionName}`,
        actionId: null,
        kind: "agent_call",
        direction: "outbound",
        label: `${dependency.app}.${functionName}`,
        target: target.targetAppId || matchingGrant?.targetApp.id || dependency.app,
        access: dependency.access,
        source: "manifest",
        requested: true,
        approved: matchingGrant?.status === "active",
        approvalBasis: matchingGrant?.status === "active"
          ? "owner_capability_approval"
          : "pending",
        effective: target.valid && resolvedGrant.effective,
        required: true,
        purpose: null,
        badges: [dependency.access === "read" ? "Read" : "Write"],
      });
    }
  }
  const deduped = new Map<string, LaunchAgentHomeAuthorityItem>();
  for (const item of items) {
    const key = item.kind === "agent_call"
      // A manifest dependency and a routine capability may name the same
      // downstream function while representing different approval paths. In
      // particular, an active broad grant must never erase a pending routine
      // capability (and therefore its owner-approval action) from Agent Home.
      ? `${item.kind}:${item.source}:${item.actionId || ""}:${item.target || ""}:${item.label}:${item.access}`
      : item.id;
    const existing = deduped.get(key);
    if (!existing || (!existing.effective && item.effective)) deduped.set(key, item);
  }
  return [...deduped.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function setupRequirements(
  input: AgentHomeBuildInput,
): LaunchAgentHomeRequirement[] {
  const requirements: LaunchAgentHomeRequirement[] = [{
    id: "routine:primary",
    actionId: null,
    kind: "routine",
    label: "Primary routine",
    description: "One paused routine proposal defines this Agent's ongoing job.",
    required: true,
    configured: input.routine !== null,
    blocking: input.routine === null,
    secret: false,
    settingKey: null,
    settingScope: null,
    input: null,
    placeholder: null,
    help: null,
    group: null,
    destination: null,
    updatedAt: null,
    actions: [],
  }];
  const reportingConfigured = input.effectivePermissions.includes("notify:owner");
  requirements.push({
    id: "reporting:galactic_inbox",
    actionId: null,
    kind: "capability",
    label: "Galactic inbox reporting",
    description: "The Agent can report milestones and anomalies to its owner.",
    required: true,
    configured: reportingConfigured,
    blocking: !reportingConfigured,
    secret: false,
    settingKey: null,
    settingScope: null,
    input: null,
    placeholder: null,
    help: null,
    group: null,
    destination: "galactic_inbox",
    updatedAt: null,
    actions: [],
  });
  const usesInference = input.effectivePermissions.includes("ai:call") ||
    input.effectivePermissions.includes("ai:embed");
  if (usesInference) {
    requirements.push({
      id: "inference:byok",
      actionId: null,
      kind: "capability",
      label: "BYOK inference provider",
      description:
        "This Agent uses AI and needs one of your configured provider API keys. Galactic never supplies a model key.",
      required: true,
      configured: input.byokConfigured === true,
      blocking: input.byokConfigured !== true,
      secret: true,
      settingKey: null,
      settingScope: null,
      input: null,
      placeholder: null,
      help: null,
      group: "Inference",
      destination: "/account",
      updatedAt: null,
      actions: [],
    });
  }
  for (const setting of input.settings) {
    requirements.push({
      id: `setting:${setting.key}`,
      actionId: setting.key,
      kind: "setting",
      label: setting.label,
      description: setting.description || setting.help,
      required: setting.required,
      configured: setting.configured,
      blocking: setting.required && !setting.configured,
      secret: setting.secret,
      settingKey: setting.key,
      settingScope: setting.scope,
      input: setting.input,
      placeholder: setting.placeholder,
      help: setting.help,
      group: setting.group,
      destination: setting.destination,
      updatedAt: setting.updatedAt,
      actions: setting.configured ? ["replace", "remove"] : ["set"],
    });
  }
  for (const capability of input.routine?.capabilities || []) {
    const targetRef = capability.appId || capability.appRef;
    const target = callTarget(input, targetRef, capability.functionName);
    requirements.push({
      id: `capability:${capability.id}`,
      actionId: capability.id,
      kind: "capability",
      label: `${capability.appRef}.${capability.functionName}`,
      description: capability.purpose,
      required: capability.required,
      configured: capability.approved,
      blocking: capability.required && !capability.approved,
      secret: false,
      settingKey: null,
      settingScope: null,
      input: null,
      placeholder: null,
      help: null,
      group: null,
      destination: capability.appRef,
      updatedAt: capability.approvedAt,
      actions: capability.approved ? [] : ["approve"],
    });
    const resolvedGrant = resolveRoutineGrant(input.grants, {
      callerAppId: input.agent.id,
      targetAppId: target.targetAppId || capability.appId,
      targetAppRef: capability.appRef,
      targetFunction: capability.functionName,
      now: input.now,
    });
    const grant = resolvedGrant.grant;
    requirements.push({
      id: `grant:${capability.id}`,
      actionId: null,
      kind: "grant",
      label: `Grant ${capability.appRef}.${capability.functionName}`,
      description: target.valid
        ? "A bounded active grant is required for this downstream call."
        : "The target must remain one of your private Agents and expose this function.",
      required: capability.required,
      configured: target.valid && resolvedGrant.effective,
      blocking: capability.required &&
        (!target.valid || !resolvedGrant.effective),
      secret: false,
      settingKey: null,
      settingScope: null,
      input: null,
      placeholder: null,
      help: null,
      group: null,
      destination: capability.appRef,
      updatedAt: grant?.updatedAt || null,
      actions: [],
    });
  }
  const candidate = buildRelease(input.release).candidate;
  if (candidate?.reviewStatus === "owner_review_required") {
    requirements.push({
      id: `release:${candidate.version}`,
      actionId: candidate.version,
      kind: "release",
      label: `Review version ${candidate.version}`,
      description: "This tested version requests authority beyond the live version.",
      required: false,
      configured: false,
      blocking: false,
      secret: false,
      settingKey: null,
      settingScope: null,
      input: null,
      placeholder: null,
      help: null,
      group: null,
      destination: null,
      updatedAt: candidate.uploadedAt,
      actions: ["promote"],
    });
  }
  return requirements;
}

function metadataForVersion(
  metadata: VersionMetadata[],
  version: string | null,
): VersionMetadata | null {
  if (!version) return null;
  for (let index = metadata.length - 1; index >= 0; index -= 1) {
    if (metadata[index]?.version === version) return metadata[index];
  }
  return null;
}

function versionSummary(
  metadata: VersionMetadata | null,
  version: string,
): {
  version: string;
  sourceFingerprint: string | null;
  uploadedAt: string | null;
  testedAt: string | null;
} {
  return {
    version,
    sourceFingerprint: metadata?.source_hash || null,
    uploadedAt: metadata?.created_at || null,
    testedAt: metadata?.test_attestation?.tested_at || null,
  };
}

export function versionWasUploadedAfterLive(
  metadata: VersionMetadata[],
  currentVersion: string | null,
  candidateVersion: string,
): boolean {
  const currentCreatedAt = Date.parse(
    metadataForVersion(metadata, currentVersion)?.created_at || "",
  );
  if (!Number.isFinite(currentCreatedAt)) return true;
  const candidateCreatedAt = Date.parse(
    metadataForVersion(metadata, candidateVersion)?.created_at || "",
  );
  return Number.isFinite(candidateCreatedAt) &&
    candidateCreatedAt > currentCreatedAt;
}

function buildRelease(input: AgentHomeReleaseInput): LaunchAgentHomeRelease {
  const metadata = Array.isArray(input.versionMetadata) ? input.versionMetadata : [];
  const candidates = [...new Set(input.versions)].filter((version) => {
    if (!version || version === input.currentVersion) return false;
    const entry = metadataForVersion(metadata, version);
    if (
      entry?.test_attestation === undefined ||
      entry.test_attestation.source_hash !== entry.source_hash
    ) return false;
    // A staged candidate is a release uploaded after the live release. Older
    // tested artifacts remain valid history, but presenting one as "latest"
    // would disguise a rollback as a forward promotion. Legacy rows without a
    // usable live timestamp retain the old behavior until they are promoted.
    return versionWasUploadedAfterLive(
      metadata,
      input.currentVersion,
      version,
    );
  }).sort((left, right) => {
    const leftAt = Date.parse(metadataForVersion(metadata, left)?.created_at || "");
    const rightAt = Date.parse(metadataForVersion(metadata, right)?.created_at || "");
    return (Number.isFinite(rightAt) ? rightAt : 0) -
      (Number.isFinite(leftAt) ? leftAt : 0);
  });
  const candidateVersion = candidates[0] || null;
  const candidateMetadata = metadataForVersion(metadata, candidateVersion);
  const authorityChanges = input.candidateAuthorityChanges || [];
  const reviewStatus = !input.candidateManifestAvailable ||
      !input.candidatePreflightReady
    ? "unavailable"
    : authorityChanges.length > 0
    ? "owner_review_required"
    : "ready";
  return {
    live: input.currentVersion
      ? {
        ...versionSummary(
          metadataForVersion(metadata, input.currentVersion),
          input.currentVersion,
        ),
        promotedAt: input.promotedAt,
        executedVersion: input.executedVersion,
        integrity: input.integrity,
      }
      : null,
    candidate: candidateVersion
      ? {
        ...versionSummary(candidateMetadata, candidateVersion),
        authorityChanges,
        reviewStatus,
        canPromote: input.candidateManifestAvailable &&
          input.candidatePreflightReady &&
          candidateMetadata?.test_attestation !== undefined,
      }
      : null,
    candidateCount: candidates.length,
  };
}

export function buildAgentHomeResponse(
  input: AgentHomeBuildInput,
): LaunchAgentHomeResponse {
  const requirements = setupRequirements(input);
  const blockers: LaunchAgentRoutineBlocker[] = [
    ...(input.routine?.blockers || []),
    ...requirements.filter((item) => item.blocking).map((item) => ({
      code: item.kind === "setting" ? "missing_required_setting" : "routine_required",
      message: item.kind === "setting"
        ? `${item.label} must be configured before activation.`
        : item.description || `${item.label} is required.`,
    })),
  ].filter((blocker, index, all) =>
    all.findIndex((candidate) =>
      candidate.code === blocker.code && candidate.message === blocker.message
    ) === index
  );
  const release = buildRelease(input.release);
  if (input.release.currentVersion && input.release.integrity !== "verified") {
    blockers.push({
      code: input.release.integrity === "unverified"
        ? "executed_release_unverified"
        : "executed_release_integrity_unknown",
      message: input.release.integrity === "unverified"
        ? "The running bundle does not match its verified release state."
        : "The running bundle could not be verified, so activation is unavailable.",
    });
  } else if (!input.release.currentVersion) {
    blockers.push({
      code: "live_release_required",
      message: "A verified live release is required before activation.",
    });
  }
  const budget: LaunchAgentHomeBudget | null = input.routine && input.budgetUsage
    ? {
      unit: "work_units",
      ceilings: {
        perRun: input.routine.budgets.maxLightPerRun,
        daily: input.routine.budgets.maxLightPerDay,
        monthly: input.routine.budgets.maxLightPerMonth,
        callsPerRun: input.routine.budgets.maxCallsPerRun,
      },
      usage: {
        lastRun: finiteNonNegative(input.budgetUsage.lastRun),
        lastRunCalls: Math.floor(finiteNonNegative(input.budgetUsage.lastRunCalls)),
        daily: finiteNonNegative(input.budgetUsage.daily),
        monthly: finiteNonNegative(input.budgetUsage.monthly),
        dayStartedAt: input.budgetUsage.dayStartedAt,
        monthStartedAt: input.budgetUsage.monthStartedAt,
      },
    }
    : null;
  const lifecycle = lifecycleState(input.routine, blockers);
  const canOperate = lifecycle === "active" && blockers.length === 0;
  const derivedHealth = healthState(input.routine);
  const health = input.release.integrity === "unverified" &&
      derivedHealth !== "failing"
    ? "degraded"
    : derivedHealth;
  return {
    contractVersion: AGENT_HOME_CONTRACT_VERSION,
    revision: input.revision,
    generatedAt: input.now.toISOString(),
    agent: {
      ...input.agent,
      visibility: "private",
    },
    responsibility: {
      mission: input.routine?.mission || "",
      cadence: input.routine?.schedule || null,
      reporting: {
        kind: "galactic_inbox",
        label: "Galactic inbox",
        configured: input.effectivePermissions.includes("notify:owner"),
      },
    },
    state: {
      lifecycle,
      execution: executionState(input.routine),
      health,
      nextRunAt: input.routine?.nextRunAt || null,
      lastRunAt: input.routine?.lastRunAt || null,
      lastSuccessAt: input.routine?.lastSuccessAt || null,
      lastErrorAt: input.routine?.lastErrorAt || null,
      failureCount: input.routine?.failureCount || 0,
      blockers,
    },
    setup: {
      ready: blockers.length === 0,
      requirements,
    },
    authority: { items: authorityItems(input) },
    capacity: input.capacity ?? null,
    budget,
    release,
    recentRuns: (input.routine?.recentRuns || []).slice(0, 5).map((run) => ({
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      traceId: run.traceId,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      workUnits: finiteNonNegative(run.totalLight),
      calls: input.callsByRun.get(run.id) || 0,
      summary: run.summary,
      errorCode: run.errorCode,
      createdAt: run.createdAt,
      detailUrl: null,
    })),
    actions: {
      canEditIdentity: true,
      canEditRoutine: input.routine !== null,
      canManageSettings: input.settings.length > 0,
      canApproveCapabilities: input.routine?.actions.canApproveCapabilities || false,
      canActivate: input.routine !== null &&
        (input.routine.status === "paused" || input.routine.status === "error") &&
        blockers.length === 0,
      canPause: input.routine?.actions.canPause || false,
      canRunNow: canOperate && (input.routine?.actions.canRunNow || false),
      canPromoteCandidate: release.candidate?.canPromote || false,
    },
  };
}
