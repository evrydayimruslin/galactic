import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  LaunchAgentAccessConsumer,
  LaunchAgentAccessGroup,
  LaunchAgentAccessGroupKind,
  LaunchAgentAccessProjection,
  LaunchAgentHomeResponse,
} from "../../../../../shared/contracts/launch.ts";
import {
  launchApi,
  type LaunchAgentSettingsResponse,
} from "../../lib/api";
import { resolveOperatorAccessItem } from "../../lib/operator-item-targets";
import { StudioPageHeader } from "./agent-studio-overview";

import "./agent-studio-connections.css";

export interface AgentStudioConnectionsClient {
  agentSettings: typeof launchApi.agentSettings;
  updateAgentHomeSettings: typeof launchApi.updateAgentHomeSettings;
}

export interface AgentStudioConnectionsProps {
  access: LaunchAgentAccessProjection;
  agentIdOrSlug: string;
  agentName: string;
  homeRevision: string;
  client?: AgentStudioConnectionsClient;
  itemId?: string | null;
  onChanged?: (response: LaunchAgentHomeResponse) => void;
  onHandOffConnection?: (group?: LaunchAgentAccessGroup) => void;
  onOpenConsumer?: (consumer: LaunchAgentAccessConsumer) => void;
  onOpenItem: (itemId: string | null) => void;
}

function defaultConnectionsClient(): AgentStudioConnectionsClient {
  return {
    agentSettings: launchApi.agentSettings.bind(launchApi),
    updateAgentHomeSettings: launchApi.updateAgentHomeSettings.bind(launchApi),
  };
}

function groupKindLabel(kind: LaunchAgentAccessGroupKind): string {
  const labels: Record<LaunchAgentAccessGroupKind, string> = {
    agent: "Agent access",
    ai: "Inference",
    compute: "Compute",
    configuration: "Plain settings",
    external_endpoint: "External endpoint",
    internal: "Internal authority",
    memory: "Memory",
    reporting: "Reporting",
    storage: "Storage",
  };
  return labels[kind];
}

function groupStatus(group: LaunchAgentAccessGroup): {
  label: string;
  tone: "connected" | "partial" | "review";
} {
  if (group.effective) return { label: "Effective", tone: "connected" };
  if (group.configured) {
    return { label: "Configured · not effective", tone: "review" };
  }
  const fields = [...group.credentials, ...group.settings];
  if (fields.length) {
    const configured = fields.filter((field) => field.configured).length;
    return {
      label: configured
        ? `${configured} of ${fields.length} set`
        : "Not connected",
      tone: "partial",
    };
  }
  return { label: "Review required", tone: "review" };
}

export function settingsPresenceAfterUpdate(
  access: LaunchAgentAccessProjection,
  connectedKeys: readonly string[],
): LaunchAgentAccessProjection {
  const connected = new Set(connectedKeys);
  const groups = access.groups.map((group) => {
    const credentials = group.credentials.map((credential) => ({
      ...credential,
      configured: connected.has(credential.key),
    }));
    const settings = group.settings.map((setting) => ({
      ...setting,
      configured: connected.has(setting.key),
    }));
    const declaredFields = [...credentials, ...settings];
    const fieldsConfigured = declaredFields
      .filter((field) => field.required)
      .every((field) => field.configured);
    const authorityConfigured = group.authority
      .filter((authority) => authority.required)
      .every((authority) => authority.approved);
    const configured = fieldsConfigured && authorityConfigured;
    return {
      ...group,
      configured,
      credentials,
      // Presence is not a health check. Preserve the server projection until
      // the post-save Agent Home reload returns a new effective state.
      effective: group.effective,
      settings,
    };
  });
  return {
    configured: groups.every((group) => group.configured),
    effective: groups.every((group) => group.effective),
    groups,
  };
}

