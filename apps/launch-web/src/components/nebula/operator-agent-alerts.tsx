import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  LaunchAgentAttentionActionRequest,
  LaunchAgentAttentionActionResponse,
  LaunchAgentAttentionItem,
  LaunchAgentAttentionLifecycle,
  LaunchAgentAttentionProjection,
  LaunchAgentSummary,
  LaunchNavigationTarget,
} from "../../../../../shared/contracts/launch.ts";
import { isAgentPane } from "../../lib/agent-pane-registry";
import { launchApi } from "../../lib/api";
import type { LaunchNavigate } from "../../lib/navigation";
import { Glyph } from "./glyph";

type AttentionLifecycleAction = Exclude<
  LaunchAgentAttentionActionRequest["action"],
  "execute_brief"
>;

interface AttentionActionOption {
  action: AttentionLifecycleAction;
  emphasis: "secondary" | "danger";
  label: string;
}

interface AttentionGroup {
  id: "active" | "snoozed" | "resolved" | "archived";
  items: LaunchAgentAttentionItem[];
  label: string;
}

export interface OperatorAgentAlertsProps {
  agent: Pick<LaunchAgentSummary, "id" | "name" | "slug">;
  attention: LaunchAgentAttentionProjection;
  embedded?: boolean;
  itemId?: string;
  onAttentionCountChange: (count: number) => void;
  onClearItem?: () => void;
  loadPage?: (
    cursor: string,
  ) => Promise<LaunchAgentAttentionProjection>;
  onNavigate: LaunchNavigate;
  query?: string;
}

interface PerformAttentionActionOptions {
  action: AttentionLifecycleAction;
  actOnAttention?: (
    notificationId: string,
    request: LaunchAgentAttentionActionRequest,
  ) => Promise<LaunchAgentAttentionActionResponse>;
  idempotencyKey?: string;
  now?: Date;
}

const SNOOZE_DURATION_MS = 60 * 60 * 1_000;

function randomIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `attention-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readableTime(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function isLifecycleCompatible(
  item: LaunchAgentAttentionItem,
  lifecycle: LaunchAgentAttentionLifecycle,
): boolean {
  return item.type === "report"
    ? lifecycle.state === "open" || lifecycle.state === "archived"
    : lifecycle.state === "open" ||
      lifecycle.state === "snoozed" ||
      lifecycle.state === "resolved";
}

function matchesDeepLink(
  item: LaunchAgentAttentionItem,
  itemId: string | undefined,
): boolean {
  return Boolean(
    itemId &&
      (item.notificationId === itemId ||
        item.id === itemId ||
        item.id === `attention:${itemId}`),
  );
}

export function resolveAttentionItemTarget(
  items: readonly LaunchAgentAttentionItem[],
  itemId: string | null | undefined,
): LaunchAgentAttentionItem | null {
  const normalized = itemId?.trim();
  if (!normalized) return null;
  return items.find((item) => matchesDeepLink(item, normalized)) ?? null;
}

function isActiveAttention(
  item: LaunchAgentAttentionItem,
  now: number,
): boolean {
  if (item.type === "report") {
    return item.lifecycle.state === "open" && !item.lifecycle.readAt;
  }
  if (item.lifecycle.state === "open") return true;
  return item.lifecycle.state === "snoozed" &&
    Boolean(
      item.lifecycle.snoozedUntil &&
        Date.parse(item.lifecycle.snoozedUntil) <= now,
    );
}

export function activeAttentionCount(
  items: readonly LaunchAgentAttentionItem[],
  now = Date.now(),
): number {
  return items.filter((item) => isActiveAttention(item, now)).length;
}

export function activeAttentionDecisionCount(
  items: readonly LaunchAgentAttentionItem[],
  now = Date.now(),
): number {
  return items.filter((item) =>
    item.brief.requiresDecision && isActiveAttention(item, now)
  ).length;
}

export function attentionCountAfterLifecycleTransition(
  exactCount: number,
  item: LaunchAgentAttentionItem,
  lifecycle: LaunchAgentAttentionLifecycle,
  now = Date.now(),
): number {
  if (!isLifecycleCompatible(item, lifecycle)) return exactCount;
  const wasActive = isActiveAttention(item, now);
  const nextItem = { ...item, lifecycle } as LaunchAgentAttentionItem;
  const isActive = isActiveAttention(nextItem, now);
  return Math.max(0, exactCount + Number(isActive) - Number(wasActive));
}

export function attentionDecisionCountAfterLifecycleTransition(
  exactCount: number,
  item: LaunchAgentAttentionItem,
  lifecycle: LaunchAgentAttentionLifecycle,
  now = Date.now(),
): number {
  return item.brief.requiresDecision
    ? attentionCountAfterLifecycleTransition(
      exactCount,
      item,
      lifecycle,
      now,
    )
    : exactCount;
}

export function appendAttentionItems(
  current: readonly LaunchAgentAttentionItem[],
  next: readonly LaunchAgentAttentionItem[],
): LaunchAgentAttentionItem[] {
  const byNotificationId = new Map(
    current.map((item) => [item.notificationId, item]),
  );
  for (const item of next) {
    if (!byNotificationId.has(item.notificationId)) {
      byNotificationId.set(item.notificationId, item);
    }
  }
  return [...byNotificationId.values()];
}

export function attentionLifecycleActions(
  item: LaunchAgentAttentionItem,
): AttentionActionOption[] {
  const actions: AttentionActionOption[] = [];
  if (!item.lifecycle.readAt) {
    actions.push({
      action: "read",
      emphasis: "secondary",
      label: "Mark read",
    });
  }
  if (item.type === "report") {
    if (item.lifecycle.state === "open") {
      actions.push({
        action: "archive",
        emphasis: "secondary",
        label: "Archive",
      });
    }
    return actions;
  }
  if (item.lifecycle.state === "open") {
    actions.push(
      {
        action: "snooze",
        emphasis: "secondary",
        label: "Snooze 1h",
      },
      {
        action: "resolve",
        emphasis: "secondary",
        label: "Resolve",
      },
    );
  } else {
    actions.push({
      action: "reopen",
      emphasis: "secondary",
      label: "Reopen",
    });
  }
  return actions;
}

export function buildAttentionLifecycleRequest(
  action: AttentionLifecycleAction,
  idempotencyKey: string,
  now = new Date(),
): LaunchAgentAttentionActionRequest {
  return {
    action,
    idempotencyKey,
    ...(action === "snooze"
      ? { snoozedUntil: new Date(now.getTime() + SNOOZE_DURATION_MS).toISOString() }
      : {}),
  };
}

export async function performAttentionLifecycleAction(
  notificationId: string,
  {
    action,
    actOnAttention = (id, request) =>
      launchApi.actOnAttention(id, request),
    idempotencyKey = randomIdempotencyKey(),
    now = new Date(),
  }: PerformAttentionActionOptions,
): Promise<LaunchAgentAttentionActionResponse> {
  return await actOnAttention(
    notificationId,
    buildAttentionLifecycleRequest(action, idempotencyKey, now),
  );
}

/**
 * Attention actions may only navigate within the same private Agent. Rebuild
 * the canonical route rather than forwarding a server/model-authored href.
 */
export function safeAttentionDestinationHref(
  destination: LaunchNavigationTarget | null | undefined,
  agent: Pick<LaunchAgentSummary, "id" | "slug">,
): string | null {
  if (
    !destination ||
    typeof destination.href !== "string" ||
    (destination.agentId && destination.agentId !== agent.id)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(destination.href, "https://galactic.internal");
  } catch {
    return null;
  }
  const expectedPath = `/agents/${encodeURIComponent(agent.slug)}`;
  if (
    parsed.origin !== "https://galactic.internal" ||
    parsed.pathname !== expectedPath ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }
  const entries = [...parsed.searchParams.entries()];
  if (
    entries.some(([key]) => key !== "pane" && key !== "item") ||
    new Set(entries.map(([key]) => key)).size !== entries.length
  ) {
    return null;
  }
  const pane = parsed.searchParams.get("pane");
  if (!isAgentPane(pane) || destination.pane !== pane) return null;
  const itemId = parsed.searchParams.get("item");
  if (itemId !== (destination.itemId ?? null)) return null;

  const canonical = new URLSearchParams({ pane });
  if (itemId) canonical.set("item", itemId);
  return `${expectedPath}?${canonical.toString()}`;
}

export function groupAttentionItems(
  items: readonly LaunchAgentAttentionItem[],
  now = Date.now(),
): AttentionGroup[] {
  const active: LaunchAgentAttentionItem[] = [];
  const snoozed: LaunchAgentAttentionItem[] = [];
  const resolved: LaunchAgentAttentionItem[] = [];
  const archived: LaunchAgentAttentionItem[] = [];
  for (const item of items) {
    if (isActiveAttention(item, now)) {
      active.push(item);
    } else if (item.lifecycle.state === "snoozed") {
      snoozed.push(item);
    } else if (item.lifecycle.state === "resolved") {
      resolved.push(item);
    } else if (item.lifecycle.state === "archived") {
      archived.push(item);
    }
  }
  return [
    { id: "active", items: active, label: "Needs attention" },
    { id: "snoozed", items: snoozed, label: "Snoozed" },
    { id: "resolved", items: resolved, label: "Resolved" },
    { id: "archived", items: archived, label: "Archived" },
  ].filter((group) => group.items.length > 0) as AttentionGroup[];
}

function lifecycleLabel(item: LaunchAgentAttentionItem): string {
  if (item.lifecycle.state === "snoozed") {
    const until = readableTime(item.lifecycle.snoozedUntil);
    return until ? `Snoozed until ${until}` : "Snoozed";
  }
  return item.lifecycle.state[0].toUpperCase() +
    item.lifecycle.state.slice(1);
}

function enrichmentLabel(item: LaunchAgentAttentionItem): string | null {
  if (item.enrichment.status === "ready") return "Contextualized";
  if (item.enrichment.status === "pending") return "Adding context";
  if (item.enrichment.status === "failed") return "Raw event";
  return null;
}

function AttentionCard({
  agent,
  busy,
  deepLinked,
  item,
  onAct,
  onNavigate,
  targetRef,
}: {
  agent: Pick<LaunchAgentSummary, "id" | "slug">;
  busy: string | null;
  deepLinked: boolean;
  item: LaunchAgentAttentionItem;
  onAct: (
    item: LaunchAgentAttentionItem,
    action: AttentionLifecycleAction,
  ) => void;
  onNavigate: LaunchNavigate;
  targetRef: { current: HTMLElement | null };
}): ReactElement {
  const occurredAt = readableTime(item.occurredAt);
  const enrichment = enrichmentLabel(item);
  const controls = attentionLifecycleActions(item);
  return (
    <article
      aria-label={`${item.type === "incident" ? "Incident" : "Report"}: ${item.brief.headline}`}
      className={[
        "neb-agent-attention-card",
        item.type,
        item.severity,
        item.lifecycle.readAt ? "read" : "unread",
        deepLinked ? "neb-deep-link-target" : "",
      ].filter(Boolean).join(" ")}
      data-state={item.lifecycle.state}
      id={`attention-${item.notificationId}`}
      ref={deepLinked ? targetRef : undefined}
      tabIndex={deepLinked ? -1 : undefined}
    >
      <header className="neb-agent-attention-card-head">
        <span
          className={`neb-agent-attention-kind ${
            item.type === "incident" ? "incident" : "report"
          }`}
        >
          <Glyph name={item.type === "incident" ? "alert" : "spark"} />
          {item.type === "incident" ? "Incident" : "Report"}
        </span>
        <span className="neb-agent-attention-meta">
          <span>{lifecycleLabel(item)}</span>
          {occurredAt
            ? <time dateTime={item.occurredAt}>{occurredAt}</time>
            : null}
        </span>
      </header>

      <div className="neb-agent-attention-copy">
        <h3>{item.brief.headline}</h3>
        {item.brief.impact ? <p>{item.brief.impact}</p> : null}
        {item.brief.context
          ? (
            <p className="neb-agent-attention-context">
              <span>Context</span>
              {item.brief.context}
            </p>
          )
          : null}
        {item.brief.recommendedNextMove
          ? (
            <p className="neb-agent-attention-next">
              <span>Recommended next move</span>
              {item.brief.recommendedNextMove}
            </p>
          )
          : null}
      </div>

      {item.brief.evidence.length > 0
        ? (
          <div className="neb-agent-attention-evidence">
            <span>Evidence</span>
            <div>
              {item.brief.evidence.map((evidence) => {
                const href = safeAttentionDestinationHref(
                  evidence.destination,
                  agent,
                );
                return href
                  ? (
                    <a
                      href={href}
                      key={`${evidence.kind}:${evidence.sourceId}`}
                      onClick={(event) => {
                        event.preventDefault();
                        onNavigate(href, { scroll: "preserve" });
                      }}
                    >
                      {evidence.label}
                    </a>
                  )
                  : (
                    <span key={`${evidence.kind}:${evidence.sourceId}`}>
                      {evidence.label}
                    </span>
                  );
              })}
            </div>
          </div>
        )
        : null}

      <footer className="neb-agent-attention-actions">
        <div>
          {item.actions.map((action) => {
            const href = safeAttentionDestinationHref(
              action.destination,
              agent,
            );
            return href
              ? (
                <a
                  className={`neb-btn-sm ${action.emphasis}`}
                  href={href}
                  key={action.id}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(href, { scroll: "preserve" });
                  }}
                >
                  {action.label}
                </a>
              )
              : null;
          })}
        </div>
        <div>
          {controls.map((control) => {
            const actionBusy = busy === `${item.notificationId}:${control.action}`;
            return (
              <button
                className={`neb-btn-sm ${control.emphasis}`}
                disabled={busy !== null}
                key={control.action}
                onClick={() => onAct(item, control.action)}
                type="button"
              >
                {actionBusy ? "Updating…" : control.label}
              </button>
            );
          })}
        </div>
      </footer>

      {enrichment
        ? <span className={`neb-agent-attention-enrichment ${item.enrichment.status}`}>{enrichment}</span>
        : null}
    </article>
  );
}

export function OperatorAgentAlerts({
  agent,
  attention,
  embedded = false,
  itemId,
  loadPage,
  onAttentionCountChange,
  onClearItem,
  onNavigate,
  query = "",
}: OperatorAgentAlertsProps): ReactElement {
  const [items, setItems] = useState<LaunchAgentAttentionItem[]>(
    attention.items,
  );
  const [exactOpenCount, setExactOpenCount] = useState(attention.openCount);
  const [exactDecisionCount, setExactDecisionCount] = useState(
    attention.requiresDecisionCount,
  );
  const [nextCursor, setNextCursor] = useState(attention.nextCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const deepLinkRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setItems(attention.items);
  }, [attention.items]);
  useEffect(() => {
    setExactOpenCount(attention.openCount);
  }, [agent.id, attention.openCount]);
  useEffect(() => {
    setExactDecisionCount(attention.requiresDecisionCount);
  }, [agent.id, attention.requiresDecisionCount]);
  useEffect(() => {
    setNextCursor(attention.nextCursor ?? null);
  }, [agent.id, attention.nextCursor]);
  useEffect(() => {
    onAttentionCountChange(exactOpenCount);
  }, [exactOpenCount, onAttentionCountChange]);
  const deepLinkedItem = useMemo(
    () => resolveAttentionItemTarget(items, itemId),
    [itemId, items],
  );
  useEffect(() => {
    if (!deepLinkedItem || !deepLinkRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      deepLinkRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      deepLinkRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [deepLinkedItem?.id]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = useMemo(
    () =>
      normalizedQuery
        ? items.filter((item) =>
          [
            item.brief.headline,
            item.brief.impact,
            item.brief.context,
            item.brief.recommendedNextMove,
            item.raw.kind,
            item.raw.title,
            item.raw.body,
          ].filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery)
        )
        : items,
    [items, normalizedQuery],
  );
  const groups = useMemo(
    () => groupAttentionItems(visibleItems),
    [visibleItems],
  );
  const decisionCount = exactDecisionCount;
  const staleItem = !embedded && attention.available !== false &&
    Boolean(itemId) && !deepLinkedItem && !nextCursor && !loadingMore;
  const loadOlder = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await (
        loadPage ??
          ((cursor: string) =>
            launchApi.agentAttention(agent.slug, { cursor, limit: 200 }))
      )(nextCursor);
      setItems((current) => appendAttentionItems(current, page.items));
      setExactOpenCount(page.openCount);
      setExactDecisionCount(page.requiresDecisionCount);
      setNextCursor(page.nextCursor ?? null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Older Alerts could not be loaded.",
      );
    } finally {
      setLoadingMore(false);
    }
  };
  const perform = async (
    item: LaunchAgentAttentionItem,
    action: AttentionLifecycleAction,
  ) => {
    const busyKey = `${item.notificationId}:${action}`;
    setBusy(busyKey);
    setError("");
    try {
      const response = await performAttentionLifecycleAction(
        item.notificationId,
        { action },
      );
      if (
        response.notificationId !== item.notificationId ||
        !isLifecycleCompatible(item, response.lifecycle)
      ) {
        throw new Error("The Attention action returned an invalid state.");
      }
      setItems((current) =>
        current.map((entry) =>
          entry.notificationId === item.notificationId
            ? { ...entry, lifecycle: response.lifecycle } as LaunchAgentAttentionItem
            : entry
        )
      );
      setExactOpenCount((current) =>
        attentionCountAfterLifecycleTransition(
          current,
          item,
          response.lifecycle,
        )
      );
      setExactDecisionCount((current) =>
        attentionDecisionCountAfterLifecycleTransition(
          current,
          item,
          response.lifecycle,
        )
      );
      const destination = safeAttentionDestinationHref(
        response.destination,
        agent,
      );
      if (destination) {
        onNavigate(destination, { scroll: "preserve" });
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The Attention action could not be completed.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className={`neb-modal-pane active neb-agent-attention${
        embedded ? " embedded" : ""
      }`}
    >
      <div className="neb-agent-attention-head">
        <div>
          <h2 className="neb-modal-h">{embedded ? agent.name : "Alerts"}</h2>
          <p>
            {embedded
              ? "Contextual reports and incidents."
              : `Contextual reports and incidents from ${agent.name}.`}
          </p>
        </div>
        {decisionCount > 0
          ? (
            <span className="neb-agent-attention-count">
              {decisionCount} decision{decisionCount === 1 ? "" : "s"} needed
            </span>
          )
          : null}
      </div>

      {attention.available === false
        ? (
          <div className="neb-compute-gate" role="status">
            <strong>Agent Alerts are temporarily unavailable.</strong>
            <p>Its work continues while this view reconnects.</p>
          </div>
        )
        : staleItem
        ? (
          <div className="neb-stale-item" role="status">
            <p className="neb-ov-note">
              This alert is no longer available for this Agent.
            </p>
            {onClearItem
              ? (
                <button
                  className="neb-btn-sm"
                  onClick={onClearItem}
                  type="button"
                >
                  Return to Alerts
                </button>
              )
              : null}
          </div>
        )
        : groups.length > 0
        ? (
          <div className="neb-agent-attention-groups">
            {groups.map((group) => (
              <section
                aria-labelledby={`attention-group-${group.id}`}
                className="neb-agent-attention-group"
                key={group.id}
              >
                <div className="neb-overview-section-head compact">
                  <div
                    className="neb-ov-label"
                    id={`attention-group-${group.id}`}
                  >
                    {group.label}
                  </div>
                  <span className="neb-rail-count">
                    {group.id === "active" && !normalizedQuery
                      ? exactOpenCount
                      : group.items.length}
                  </span>
                </div>
                <div className="neb-agent-attention-list">
                  {group.items.map((item) => (
                    <AttentionCard
                      agent={agent}
                      busy={busy}
                      deepLinked={deepLinkedItem?.id === item.id}
                      item={item}
                      key={item.id}
                      onAct={(target, action) => void perform(target, action)}
                      onNavigate={onNavigate}
                      targetRef={deepLinkRef}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )
        : (
          <div className="neb-agent-attention-empty">
            <Glyph name="check" />
            <strong>
              {normalizedQuery
                ? "No alerts match."
                : "Nothing needs your attention."}
            </strong>
            {!normalizedQuery
              ? <span>New reports and operator decisions will appear here.</span>
              : null}
          </div>
        )}

      {nextCursor
        ? (
          <button
            className="neb-add-row"
            disabled={loadingMore}
            onClick={() => void loadOlder()}
            type="button"
          >
            {loadingMore ? "Loading older alerts…" : "Load older alerts"}
          </button>
        )
        : null}
      {error ? <p className="neb-error-note" role="alert">{error}</p> : null}
      {!embedded
        ? (
          <p className="neb-ov-note">
            This view is scoped to {agent.name}. The bell keeps the account-wide
            Alerts view.
          </p>
        )
        : null}
    </section>
  );
}
