import { type ReactElement, useEffect, useRef } from "react";

import type {
  LaunchAgentAccessGroup,
  LaunchAgentAccessProjection,
} from "../../../../../shared/contracts/launch.ts";
import type { LaunchNavigate } from "../../lib/navigation";
import { resolveOperatorAccessItem } from "../../lib/operator-item-targets";

export interface OperatorAgentAccessProps {
  access: LaunchAgentAccessProjection;
  agentSlug: string;
  itemId?: string;
  onConfigureSetting: (key: string) => void;
  onNavigate: LaunchNavigate;
}

function statusLabel(group: LaunchAgentAccessGroup): string {
  if (group.effective) return "Effective";
  if (group.configured) return "Configured · not effective";
  return "Setup required";
}

export function OperatorAgentAccess({
  access,
  agentSlug,
  itemId,
  onConfigureSetting,
  onNavigate,
}: OperatorAgentAccessProps): ReactElement {
  const listRef = useRef<HTMLDivElement>(null);
  const target = resolveOperatorAccessItem(access.groups, itemId);
  useEffect(() => {
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>('[data-focused="true"]')
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [target?.id, target?.kind]);
  const focused = (
    kind: "group" | "authority" | "setting",
    id: string,
  ) =>
    target?.kind === kind && target.id === id;

  return (
    <section className="neb-modal-pane active neb-operator-access">
      <h2 className="neb-modal-h">Access</h2>
      <p className="neb-ov-note top-note">
        Effective endpoints, credentials, configuration, and authority for the
        live release. Secret values are never displayed.
      </p>
      <div className="neb-operator-access-list" ref={listRef}>
        {access.groups.map((group) => (
          <section
            className={`neb-operator-access-group${
              focused("group", group.id) ? " focused" : ""
            }`}
            data-focused={focused("group", group.id) ? "true" : undefined}
            key={group.id}
          >
            <div className="neb-operator-access-head">
              <div>
                <strong>{group.label}</strong>
                {group.target ? <code>{group.target}</code> : null}
                {group.description ? <p>{group.description}</p> : null}
              </div>
              <span
                className={`neb-operator-access-status${
                  group.effective ? " effective" : ""
                }`}
              >
                {statusLabel(group)}
              </span>
            </div>

            {group.credentials.length > 0
              ? (
                <div className="neb-operator-access-subsection">
                  <span className="neb-ov-label">Credentials</span>
                  {group.credentials.map((credential) => (
                    <button
                      className={`neb-operator-access-row${
                        focused("setting", credential.key) ? " focused" : ""
                      }`}
                      data-focused={focused("setting", credential.key)
                        ? "true"
                        : undefined}
                      key={credential.key}
                      onClick={() => onConfigureSetting(credential.key)}
                      type="button"
                    >
                      <span>
                        <strong>{credential.label}</strong>
                        <small>{credential.key}</small>
                      </span>
                      <em className={credential.configured ? "configured" : ""}>
                        {credential.configured
                          ? "Configured"
                          : credential.required
                          ? "Required"
                          : "Optional"}
                      </em>
                    </button>
                  ))}
                </div>
              )
              : null}

            {group.settings.length > 0
              ? (
                <div className="neb-operator-access-subsection">
                  <span className="neb-ov-label">Variables</span>
                  {group.settings.map((setting) => (
                    <button
                      className={`neb-operator-access-row${
                        focused("setting", setting.key) ? " focused" : ""
                      }`}
                      data-focused={focused("setting", setting.key)
                        ? "true"
                        : undefined}
                      key={setting.key}
                      onClick={() => onConfigureSetting(setting.key)}
                      type="button"
                    >
                      <span>
                        <strong>{setting.label}</strong>
                        <small>{setting.key}{setting.secret ? " · secret" : ""}</small>
                      </span>
                      <em className={setting.configured ? "configured" : ""}>
                        {setting.configured
                          ? "Configured"
                          : setting.required
                          ? "Required"
                          : "Optional"}
                      </em>
                    </button>
                  ))}
                </div>
              )
              : null}

            {group.authority.length > 0
              ? (
                <div className="neb-operator-access-subsection">
                  <span className="neb-ov-label">Allowed access</span>
                  {group.authority.map((authority) => (
                    <div
                      className={`neb-operator-access-row${
                        focused("authority", authority.id) ? " focused" : ""
                      }`}
                      data-focused={focused("authority", authority.id)
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

            {group.consumers.length > 0
              ? (
                <div className="neb-operator-consumers">
                  <span>Used by</span>
                  {group.consumers.map((consumer) => (
                    <a
                      href={`/agents/${encodeURIComponent(agentSlug)}?pane=${
                        consumer.kind === "routine" ? "routines" : "functions"
                      }&item=${encodeURIComponent(consumer.id)}`}
                      key={`${consumer.kind}:${consumer.id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        onNavigate(
                          `/agents/${encodeURIComponent(agentSlug)}?pane=${
                            consumer.kind === "routine"
                              ? "routines"
                              : "functions"
                          }&item=${encodeURIComponent(consumer.id)}`,
                          { scroll: "preserve" },
                        );
                      }}
                    >
                      {consumer.label}
                    </a>
                  ))}
                </div>
              )
              : null}
          </section>
        ))}
      </div>
      {access.groups.length === 0
        ? (
          <p className="neb-ov-note">
            This Agent declares no external access or configurable variables.
          </p>
        )
        : null}
      {itemId && !target
        ? (
          <div className="neb-stale-item" role="status">
            <p className="neb-ov-note">
              This access item is no longer part of the live Agent release.
            </p>
            <button
              className="neb-btn-sm"
              onClick={() =>
                onNavigate(
                  `/agents/${encodeURIComponent(agentSlug)}?pane=access`,
                  { scroll: "preserve" },
                )}
              type="button"
            >
              Return to Access
            </button>
          </div>
        )
        : null}
    </section>
  );
}
