import type { ReactElement } from "react";

import { connectTutorialHref } from "../lib/connect-tutorial";
import type { LaunchNavigate } from "../lib/navigation";
import { NebulaPublicShell } from "./nebula-fleet";
import { useSignInModal } from "./sign-in-modal";

import "./pre-auth-fleet.css";

const FLEET_EXAMPLES = [
  {
    activity: "Drafted 4 replies for review",
    initials: "ed",
    name: "Email Drafter Agent",
    release: "2.1",
    time: "2h ago",
  },
  {
    activity: "Nudged 2 overdue invoices",
    initials: "ic",
    name: "Invoice Chaser Agent",
    release: "1.4",
    time: "this morning",
  },
] as const;

export const PRE_AUTH_ADD_AGENT_HREF = connectTutorialHref({
  intent: "agent",
  source: "fleet-card",
});

export function PreAuthFleetHome({
  navigate,
}: {
  navigate: LaunchNavigate;
}): ReactElement {
  const openSignIn = useSignInModal();
  const startPlanning = () => navigate(PRE_AUTH_ADD_AGENT_HREF);

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

      <main className="neb-app neb-preauth-app">
        <section
          aria-labelledby="preauth-fleet-heading"
          className="neb-preauth-fleet"
        >
          <div className="neb-preauth-hero">
            <h1 id="preauth-fleet-heading">No agents yet</h1>
            <p>
              This is your fleet. Plan an agent here, hand the prompt to your
              coding agent, and Galactic runs what it builds. You don&apos;t
              need an account to plan one.
            </p>
          </div>

          <div aria-label="Your future Agent fleet" className="neb-roster">
            <a
              aria-describedby="preauth-add-agent-detail"
              className="neb-add-agent-card neb-preauth-add-agent"
              href={PRE_AUTH_ADD_AGENT_HREF}
              onClick={(event) => {
                event.preventDefault();
                startPlanning();
              }}
            >
              <span aria-hidden="true" className="neb-preauth-plus">+</span>
              <span className="neb-preauth-add-label">Add agent</span>
              <span id="preauth-add-agent-detail">
                seven questions, all optional
              </span>
            </a>

            {FLEET_EXAMPLES.map((example) => (
              <article
                aria-label={`Example: ${example.name}`}
                className="neb-agent-card neb-preauth-example"
                key={example.name}
              >
                <span className="neb-card-no">example</span>
                <div className="neb-agent-head">
                  <div aria-hidden="true" className="neb-agent-avatar">
                    {example.initials}
                  </div>
                  <div className="neb-agent-meta">
                    <div className="neb-agent-name">{example.name}</div>
                    <div className="neb-status-row neb-preauth-running">
                      <span className="neb-status-dot" />
                      <span className="neb-status-copy">
                        Running · release {example.release}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="neb-last-actions">
                  <div className="neb-last-action-item">
                    <span>{example.activity}</span>
                    <span className="neb-last-action-time">{example.time}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>

          <p className="neb-preauth-footnote">
            The examples show what a running agent looks like. Yours starts as a
            plan —{" "}
            <a
              href={PRE_AUTH_ADD_AGENT_HREF}
              onClick={(event) => {
                event.preventDefault();
                startPlanning();
              }}
            >
              add your first agent
            </a>
            .
          </p>
        </section>
      </main>
    </NebulaPublicShell>
  );
}
