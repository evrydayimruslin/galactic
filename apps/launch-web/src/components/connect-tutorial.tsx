import { type ReactElement } from "react";

import type { LaunchAgentSummary } from "../../../../shared/contracts/launch.ts";
import type { LocationState } from "../App";
import { createStudioHandoffCredential } from "../lib/agent-studio-handoff-credential";
import { launchApiOrigin } from "../lib/api";
import {
  parseConnectTutorialContext,
  type ConnectTutorialIntent,
} from "../lib/connect-tutorial";
import { AgentStudioHandoff } from "./agent-studio/agent-studio-handoff";
import type {
  AgentStudioHandoffTarget,
  AuthenticatedAgentStudioHandoffIntent,
} from "./agent-studio/agent-studio-handoff-model";

import "./agent-studio/agent-studio.css";
import "./connect-tutorial.css";

function isExtensionIntent(
  intent: ConnectTutorialIntent,
): intent is "interface" | "function" | "routine" {
  return intent === "interface" || intent === "function" ||
    intent === "routine";
}

function handoffTarget(
  agent: LaunchAgentSummary | null,
): AgentStudioHandoffTarget | null {
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    slug: agent.slug,
  };
}

function tutorialTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem("galactic.agent-studio.theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Use the browser preference when storage is unavailable.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * The canonical Connect surface uses the same handoff component as Agent
 * Studio. Credentials are issued only after Copy, expire in 30 minutes, and
 * are never replaced with the legacy broad 30-day builder key.
 */
export function ConnectTutorialPanel({
  agent = null,
  dataReady = true,
  location,
  onSignIn,
  signedIn,
}: {
  agent?: LaunchAgentSummary | null;
  dataReady?: boolean;
  location: LocationState;
  onSignIn: () => void;
  signedIn: boolean;
}): ReactElement {
  const context = parseConnectTutorialContext(location.search);
  const needsAgent = isExtensionIntent(context.intent);
  const intendedIntent =
    context.intent as AuthenticatedAgentStudioHandoffIntent;
  const activeIntent = signedIn ? intendedIntent : "signed-out";
  const target = handoffTarget(agent);
  const draftStorageKey = `galactic.connect.handoff:${context.intent}:${
    context.agentSlug ?? "workspace"
  }`;

  if (signedIn && needsAgent && !agent) {
    return (
      <section
        aria-label="Coding-agent handoff"
        className="neb-inline-panel neb-connect-tutorial-panel agent-studio"
        data-connect-intent={context.intent}
        data-theme={tutorialTheme()}
      >
        <p className="neb-connect-tutorial-status" role="status">
          {dataReady
            ? "This Agent is no longer available in your fleet."
            : "Loading the selected Agent…"}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Coding-agent handoff"
      className="neb-inline-panel neb-connect-tutorial-panel agent-studio"
      data-connect-intent={context.intent}
      data-theme={tutorialTheme()}
    >
      <AgentStudioHandoff
        continuationIntent={intendedIntent}
        createCredential={signedIn && intendedIntent !== "agent"
          ? createStudioHandoffCredential
          : undefined}
        credentialUnavailableMessage={intendedIntent === "agent"
          ? "New-Agent handoffs are waiting for durable single-create binding. No broader key will be substituted."
          : undefined}
        draftStorageKey={draftStorageKey}
        intent={activeIntent}
        key={draftStorageKey}
        onCreateAccount={() => onSignIn()}
        onSignIn={() => onSignIn()}
        platformMcpUrl={`${launchApiOrigin()}/mcp/platform`}
        target={target}
      />
    </section>
  );
}
