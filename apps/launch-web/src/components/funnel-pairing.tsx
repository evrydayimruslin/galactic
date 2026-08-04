import { type ReactElement, useEffect, useRef, useState } from "react";

import type { LaunchFunnelPairingProjection } from "../../../../shared/contracts/launch.ts";
import { launchApi } from "../lib/api";
import type { LaunchNavigate } from "../lib/navigation";
import { NebulaPublicShell } from "./nebula-fleet";
import { useSignInModal } from "./sign-in-modal";

import "./funnel-pairing.css";

const POLL_INTERVAL_MS = 5_000;
export const FUNNEL_PAIRING_STORAGE_KEY = "galactic.funnel-pairing";

/**
 * WO-F1: the unlisted watch page. Stages only — everything rendered here
 * comes from the sanitized pairing projection; the page never sees (and can
 * never leak) credential material, source, or evidence.
 */
export function FunnelPairingPage({
  code,
  navigate,
}: {
  code: string;
  navigate: LaunchNavigate;
}): ReactElement {
  const [projection, setProjection] = useState<
    LaunchFunnelPairingProjection | null
  >(null);
  const [gone, setGone] = useState(false);
  const [stale, setStale] = useState(false);
  const hasLoaded = useRef(false);

  useEffect(() => {
    let mounted = true;
    hasLoaded.current = false;
    let timer: number | null = null;
    const read = async () => {
      try {
        const response = await launchApi.funnelPairing(code);
        if (!mounted) return;
        hasLoaded.current = true;
        setProjection(response.pairing);
        setStale(false);
        try {
          window.localStorage.setItem(FUNNEL_PAIRING_STORAGE_KEY, code);
        } catch {
          // The homepage build card is a nicety, never a requirement.
        }
      } catch {
        if (!mounted) return;
        // A pairing that never loads is unknown/expired; one that stops
        // loading after success is a transient — keep the last projection.
        if (!hasLoaded.current) {
          setGone(true);
          if (timer !== null) window.clearInterval(timer);
        } else {
          setStale(true);
        }
      }
    };
    void read();
    timer = window.setInterval(() => void read(), POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [code]);

  const openSignIn = useSignInModal();

  return (
    <NebulaPublicShell>
      <header className="neb-topbar-shell">
        <div className="neb-topbar neb-preauth-topbar">
          <button
            className="neb-wordmark"
            onClick={() => navigate("/")}
            type="button"
          >
            galactic
          </button>
          <button
            className="neb-preauth-signin"
            onClick={openSignIn}
            type="button"
          >
            Sign in
          </button>
        </div>
      </header>
      <main className="neb-app neb-funnel-app">
        {gone
          ? <FunnelPairingGone navigate={navigate} />
          : projection
          ? (
            <FunnelPairingView
              navigate={navigate}
              onRun={() => {
                void launchApi.funnelRun(code)
                  .then(() => launchApi.funnelPairing(code))
                  .then(
                    (response) => setProjection(response.pairing),
                    () => setStale(true),
                  );
              }}
              projection={projection}
              stale={stale}
            />
          )
          : (
            <section aria-busy="true" className="neb-funnel-loading">
              <p>Finding your build…</p>
            </section>
          )}
      </main>
    </NebulaPublicShell>
  );
}

interface FunnelStageRow {
  key: string;
  label: string;
  at: string | null;
}

export function funnelStageRows(
  projection: LaunchFunnelPairingProjection,
): FunnelStageRow[] {
  return [
    { key: "handed_off", label: "Handed off", at: projection.createdAt },
    {
      key: "connected",
      label: "Coding agent connected",
      at: projection.connectedAt,
    },
    { key: "staged", label: "Source staged", at: projection.stagedAt },
    { key: "tested", label: "Exact-tested", at: projection.testedAt },
    { key: "uploaded", label: "Candidate uploaded", at: projection.uploadedAt },
    { key: "promoted", label: "Deployed", at: projection.promotedAt },
  ];
}

/** Pure view, exported for markup tests. */
export function FunnelPairingView({
  navigate,
  onRun,
  projection,
  stale = false,
}: {
  navigate?: LaunchNavigate;
  onRun?: () => void;
  projection: LaunchFunnelPairingProjection;
  stale?: boolean;
}): ReactElement {
  const rows = funnelStageRows(projection);
  const reachedCount = rows.filter((row) => row.at !== null).length;
  const buildCredentialLive = projection.uploadedAt === null &&
    Date.parse(projection.handoffExpiresAt) > Date.now();

  return (
    <section aria-labelledby="funnel-heading" className="neb-funnel-watch">
      <p className="neb-funnel-eyebrow">Watching a build</p>
      <h1 id="funnel-heading">
        {projection.agentName ?? "Your agent"}
        {projection.uploadedVersion
          ? (
            <span className="neb-funnel-version">
              v{projection.uploadedVersion}
            </span>
          )
          : null}
      </h1>
      <p className="neb-funnel-lede">
        {projection.claimed
          ? "This build has been claimed. It lives in its owner's fleet now."
          : "No account needed to watch. This unlisted link keeps working for 7 days — come back any time before then to claim the finished agent."}
      </p>
      {stale
        ? (
          <p className="neb-funnel-stale" role="status">
            Connection hiccup — showing the last known state.
          </p>
        )
        : null}

      <ol aria-label="Build stages" className="neb-funnel-stages">
        {rows.map((row, index) => (
          <li
            className={row.at !== null
              ? "reached"
              : index === reachedCount
              ? "active"
              : ""}
            key={row.key}
          >
            <span className="neb-funnel-stage-label">{row.label}</span>
            <span className="neb-funnel-stage-time">
              {row.at !== null
                ? new Date(row.at).toLocaleTimeString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                })
                : index === reachedCount
                ? "in progress"
                : "—"}
            </span>
          </li>
        ))}
      </ol>

      {projection.heldCard
        ? (
          <div
            aria-label="Held by your policy"
            className="neb-funnel-held-card"
            role="group"
          >
            <p className="neb-funnel-held-eyebrow">Held by your policy</p>
            <p className="neb-funnel-held-sentence">
              {projection.heldCard.seedSentence
                ? `"It must ask me before ${projection.heldCard.seedSentence}."`
                : "A guarded action is waiting for your approval."}
            </p>
            <p className="neb-funnel-held-detail">
              <code>{projection.heldCard.functionName}</code> stopped at the
              gate before touching the world. Approving lets it finish;
              denying and editing are always free.
            </p>
            <div className="neb-funnel-held-actions">
              <span className="neb-funnel-held-primary">
                Approve — claim this build to resume it
              </span>
              <span>Deny · Edit — sign in, always free</span>
            </div>
          </div>
        )
        : projection.uploadedAt && !projection.claimed
        ? (
          <button
            className="neb-funnel-cta"
            onClick={() => onRun?.()}
            type="button"
          >
            Run it once
          </button>
        )
        : null}

      {projection.claimed
        ? (
          <button
            className="neb-funnel-cta"
            onClick={() => navigate?.("/")}
            type="button"
          >
            Open the fleet
          </button>
        )
        : buildCredentialLive
        ? (
          <p className="neb-funnel-note">
            The coding agent&apos;s build credential expires{" "}
            {new Date(projection.handoffExpiresAt).toLocaleTimeString(
              undefined,
              { hour: "numeric", minute: "2-digit" },
            )} — a fresh one is a{" "}
            <code>galacticconnection resume</code> away.
          </p>
        )
        : (
          <p className="neb-funnel-note">
            Sign in to claim this build into your fleet when it&apos;s ready.
          </p>
        )}
    </section>
  );
}

function FunnelPairingGone({
  navigate,
}: {
  navigate: LaunchNavigate;
}): ReactElement {
  return (
    <section className="neb-funnel-gone">
      <h1>This build link has expired or never existed.</h1>
      <p>
        Unclaimed builds are kept for 7 days. Start a fresh one from the
        homepage — no account needed.
      </p>
      <button
        className="neb-funnel-cta"
        onClick={() => navigate("/")}
        type="button"
      >
        Back to the fleet
      </button>
    </section>
  );
}
