import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  AGENT_STUDIO_HANDOFF_COPY,
  AGENT_STUDIO_HANDOFF_INTENTS,
  type AuthenticatedAgentStudioHandoffIntent,
  type AgentStudioHandoffCopy,
  type AgentStudioHandoffCredentialIssued,
  type AgentStudioHandoffIntent,
  type AgentStudioHandoffTarget,
  buildAgentStudioHandoffPrompt,
  buildRedactedHandoffPreview,
  buildSignedOutHandoffPreview,
  type CreateAgentStudioHandoffCredential,
  credentialRequestFor,
  descriptionIsReady,
  handoffCredentialNeedsRenewal,
  isAgentStudioHandoffTargeted,
  isAgentStudioHandoffUuid,
  validateHandoffCredential,
} from "./agent-studio-handoff-model";

import "./agent-studio-handoff.css";

export interface AgentStudioHandoffProps {
  continuationIntent?: AuthenticatedAgentStudioHandoffIntent;
  createCredential?: CreateAgentStudioHandoffCredential;
  credentialUnavailableMessage?: string;
  draftStorageKey?: string;
  initialDescriptions?: Partial<Record<AgentStudioHandoffIntent, string>>;
  initialIntent?: AgentStudioHandoffIntent;
  intent?: AgentStudioHandoffIntent;
  onBack?: () => void;
  onCreateAccount?: (description: string) => void;
  onDescriptionChange?: (
    descriptions: Partial<Record<AgentStudioHandoffIntent, string>>,
  ) => void;
  onIntentChange?: (intent: AgentStudioHandoffIntent) => void;
  onSignIn?: (description: string) => void;
  platformMcpUrl?: string;
  showIntentTabs?: boolean;
  target?: AgentStudioHandoffTarget | null;
  workspaceAgentCount?: number | null;
}

type CredentialPhase =
  | "idle"
  | "issuing"
  | "copying"
  | "copied"
  | "error";

interface CredentialState {
  credential: AgentStudioHandoffCredentialIssued | null;
  error: string;
  phase: CredentialPhase;
}

const EMPTY_CREDENTIAL_STATE: CredentialState = {
  credential: null,
  error: "",
  phase: "idle",
};
const HANDOFF_DESCRIPTION_MAX_LENGTH = 4_000;