export function AgentStudioConnections({
  access,
  agentIdOrSlug,
  agentName,
  homeRevision,
  client,
  itemId,
  onChanged,
  onHandOffConnection,
  onOpenConsumer,
  onOpenItem,
}: AgentStudioConnectionsProps): ReactElement {
  const api = useMemo(() => client ?? defaultConnectionsClient(), [client]);
  const [current, setCurrent] = useState(access);
  const [currentRevision, setCurrentRevision] = useState(homeRevision);
  const listRef = useRef<HTMLDivElement>(null);
  const target = resolveOperatorAccessItem(current.groups, itemId);
  const settingKey = target?.kind === "setting" ? target.settingKey : null;
  const settingIsSecret = settingKey
    ? current.groups.some((group) =>
      group.credentials.some((credential) => credential.key === settingKey)
    )
    : false;

  useEffect(() => {
    setCurrent(access);
    setCurrentRevision(homeRevision);
  }, [access, agentIdOrSlug, homeRevision]);
  useEffect(() => {
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>('[data-focused="true"]')
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [target?.id, target?.kind]);

  const saved = (response: LaunchAgentHomeResponse) => {
    if (response.access) setCurrent(response.access);
    setCurrentRevision(response.revision);
    onChanged?.(response);
  };

  return (
    <section className="agent-studio-screen agent-studio-connections">
      <StudioPageHeader
        description={`The outside systems ${agentName} can reach, grouped by purpose instead of exposed as a list of environment variables. Secret values are never shown — only whether they are set.`}
        title="Connections"
      />

      <div className="agent-studio-connection-list" ref={listRef}>
        {current.groups.map((group) => (
          <ConnectionCard
            focusedId={target?.id ?? null}
            focusedKind={target?.kind ?? null}
            group={group}
            key={group.id}
            onConfigure={(key) => onOpenItem(`setting:${key}`)}
            onHandOff={onHandOffConnection
              ? () => onHandOffConnection(group)
              : undefined}
            onOpenConsumer={onOpenConsumer}
          />
        ))}
      </div>

      {current.groups.length === 0
        ? (
          <div className="agent-studio-connection-empty">
            <strong>No outside connections are declared.</strong>
            <p>
              This live release does not ask for credentials, destinations, or
              configurable values.
            </p>
            {onHandOffConnection
              ? (
                <button onClick={() => onHandOffConnection()} type="button">
                  Add with your coding agent
                </button>
              )
              : (
                <p>
                  Connection declarations are release changes. A
                  purpose-bound handoff for them is not available yet.
                </p>
              )}
          </div>
        )
        : null}

      {itemId && !target
        ? (
          <div className="agent-studio-connection-stale" role="status">
            <p>
              This connection item is no longer part of the live Agent release.
            </p>
            <button onClick={() => onOpenItem(null)} type="button">
              Return to Connections
            </button>
          </div>
        )
        : null}

      <div className="agent-studio-connection-footnote">
        <span>
          Small monospace names are the exact keys declared by the release.
          Galactic reports presence only and never returns their values to this
          screen. “Effective” is an authority projection, not a connection
          health test.
        </span>
        {onHandOffConnection
          ? (
            <button onClick={() => onHandOffConnection()} type="button">
              &lt;/&gt; Hand to your coding agent
            </button>
          )
          : null}
      </div>

      {settingKey
        ? (
          <ConnectionSettingEditor
            agentIdOrSlug={agentIdOrSlug}
            client={api}
            expectedRevision={currentRevision}
            key={`${agentIdOrSlug}:${settingKey}`}
            onClose={() => onOpenItem(null)}
            onSaved={saved}
            secret={settingIsSecret}
            settingKey={settingKey}
          />
        )
        : null}
    </section>
  );
}

function ConnectionCard({
  focusedId,
  focusedKind,
  group,
  onConfigure,
  onHandOff,
  onOpenConsumer,
}: {
  focusedId: string | null;
  focusedKind: "authority" | "group" | "setting" | null;
  group: LaunchAgentAccessGroup;
  onConfigure: (key: string) => void;
  onHandOff?: () => void;
  onOpenConsumer?: (consumer: LaunchAgentAccessConsumer) => void;
}): ReactElement {
  const status = groupStatus(group);
  const fields = [
    ...group.credentials.map((credential) => ({
      ...credential,
      secret: true,
    })),
    ...group.settings,
  ];
  const groupFocused = focusedKind === "group" && focusedId === group.id;
  const focusIsInGroup = groupFocused ||
    fields.some((field) =>
      focusedKind === "setting" && field.key === focusedId
    ) ||
    group.authority.some((authority) =>
      focusedKind === "authority" && authority.id === focusedId
    );

  return (
    <article
      className={`agent-studio-connection-card${
        focusIsInGroup ? " focused" : ""
      }`}
      data-focused={groupFocused ? "true" : undefined}
      data-group-id={group.id}
    >
      <header>
        <div>
          <strong>{group.label}</strong>
          <span>
            {groupKindLabel(group.kind)}
            {group.target ? ` · ${group.target}` : ""}
          </span>
          {group.description ? <p>{group.description}</p> : null}
        </div>
        <em className={status.tone}>
          <i />
          {status.label}
        </em>
      </header>

      {fields.length
        ? (
          <div className="agent-studio-connection-fields">
            {fields.map((field) => (
              <button
                className={focusedKind === "setting" &&
                    focusedId === field.key
                  ? "focused"
                  : ""}
                data-focused={focusedKind === "setting" &&
                    focusedId === field.key
                  ? "true"
                  : undefined}
                key={field.key}
                onClick={() => onConfigure(field.key)}
                type="button"
              >
                <span>
                  <strong>{field.label}</strong>
                  <code>
                    {field.key}{field.secret ? " · write-only" : ""}
                  </code>
                </span>
                <span className={field.configured ? "configured" : "needed"}>
                  <strong>{field.configured ? "Set" : "Needed"}</strong>
                  <small>
                    {field.secret
                      ? "Value is stored write-only"
                      : field.required
                      ? "Required by this release"
                      : "Optional"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        )
        : null}

      {group.authority.length
        ? (
          <div className="agent-studio-connection-authority">
            <span>Allowed access</span>
            {group.authority.map((authority) => (
              <div
                className={focusedKind === "authority" &&
                    focusedId === authority.id
                  ? "focused"
                  : ""}
                data-focused={focusedKind === "authority" &&
                    focusedId === authority.id
                  ? "true"
                  : undefined}
                key={authority.id}
              >
                <span>
                  <strong>{authority.label}</strong>
                  {authority.purpose ? <small>{authority.purpose}</small> : null}
                </span>
                <em className={authority.effective ? "configured" : ""}>
                  {authority.effective
                    ? "Effective"
                    : authority.approved
                    ? "Approved"
                    : "Review required"}
                </em>
              </div>
            ))}
          </div>
        )
        : null}

      {group.consumers.length
        ? (
          <div className="agent-studio-connection-consumers">
            <span>Used by</span>
            {group.consumers.map((consumer) =>
              onOpenConsumer
                ? (
                  <button
                    key={`${consumer.kind}:${consumer.id}`}
                    onClick={() => onOpenConsumer(consumer)}
                    type="button"
                  >
                    {consumer.label}
                  </button>
                )
                : (
                  <code key={`${consumer.kind}:${consumer.id}`}>
                    {consumer.label}
                  </code>
                )
            )}
          </div>
        )
        : null}

      <div className="agent-studio-connection-actions">
        {fields.length
          ? (
            <button
              onClick={() => {
                const missing = fields.find((field) => !field.configured);
                onConfigure(missing?.key ?? fields[0]!.key);
              }}
              type="button"
            >
              {fields.some((field) => !field.configured)
                ? "Configure"
                : "Replace values"}
            </button>
          )
          : null}
        {onHandOff
          ? (
            <button onClick={onHandOff} type="button">
              Change release declaration
            </button>
          )
          : null}
      </div>
    </article>
  );
}

export function ConnectionSettingEditor({
  agentIdOrSlug,
  client,
  expectedRevision,
  onClose,
  onSaved,
  secret,
  settingKey,
}: {
  agentIdOrSlug: string;
  client?: AgentStudioConnectionsClient;
  expectedRevision: string;
  onClose: () => void;
  onSaved: (response: LaunchAgentHomeResponse) => void;
  secret: boolean;
  settingKey: string;
}): ReactElement {
  const api = useMemo(() => client ?? defaultConnectionsClient(), [client]);
  const [settings, setSettings] = useState<LaunchAgentSettingsResponse | null>(
    null,
  );
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const readGeneration = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const setting = settings?.settings.find((item) =>
    item.key === settingKey
  ) ?? null;

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() =>
      dialogRef.current?.focus()
    );
    return () => {
      window.cancelAnimationFrame(frame);
      restoreFocusRef.current?.focus();
    };
  }, []);
  useEffect(() => {
    const generation = ++readGeneration.current;
    setSettings(null);
    setValue("");
    setBusy(false);
    setError("");
    setConfirmRemoval(false);
    api.agentSettings(agentIdOrSlug)
      .then((response) => {
        if (generation === readGeneration.current) setSettings(response);
      })
      .catch((reason) => {
        if (generation === readGeneration.current) {
          setError(errorMessage(reason));
        }
      });
    return () => {
      readGeneration.current += 1;
    };
  }, [agentIdOrSlug, api, settingKey]);
  useEffect(() => {
    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKey);
    return () => window.removeEventListener("keydown", handleDialogKey);
  }, [busy, onClose]);
  useEffect(() => {
    if (setting) (textareaRef.current ?? inputRef.current)?.focus();
  }, [setting?.key]);

  const save = async (nextValue: string | null) => {
    if (busy) return;
    const generation = readGeneration.current;
    setBusy(true);
    setError("");
    try {
      const response = await api.updateAgentHomeSettings(agentIdOrSlug, {
        expectedRevision,
        values: {
          [settingKey]: nextValue,
        },
      });
      if (generation !== readGeneration.current) return;
      onSaved(response);
      setValue("");
      onClose();
    } catch (reason) {
      if (generation === readGeneration.current) {
        setError(errorMessage(reason));
      }
    } finally {
      if (generation === readGeneration.current) setBusy(false);
    }
  };

  return (
    <div
      className="agent-studio-connection-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        aria-labelledby="agent-studio-connection-dialog-title"
        aria-modal="true"
        className="agent-studio-connection-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <button
          aria-label="Close connection setting"
          className="close"
          disabled={busy}
          onClick={onClose}
          type="button"
        >
          ×
        </button>
        <span className="agent-studio-section-label">Connection value</span>
        <h2 id="agent-studio-connection-dialog-title">
          {setting?.label ?? settingKey}
        </h2>
        {setting?.description ? <p>{setting.description}</p> : null}
        {setting
          ? (
            <>
              <label htmlFor={`studio-setting-${setting.key}`}>
                {setting.configured
                  ? "Replace configured value"
                  : setting.required
                  ? "Required value"
                  : "Value"}
              </label>
              {!secret && setting.input === "textarea"
                ? (
                  <textarea
                    autoComplete="off"
                    id={`studio-setting-${setting.key}`}
                    onChange={(event) => {
                      setValue(event.currentTarget.value);
                      setConfirmRemoval(false);
                    }}
                    placeholder={setting.placeholder ?? undefined}
                    ref={textareaRef}
                    value={value}
                  />
                )
                : (
                  <input
                    autoComplete="off"
                    id={`studio-setting-${setting.key}`}
                    onChange={(event) => {
                      setValue(event.currentTarget.value);
                      setConfirmRemoval(false);
                    }}
                    placeholder={setting.placeholder ?? undefined}
                    ref={inputRef}
                    type={secret
                      ? "password"
                      : settingInputType(setting.input)}
                    value={value}
                  />
                )}
              <p className="write-only">
                Existing values are never returned to the browser.
                {setting.help ? ` ${setting.help}` : ""}
              </p>
              <div className="actions">
                <button
                  disabled={busy || !value}
                  onClick={() => void save(value)}
                  type="button"
                >
                  {busy
                    ? "Saving…"
                    : setting.configured
                    ? "Replace"
                    : "Save"}
                </button>
                {setting.configured
                  ? (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (confirmRemoval) {
                          void save(null);
                        } else {
                          setConfirmRemoval(true);
                        }
                      }}
                      type="button"
                    >
                      {confirmRemoval ? "Confirm removal" : "Remove value"}
                    </button>
                  )
                  : null}
              </div>
              {confirmRemoval
                ? (
                  <p className="removal-warning" role="alert">
                    Removing this {setting.required ? "required " : ""}value
                    may make the live Agent ineffective. Click Confirm removal
                    to continue.
                  </p>
                )
                : null}
            </>
          )
          : !settings && !error
          ? <p className="loading" role="status">Loading configuration…</p>
          : null}
        {settings && !setting
          ? (
            <p className="error" role="alert">
              This key is declared by the live release, but the current
              settings endpoint does not expose it for editing.
            </p>
          )
          : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function settingInputType(
  input: string,
): "email" | "number" | "password" | "text" | "url" {
  if (
    input === "email" || input === "number" || input === "password" ||
    input === "url"
  ) {
    return input;
  }
  return "text";
}
