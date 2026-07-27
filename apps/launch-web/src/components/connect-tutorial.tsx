import type { ReactElement } from "react";

import type { LocationState } from "../App";
import { hasLaunchAuthToken } from "../lib/auth";
import {
  parseConnectTutorialContext,
  type ConnectTutorialIntent,
} from "../lib/connect-tutorial";
import type { LaunchNavigate } from "../lib/navigation";

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

export function ConnectTutorialPage({
  location,
  navigate,
}: {
  location: LocationState;
  navigate: LaunchNavigate;
}): ReactElement {
  const context = parseConnectTutorialContext(location.search);
  const copy = tutorialCopy[context.intent];
  const signedIn = hasLaunchAuthToken();

  return (
    <div
      className="launch-page-narrow connect-tutorial-page"
      data-connect-intent={context.intent}
    >
      <section className="connect-tutorial-hero">
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1>{copy.title}</h1>
        <p>{copy.intro}</p>
        {context.agentSlug
          ? (
            <p className="connect-tutorial-context">
              Agent context <strong>{context.agentSlug}</strong>
            </p>
          )
          : null}
      </section>

      <section className="connect-tutorial-map" aria-label="Tutorial outline">
        <article>
          <span>01</span>
          <h2>Choose your AI</h2>
          <p>Select the client and environment you want to connect.</p>
        </article>
        <article>
          <span>02</span>
          <h2>Connect securely</h2>
          <p>Follow setup tailored to that client and this task.</p>
        </article>
        <article>
          <span>03</span>
          <h2>Build together</h2>
          <p>Continue with the right Agent, interface, function, or routine flow.</p>
        </article>
      </section>

      <div className="connect-tutorial-note">
        <p>
          The detailed walkthrough and client-specific setup belong here. This
          page establishes the shared destination without creating credentials
          or copying a prompt on arrival.
        </p>
        {signedIn
          ? (
            <button onClick={() => navigate("/")} type="button">
              Back to your fleet
            </button>
          )
          : null}
      </div>
    </div>
  );
}
