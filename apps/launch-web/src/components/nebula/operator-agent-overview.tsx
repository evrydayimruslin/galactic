import { Fragment, type ReactElement } from "react";

import type {
  LaunchAgentActivityItem,
  LaunchAgentActivityPreview,
  LaunchAgentAttentionItem,
  LaunchAgentHomeResponse,
  LaunchInterfaceSummary,
} from "../../../../../shared/contracts/launch.ts";
import { buildOperatorOverviewModel } from "../../lib/operator-overview-model";
import type { LaunchNavigate } from "../../lib/navigation";
import { Glyph } from "./glyph";

export interface OperatorAgentOverviewProps {
  home: LaunchAgentHomeResponse;
  interfaces: readonly LaunchInterfaceSummary[];
  activityExpanded?: boolean;
  activityLoading?: boolean;
  activityOverride?: LaunchAgentActivityPreview | null;
  activityNextCursor?: string | null;
  onEditDirective: () => void;
  onCloseActivity: () => void;
  onOpenActivity: () => void;
  onLoadMoreActivity?: () => void;
  onOpenInterface: (item: LaunchInterfaceSummary) => void;
  onNavigate: LaunchNavigate;
}

function readableTime(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function ActivityRow(
  { item }: { item: LaunchAgentActivityItem },
): ReactElement {
  const time = readableTime(item.scheduledAt || item.occurredAt);
  const content = (
    <>
      <span className="neb-operator-activity-main">
        <strong>{item.title}</strong>
        {item.summary ? <small>{item.summary}</small> : null}
      </span>
      <span className="neb-operator-activity-meta">
        {time ? <time dateTime={item.scheduledAt || item.occurredAt || ""}>{time}</time> : null}
        <span>{item.status}</span>
      </span>
    </>
  );
  return <div className="neb-operator-activity-row">{content}</div>;
}

function NavigableActivityRow(
  { item, onNavigate }: {
    item: LaunchAgentActivityItem;
    onNavigate: LaunchNavigate;
  },
): ReactElement {
  if (!item.destination?.href) {
    return <ActivityRow item={item} />;
  }
  const href = item.destination.href;
  return (
    <a
      className="neb-operator-activity-row"
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(href, { scroll: "preserve" });
      }}
    >
      <span className="neb-operator-activity-main">
        <strong>{item.title}</strong>
        {item.summary ? <small>{item.summary}</small> : null}
      </span>
      <span className="neb-operator-activity-meta">
        {readableTime(item.scheduledAt || item.occurredAt)
          ? (
            <time dateTime={item.scheduledAt || item.occurredAt || ""}>
              {readableTime(item.scheduledAt || item.occurredAt)}
            </time>
          )
          : null}
        <span>{item.status}</span>
      </span>
    </a>
  );
}

function AttentionCard(
  { item, onNavigate }: {
    item: LaunchAgentAttentionItem;
    onNavigate: LaunchNavigate;
  },
): ReactElement {
  return (
    <article
      className={`neb-operator-attention-card ${item.type} ${item.severity}`}
    >
      <div className="neb-operator-attention-copy">
        <strong>{item.brief.headline}</strong>
        {item.brief.impact ? <p>{item.brief.impact}</p> : null}
        {item.brief.recommendedNextMove
          ? (
            <p className="neb-operator-next-move">
              <span>Recommended next move</span>
              {item.brief.recommendedNextMove}
            </p>
          )
          : null}
      </div>
      {item.actions.length > 0
        ? (
          <div className="neb-operator-attention-actions">
            {item.actions.flatMap((action) =>
              action.destination?.href
                ? [
                  <a
                    className={`neb-btn-sm ${action.emphasis}`}
                    href={action.destination.href}
                    key={action.id}
                    onClick={(event) => {
                      event.preventDefault();
                      onNavigate(action.destination!.href, {
                        scroll: "preserve",
                      });
                    }}
                  >
                    {action.label}
                  </a>,
                ]
                : []
            )}
          </div>
        )
        : null}
    </article>
  );
}

