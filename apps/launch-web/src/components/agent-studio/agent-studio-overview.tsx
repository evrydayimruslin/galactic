import { type ReactElement, useState } from "react";

import type {
  LaunchAgentActivityItem,
  LaunchAgentAttentionItem,
  LaunchAgentHomeResponse,
  LaunchInterfaceSummary,
} from "../../../../../shared/contracts/launch.ts";
import type { AgentStudioPane } from "../../lib/agent-studio-route";
import {
  agentStudioSetupCapabilityId,
  agentStudioSetupGrantRequest,
  shouldShowAgentSetup,
} from "../../lib/agent-studio-state";
import type { LaunchNavigate } from "../../lib/navigation";
import { safeAttentionDestinationHref } from "../nebula/operator-agent-alerts";

interface AgentStudioOverviewProps {
  activationBusy: boolean;
  agentPauseBusy: boolean;
  agentPauseNotice: string;
  endpoint: string | null;
  favoriteInterfaceIds: readonly string[];
  home: LaunchAgentHomeResponse;
  interfaces: readonly LaunchInterfaceSummary[];
  onActivate: () => void;
  onApproveSetupCapability: (requirementId: string) => void;
  onNavigate: LaunchNavigate;
  onOpenPane: (pane: AgentStudioPane, item?: string | null) => void;
  onPauseAgent: () => void;
  onRemediateSetupGrant: (requirementId: string) => void;
  onResumeAgent: () => void;
  setupActionBusy: string | null;
  setupActionError: string;
}

