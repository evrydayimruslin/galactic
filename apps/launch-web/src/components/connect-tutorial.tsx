import type { ReactElement } from "react";

import type { LocationState } from "../App";
import {
  parseConnectTutorialContext,
  type ConnectTutorialIntent,
} from "../lib/connect-tutorial";

const tutorialCopy: Record<
  ConnectTutorialIntent,
  { eyebrow: string; title: string; intro: string }
> = {
  connect: {
    eyebrow: "Connect AI",
    title: "Bring your AI to Galactic.",
    intro:
      "A guided setup for connecting Codex, Claude Code, Cursor, or another MCP client to your Galactic workspace.",
  },
  agent: {
    eyebrow: "Add an Agent",
    title: "Build your next persistent Agent.",
    intro:
      "Connect a coding AI, define the responsibility together, and bring the resulting Agent back to Galactic for review.",
  },
  interface: {
    eyebrow: "Add an Interface",
    title: "Give this Agent a purpose-built interface.",
    intro:
      "This version of the tutorial will keep the selected Agent in context and guide your coding AI through an interface addition.",
  },
  function: {
    eyebrow: "Add a Function",
    title: "Extend what this Agent can do.",
    intro:
      "This version of the tutorial will keep the selected Agent in context and guide your coding AI through a function addition.",
  },
  routine: {
    eyebrow: "Add a Routine",
    title: "Give this Agent recurring work.",
    intro:
      "This version of the tutorial will keep the selected Agent in context and guide your coding AI through a routine addition.",
  },
};

export function ConnectTutorialPanel({
  location,
  onSignIn,
  signedIn,
}: {
  location: LocationState;
  onSignIn: () => void;
  signedIn: boolean;
}): ReactElement {
  const context = parseConnectTutorialContext(location.search);
  const copy = tutorialCopy[context.intent];

  return (
    <section
      className="neb-inline-panel neb-connect-tutorial-panel"
      aria-label={copy.eyebrow}
      data-connect-intent={context.intent}
    >
      <div className="neb-modal-content">
        <section className="neb-modal-pane active">
          <p className="neb-connect-tutorial-kicker">{copy.eyebrow}</p>
          <h2 className="neb-connect-tutorial-title">{copy.title}</h2>
          <p className="neb-connect-tutorial-intro">{copy.intro}</p>
          {context.agentSlug
            ? (
              <p className="neb-connect-tutorial-context">
                Agent context <strong>{context.agentSlug}</strong>
              </p>
            )
            : null}

          <div
            className="neb-connect-tutorial-steps"
            aria-label="Tutorial outline"
          >
            <article>
              <span>01</span>
              <div>
                <h3>Choose your AI</h3>
                <p>Select the client and environment you want to connect.</p>
              </div>
            </article>
            <article>
              <span>02</span>
              <div>
                <h3>Connect securely</h3>
                <p>Follow setup tailored to that client and this task.</p>
              </div>
            </article>
            <article>
              <span>03</span>
              <div>
                <h3>Build together</h3>
                <p>
                  Continue with the right Agent, interface, function, or
                  routine flow.
                </p>
              </div>
            </article>
          </div>

          <p className="neb-connect-tutorial-note">
            Detailed walkthrough content will live here. Opening this page does
            not create credentials or copy a prompt.
          </p>
          {!signedIn
            ? (
              <div className="neb-connect-tutorial-actions">
                <button onClick={onSignIn} type="button">
                  Sign in to continue
                </button>
                <span>Your place in this tutorial will be preserved.</span>
              </div>
            )
            : null}
        </section>
      </div>
    </section>
  );
}