export function OperatorAgentOverview({
  activityExpanded = false,
  activityLoading = false,
  activityNextCursor = null,
  activityOverride = null,
  home,
  interfaces,
  onEditDirective,
  onCloseActivity,
  onOpenActivity,
  onLoadMoreActivity,
  onOpenInterface,
  onNavigate,
}: OperatorAgentOverviewProps): ReactElement {
  const model = buildOperatorOverviewModel(home, interfaces);
  const directive = home.directive ?? {
    mission: home.responsibility.mission,
    source: "managed_routines" as const,
    sourceRoutineId: null,
    cadence: home.responsibility.cadence,
    reporting: home.responsibility.reporting,
  };
  const activity = activityOverride ?? home.activity;
  const operating = home.operatingSummary;

  const sections = {
    attention: (
      <section
        aria-labelledby="neb-operator-attention"
        className="neb-overview-block neb-operator-attention"
      >
        <div className="neb-overview-section-head compact">
          <div className="neb-ov-label" id="neb-operator-attention">
            Attention
          </div>
          <span className="neb-rail-count">{model.attentionCount}</span>
        </div>
        <div className="neb-operator-attention-list">
          {model.attention.map((item) => (
            <AttentionCard item={item} key={item.id} onNavigate={onNavigate} />
          ))}
        </div>
      </section>
    ),
    favorites: (
      <section
        aria-labelledby="neb-operator-favorites"
        className="neb-overview-block"
      >
        <div className="neb-ov-label" id="neb-operator-favorites">
          Favorites
        </div>
        <div className="neb-overview-interface-grid">
          {model.favoriteInterfaces.map((item) => (
            <button
              className="neb-overview-interface"
              key={item.id}
              onClick={() => onOpenInterface(item)}
              type="button"
            >
              <Glyph name="star" />
              <span>
                <strong>{item.label}</strong>
                <small>
                  {item.description ??
                    `${item.functions.length} connected function${
                      item.functions.length === 1 ? "" : "s"
                    }`}
                </small>
              </span>
            </button>
          ))}
        </div>
      </section>
    ),
    directive: (
      <section
        aria-labelledby="neb-operator-directive"
        className="neb-overview-identity neb-operator-directive"
      >
        <div className="neb-overview-section-head">
          <div>
            <div className="neb-ov-label" id="neb-operator-directive">
              Directive
            </div>
            <strong>
              {directive.mission || "Define what this Agent should own."}
            </strong>
          </div>
          <button
            className="neb-btn-sm"
            disabled={!home.actions.canEditRoutine}
            onClick={onEditDirective}
            type="button"
          >
            Edit
          </button>
        </div>
        {operating
          ? (
            <div className="neb-overview-status-line">
              <span
                className={`neb-status-dot${
                  operating.readiness.working ? "" : " paused"
                }`}
              />
              <span>
                {operating.label}
                {operating.detail ? <small>{operating.detail}</small> : null}
              </span>
            </div>
          )
          : null}
      </section>
    ),
    activity: (
      <section
        aria-labelledby="neb-operator-activity"
        className="neb-overview-block neb-operator-activity"
      >
        <div className="neb-ov-label" id="neb-operator-activity">
          Activity
        </div>
        {activity?.upNext
          ? (
            <div className="neb-operator-activity-group">
              <span className="neb-operator-activity-phase">Up next</span>
              <NavigableActivityRow item={activity.upNext} onNavigate={onNavigate} />
            </div>
          )
          : null}
        {activity?.now.length
          ? (
            <div className="neb-operator-activity-group">
              <span className="neb-operator-activity-phase">Now</span>
              {activity.now.map((item) => (
                <NavigableActivityRow
                  item={item}
                  key={item.id}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          )
          : null}
        {activity?.recent.length
          ? (
            <div className="neb-operator-activity-group">
              <span className="neb-operator-activity-phase">Recent</span>
              {(activityExpanded ? activity.recent : activity.recent.slice(0, 3))
                .map((item) => (
                <NavigableActivityRow
                  item={item}
                  key={item.id}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          )
          : null}
        {!activityExpanded
          ? (
            <button
              className="neb-operator-view-all"
              onClick={onOpenActivity}
              type="button"
            >
              View all activity
            </button>
          )
          : (
            <div className="neb-operator-activity-controls">
              {activityNextCursor && onLoadMoreActivity
                ? (
                  <button
                    className="neb-operator-view-all"
                    disabled={activityLoading}
                    onClick={onLoadMoreActivity}
                    type="button"
                  >
                    {activityLoading ? "Loading…" : "Load more activity"}
                  </button>
                )
                : (
                  <span className="neb-operator-activity-end">
                    {activityLoading
                      ? "Loading activity…"
                      : "All activity shown"}
                  </span>
                )}
              <button
                className="neb-operator-view-all"
                onClick={onCloseActivity}
                type="button"
              >
                Show less
              </button>
            </div>
          )}
      </section>
    ),
    signals: (
      <section
        aria-labelledby="neb-operator-signals"
        className="neb-overview-block neb-operator-signals"
      >
        <div className="neb-ov-label" id="neb-operator-signals">
          Review
        </div>
        {home.release.candidate
          ? (
            <a
              className="neb-operator-signal"
              href={`/agents/${encodeURIComponent(home.agent.slug)}?pane=settings&item=release`}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(
                  `/agents/${encodeURIComponent(home.agent.slug)}?pane=settings&item=release`,
                  { scroll: "preserve" },
                );
              }}
            >
              <span>A tested release is ready for review</span>
              <strong>{home.release.candidate.version}</strong>
            </a>
          )
          : null}
        {home.capacity?.state === "low" ||
            home.capacity?.state === "waiting" ||
            home.agentCapacity?.state === "low" ||
            home.agentCapacity?.state === "waiting"
          ? (
            <a
              className="neb-operator-signal"
              href={`/agents/${encodeURIComponent(home.agent.slug)}?pane=settings&item=rate-limits`}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(
                  `/agents/${encodeURIComponent(home.agent.slug)}?pane=settings&item=rate-limits`,
                  { scroll: "preserve" },
                );
              }}
            >
              <span>Usage capacity needs review</span>
              <strong>
                {home.agentCapacity?.state ?? home.capacity?.state}
              </strong>
            </a>
          )
          : null}
      </section>
    ),
  } satisfies Record<
    ReturnType<typeof buildOperatorOverviewModel>["sectionOrder"][number],
    ReactElement
  >;

  return (
    <section className="neb-modal-pane active neb-agent-overview neb-operator-overview">
      {model.sectionOrder.map((section) => (
        <Fragment key={section}>{sections[section]}</Fragment>
      ))}
    </section>
  );
}