export function AgentStudioOverview({
  activationBusy,
  agentPauseBusy,
  agentPauseNotice,
  endpoint,
  favoriteInterfaceIds,
  home,
  interfaces,
  onActivate,
  onApproveSetupCapability,
  onNavigate,
  onOpenPane,
  onPauseAgent,
  onRemediateSetupGrant,
  onResumeAgent,
  setupActionBusy,
  setupActionError,
}: AgentStudioOverviewProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const [interfacePage, setInterfacePage] = useState(0);
  const favoriteIds = new Set(favoriteInterfaceIds);
  const pinned = interfaces.filter((item) => favoriteIds.has(item.id));
  const interfacePageCount = Math.ceil(pinned.length / 2);
  const visibleInterfacePage = Math.min(
    interfacePage,
    Math.max(0, interfacePageCount - 1),
  );
  const visiblePinned = pinned.slice(
    visibleInterfacePage * 2,
    visibleInterfacePage * 2 + 2,
  );
  const attention = home.attention?.items ?? [];
  const operating = home.operatingSummary;
  const activity = home.activity?.recent.slice(0, 5) ?? [];
  const candidate = home.release.candidate;
  const candidatePresentation = candidate
    ? candidateSignal(candidate)
    : null;
  const showSetup = shouldShowAgentSetup(home);
  const agentCapacityNeedsReview = home.agentCapacity?.state === "low" ||
    home.agentCapacity?.state === "waiting";
  const accountCapacityNeedsReview = home.capacity?.state === "low" ||
    home.capacity?.state === "waiting";
  const needCount = (home.attention?.openCount ?? attention.length) +
    (candidate ? 1 : 0) +
    (agentCapacityNeedsReview ? 1 : 0) +
    (accountCapacityNeedsReview ? 1 : 0);
  const hasNeeds = attention.length > 0 ||
    Boolean(candidate) ||
    agentCapacityNeedsReview ||
    accountCapacityNeedsReview;
  const matureDescription = needCount === 0
    ? `What ${home.agent.name} is doing right now, and whether it needs anything from you.`
    : needCount === 1
    ? `What ${home.agent.name} is doing right now, and the thing it needs from you.`
    : needCount === 2
    ? `What ${home.agent.name} is doing right now, and the two things it needs from you.`
    : `What ${home.agent.name} is doing right now, and the ${needCount} things it needs from you.`;

  const copyEndpoint = async () => {
    if (!endpoint || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="agent-studio-screen agent-studio-overview">
      <StudioPageHeader
        description={showSetup
          ? "Four steps until this agent can work without you. It cannot reach anyone outside Galactic until they are done."
          : matureDescription}
        title={showSetup ? `Set up ${home.agent.name}` : "Overview"}
      />
      {!showSetup
        ? (
          <>
            <div className="agent-studio-status-plate">
              <section className="agent-studio-plate-cell interfaces">
                <div className="agent-studio-interface-heading">
                  <div className="agent-studio-cell-label">Interfaces</div>
                  {interfacePageCount > 1
                    ? (
                      <span>
                        <button
                          aria-label="Previous favorite Interfaces"
                          disabled={visibleInterfacePage === 0}
                          onClick={() =>
                            setInterfacePage((page) => Math.max(0, page - 1))}
                          type="button"
                        >
                          ↑
                        </button>
                        <button
                          aria-label="Next favorite Interfaces"
                          disabled={visibleInterfacePage >=
                            interfacePageCount - 1}
                          onClick={() =>
                            setInterfacePage((page) =>
                              Math.min(interfacePageCount - 1, page + 1)
                            )}
                          type="button"
                        >
                          ↓
                        </button>
                      </span>
                    )
                    : null}
                </div>
                <div className="agent-studio-interface-stack">
                  {visiblePinned.map((item) => (
                    <button
                      className="agent-studio-interface-tile"
                      key={item.id}
                      onClick={() => onOpenPane("interfaces", item.id)}
                      type="button"
                    >
                      <span>
                        <strong>{item.label}</strong>
                        <small>
                          {item.functions.length} function{
                            item.functions.length === 1 ? "" : "s"
                          }
                        </small>
                      </span>
                      <em>
                        {item.description ??
                          "Open this release-declared interface."}
                      </em>
                    </button>
                  ))}
                  {pinned.length === 0
                    ? (
                      <button
                        className="agent-studio-empty-tile"
                        onClick={() => onOpenPane("interfaces")}
                        type="button"
                      >
                        Pin an interface to keep it here.
                      </button>
                    )
                    : null}
                </div>
              </section>
              <section className="agent-studio-plate-cell now">
                <div className="agent-studio-cell-label">Right now</div>
                <div className="agent-studio-now-state">
                  <span
                    className={`agent-studio-dot${
                      operating?.readiness.working ? "" : " waiting"
                    }`}
                  />
                  <strong>{operating?.label ?? "Loading state"}</strong>
                </div>
                {operating?.detail
                  ? <p>{operating.detail}</p>
                  : null}
                <strong className="agent-studio-run-count">
                  {home.recentRuns.length} recent run{
                    home.recentRuns.length === 1 ? "" : "s"
                  }
                </strong>
                <p>
                  {home.state.nextRunAt
                    ? `Next event ${relativeTime(home.state.nextRunAt)}`
                    : "Waiting for the next declared event"}
                </p>
                <div className="agent-studio-pause-controls">
                  {home.actions.canPause
                    ? (
                      <button
                        aria-label="Pause this agent"
                        disabled={agentPauseBusy}
                        onClick={onPauseAgent}
                        type="button"
                      >
                        {agentPauseBusy ? "Pausing…" : "Pause agent"}
                      </button>
                    )
                    : null}
                  {operating?.mode === "paused"
                    ? (
                      <button
                        aria-label="Resume this agent"
                        disabled={agentPauseBusy}
                        onClick={onResumeAgent}
                        type="button"
                      >
                        {agentPauseBusy ? "Resuming…" : "Resume agent"}
                      </button>
                    )
                    : null}
                  {agentPauseNotice
                    ? (
                      <p className="agent-studio-pause-notice" role="status">
                        {agentPauseNotice}
                      </p>
                    )
                    : null}
                </div>
              </section>
              <section className="agent-studio-plate-cell consuming">
                <div className="agent-studio-cell-label">
                  What it is consuming
                </div>
                <ConsumptionMeter
                  capNote={galacticCapNote(home)}
                  label="Galactic pool"
                  percent={galacticUsagePercent(home)}
                  value={galacticUsageLabel(home)}
                />
                <ConsumptionMeter
                  capNote="Estimated inference cost is not available yet"
                  label="Inference, your key"
                  percent={null}
                  value="—"
                />
              </section>
            </div>

            {hasNeeds
              ? (
                <section className="agent-studio-overview-section">
                  <div className="agent-studio-section-label">Needs you</div>
                  <div className="agent-studio-needs-list">
                    {attention.slice(0, 3).map((item) => (
                      <AttentionRow
                        item={item}
                        key={item.id}
                        agent={home.agent}
                        onNavigate={onNavigate}
                        onOpenAlerts={() =>
                          onOpenPane("alerts", item.id)}
                      />
                    ))}
                    {candidate
                      ? (
                        <StudioSignalRow
                          action="Review"
                          detail={candidatePresentation?.detail ?? ""}
                          onOpen={() =>
                            onOpenPane(
                              "settings",
                              `release:${candidate.version}`,
                            )}
                          title={candidatePresentation?.title ?? ""}
                        />
                      )
                      : null}
                    {agentCapacityNeedsReview
                      ? (
                        <StudioSignalRow
                          action="Review"
                          detail="This Agent is close to, or waiting on, its Galactic capacity ceiling."
                          onOpen={() => onOpenPane("limits")}
                          title="Galactic capacity needs review"
                        />
                      )
                      : null}
                    {accountCapacityNeedsReview
                      ? (
                        <StudioSignalRow
                          action="Review"
                          detail="The shared Galactic account pool is close to, or waiting on, its current window."
                          onOpen={() => onOpenPane("limits")}
                          title="Shared Galactic pool needs review"
                        />
                      )
                      : null}
                  </div>
                </section>
              )
              : null}

            <section className="agent-studio-overview-section">
              <div className="agent-studio-section-head">
                <span className="agent-studio-section-label">
                  Latest actions
                </span>
                <button
                  className="agent-studio-text-action"
                  onClick={() => onOpenPane("activity")}
                  type="button"
                >
                  See all activity →
                </button>
              </div>
              <div className="agent-studio-ruled-list">
                {activity.map((item) => (
                  <ActivityRow item={item} key={item.id} />
                ))}
                {activity.length === 0
                  ? (
                    <div className="agent-studio-list-empty">
                      No completed work has been recorded yet.
                    </div>
                  )
                  : null}
              </div>
            </section>

            <section className="agent-studio-mission-card">
              <div className="agent-studio-section-head">
                <span className="agent-studio-section-label">Mission</span>
                <button
                  className="agent-studio-text-action"
                onClick={() => onOpenPane("directive")}
                type="button"
              >
                  Open source
                </button>
              </div>
              <p>
                {home.directive?.mission ||
                  home.responsibility.mission ||
                  "Define what this Agent should own."}
              </p>
              <button
                className="agent-studio-mission-meta"
                onClick={() => onOpenPane("directive")}
                type="button"
              >
                {home.directive?.source === "primary_routine"
                  ? "Defined by its primary routine →"
                  : "Derived from its managed routines →"}
              </button>
            </section>

            {endpoint
              ? (
                <section className="agent-studio-endpoint-card">
                  <div>
                    <div className="agent-studio-section-label">
                      Reachable by other systems at
                    </div>
                    <code>{endpoint}</code>
                  </div>
                  <button onClick={() => void copyEndpoint()} type="button">
                    {copied ? "Copied" : "Copy"}
                  </button>
                </section>
              )
              : null}
          </>
        )
        : (
          <AgentSetupPath
            activationBusy={activationBusy}
            home={home}
            onActivate={onActivate}
            onApproveSetupCapability={onApproveSetupCapability}
            onNavigate={onNavigate}
            onOpenPane={onOpenPane}
            onRemediateSetupGrant={onRemediateSetupGrant}
            setupActionBusy={setupActionBusy}
            setupActionError={setupActionError}
          />
        )}
    </section>
  );
}

export function StudioPageHeader({
  aside,
  description,
  title,
}: {
  aside?: ReactElement | null;
  description: string;
  title: string;
}): ReactElement {
  return (
    <header className="agent-studio-page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {aside ?? null}
    </header>
  );
}

function ConsumptionMeter({
  capNote,
  label,
  percent,
  value,
}: {
  capNote: string;
  label: string;
  percent: number | null;
  value: string;
}): ReactElement {
  return (
    <div className="agent-studio-consumption">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="agent-studio-meter" aria-hidden="true">
        <span style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} />
      </div>
      <small>{capNote}</small>
    </div>
  );
}

