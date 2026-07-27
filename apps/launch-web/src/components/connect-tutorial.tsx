import {
  type ReactElement,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { LaunchAgentSummary } from "../../../../shared/contracts/launch.ts";
import type { LocationState } from "../App";
import {
  buildAgentExtensionPrompt,
  buildConnectAiPrompt,
  buildNewAgentPrompt,
  type AgentExtensionKind,
} from "../lib/agent-extension-prompt";
import {
  getLaunchAuthToken,
  launchAuthSessionIdentity,
} from "../lib/auth";
import {
  launchApi,
  launchApiOrigin,
} from "../lib/api";
import {
  connectTutorialApiKeyRequest,
  connectTutorialHeroTitle,
  parseConnectTutorialContext,
  type ConnectTutorialIntent,
} from "../lib/connect-tutorial";

const tutorialInstruction: Record<ConnectTutorialIntent, string> = {
  connect:
    "Copy the prompt below and paste it into your coding agent to connect it to your Galactic workspace.",
  agent:
    "Copy the prompt below and paste it into your coding agent. It will help define and stage a new persistent Agent for your review.",
  interface:
    "Copy the prompt below and paste it into your coding agent. It is scoped to the selected Agent and guides a safe interface addition.",
  function:
    "Copy the prompt below and paste it into your coding agent. It is scoped to the selected Agent and guides a safe function addition.",
  routine:
    "Copy the prompt below and paste it into your coding agent. It is scoped to the selected Agent and guides a safe routine addition.",
};

interface ProvisionedPrompt {
  keyName: string;
  prompt: string;
}

const provisionedPrompts = new Map<string, Promise<ProvisionedPrompt>>();

function isExtensionIntent(
  intent: ConnectTutorialIntent,
): intent is AgentExtensionKind {
  return intent === "interface" || intent === "function" || intent === "routine";
}

function promptLabel(
  intent: ConnectTutorialIntent,
  agentName?: string | null,
): string {
  switch (intent) {
    case "connect":
      return "Galactic connection prompt";
    case "agent":
      return "New Agent prompt";
    case "interface":
      return `${agentName ?? "Agent"} · Interface prompt`;
    case "function":
      return `${agentName ?? "Agent"} · Function prompt`;
    case "routine":
      return `${agentName ?? "Agent"} · Routine prompt`;
  }
}

function buildPrompt(
  intent: ConnectTutorialIntent,
  agent: LaunchAgentSummary | null,
  apiKey: string,
): string {
  const platformMcpUrl = `${launchApiOrigin()}/mcp/platform`;
  if (isExtensionIntent(intent) && agent) {
    return buildAgentExtensionPrompt({
      agent,
      apiKey,
      kind: intent,
      platformMcpUrl,
    });
  }
  if (intent === "agent") {
    return buildNewAgentPrompt({ apiKey, platformMcpUrl });
  }
  return buildConnectAiPrompt({ apiKey, platformMcpUrl });
}

function provisionPrompt(
  intent: ConnectTutorialIntent,
  agent: LaunchAgentSummary | null,
): Promise<ProvisionedPrompt> {
  const session = launchAuthSessionIdentity(getLaunchAuthToken());
  const cacheKey = [
    session,
    intent,
    agent?.id ?? "workspace",
    agent?.name ?? "",
    agent?.description ?? "",
  ].join(":");
  const existing = provisionedPrompts.get(cacheKey);
  if (existing) return existing;

  const request = connectTutorialApiKeyRequest({
    agent,
    intent,
    suffix: globalThis.crypto?.randomUUID?.().slice(0, 8) ??
      Date.now().toString(36),
  });
  const pending = launchApi.createApiKey(request)
    .then((response) => ({
      keyName: response.apiKey.name,
      prompt: buildPrompt(intent, agent, response.plaintextToken),
    }))
    .catch((error) => {
      provisionedPrompts.delete(cacheKey);
      throw error;
    });
  provisionedPrompts.set(cacheKey, pending);
  return pending;
}

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
  const [retry, setRetry] = useState(0);
  const [provisioned, setProvisioned] = useState<ProvisionedPrompt | null>(null);
  const [provisionError, setProvisionError] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const heroTitle = connectTutorialHeroTitle(context.intent, agent?.name);
  const instruction = useMemo(() => {
    const base = tutorialInstruction[context.intent];
    return agent && needsAgent
      ? `${base} The key can act only on ${agent.name}.`
      : base;
  }, [agent, context.intent, needsAgent]);

  useEffect(() => {
    setProvisioned(null);
    setProvisionError("");
    setCopyState("idle");
    if (!signedIn || (needsAgent && !agent)) return;

    let active = true;
    void provisionPrompt(context.intent, agent)
      .then((result) => {
        if (active) setProvisioned(result);
      })
      .catch((error) => {
        if (!active) return;
        setProvisionError(
          error instanceof Error
            ? error.message
            : "The secure prompt could not be prepared.",
        );
      });
    return () => {
      active = false;
    };
  }, [agent, context.intent, needsAgent, retry, signedIn]);

  const copyPrompt = async () => {
    if (!provisioned) return;
    try {
      await navigator.clipboard.writeText(provisioned.prompt);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("error");
    }
  };

  return (
    <section
      className="neb-inline-panel neb-connect-tutorial-panel"
      aria-label={heroTitle}
      data-connect-intent={context.intent}
    >
      <div className="neb-modal-content">
        <section className="neb-modal-pane active">
          {!signedIn
            ? (
              <div className="neb-connect-tutorial-actions">
                <button onClick={onSignIn} type="button">
                  Sign in to continue
                </button>
                <span>
                  Sign in to provision a scoped prompt for your coding agent.
                </span>
              </div>
            )
            : needsAgent && !agent
            ? (
              <p className="neb-connect-tutorial-status" role="status">
                {dataReady
                  ? "This Agent is no longer available in your fleet."
                  : "Loading the selected Agent…"}
              </p>
            )
            : provisionError
            ? (
              <div className="neb-connect-tutorial-error" role="alert">
                <p>{provisionError}</p>
                <button onClick={() => setRetry((value) => value + 1)} type="button">
                  Try again
                </button>
              </div>
            )
            : provisioned
            ? (
              <>
                <p className="neb-connect-tutorial-instruction">{instruction}</p>
                <div className="neb-connect-tutorial-prompt">
                  <div className="neb-connect-tutorial-prompt-bar">
                    <span>{promptLabel(context.intent, agent?.name)}</span>
                    <button
                      className={copyState === "copied" ? "copied" : ""}
                      onClick={() => void copyPrompt()}
                      type="button"
                    >
                      {copyState === "copied" ? "Copied" : "Copy prompt"}
                    </button>
                  </div>
                  <pre tabIndex={0}>{provisioned.prompt}</pre>
                </div>
                <p className="neb-connect-tutorial-secret">
                  {copyState === "error"
                    ? "Clipboard access was blocked. Select the prompt above and copy it manually."
                    : `The provisioned key “${provisioned.keyName}” is revealed only in this prompt. Keep it secret.`}
                </p>
              </>
            )
            : (
              <p className="neb-connect-tutorial-status" role="status">
                Preparing your scoped coding-agent prompt…
              </p>
            )}
        </section>
      </div>
    </section>
  );
}
