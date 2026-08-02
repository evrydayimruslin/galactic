import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  LaunchAgentAccessConsumer,
  LaunchAgentActivityPreview,
  LaunchAgentPreferences,
  LaunchAgentSummary,
} from "../../../../../shared/contracts/launch.ts";
import type { LaunchPageProps } from "../../App";
import {
  parseAgentStudioRouteState,
  type AgentStudioPane,
  updateAgentStudioRoute,
} from "../../lib/agent-studio-route";
import {
  agentStudioSetupCapabilityId,
  clearStudioActionKey,
  getOrCreateStudioActionKey,
  remediateAgentStudioSetupGrant,
  retainIdempotencyKeyAfterFailure,
  shouldShowAgentSetup,
  studioStatus,
} from "../../lib/agent-studio-state";
import { createStudioHandoffCredential } from "../../lib/agent-studio-handoff-credential";
import { launchApi, launchApiOrigin } from "../../lib/api";
import {
  clearLegacyInterfaceFavorites,
  readLegacyInterfaceFavoritesForMigration,
  shouldApplyInterfaceFavoritesRead,
  shouldMigrateLegacyInterfaceFavorites,
} from "../../lib/interface-favorites";
import { dismissLaunchWorkspace } from "../../lib/navigation";
import { mergeAgentActivityPages } from "../../lib/operator-activity-state";
import { AgentComputePane } from "../agent-compute-pane";
import {
  AgentSettingsPane,
  FunctionsPane,
} from "../nebula-fleet";
import { OperatorAgentAlerts } from "../nebula/operator-agent-alerts";
import { AgentStudioConnections } from "./agent-studio-connections";
import {
  AgentStudioHandoff,
} from "./agent-studio-handoff";
import type { AgentStudioHandoffIntent } from "./agent-studio-handoff-model";
import { AgentStudioInterfaces } from "./agent-studio-interfaces";
import { AgentStudioOverview } from "./agent-studio-overview";
import {
  type AgentStudioRoutineStarter,
  AgentStudioRoutines,
} from "./agent-studio-routines";
import {
  AgentStudioActivity,
  AgentStudioCapabilitiesIntro,
  AgentStudioContractBoundary,
  AgentStudioDirective,
  AgentStudioLimits,
} from "./agent-studio-screens";
import {
  AgentStudioShell,
  type AgentStudioTheme,
} from "./agent-studio-shell";

import "./agent-studio.css";

const STUDIO_THEME_KEY = "galactic.agent-studio.theme";