function AttentionRow({
  agent,
  item,
  onNavigate,
  onOpenAlerts,
}: {
  agent: LaunchAgentHomeResponse["agent"];
  item: LaunchAgentAttentionItem;
  onNavigate: LaunchNavigate;
  onOpenAlerts: () => void;
}): ReactElement {
  const action = item.actions
    .map((candidate) => ({
      candidate,
      href: safeAttentionDestinationHref(candidate.destination, agent),
    }))
    .find(({ href }) => Boolean(href));
  const act = () => {
    if (action?.href) {
      onNavigate(action.href, { scroll: "preserve" });
    } else {
      onOpenAlerts();
    }
  };
  return (
    <article className="agent-studio-needs-row">
      <span aria-hidden="true" />
      <div>
        <strong>{item.brief.headline}</strong>
        <p>
          {item.brief.impact ??
            item.brief.context ??
            "Open this item to review what the Agent needs."}
        </p>
      </div>
      <button onClick={act} type="button">
        {action?.candidate.label ??
          (item.brief.requiresDecision ? "Review" : "Open")}
      </button>
    </article>
  );
}

function StudioSignalRow({
  action,
  detail,
  onOpen,
  title,
}: {
  action: string;
  detail: string;
  onOpen: () => void;
  title: string;
}): ReactElement {
  return (
    <article className="agent-studio-needs-row">
      <span aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <button onClick={onOpen} type="button">{action}</button>
    </article>
  );
}