export function AgentStudioHandoff({
  continuationIntent,
  createCredential,
  credentialUnavailableMessage,
  draftStorageKey,
  initialDescriptions = {},
  initialIntent = "interface",
  intent: controlledIntent,
  onBack,
  onCreateAccount,
  onDescriptionChange,
  onIntentChange,
  onSignIn,
  platformMcpUrl = "https://api.galactic.dev/mcp/platform",
  showIntentTabs = false,
  target = null,
  workspaceAgentCount = null,
}: AgentStudioHandoffProps): ReactElement {
  const [internalIntent, setInternalIntent] =
    useState<AgentStudioHandoffIntent>(initialIntent);
  const intent = controlledIntent ?? internalIntent;
  const [descriptions, setDescriptions] = useState<
    Partial<Record<AgentStudioHandoffIntent, string>>
  >(() => readDrafts(draftStorageKey, initialDescriptions));
  const [credentialState, setCredentialState] =
    useState<CredentialState>(EMPTY_CREDENTIAL_STATE);
  const requestGeneration = useRef(0);
  const description = descriptions[intent] ?? "";
  const copy = AGENT_STUDIO_HANDOFF_COPY[intent];
  const signedOut = intent === "signed-out";
  const exactTargetReady = !isAgentStudioHandoffTargeted(intent) ||
    Boolean(target && isAgentStudioHandoffUuid(target.id));
  const ready = descriptionIsReady(intent, description) &&
    exactTargetReady &&
    !signedOut &&
    Boolean(createCredential);
  const displayCopy = dynamicCopy(copy, intent, target);

  useEffect(() => {
    if (!draftStorageKey) return;
    try {
      window.sessionStorage.setItem(
        draftStorageKey,
        JSON.stringify(descriptions),
      );
    } catch {
      // The controlled callback still lets the host preserve a draft.
    }
  }, [descriptions, draftStorageKey]);
  useEffect(() => {
    requestGeneration.current += 1;
    setCredentialState(EMPTY_CREDENTIAL_STATE);
  }, [description, intent, target?.id]);
  useEffect(() =>
    () => {
      requestGeneration.current += 1;
    }, []);

  const preview = useMemo(() => {
    if (signedOut) {
      return buildSignedOutHandoffPreview(
        description,
        platformMcpUrl,
        continuationIntent,
      );
    }
    try {
      return buildRedactedHandoffPreview({
        description,
        intent,
        platformMcpUrl,
        target,
      });
    } catch {
      return [
        `Add a new ${intent} to this exact Galactic Agent.`,
        "",
        "Exact Agent UUID: [required before this prompt can be copied]",
        "",
        "What I want:",
        description.trim() || "your description goes here",
      ].join("\n");
    }
  }, [
    continuationIntent,
    description,
    intent,
    platformMcpUrl,
    signedOut,
    target,
  ]);

  const selectIntent = (next: AgentStudioHandoffIntent) => {
    if (controlledIntent === undefined) setInternalIntent(next);
    onIntentChange?.(next);
  };
  const updateDescription = (value: string) => {
    const next = {
      ...descriptions,
      [intent]: value,
      ...(intent === "signed-out" && continuationIntent
        ? { [continuationIntent]: value }
        : {}),
    };
    setDescriptions(next);
    onDescriptionChange?.(next);
  };
  const copyPrompt = async () => {
    if (
      signedOut ||
      !createCredential ||
      !descriptionIsReady(intent, description)
    ) return;

    const generation = ++requestGeneration.current;
    let credential = credentialState.credential;
    if (credential && handoffCredentialNeedsRenewal(credential)) {
      credential = null;
    }
    let credentialAccepted = false;
    setCredentialState({
      credential,
      error: "",
      phase: credential ? "copying" : "issuing",
    });

    try {
      const request = credentialRequestFor(intent, target, description);
      if (!credential) {
        const result = await createCredential(request);
        if (generation !== requestGeneration.current) return;
        if (result.status === "unavailable") {
          throw new Error(result.message);
        }
        credential = result;
      }
      validateHandoffCredential(credential, request);
      credentialAccepted = true;
      setCredentialState({
        credential,
        error: "",
        phase: "copying",
      });
      const prompt = buildAgentStudioHandoffPrompt({
        bearerToken: credential.bearerToken,
        description,
        expiresAt: credential.expiresAt,
        intent,
        platformMcpUrl: credential.platformMcpUrl,
        sessionId: credential.sessionId,
        target,
      });
      await writePrompt(prompt);
      if (generation !== requestGeneration.current) return;
      setCredentialState({
        credential,
        error: "",
        phase: "copied",
      });
    } catch (reason) {
      if (generation !== requestGeneration.current) return;
      setCredentialState({
        credential: credentialAccepted ? credential : null,
        error: errorMessage(reason),
        phase: "error",
      });
    }
  };

  const status = handoffStatus({
    createCredential: Boolean(createCredential),
    description,
    exactTargetReady,
    intent,
    phase: credentialState.phase,
  });
  const metadata = handoffMetadata({
    credential: credentialState.credential,
    intent,
    target,
    workspaceAgentCount,
  });
  const beats = handoffBeats(intent, target);
  const actionBusy = credentialState.phase === "issuing" ||
    credentialState.phase === "copying";

  return (
    <section
      aria-labelledby="agent-studio-handoff-title"
      className="agent-studio-handoff"
    >
      {showIntentTabs
        ? (
          <div
            aria-label="Coding-agent handoff intent"
            className="agent-studio-handoff-tabs"
            role="tablist"
          >
            {AGENT_STUDIO_HANDOFF_INTENTS.map((candidate) => (
              <button
                aria-selected={intent === candidate}
                disabled={actionBusy}
                key={candidate}
                onClick={() => selectIntent(candidate)}
                role="tab"
                type="button"
              >
                {AGENT_STUDIO_HANDOFF_COPY[candidate].tabLabel}
              </button>
            ))}
          </div>
        )
        : null}

      {onBack
        ? (
          <button
            className="agent-studio-handoff-back"
            onClick={onBack}
            type="button"
          >
            <span aria-hidden="true">←</span>
            {displayCopy.backLabel}
          </button>
        )
        : null}

      <div className="agent-studio-handoff-layout">
        <div className="agent-studio-handoff-explainer">
          <h2 id="agent-studio-handoff-title">{displayCopy.headline}</h2>
          <p>{displayCopy.subhead}</p>
          <HandoffRing backLabel={displayCopy.backResultLabel} />
          <ol className="agent-studio-handoff-beats">
            {beats.map((beat, index) => (
              <li key={beat.title}>
                <div aria-hidden="true">
                  <span>{index + 1}</span>
                </div>
                <div>
                  <strong>{beat.title}</strong>
                  <p>{beat.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <article className="agent-studio-handoff-card">
          <header>
            <span>{displayCopy.cardTitle}</span>
            <span className={`agent-studio-handoff-state ${status.tone}`}>
              <span aria-hidden="true" />
              {status.label}
            </span>
          </header>

          <dl className="agent-studio-handoff-meta">
            {metadata.map((entry) => (
              <div key={entry.label}>
                <dt>{entry.label}</dt>
                <dd className={entry.tone}>{entry.value}</dd>
              </div>
            ))}
          </dl>

          <pre className="agent-studio-handoff-prompt">
            <PromptPreview
              description={description}
              optional={copy.optional}
              prompt={preview}
            />
          </pre>

          <div className="agent-studio-handoff-field">
            <label htmlFor={`agent-studio-handoff-${intent}`}>
              {displayCopy.fieldLabel}
            </label>
            <textarea
              disabled={actionBusy}
              id={`agent-studio-handoff-${intent}`}
              maxLength={HANDOFF_DESCRIPTION_MAX_LENGTH}
              onChange={(event) => updateDescription(event.target.value)}
              placeholder={displayCopy.placeholder}
              value={description}
            />
            <small>
              {description.length.toLocaleString()} /{" "}
              {HANDOFF_DESCRIPTION_MAX_LENGTH.toLocaleString()}
            </small>
          </div>

          {signedOut
            ? (
              <footer className="agent-studio-handoff-auth">
                <div>
                  <button
                    className="primary"
                    onClick={() => onSignIn?.(description)}
                    type="button"
                  >
                    Sign in to Galactic
                  </button>
                  <button
                    onClick={() => onCreateAccount?.(description)}
                    type="button"
                  >
                    Create an account
                  </button>
                </div>
                <p>{copy.hint}</p>
              </footer>
            )
            : (
              <footer className="agent-studio-handoff-copy">
                <div aria-live="polite">
                  {credentialState.error ||
                    handoffHint({
                      copy,
                      createCredential: Boolean(createCredential),
                      credentialUnavailableMessage,
                      description,
                      exactTargetReady,
                      credential: credentialState.credential,
                    })}
                </div>
                <button
                  className={credentialState.phase === "copied"
                    ? "copied"
                    : ""}
                  disabled={!ready || actionBusy}
                  onClick={copyPrompt}
                  type="button"
                >
                  {copyButtonLabel(credentialState.phase)}
                </button>
              </footer>
            )}
        </article>
      </div>
    </section>
  );
}

function PromptPreview({
  description,
  optional,
  prompt,
}: {
  description: string;
  optional: boolean;
  prompt: string;
}) {
  const slot = description.trim() ||
    (optional
      ? "nothing in particular—just connect"
      : "your description goes here");
  const splitAt = prompt.indexOf(slot);
  if (splitAt < 0) return prompt;
  return (
    <>
      {prompt.slice(0, splitAt)}
      <mark className={description.trim() ? "complete" : ""}>{slot}</mark>
      {prompt.slice(splitAt + slot.length)}
    </>
  );
}

function HandoffRing({ backLabel }: { backLabel: string }) {
  return (
    <div className="agent-studio-handoff-ring">
      <svg
        aria-label={`A prompt moves from Galactic to your coding agent and returns as ${backLabel}.`}
        fill="none"
        role="img"
        viewBox="0 0 300 218"
      >
        <circle cx="70" cy="109" r="44" />
        <text x="70" y="113" textAnchor="middle">Galactic</text>
        <circle cx="230" cy="109" r="44" />
        <text x="230" y="106" textAnchor="middle">your coding</text>
        <text x="230" y="120" textAnchor="middle">agent</text>
        <path
          className="out"
          d="M78.5 57.7 A 88 88 0 0 1 221.5 57.7"
        />
        <path
          className="out"
          d="M219.38 48.95 L221.5 57.7 L213.9 52.88"
        />
        <text className="out-label" x="150" y="15" textAnchor="middle">
          this prompt
        </text>
        <path
          className="back"
          d="M221.5 160.3 A 88 88 0 0 1 78.5 160.3"
        />
        <path
          className="back"
          d="M80.62 169.05 L78.5 160.3 L86.1 165.12"
        />
        <text className="back-label" x="150" y="212" textAnchor="middle">
          {backLabel}
        </text>
      </svg>
    </div>
  );
}

function dynamicCopy(
  copy: AgentStudioHandoffCopy,
  intent: AgentStudioHandoffIntent,
  target: AgentStudioHandoffTarget | null,
): AgentStudioHandoffCopy {
  if (!target || !isAgentStudioHandoffTargeted(intent)) return copy;
  const noun = intent === "interface"
    ? "interface"
    : intent === "function"
    ? "capability"
    : "routine";
  return {
    ...copy,
    cardTitle: `New ${target.name} ${
      intent === "function" ? "function" : intent
    }`,
    headline: `${intent === "function" ? "Write" : intent === "routine"
      ? "Start"
      : "Add"} a${intent === "interface" ? "n" : ""} ${noun} for ${
      target.name
    }`,
    subhead: copy.subhead.replaceAll("this Agent", target.name),
  };
}

function handoffBeats(
  intent: AgentStudioHandoffIntent,
  target: AgentStudioHandoffTarget | null,
) {
  const name = target?.name ?? "this Agent";
  switch (intent) {
    case "agent":
      return [
        {
          body: "Claude Code, Cursor, or whatever you write code in.",
          title: "Paste this prompt to your coding agent",
        },
        {
          body:
            "It asks what the Agent may touch and what it must never do alone, then prepares it for review.",
          title: "Your coding agent asks, builds and prepares",
        },
        {
          body:
            "Release 1.0.0, private and paused, with nothing granted until you say so.",
          title: AGENT_STUDIO_HANDOFF_COPY.agent.thirdBeatTitle,
        },
      ];
    case "connect":
      return [
        {
          body: "Claude Code, Cursor, or whatever you write code in.",
          title: "Paste this prompt to your coding agent",
        },
        {
          body:
            "Nothing changes yet—it connects, lists what it sees, and waits for you.",
          title: "Your coding agent connects and lists what it sees",
        },
        {
          body:
            "Each change arrives as an immutable release you approve or roll back.",
          title: AGENT_STUDIO_HANDOFF_COPY.connect.thirdBeatTitle,
        },
      ];
    case "signed-out":
      return [
        {
          body:
            "A temporary key that can stage Agent changes has to belong to an account.",
          title: "Sign in to Galactic",
        },
        {
          body:
            "It arrives written for you, with a genuinely short-lived key.",
          title: "Paste this prompt to your coding agent",
        },
        {
          body:
            "Each change arrives as an immutable release you approve or roll back.",
          title: AGENT_STUDIO_HANDOFF_COPY["signed-out"].thirdBeatTitle,
        },
      ];
    default: {
      const result = intent === "interface"
        ? "interface"
        : intent === "function"
        ? "capability"
        : "routine";
      const middle = intent === "interface"
        ? "It asks who uses the screen and what it should let them do, then stages the tested candidate."
        : intent === "function"
        ? "It proposes the narrowest consequence group—read, internal write, external side effect, or spend—for your review."
        : "It asks what the routine may call and what it must never do alone, then stages the tested candidate.";
      return [
        {
          body: `Claude Code, Cursor, or whatever built ${name}.`,
          title: "Paste this prompt to your coding agent",
        },
        {
          body: middle,
          title: "Your coding agent asks, builds and stages",
        },
        {
          body: intent === "routine"
            ? "On Routines, paused, so nothing wakes until you switch it on."
            : intent === "function"
            ? "On Capabilities as tested code; no autonomous authority is implied until you configure an enforced policy."
            : "On Interfaces, tied to the immutable release you approve.",
          title: `The ${result} runs on Galactic`,
        },
      ];
    }
  }
}

function handoffMetadata({
  credential,
  intent,
  target,
  workspaceAgentCount,
}: {
  credential: AgentStudioHandoffCredentialIssued | null;
  intent: AgentStudioHandoffIntent;
  target: AgentStudioHandoffTarget | null;
  workspaceAgentCount: number | null;
}) {
  if (intent === "signed-out") {
    return [
      { label: "Signed in as", tone: "accent", value: "nobody yet" },
      { label: "Agent", tone: "muted", value: "chosen after sign-in" },
      {
        label: "Scope",
        tone: "muted",
        value: "server-bounded after sign-in",
      },
      { label: "Token", tone: "accent", value: "issued after sign-in" },
      {
        label: "Token expires",
        tone: "muted",
        value: "shown after issuance",
      },
    ];
  }

  const keyValue = credential
    ? maskCredential(credential.bearerToken)
    : "issued when copied";
  const expiry = credential
    ? formatExpiry(credential.expiresAt)
    : "not issued";
  if (intent === "agent") {
    return [
      { label: "Creating", tone: "", value: "a new Agent" },
      { label: "Existing Agents", tone: "", value: "untouched" },
      {
        label: "Scope",
        tone: "danger",
        value: "single-create binding required",
      },
      { label: "Token", tone: "accent", value: keyValue },
      { label: "Token expires", tone: "accent", value: expiry },
    ];
  }
  if (intent === "connect") {
    return [
      { label: "Connecting", tone: "", value: "your coding agent" },
      {
        label: "Covers",
        tone: "",
        value: workspaceAgentCount === null
          ? "your workspace Agents"
          : `all your Agents · ${workspaceAgentCount}`,
      },
      { label: "Scope", tone: "accent", value: "inspect + stage candidate" },
      { label: "Token", tone: "accent", value: keyValue },
      { label: "Token expires", tone: "accent", value: expiry },
    ];
  }

  const current = intent === "function"
    ? [
      {
        label: "Declared now",
        tone: "",
        value: target?.functionCount == null
          ? "from the live release"
          : `${target.functionCount} functions${
            target.capabilityGroupCount == null
              ? ""
              : `, ${target.capabilityGroupCount} groups`
          }`,
      },
    ]
    : intent === "routine"
    ? [
      {
        label: "Routines now",
        tone: "",
        value: target?.routineCount == null
          ? "from the live release"
          : String(target.routineCount),
      },
    ]
    : [
      {
        label: "Release",
        tone: "",
        value: target?.releaseVersion ?? "live",
      },
    ];
  return [
    { label: "Agent", tone: "", value: target?.name ?? "exact target needed" },
    {
      label: "Agent id",
      tone: target && isAgentStudioHandoffUuid(target.id) ? "" : "danger",
      value: target?.id ?? "exact UUID needed",
    },
    ...current,
    { label: "Token", tone: "accent", value: keyValue },
    { label: "Token expires", tone: "accent", value: expiry },
  ];
}

function handoffStatus({
  createCredential,
  description,
  exactTargetReady,
  intent,
  phase,
}: {
  createCredential: boolean;
  description: string;
  exactTargetReady: boolean;
  intent: AgentStudioHandoffIntent;
  phase: CredentialPhase;
}) {
  if (intent === "signed-out") {
    return { label: "Sign in required", tone: "waiting" };
  }
  if (phase === "issuing") {
    return { label: "Issuing scoped token", tone: "waiting" };
  }
  if (phase === "copying") {
    return { label: "Copying", tone: "waiting" };
  }
  if (phase === "copied") return { label: "Copied", tone: "ready" };
  if (phase === "error") return { label: "Could not copy", tone: "error" };
  if (!exactTargetReady) {
    return { label: "Exact UUID required", tone: "waiting" };
  }
  if (!descriptionIsReady(intent, description)) {
    return { label: "Incomplete", tone: "incomplete" };
  }
  if (!createCredential) {
    return { label: "Secure key unavailable", tone: "waiting" };
  }
  return { label: "Ready to copy", tone: "ready" };
}

function handoffHint({
  copy,
  createCredential,
  credential,
  credentialUnavailableMessage,
  description,
  exactTargetReady,
}: {
  copy: AgentStudioHandoffCopy;
  createCredential: boolean;
  credential: AgentStudioHandoffCredentialIssued | null;
  credentialUnavailableMessage?: string;
  description: string;
  exactTargetReady: boolean;
}) {
  if (!description.trim() && !copy.optional) {
    return "Describe it first—the prompt is missing a line.";
  }
  if (!exactTargetReady) {
    return "This prompt needs the Agent’s complete UUID before it can issue a key.";
  }
  if (!createCredential) {
    return credentialUnavailableMessage ||
      "Short-lived handoff credentials are not available yet. No general API key will be substituted.";
  }
  if (credential) {
    return `The token expires ${
      formatExpiry(credential.expiresAt)
    }. An MCP server entry saved by your client cannot authenticate afterward.`;
  }
  return copy.hint;
}

function copyButtonLabel(phase: CredentialPhase) {
  switch (phase) {
    case "issuing":
      return "Issuing token…";
    case "copying":
      return "Copying…";
    case "copied":
      return "✓ Copied";
    default:
      return "Copy prompt";
  }
}

function maskCredential(token: string): string {
  const start = token.slice(0, Math.min(6, token.length));
  const end = token.length > 10 ? token.slice(-4) : "";
  return `${start}…${end}`;
}

function formatExpiry(value: string): string {
  const delta = Date.parse(value) - Date.now();
  if (!Number.isFinite(delta)) return "at the issued time";
  if (delta <= 0) return "already expired";
  const minutes = Math.max(1, Math.ceil(delta / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.ceil(hours / 24);
  return `in ${days} days`;
}

function readDrafts(
  key: string | undefined,
  initial: Partial<Record<AgentStudioHandoffIntent, string>>,
) {
  if (!key || typeof window === "undefined") return initial;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(key) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return initial;
    }
    const persisted: Partial<Record<AgentStudioHandoffIntent, string>> = {};
    for (const intent of AGENT_STUDIO_HANDOFF_INTENTS) {
      if (typeof parsed[intent] === "string") {
        persisted[intent] = parsed[intent];
      }
    }
    return { ...initial, ...persisted };
  } catch {
    return initial;
  }
}

async function writePrompt(prompt: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error(
      "Your browser did not allow clipboard access. The scoped token was not displayed.",
    );
  }
  await navigator.clipboard.writeText(prompt);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