export function AgentStudioApp({
  live,
  location,
  navigate,
}: LaunchPageProps): ReactElement {
  const agent = live.data.agent?.agent ?? live.data.agent?.tool ?? null;
  const home = live.data.agentHome;
  const interfaceIdsKey = (agent?.interfaces ?? [])
    .map((entry) => entry.id)
    .join("\u0000");
  const { item, pane } = useMemo(
    () => parseAgentStudioRouteState(location.search),
    [location.search],
  );
  const [theme, setTheme] = useState<AgentStudioTheme>(readStudioTheme);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState("");
  const [activationBusy, setActivationBusy] = useState(false);
  const [activationError, setActivationError] = useState("");
  const [agentPauseBusy, setAgentPauseBusy] = useState(false);
  const [agentPauseNotice, setAgentPauseNotice] = useState("");
  const [setupActionBusy, setSetupActionBusy] = useState<string | null>(null);
  const [setupActionError, setSetupActionError] = useState("");
  const homeActionIdempotencyKeys = useRef(new Map<string, string>());
  const [attentionCount, setAttentionCount] = useState(
    home?.attention?.openCount ?? 0,
  );
  const [preferences, setPreferences] = useState<LaunchAgentPreferences | null>(
    home?.preferences ?? null,
  );
  const preferenceReadGeneration = useRef(0);
  const preferenceMutationGeneration = useRef(0);
  const [preferencesError, setPreferencesError] = useState("");
  const preferenceMutationInFlight = useRef(false);
  const [activity, setActivity] = useState<LaunchAgentActivityPreview | null>(
    home?.activity ?? null,
  );
  const activityRequestGeneration = useRef(0);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");
  const [handoffDescriptions, setHandoffDescriptions] = useState<
    Partial<Record<AgentStudioHandoffIntent, string>>
  >({});

  useEffect(() => {
    try {
      window.localStorage.setItem(STUDIO_THEME_KEY, theme);
    } catch {
      // The theme remains session-local when browser storage is unavailable.
    }
    document.body.dataset.agentStudioTheme = theme;
    return () => {
      delete document.body.dataset.agentStudioTheme;
    };
  }, [theme]);
  useEffect(() => {
    if (home?.attention) setAttentionCount(home.attention.openCount);
  }, [home?.attention?.openCount]);
  useEffect(() => {
    setAttentionCount(home?.attention?.openCount ?? 0);
    setSetupActionBusy(null);
    setSetupActionError("");
  }, [agent?.id]);
  useEffect(() => {
    preferenceReadGeneration.current += 1;
    preferenceMutationGeneration.current += 1;
    preferenceMutationInFlight.current = false;
    setPreferences(home?.preferences ?? null);
    setPreferencesError("");
  }, [agent?.id]);
  useEffect(() => {
    if (!agent) return;
    const readGeneration = ++preferenceReadGeneration.current;
    const mutationGeneration = preferenceMutationGeneration.current;
    let mounted = true;
    launchApi.agentPreferences(agentLocator(agent))
      .then(async ({ preferences: fetched }) => {
        if (!shouldApplyInterfaceFavoritesRead({
          currentMutationGeneration: preferenceMutationGeneration.current,
          currentReadGeneration: preferenceReadGeneration.current,
          mounted,
          mutationGeneration,
          readGeneration,
        })) return;
        let next = fetched;
        let storage: Storage | null = null;
        try {
          storage = window.localStorage;
        } catch {
          // Server preferences remain authoritative when storage is denied.
        }
        const legacy = storage
          ? readLegacyInterfaceFavoritesForMigration(
            storage,
            agent.id,
            (agent.interfaces ?? []).map((entry) => entry.id),
          )
          : null;
        if (legacy !== null && storage) {
          if (shouldMigrateLegacyInterfaceFavorites(fetched, legacy)) {
            const migrated = await launchApi.updateAgentPreferences(
              agentLocator(agent),
              {
                expectedRevision: fetched.revision,
                favoriteInterfaceIds: legacy,
                favoritesInitialized: true,
              },
            );
            next = migrated.preferences;
          }
          clearLegacyInterfaceFavorites(storage, agent.id);
        }
        if (!shouldApplyInterfaceFavoritesRead({
          currentMutationGeneration: preferenceMutationGeneration.current,
          currentReadGeneration: preferenceReadGeneration.current,
          mounted,
          mutationGeneration,
          readGeneration,
        })) return;
        setPreferences(next);
        setPreferencesError("");
      })
      .catch((reason) => {
        if (shouldApplyInterfaceFavoritesRead({
          currentMutationGeneration: preferenceMutationGeneration.current,
          currentReadGeneration: preferenceReadGeneration.current,
          mounted,
          mutationGeneration,
          readGeneration,
        })) {
          setPreferencesError(errorMessage(reason));
        }
      });
    return () => {
      mounted = false;
    };
  }, [
    agent?.id,
    agent?.slug,
    home?.preferences?.revision,
    interfaceIdsKey,
  ]);
  useEffect(() => {
    setActivity(null);
    setActivityCursor(null);
    setHandoffDescriptions({});
  }, [agent?.id]);
  useEffect(() => {
    if (pane === "activity") return;
    setActivity(home?.activity ?? null);
    setActivityCursor(null);
  }, [home?.activity?.generatedAt, pane]);
  useEffect(() => {
    activityRequestGeneration.current += 1;
    setActivityLoading(false);
  }, [agent?.id, pane]);
  useEffect(() => {
    if (pane !== "activity" || !agent) return;
    const requestGeneration = activityRequestGeneration.current;
    let mounted = true;
    setActivityLoading(true);
    launchApi.agentActivity(agentLocator(agent), { limit: 20 })
      .then((response) => {
        if (
          !mounted ||
          requestGeneration !== activityRequestGeneration.current
        ) return;
        setActivity(response.activity);
        setActivityCursor(response.nextCursor);
        setActivityError("");
      })
      .catch((reason) => {
        if (
          mounted &&
          requestGeneration === activityRequestGeneration.current
        ) {
          setActivityError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (
          mounted &&
          requestGeneration === activityRequestGeneration.current
        ) {
          setActivityLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [agent?.id, agent?.slug, pane]);

  const openPane = (
    nextPane: AgentStudioPane,
    nextItem?: string | null,
    replace = false,
  ) => {
    navigate(updateAgentStudioRoute(location.pathname, location.search, {
      pane: nextPane,
      ...(nextItem !== undefined ? { item: nextItem } : {}),
    }), { replace, scroll: "preserve" });
  };

  const openHandoff = (
    returnPane: AgentStudioPane,
    intent: Extract<
      AgentStudioHandoffIntent,
      "interface" | "function" | "routine"
    >,
    description = "",
  ) => {
    if (description) {
      setHandoffDescriptions((current) => ({
        ...current,
        [intent]: description,
      }));
    }
    openPane(returnPane, `handoff:${intent}`);
  };

  const toggleFavorite = async (interfaceId: string) => {
    const currentPreferences = preferences ?? home?.preferences ?? null;
    if (
      !agent ||
      !currentPreferences ||
      preferenceMutationInFlight.current
    ) return;
    preferenceMutationInFlight.current = true;
    const mutationGeneration = ++preferenceMutationGeneration.current;
    const favoriteInterfaceIds =
      currentPreferences.favoriteInterfaceIds.includes(
        interfaceId,
      )
      ? currentPreferences.favoriteInterfaceIds.filter((id) =>
        id !== interfaceId
      )
      : [...currentPreferences.favoriteInterfaceIds, interfaceId];
    try {
      const response = await launchApi.updateAgentPreferences(
        agentLocator(agent),
        {
          expectedRevision: currentPreferences.revision,
          favoriteInterfaceIds,
          favoritesInitialized: true,
        },
      );
      if (mutationGeneration === preferenceMutationGeneration.current) {
        setPreferences(response.preferences);
        setPreferencesError("");
      }
      live.reload();
    } catch (reason) {
      if (mutationGeneration === preferenceMutationGeneration.current) {
        setPreferencesError(errorMessage(reason));
        try {
          const { preferences: canonical } = await launchApi.agentPreferences(
            agentLocator(agent),
          );
          if (mutationGeneration === preferenceMutationGeneration.current) {
            setPreferences(canonical);
          }
        } catch {
          // Preserve the original mutation failure; the next load reconciles.
        }
      }
    } finally {
      if (mutationGeneration === preferenceMutationGeneration.current) {
        preferenceMutationInFlight.current = false;
      }
    }
  };

  const runNow = async () => {
    if (!agent || !home || !home.actions.canRunNow || runBusy) return;
    const attemptKey = `${agent.id}:home:run_now`;
    const idempotencyKey = getOrCreateStudioActionKey(
      attemptKey,
      homeActionIdempotencyKeys.current,
    );
    setRunBusy(true);
    setRunError("");
    try {
      await launchApi.actOnAgentHome(agentLocator(agent), {
        action: "run_now",
        expectedRevision: home.revision,
        idempotencyKey,
      });
      clearStudioActionKey(attemptKey, homeActionIdempotencyKeys.current);
      live.reload();
    } catch (reason) {
      if (!retainIdempotencyKeyAfterFailure(reason)) {
        clearStudioActionKey(attemptKey, homeActionIdempotencyKeys.current);
      }
      setRunError(errorMessage(reason));
    } finally {
      setRunBusy(false);
    }
  };

  const activate = async () => {
    if (!agent || !home || !home.actions.canActivate || activationBusy) return;
    const attemptKey = `${agent.id}:home:activate`;
    const idempotencyKey = getOrCreateStudioActionKey(
      attemptKey,
      homeActionIdempotencyKeys.current,
    );
    setActivationBusy(true);
    setActivationError("");
    try {
      await launchApi.actOnAgentHome(agentLocator(agent), {
        action: "activate",
        expectedRevision: home.revision,
        idempotencyKey,
      });
      clearStudioActionKey(attemptKey, homeActionIdempotencyKeys.current);
      live.reload();
    } catch (reason) {
      if (!retainIdempotencyKeyAfterFailure(reason)) {
        clearStudioActionKey(attemptKey, homeActionIdempotencyKeys.current);
      }
      setActivationError(errorMessage(reason));
    } finally {
      setActivationBusy(false);
    }
  };

  // Agent-wide pause/resume ride the safety lane (no saga, no revision CAS):
  // the stop switch stays available whatever state the Home aggregate is in.
  const pauseAgent = async () => {
    if (!agent || agentPauseBusy) return;
    setAgentPauseBusy(true);
    setAgentPauseNotice("");
    try {
      const outcome = await launchApi.pauseAgentHomeAgentWide(
        agentLocator(agent),
      );
      setAgentPauseNotice(
        outcome.pausedRoutineIds.length === 0
          ? "Nothing was active — the agent is already stopped."
          : `Paused ${outcome.pausedRoutineIds.length} routine${
            outcome.pausedRoutineIds.length === 1 ? "" : "s"
          }. In-flight work finishes; no new wakes will fire.`,
      );
      live.reload();
    } catch (reason) {
      setAgentPauseNotice(errorMessage(reason));
    } finally {
      setAgentPauseBusy(false);
    }
  };

  const resumeAgent = async () => {
    if (!agent || agentPauseBusy) return;
    setAgentPauseBusy(true);
    setAgentPauseNotice("");
    try {
      const outcome = await launchApi.resumeAgentHomeAgentWide(
        agentLocator(agent),
      );
      const blockedNote = outcome.blocked.length > 0
        ? ` ${outcome.blocked.length} stayed paused: ${
          outcome.blocked.map((item) => item.reason)[0]
        }`
        : "";
      setAgentPauseNotice(
        outcome.resumedRoutineIds.length === 0 && outcome.blocked.length === 0
          ? "Nothing to resume — no agent-wide pause is in effect."
          : `Resumed ${outcome.resumedRoutineIds.length} routine${
            outcome.resumedRoutineIds.length === 1 ? "" : "s"
          }.${blockedNote}`,
      );
      live.reload();
    } catch (reason) {
      setAgentPauseNotice(errorMessage(reason));
    } finally {
      setAgentPauseBusy(false);
    }
  };

  const approveSetupCapability = async (requirementId: string) => {
    if (!agent || !home || setupActionBusy) return;
    const capabilityId = agentStudioSetupCapabilityId(home, requirementId);
    if (!capabilityId || !home.actions.canApproveCapabilities) {
      setSetupActionError(
        "This capability is no longer awaiting owner approval. Refresh setup and review the current release.",
      );
      return;
    }
    const attemptKey =
      `${agent.id}:home:approve_capabilities:${capabilityId}`;
    const idempotencyKey = getOrCreateStudioActionKey(
      attemptKey,
      homeActionIdempotencyKeys.current,
    );
    setSetupActionBusy(requirementId);
    setSetupActionError("");
    try {
      await launchApi.actOnAgentHome(agentLocator(agent), {
        action: "approve_capabilities",
        capabilityIds: [capabilityId],
        expectedRevision: home.revision,
        idempotencyKey,
      });
      clearStudioActionKey(attemptKey, homeActionIdempotencyKeys.current);
      live.reload();
    } catch (reason) {
      if (!retainIdempotencyKeyAfterFailure(reason)) {
        clearStudioActionKey(attemptKey, homeActionIdempotencyKeys.current);
      }
      setSetupActionError(errorMessage(reason));
    } finally {
      setSetupActionBusy(null);
    }
  };

  const remediateSetupGrant = async (requirementId: string) => {
    if (!agent || !home || setupActionBusy) return;
    setSetupActionBusy(requirementId);
    setSetupActionError("");
    try {
      await remediateAgentStudioSetupGrant(
        launchApi,
        home,
        requirementId,
      );
      live.reload();
    } catch (reason) {
      setSetupActionError(errorMessage(reason));
    } finally {
      setSetupActionBusy(null);
    }
  };

  const loadMoreActivity = async () => {
    if (!agent || !activityCursor || activityLoading) return;
    const requestGeneration = activityRequestGeneration.current;
    setActivityLoading(true);
    try {
      const response = await launchApi.agentActivity(agentLocator(agent), {
        cursor: activityCursor,
        limit: 20,
      });
      if (requestGeneration !== activityRequestGeneration.current) return;
      setActivity((current) =>
        mergeAgentActivityPages(current, response.activity)
      );
      setActivityCursor(response.nextCursor);
      setActivityError("");
    } catch (reason) {
      if (requestGeneration === activityRequestGeneration.current) {
        setActivityError(errorMessage(reason));
      }
    } finally {
      if (requestGeneration === activityRequestGeneration.current) {
        setActivityLoading(false);
      }
    }
  };

  const status = studioStatus(home);
  const returnToAlerts = new URLSearchParams(location.search).get("from") ===
    "alerts";
  return (
    <AgentStudioShell
      agentName={agent?.name ?? "Loading Agent"}
      badges={{
        ...(attentionCount ? { alerts: attentionCount } : {}),
      }}
      canRunNow={Boolean(home?.actions.canRunNow)}
      onBack={() => dismissLaunchWorkspace(navigate, returnToAlerts)}
      onPaneChange={(next) => openPane(next, null)}
      onRunNow={() => void runNow()}
      onThemeChange={setTheme}
      pane={pane}
      releaseVersion={home?.release.live?.version ?? null}
      runBusy={runBusy}
      statusLabel={status.label}
      statusTone={status.tone}
      theme={theme}
    >
      {!agent
        ? <StudioLoading error={live.error} />
        : (
          <>
            <AgentStudioPaneContent
              activity={activity}
              activityCursor={activityCursor}
              activityLoading={activityLoading}
              activationBusy={activationBusy}
              agent={agent}
              agentPauseBusy={agentPauseBusy}
              agentPauseNotice={agentPauseNotice}
              home={home}
              item={item}
              live={live}
              onAttentionCountChange={setAttentionCount}
              onActivate={() => void activate()}
              onPauseAgent={() => void pauseAgent()}
              onResumeAgent={() => void resumeAgent()}
              onApproveSetupCapability={(requirementId) =>
                void approveSetupCapability(requirementId)}
              onLoadMoreActivity={() => void loadMoreActivity()}
              onNavigate={navigate}
              onOpenHandoff={openHandoff}
              onOpenPane={openPane}
              onRemediateSetupGrant={(requirementId) =>
                void remediateSetupGrant(requirementId)}
              onRunNow={() => void runNow()}
              onToggleFavorite={(id) => void toggleFavorite(id)}
              pane={pane}
              preferences={preferences}
              setupActionBusy={setupActionBusy}
              setupActionError={setupActionError}
              handoffDescriptions={handoffDescriptions}
              onHandoffDescriptionsChange={setHandoffDescriptions}
            />
            {runError
              ? <p className="agent-studio-inline-error" role="alert">{runError}</p>
              : null}
            {activationError
              ? (
                <p className="agent-studio-inline-error" role="alert">
                  {activationError}
                </p>
              )
              : null}
            {preferencesError
              ? (
                <p className="agent-studio-inline-error" role="alert">
                  {preferencesError}
                </p>
              )
              : null}
            {activityError && pane === "activity"
              ? (
                <p className="agent-studio-inline-error" role="alert">
                  {activityError}
                </p>
              )
              : null}
          </>
        )}
    </AgentStudioShell>
  );
}

function AgentStudioPaneContent({
  activity,
  activityCursor,
  activityLoading,
  activationBusy,
  agent,
  agentPauseBusy,
  agentPauseNotice,
  home,
  item,
  live,
  onAttentionCountChange,
  onActivate,
  onPauseAgent,
  onResumeAgent,
  onApproveSetupCapability,
  onLoadMoreActivity,
  onNavigate,
  onOpenHandoff,
  onOpenPane,
  onRemediateSetupGrant,
  onRunNow,
  onToggleFavorite,
  pane,
  preferences,
  setupActionBusy,
  setupActionError,
  handoffDescriptions,
  onHandoffDescriptionsChange,
}: {
  activity: LaunchAgentActivityPreview | null;
  activityCursor: string | null;
  activityLoading: boolean;
  activationBusy: boolean;
  agent: LaunchAgentSummary;
  agentPauseBusy: boolean;
  agentPauseNotice: string;
  home: LaunchPageProps["live"]["data"]["agentHome"];
  item?: string;
  live: LaunchPageProps["live"];
  onAttentionCountChange: (count: number) => void;
  onActivate: () => void;
  onPauseAgent: () => void;
  onResumeAgent: () => void;
  onApproveSetupCapability: (requirementId: string) => void;
  onLoadMoreActivity: () => void;
  onNavigate: LaunchPageProps["navigate"];
  onOpenHandoff: (
    pane: AgentStudioPane,
    intent: "interface" | "function" | "routine",
    description?: string,
  ) => void;
  onOpenPane: (
    pane: AgentStudioPane,
    item?: string | null,
    replace?: boolean,
  ) => void;
  onRemediateSetupGrant: (requirementId: string) => void;
  onRunNow: () => void;
  onToggleFavorite: (interfaceId: string) => void;
  pane: AgentStudioPane;
  preferences: LaunchAgentPreferences | null;
  setupActionBusy: string | null;
  setupActionError: string;
  handoffDescriptions: Partial<Record<AgentStudioHandoffIntent, string>>;
  onHandoffDescriptionsChange: (
    descriptions: Partial<Record<AgentStudioHandoffIntent, string>>,
  ) => void;
}): ReactElement {
  const interfaces = agent.interfaces ?? [];
  const handoffIntent = studioHandoffIntent(item);
  if (handoffIntent) {
    return (
      <AgentStudioHandoff
        createCredential={createStudioHandoffCredential}
        draftStorageKey={`galactic.agent-studio.handoff:${agent.id}`}
        initialDescriptions={handoffDescriptions}
        initialIntent={handoffIntent}
        onBack={() => onOpenPane(pane, null, true)}
        onDescriptionChange={onHandoffDescriptionsChange}
        platformMcpUrl={`${launchApiOrigin()}/mcp/platform`}
        target={{
          capabilityGroupCount: null,
          functionCount: live.data.agentFunctions?.functions.length ?? null,
          id: agent.id,
          name: agent.name,
          releaseVersion: home?.release.live?.version ?? null,
          routineCount: live.data.agentRoutines?.routines.length ?? null,
          slug: agent.slug,
        }}
      />
    );
  }
  if (pane === "overview") {
    return home
      ? (
        <AgentStudioOverview
          endpoint={live.data.install?.agentInstall?.agentMcpUrl ??
            `${launchApiOrigin()}/mcp/${agent.id}`}
          home={home}
          interfaces={interfaces}
          favoriteInterfaceIds={preferences?.favoriteInterfaceIds ??
            home.preferences?.favoriteInterfaceIds ??
            []}
          activationBusy={activationBusy}
          agentPauseBusy={agentPauseBusy}
          agentPauseNotice={agentPauseNotice}
          onPauseAgent={onPauseAgent}
          onResumeAgent={onResumeAgent}
          onNavigate={onNavigate}
          onActivate={onActivate}
          onApproveSetupCapability={onApproveSetupCapability}
          onOpenPane={onOpenPane}
          onRemediateSetupGrant={onRemediateSetupGrant}
          setupActionBusy={setupActionBusy}
          setupActionError={setupActionError}
        />
      )
      : <StudioLoading error={live.data.agentHomeError} />;
  }
  if (pane === "interfaces") {
    return (
      <AgentStudioInterfaces
        agent={agent}
        favoriteInterfaceIds={preferences?.favoriteInterfaceIds ??
          home?.preferences?.favoriteInterfaceIds ??
          []}
        interfaces={interfaces}
        itemId={item}
        onAddInterface={() => onOpenHandoff("interfaces", "interface")}
        onItemChange={(interfaceId) =>
          onOpenPane("interfaces", interfaceId, interfaceId === null)}
        onToggleFavorite={onToggleFavorite}
      />
    );
  }
  if (pane === "approvals") {
    return (
      <AgentStudioContractBoundary
        body="Use the Agent’s published Interfaces for approval workflows it owns today. Galactic will show held work here once it can safely present the proposed action and resume the exact run."
        description="Work the Agent deliberately stopped before changing the world."
        details={[
          "What prompted the held action",
          "What the Agent proposes to do",
          "Approve, revise, or reject",
        ]}
        eyebrow="Not available for this Agent"
        heading="No Studio approvals are available yet."
        title="Approvals"
      />
    );
  }
  if (pane === "activity") {
    return (
      <AgentStudioActivity
        activity={activity}
        canRunNow={Boolean(home?.actions.canRunNow)}
        hasMore={Boolean(activityCursor)}
        loading={activityLoading}
        newAgent={Boolean(home && shouldShowAgentSetup(home))}
        onLoadMore={onLoadMoreActivity}
        onRunNow={onRunNow}
      />
    );
  }
  if (pane === "alerts") {
    if (!home) return <StudioLoading error={live.data.agentHomeError} />;
    if (!home.attention) {
      return (
        <AgentStudioContractBoundary
          body="This Agent’s current snapshot does not include its Alerts feed. Its routines can keep operating; refresh the Studio or use Activity for the evidence available now."
          description="Conditions, incidents, and reports that may need your attention."
          details={[]}
          eyebrow="Temporarily unavailable"
          heading="Alerts are unavailable right now."
          title="Alerts"
        />
      );
    }
    return (
      <OperatorAgentAlerts
        agent={agent}
        attention={home.attention}
        itemId={item}
        loadPage={(cursor) =>
          launchApi.agentAttention(agentLocator(agent), {
            cursor,
            limit: 50,
          })}
        onAttentionCountChange={onAttentionCountChange}
        onClearItem={() => onOpenPane("alerts", null)}
        onNavigate={onNavigate}
      />
    );
  }
  if (pane === "directive") {
    return home
      ? <AgentStudioDirective home={home} onOpenPane={onOpenPane} />
      : <StudioLoading error={live.data.agentHomeError} />;
  }
  if (pane === "routines") {
    return (
      <AgentStudioRoutines
        agentIdOrSlug={agentLocator(agent)}
        agentName={agent.name}
        error={live.data.agentRoutinesError}
        itemId={item}
        onAddRoutine={(starter?: AgentStudioRoutineStarter) =>
          onOpenHandoff(
            "routines",
            "routine",
            starter?.description ?? "",
          )}
        onChanged={() => live.reload()}
        onOpenRoutine={(routineId) =>
          onOpenPane("routines", routineId, routineId === null)}
        routines={live.data.agentRoutines}
      />
    );
  }
  if (pane === "knowledge") {
    return (
      <AgentStudioContractBoundary
        body="Use this Agent’s published Interfaces to manage its source data today. Studio will gather reliable working knowledge here when a compatible source is connected."
        description="Facts, open questions, citations, and contradictions this Agent can use while it works."
        details={[
          "Facts with source and confirmation status",
          "Open questions that need an answer",
          "Citations and conflicting information",
        ]}
        eyebrow="Not available for this Agent"
        heading="No Studio knowledge source is connected."
        title="Knowledge"
      />
    );
  }
  if (pane === "capabilities") {
    return (
      <section className="agent-studio-screen agent-studio-legacy-screen">
        <AgentStudioCapabilitiesIntro />
        <FunctionsPane
          agent={agent}
          functions={live.data.agentFunctions}
          itemId={item}
          live={live}
          onAddFunction={() => onOpenHandoff("capabilities", "function")}
          onNavigate={onNavigate}
        />
      </section>
    );
  }
  if (pane === "connections") {
    if (!home) return <StudioLoading error={live.data.agentHomeError} />;
    const access = home.access;
    if (!access) {
      return (
        <AgentStudioContractBoundary
          body="This Agent’s current snapshot does not include connection status. Secret values remain write-only and are never reconstructed from logs."
          description="Credentials, destinations, and services this Agent may reach."
          details={[]}
          eyebrow="Temporarily unavailable"
          heading="Connection status is unavailable right now."
          title="Connections"
        />
      );
    }
    return (
      <AgentStudioConnections
        access={access}
        agentIdOrSlug={agentLocator(agent)}
        agentName={agent.name}
        homeRevision={home.revision}
        itemId={item}
        onChanged={() => live.reload()}
        onOpenConsumer={(consumer) =>
          openAccessConsumer(onOpenPane, consumer)}
        onOpenItem={(itemId) =>
          onOpenPane("connections", itemId, itemId === null)}
      />
    );
  }
  if (pane === "compute") {
    return (
      <AgentComputePane
        agent={agent}
        itemId={item}
        onClearItem={() => onOpenPane("compute", null)}
      />
    );
  }
  if (pane === "limits") {
    return (
      <AgentStudioLimits
        agentIdOrSlug={agentLocator(agent)}
        capacity={home?.agentCapacity ?? live.data.agentCapacity}
        onSaved={live.reload}
      />
    );
  }
  return (
    <AgentSettingsPane
      agent={agent}
      identityReadOnly
      itemId={item}
      live={live}
      onClearItem={() => onOpenPane("settings", null)}
      showCapacity={false}
    />
  );
}

function StudioLoading({ error }: { error?: string }): ReactElement {
  return (
    <section className="agent-studio-loading" aria-busy={!error}>
      {error
        ? (
          <>
            <strong>Agent Studio could not load this view.</strong>
            <p>{error}</p>
          </>
        )
        : <><span /><span /><span /></>}
    </section>
  );
}

function readStudioTheme(): AgentStudioTheme {
  try {
    const stored = window.localStorage.getItem(STUDIO_THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Fall through to the system preference.
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function agentLocator(agent: LaunchAgentSummary): string {
  return agent.id || agent.slug;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function studioHandoffIntent(
  item: string | undefined,
): "interface" | "function" | "routine" | null {
  if (item === "handoff:interface") return "interface";
  if (item === "handoff:function") return "function";
  if (item === "handoff:routine") return "routine";
  return null;
}

function openAccessConsumer(
  onOpenPane: (pane: AgentStudioPane, item?: string | null) => void,
  consumer: LaunchAgentAccessConsumer,
): void {
  if (consumer.kind === "routine") {
    onOpenPane("routines", consumer.id);
  } else {
    onOpenPane("capabilities", consumer.id);
  }
}