function ActivityRow({
  item,
}: {
  item: LaunchAgentActivityItem;
}): ReactElement {
  const date = item.occurredAt ?? item.scheduledAt;
  return (
    <div className="agent-studio-activity-summary-row">
      <time dateTime={date ?? undefined}>{shortTime(date)}</time>
      <span>
        <strong>{item.title}</strong>
        {item.summary ? <small>{item.summary}</small> : null}
      </span>
      <em data-status={item.status}>{item.status}</em>
    </div>
  );
}

function AgentSetupPath({
  activationBusy,
  home,
  onActivate,
  onApproveSetupCapability,
  onNavigate,
  onOpenPane,
  onRemediateSetupGrant,
  setupActionBusy,
  setupActionError,
}: {
  activationBusy: boolean;
  home: LaunchAgentHomeResponse;
  onActivate: () => void;
  onApproveSetupCapability: (requirementId: string) => void;
  onNavigate: LaunchNavigate;
  onOpenPane: (pane: AgentStudioPane, item?: string | null) => void;
  onRemediateSetupGrant: (requirementId: string) => void;
  setupActionBusy: string | null;
  setupActionError: string;
}): ReactElement {
  const connectionRequirement = home.setup.requirements.find((item) =>
    item.blocking &&
    (item.kind === "setting" || item.group === "Inference")
  );
  const authorityRequirement = home.setup.requirements.find((item) =>
    item.blocking && item !== connectionRequirement
  );
  const capabilityId = authorityRequirement
    ? agentStudioSetupCapabilityId(home, authorityRequirement.id)
    : null;
  const grantRequest = authorityRequirement?.kind === "grant"
    ? agentStudioSetupGrantRequest(home, authorityRequirement.id)
    : null;
  const openConnectionRequirement = () => {
    if (connectionRequirement?.destination?.startsWith("/")) {
      onNavigate(connectionRequirement.destination);
      return;
    }
    onOpenPane(
      "connections",
      connectionRequirement?.settingKey
        ? `setting:${connectionRequirement.settingKey}`
        : null,
    );
  };
  const steps = [
    {
      action: () => onOpenPane(
        "settings",
        home.release.candidate
          ? `release:${home.release.candidate.version}`
          : null,
      ),
      actionDisabled: false,
      actionLabel: "Continue",
      complete: Boolean(home.release.live),
      description:
        "A tested release defines the Agent's functions, interfaces, and routines.",
      label: "Publish a live release",
    },
    {
      action: openConnectionRequirement,
      actionDisabled: false,
      actionLabel: "Connect",
      complete: !connectionRequirement,
      description:
        "Set the credentials and destinations its release declares.",
      label: "Connect what it needs",
    },
    capabilityId && authorityRequirement
      ? {
        action: () =>
          onApproveSetupCapability(authorityRequirement.id),
        actionDisabled: !home.actions.canApproveCapabilities,
        actionLabel: setupActionBusy === authorityRequirement.id
          ? "Approving capability…"
          : "Approve capability",
        complete: false,
        description: [
          authorityRequirement.description ?? authorityRequirement.label,
          "This approves the declared capability only. Access to another Agent requires a separate, bounded grant.",
        ].join(" "),
        label: "Approve declared capability",
      }
      : authorityRequirement?.kind === "grant" && grantRequest
      ? {
        action: () => onRemediateSetupGrant(authorityRequirement.id),
        actionDisabled: false,
        actionLabel: setupActionBusy === authorityRequirement.id
          ? "Authorizing grant…"
          : "Authorize bounded grant",
        complete: false,
        description:
          `Authorize the separate grant required for ${authorityRequirement.label} (${grantRequest.targetFunction}). Galactic preserves an existing proposal's cap; otherwise it applies the 5,000-credit monthly default. The grant can be revoked later.`,
        label: "Authorize cross-Agent access",
      }
      : authorityRequirement?.kind === "grant"
      ? {
        action: () => onOpenPane("capabilities"),
        actionDisabled: false,
        actionLabel: "Review capabilities",
        complete: false,
        description:
          `${authorityRequirement.description ?? authorityRequirement.label} The target Agent or function no longer resolves. Update and retest the release before granting access.`,
        label: "Repair cross-Agent access",
      }
      : {
        action: () => onOpenPane("routines"),
        actionDisabled: false,
        actionLabel: "Review",
        complete: !authorityRequirement,
        description: authorityRequirement?.description ??
          "Review its authority and add a routine only if it should run on a schedule.",
        label: "Review authority and routines",
      },
    {
      action: onActivate,
      actionDisabled: !home.actions.canActivate,
      actionLabel: activationBusy ? "Activating…" : "Activate Agent",
      complete: home.state.lifecycle !== "needs_setup",
      description:
        "Activate this private release after its required setup is complete.",
      label: "Activate",
    },
  ];
  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => !step.complete),
  );
  return (
    <div className="agent-studio-setup">
      {steps.map((step, index) => {
        const active = index === activeIndex && !step.complete;
        return (
          <div className="agent-studio-setup-step" key={step.label}>
            <div className="agent-studio-setup-marker">
              <span className={step.complete ? "complete" : active ? "active" : ""}>
                {step.complete ? "✓" : index + 1}
              </span>
              {index < steps.length - 1 ? <i /> : null}
            </div>
            <div className={active ? "active" : ""}>
              <header>
                <strong>{step.label}</strong>
                <em>{step.complete ? "Complete" : active ? "Next" : "Waiting"}</em>
              </header>
              {active
                ? (
                  <>
                    <p>{step.description}</p>
                    <button
                      disabled={activationBusy || Boolean(setupActionBusy) ||
                        step.actionDisabled}
                      onClick={step.action}
                      type="button"
                    >
                      {step.actionLabel}
                    </button>
                    {index === 2 && setupActionError
                      ? (
                        <p
                          className="agent-studio-setup-error"
                          role="alert"
                        >
                          {setupActionError}
                        </p>
                      )
                      : null}
                  </>
                )
                : null}
            </div>
          </div>
        );
      })}
      <p className="agent-studio-setup-note">
        Until setup is complete, the Agent only runs within its effective
        release and granted authority.
      </p>
    </div>
  );
}

