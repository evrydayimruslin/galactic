import type {
  LaunchAgentHomeResponse,
  LaunchAgentAttentionItem,
  LaunchInterfaceSummary,
} from "../../../../shared/contracts/launch.ts";

export type OperatorOverviewSectionKind =
  | "attention"
  | "favorites"
  | "directive"
  | "activity"
  | "signals";

export interface OperatorOverviewModel {
  attention: LaunchAgentAttentionItem[];
  attentionCount: number;
  favoriteInterfaces: LaunchInterfaceSummary[];
  sectionOrder: OperatorOverviewSectionKind[];
  setupAction: OperatorSetupAction | null;
  showActivity: boolean;
  showSignals: boolean;
}

export interface OperatorSetupAction {
  detail: string;
  href: string;
}

function activityPopulated(home: LaunchAgentHomeResponse): boolean {
  const activity = home.activity;
  return Boolean(
    activity?.upNext ||
      activity?.now.length ||
      activity?.recent.length,
  );
}

function signalsPopulated(home: LaunchAgentHomeResponse): boolean {
  return Boolean(
    home.release.candidate ||
      home.capacity?.state === "low" ||
      home.capacity?.state === "waiting" ||
      home.agentCapacity?.state === "low" ||
      home.agentCapacity?.state === "waiting",
  );
}

export function operatorSetupAction(
  home: LaunchAgentHomeResponse,
): OperatorSetupAction | null {
  const slug = encodeURIComponent(home.agent.slug);
  const operatingMode = home.operatingSummary?.mode;
  if (operatingMode === "no_live_release") {
    return {
      detail: home.operatingSummary?.detail ??
        "Promote a verified release before this Agent works.",
      href: `/agents/${slug}?pane=settings&item=release`,
    };
  }
  if (operatingMode === "no_enabled_routine") {
    return {
      detail: home.operatingSummary?.detail ??
        "Configure a managed routine before this Agent works.",
      href: `/agents/${slug}?pane=routines`,
    };
  }

  const blocking = home.setup.requirements.filter((item) => item.blocking);
  const setting = blocking.find((item) =>
    item.kind === "setting" && item.settingKey
  );
  if (setting?.settingKey) {
    return {
      detail: setting.description ??
        `${setting.label} must be configured before this Agent works.`,
      href: `/agents/${slug}?pane=access&item=${
        encodeURIComponent(`setting:${setting.settingKey}`)
      }`,
    };
  }

  const byok = blocking.find((item) => item.id === "inference:byok");
  if (byok) {
    return {
      detail: byok.description ??
        "Configure an inference provider before this Agent works.",
      href: "/account?pane=byok",
    };
  }

  const routine = blocking.find((item) => item.kind === "routine");
  if (routine) {
    return {
      detail: routine.description ??
        "Configure a managed routine before this Agent works.",
      href: `/agents/${slug}?pane=routines`,
    };
  }

  const access = blocking.find((item) =>
    item.kind === "capability" || item.kind === "grant"
  );
  if (access) {
    const item = access.actionId
      ? `&item=${encodeURIComponent(`grant:${access.actionId}`)}`
      : "";
    return {
      detail: access.description ??
        `${access.label} needs owner approval before this Agent works.`,
      href: `/agents/${slug}?pane=access${item}`,
    };
  }

  const release = blocking.find((item) => item.kind === "release");
  if (release) {
    return {
      detail: release.description ?? "Review the staged release.",
      href: `/agents/${slug}?pane=settings&item=release`,
    };
  }

  if (operatingMode === "setup_required" || !home.setup.ready) {
    return {
      detail: home.operatingSummary?.detail ??
        home.state.blockers[0]?.message ??
        "Review the remaining setup requirements.",
      href: `/agents/${slug}?pane=access`,
    };
  }
  return null;
}

/**
 * Canonical Overview ordering. Optional sections disappear when empty; the
 * Directive is the invariant anchor and is never displaced by placeholders.
 */
export function buildOperatorOverviewModel(
  home: LaunchAgentHomeResponse,
  interfaces: readonly LaunchInterfaceSummary[],
): OperatorOverviewModel {
  const attention = home.attention?.items ?? [];
  const attentionCount = home.attention?.openCount ?? attention.length;
  const byId = new Map(interfaces.map((item) => [item.id, item]));
  const favoriteInterfaces = (home.preferences?.favoriteInterfaceIds ?? [])
    .flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  const showActivity = activityPopulated(home);
  const showSignals = signalsPopulated(home);
  const setupAction = operatorSetupAction(home);
  const sectionOrder: OperatorOverviewSectionKind[] = [];

  if (attentionCount > 0) {
    sectionOrder.push("attention");
  }
  if (favoriteInterfaces.length > 0) sectionOrder.push("favorites");
  sectionOrder.push("directive");
  if (showActivity) sectionOrder.push("activity");
  if (showSignals) sectionOrder.push("signals");

  return {
    attention,
    attentionCount,
    favoriteInterfaces,
    sectionOrder,
    setupAction,
    showActivity,
    showSignals,
  };
}