export function galacticUsagePercent(
  home: LaunchAgentHomeResponse,
): number | null {
  const capacity = home.agentCapacity;
  if (!capacity) return null;
  return capacity.weekly.capUsedPercent ?? null;
}

function galacticUsageLabel(home: LaunchAgentHomeResponse): string {
  const usage = galacticUsagePercent(home);
  return usage === null ? home.agentCapacity?.state ?? "—" : `${Math.round(usage)}%`;
}

function galacticCapNote(home: LaunchAgentHomeResponse): string {
  if (!home.agentCapacity) return "Capacity projection unavailable";
  const cap = home.agentCapacity?.capPercent;
  return `of this Agent's ${cap}% weekly ceiling`;
}

export function candidateSignal(
  candidate: NonNullable<LaunchAgentHomeResponse["release"]["candidate"]>,
): { detail: string; title: string } {
  if (candidate.reviewStatus === "unavailable") {
    return {
      detail:
        `Version ${candidate.version} is staged, but its review state is unavailable. Open Settings for diagnostics.`,
      title: "A staged release needs attention",
    };
  }
  if (!candidate.testedAt) {
    return {
      detail:
        `Version ${candidate.version} is staged without an available test timestamp. Review it before promotion.`,
      title: "A staged release needs review",
    };
  }
  if (
    candidate.reviewStatus === "owner_review_required" ||
    !candidate.canPromote
  ) {
    return {
      detail:
        `Version ${candidate.version} was tested and is waiting for owner review.`,
      title: "A staged release needs owner review",
    };
  }
  return {
    detail:
      `Version ${candidate.version} was tested and is ready for owner review.`,
    title: "A staged release is ready",
  };
}

function shortTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "at its scheduled time";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 90) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 90) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
