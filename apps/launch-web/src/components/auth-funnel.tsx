import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { LaunchCandidateListResponse } from "../../../../shared/contracts/launch.ts";
import {
  AUTH_FUNNEL_BRIEF_MAX_LENGTH,
  AUTH_FUNNEL_FEATURES,
  AUTH_FUNNEL_NAME_MAX_LENGTH,
  AUTH_FUNNEL_NOTE_MAX_LENGTH,
  authFunnelDisplayName,
  type AuthFunnelFeature,
  type AuthFunnelFeatureKey,
  authFunnelManifestRows,
  type AuthFunnelPlan,
  authFunnelQuestionAnswered,
  type AuthFunnelQuestionKey,
  authFunnelQuestionSummary,
  buildAuthFunnelPlanDescription,
  nextAuthFunnelQuestion,
  readAuthFunnelPlan,
  selectedAuthFunnelOption,
  writeAuthFunnelPlan,
} from "../lib/auth-funnel-model";
import {
  type AgentStudioHandoffCredentialIssued,
  buildAgentStudioHandoffPrompt,
  buildRedactedHandoffPreview,
  credentialRequestFor,
  handoffCredentialNeedsRenewal,
  validateHandoffCredential,
} from "./agent-studio/agent-studio-handoff-model";
import { createStudioHandoffCredential } from "../lib/agent-studio-handoff-credential";
import { launchApi, launchApiOrigin } from "../lib/api";
import type { LaunchNavigate } from "../lib/navigation";
import { CandidateInvitations } from "./candidate-invitations";
import { NebulaPublicShell } from "./nebula-fleet";
import { useSignInModal } from "./sign-in-modal";

import "./auth-funnel.css";

export type AuthFunnelStep = "plan" | "handoff" | "review";

interface CredentialView {
  credential: AgentStudioHandoffCredentialIssued | null;
  error: string;
  phase: "idle" | "issuing" | "copying" | "copied" | "error";
}

const EMPTY_CREDENTIAL_VIEW: CredentialView = {
  credential: null,
  error: "",
  phase: "idle",
};

export function authFunnelStepFromSearch(searchValue: string): AuthFunnelStep {
  const value = new URLSearchParams(searchValue).get("step");
  return value === "handoff" || value === "review" ? value : "plan";
}

export function authFunnelHref(
  location: { pathname: string; search: string },
  step: AuthFunnelStep,
): string {
  const search = new URLSearchParams(location.search);
  search.set("intent", "agent");
  if (step === "plan") search.delete("step");
  else search.set("step", step);
  search.delete("subscription");
  search.delete("subscription_attempt");
  const query = search.toString();
  return `${location.pathname}${query ? `?${query}` : ""}`;
}

export function shouldAutoLoadCandidateReview(input: {
  error: string;
  hasResponse: boolean;
  loading: boolean;
  signedIn: boolean;
  step: AuthFunnelStep;
}): boolean {
  return input.step === "review" &&
    input.signedIn &&
    !input.hasResponse &&
    !input.error &&
    !input.loading;
}

function browserLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function AuthFunnelApp({
  location,
  navigate,
  signedIn,
}: {
  location: { pathname: string; search: string };
  navigate: LaunchNavigate;
  signedIn: boolean;
}): ReactElement {
  const openSignIn = useSignInModal();
  const step = authFunnelStepFromSearch(location.search);
  const [plan, setPlan] = useState<AuthFunnelPlan>(() =>
    readAuthFunnelPlan(browserLocalStorage())
  );
  const [candidateResponse, setCandidateResponse] = useState<
    LaunchCandidateListResponse | undefined
  >();
  const [candidateError, setCandidateError] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const reviewLoadingRef = useRef(false);

  useEffect(() => {
    writeAuthFunnelPlan(browserLocalStorage(), plan);
  }, [plan]);

  const updatePlan = useCallback((
    update: (current: AuthFunnelPlan) => AuthFunnelPlan,
  ) => {
    setPlan((current) => ({
      ...update(current),
      updatedAt: new Date().toISOString(),
    }));
  }, []);

  const changePlan = useCallback((
    update: (current: AuthFunnelPlan) => AuthFunnelPlan,
  ) => {
    updatePlan((current) => ({
      ...update(current),
      hasCopied: false,
      reviewUnlocked: false,
    }));
  }, [updatePlan]);

  const loadCandidates = useCallback(async () => {
    if (!signedIn || reviewLoadingRef.current) return;
    reviewLoadingRef.current = true;
    setReviewLoading(true);
    setCandidateError("");
    try {
      const response = await launchApi.candidates();
      setCandidateResponse(response);
      if (response.candidates.length > 0) {
        updatePlan((current) => ({ ...current, reviewUnlocked: true }));
      }
    } catch (reason) {
      setCandidateError(
        reason instanceof Error
          ? reason.message
          : "Built Agents could not be loaded.",
      );
    } finally {
      reviewLoadingRef.current = false;
      setReviewLoading(false);
    }
  }, [signedIn, updatePlan]);

  useEffect(() => {
    if (
      shouldAutoLoadCandidateReview({
        error: candidateError,
        hasResponse: Boolean(candidateResponse),
        loading: reviewLoading,
        signedIn,
        step,
      })
    ) {
      void loadCandidates();
    }
  }, [
    candidateError,
    candidateResponse,
    loadCandidates,
    reviewLoading,
    signedIn,
    step,
  ]);

  const goTo = (next: AuthFunnelStep, replace = false) => {
    navigate(authFunnelHref(location, next), { replace });
  };

  return (
    <NebulaPublicShell>
      <AuthFunnelTopbar
        backLabel={step === "plan"
          ? "Your agents"
          : step === "handoff"
          ? "Back to the questions"
          : "Back to the hand-off"}
        onBack={() => {
          if (step === "plan") navigate("/");
          else goTo(step === "review" ? "handoff" : "plan");
        }}
        onHome={() => navigate("/")}
        onSignIn={signedIn ? undefined : openSignIn}
      />

      <main className={`auth-funnel-main is-${step}`}>
        {step === "plan"
          ? (
            <PlanningBallot
              onDone={() => goTo("handoff")}
              onPlanChange={changePlan}
              onPlanUpdate={updatePlan}
              plan={plan}
            />
          )
          : step === "handoff"
          ? (
            <HandoffSteps
              location={location}
              onCandidates={(response) => {
                setCandidateResponse(response);
                updatePlan((current) => ({
                  ...current,
                  reviewUnlocked: true,
                }));
                goTo("review");
              }}
              onPlanUpdate={updatePlan}
              onSignIn={openSignIn}
              plan={plan}
              signedIn={signedIn}
            />
          )
          : (
            <CandidateReview
              error={candidateError}
              loading={reviewLoading}
              location={location}
              navigate={navigate}
              onReload={loadCandidates}
              response={candidateResponse}
            />
          )}
      </main>
    </NebulaPublicShell>
  );
}

function AuthFunnelTopbar({
  backLabel,
  onBack,
  onHome,
  onSignIn,
}: {
  backLabel: string;
  onBack: () => void;
  onHome: () => void;
  onSignIn?: () => void;
}): ReactElement {
  return (
    <header className="auth-funnel-topbar-shell">
      <div className="auth-funnel-topbar">
        <button className="auth-funnel-wordmark" onClick={onHome} type="button">
          galactic
        </button>
        <div className="auth-funnel-topbar-actions">
          <button
            className="auth-funnel-back"
            onClick={onBack}
            type="button"
          >
            ← {backLabel}
          </button>
          {onSignIn
            ? (
              <button
                className="auth-funnel-signin"
                onClick={onSignIn}
                type="button"
              >
                Sign in
              </button>
            )
            : null}
        </div>
      </div>
    </header>
  );
}

function PlanningBallot({
  onDone,
  onPlanChange,
  onPlanUpdate,
  plan,
}: {
  onDone: () => void;
  onPlanChange: (
    update: (current: AuthFunnelPlan) => AuthFunnelPlan,
  ) => void;
  onPlanUpdate: (
    update: (current: AuthFunnelPlan) => AuthFunnelPlan,
  ) => void;
  plan: AuthFunnelPlan;
}): ReactElement {
  const openQuestion = (key: AuthFunnelQuestionKey) => {
    onPlanUpdate((current) => ({
      ...current,
      open: current.open === key ? null : key,
    }));
  };

  return (
    <section
      aria-labelledby="auth-funnel-plan-heading"
      className="auth-funnel-ballot-layout"
    >
      <div className="auth-funnel-plan-column">
        <h1 id="auth-funnel-plan-heading">Let&apos;s plan your own agent</h1>
        <p className="auth-funnel-plan-intro">
          Seven rows, all optional. Open a row to answer it and leave a note —
          anything you skip stays your coding agent&apos;s call.
        </p>

        <div className="auth-funnel-manifest-head">
          <span>{authFunnelDisplayName(plan)}</span>
          <span className="auth-funnel-planning-status">
            <span aria-hidden="true" />
            Planning
          </span>
        </div>
        <div className="auth-funnel-manifest">
          {authFunnelManifestRows(plan).map((row) => (
            <button
              aria-label={`Plan ${row.label}`}
              className={row.deciding ? "is-deciding" : undefined}
              key={row.key}
              onClick={() => openQuestion(row.key)}
              type="button"
            >
              <span>{row.label}</span>
              <span className={row.value === "—" ? "is-empty" : undefined}>
                {row.value}
              </span>
            </button>
          ))}
        </div>
        <p className="auth-funnel-manifest-note">
          Your answers assemble this. Nothing is built yet.
        </p>
      </div>

      <div className="auth-funnel-questions-column">
        <ol className="auth-funnel-questions">
          <BriefQuestion
            onChange={onPlanChange}
            onOpen={openQuestion}
            onUpdate={onPlanUpdate}
            plan={plan}
          />
          {AUTH_FUNNEL_FEATURES.map((feature) => (
            <FeatureQuestion
              feature={feature}
              key={feature.key}
              onChange={onPlanChange}
              onOpen={openQuestion}
              onUpdate={onPlanUpdate}
              plan={plan}
            />
          ))}
        </ol>
        <div className="auth-funnel-ballot-footer">
          <span>unanswered rows stay with your coding agent</span>
          <button onClick={onDone} type="button">
            Done — write my prompt
          </button>
        </div>
      </div>
    </section>
  );
}

function BriefQuestion({
  onChange,
  onOpen,
  onUpdate,
  plan,
}: {
  onChange: (
    update: (current: AuthFunnelPlan) => AuthFunnelPlan,
  ) => void;
  onOpen: (key: AuthFunnelQuestionKey) => void;
  onUpdate: (
    update: (current: AuthFunnelPlan) => AuthFunnelPlan,
  ) => void;
  plan: AuthFunnelPlan;
}): ReactElement {
  const open = plan.open === "brief";
  const answered = authFunnelQuestionAnswered(plan, "brief");
  return (
    <QuestionShell
      answered={answered}
      hint="Describe it in your own words — the first line of your brief."
      onOpen={() => onOpen("brief")}
      open={open}
      summary={authFunnelQuestionSummary(plan, "brief")}
      tag="Brief"
      title="I know what to build"
    >
      <div className="auth-funnel-brief-fields">
        <label>
          <span>Name it</span>
          <input
            maxLength={AUTH_FUNNEL_NAME_MAX_LENGTH}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                agentName: event.target.value,
              }))}
            placeholder="Untitled Agent"
            type="text"
            value={plan.agentName}
          />
        </label>
        <label>
          <span>Describe it</span>
          <textarea
            maxLength={AUTH_FUNNEL_BRIEF_MAX_LENGTH}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                brief: event.target.value,
              }))}
            placeholder="Watches a shared inbox, drafts replies for approval, escalates anything angry…"
            rows={3}
            value={plan.brief}
          />
        </label>
      </div>
      <QuestionActions
        onClear={() =>
          onChange((current) => ({
            ...current,
            agentName: "",
            brief: "",
            open: null,
          }))}
        onNext={() =>
          onUpdate((current) => ({
            ...current,
            open: nextAuthFunnelQuestion("brief"),
          }))}
      />
    </QuestionShell>
  );
}

function FeatureQuestion({
  feature,
  onChange,
  onOpen,
  onUpdate,
  plan,
}: {
  feature: AuthFunnelFeature;
  onChange: (
    update: (current: AuthFunnelPlan) => AuthFunnelPlan,
  ) => void;
  onOpen: (key: AuthFunnelQuestionKey) => void;
  onUpdate: (
    update: (current: AuthFunnelPlan) => AuthFunnelPlan,
  ) => void;
  plan: AuthFunnelPlan;
}): ReactElement {
  const open = plan.open === feature.key;
  const answered = authFunnelQuestionAnswered(plan, feature.key);
  const selected = selectedAuthFunnelOption(plan, feature.key);
  return (
    <QuestionShell
      answered={answered}
      hint={feature.hint}
      onOpen={() => onOpen(feature.key)}
      open={open}
      summary={authFunnelQuestionSummary(plan, feature.key)}
      tag={feature.tag}
      title={feature.ballot}
    >
      <div className="auth-funnel-option-list">
        {feature.options.map((option) => {
          const active = selected?.id === option.id;
          return (
            <button
              aria-pressed={active}
              className={active ? "is-selected" : undefined}
              key={option.id}
              onClick={() =>
                onChange((current) => {
                  const answers = { ...current.answers };
                  if (active) delete answers[feature.key];
                  else answers[feature.key] = option.id;
                  return { ...current, answers };
                })}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <label className="auth-funnel-more-detail">
        <span>More detail</span>
        <input
          maxLength={AUTH_FUNNEL_NOTE_MAX_LENGTH}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              notes: {
                ...current.notes,
                [feature.key]: event.target.value,
              },
            }))}
          placeholder="Anything to add — timing, tools, limits…"
          type="text"
          value={plan.notes[feature.key] ?? ""}
        />
      </label>
      <QuestionActions
        onClear={() =>
          onChange((current) => {
            const answers = { ...current.answers };
            const notes = { ...current.notes };
            delete answers[feature.key];
            delete notes[feature.key];
            return { ...current, answers, notes, open: null };
          })}
        onNext={() =>
          onUpdate((current) => ({
            ...current,
            open: nextAuthFunnelQuestion(feature.key),
          }))}
      />
    </QuestionShell>
  );
}

function QuestionShell({
  answered,
  children,
  hint,
  onOpen,
  open,
  summary,
  tag,
  title,
}: {
  answered: boolean;
  children: ReactElement | ReactElement[];
  hint: string;
  onOpen: () => void;
  open: boolean;
  summary: string;
  tag: string;
  title: string;
}): ReactElement {
  return (
    <li className={open ? "is-open" : undefined}>
      <button
        aria-expanded={open}
        className="auth-funnel-question-toggle"
        onClick={onOpen}
        type="button"
      >
        <span
          aria-hidden="true"
          className={`auth-funnel-checkbox ${
            answered || open ? "is-checked" : ""
          }`}
        >
          {answered || open ? "✓" : ""}
        </span>
        <span className="auth-funnel-question-copy">
          <span className="auth-funnel-question-title">
            <strong>{title}</strong>
            <span>{tag}</span>
          </span>
          {open || !answered
            ? <span className="auth-funnel-question-hint">{hint}</span>
            : <span className="auth-funnel-question-summary">{summary}</span>}
        </span>
      </button>
      {open
        ? <div className="auth-funnel-question-body">{children}</div>
        : null}
    </li>
  );
}

function QuestionActions({
  onClear,
  onNext,
}: {
  onClear: () => void;
  onNext: () => void;
}): ReactElement {
  return (
    <div className="auth-funnel-question-actions">
      <button onClick={onNext} type="button">Next</button>
      <button onClick={onClear} type="button">
        leave this to my coding agent
      </button>
    </div>
  );
}

function HandoffSteps({
  location,
  onCandidates,
  onPlanUpdate,
  onSignIn,
  plan,
  signedIn,
}: {
  location: { pathname: string; search: string };
  onCandidates: (response: LaunchCandidateListResponse) => void;
  onPlanUpdate: (
    update: (current: AuthFunnelPlan) => AuthFunnelPlan,
  ) => void;
  onSignIn: () => void;
  plan: AuthFunnelPlan;
  signedIn: boolean;
}): ReactElement {
  const description = useMemo(
    () => buildAuthFunnelPlanDescription(plan),
    [plan],
  );
  const platformMcpUrl = `${launchApiOrigin()}/mcp/platform`;
  const [credentialView, setCredentialView] = useState<CredentialView>(
    EMPTY_CREDENTIAL_VIEW,
  );
  const [promptCollapsed, setPromptCollapsed] = useState(plan.hasCopied);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState("");
  const requestGeneration = useRef(0);

  useEffect(() => {
    requestGeneration.current += 1;
    setCredentialView(EMPTY_CREDENTIAL_VIEW);
  }, [description]);
  useEffect(() => () => {
    requestGeneration.current += 1;
  }, []);

  const preview = useMemo(() =>
    buildRedactedHandoffPreview({
      description,
      intent: "agent",
      platformMcpUrl,
      target: null,
    }), [description, platformMcpUrl]);

  const copyPrompt = async () => {
    if (!signedIn) return;
    const generation = ++requestGeneration.current;
    let credential = credentialView.credential;
    if (credential && handoffCredentialNeedsRenewal(credential)) {
      credential = null;
    }
    let credentialAccepted = false;
    setCredentialView({
      credential,
      error: "",
      phase: credential ? "copying" : "issuing",
    });
    try {
      const request = credentialRequestFor("agent", null, description);
      if (!credential) {
        const result = await createStudioHandoffCredential(request);
        if (generation !== requestGeneration.current) return;
        if (result.status === "unavailable") throw new Error(result.message);
        credential = result;
      }
      validateHandoffCredential(credential, request);
      credentialAccepted = true;
      const prompt = buildAgentStudioHandoffPrompt({
        bearerToken: credential.bearerToken,
        description,
        expiresAt: credential.expiresAt,
        intent: "agent",
        platformMcpUrl: credential.platformMcpUrl,
        sessionId: credential.sessionId,
        target: null,
      });
      setCredentialView({ credential, error: "", phase: "copying" });
      await writeAuthFunnelPrompt(prompt);
      if (generation !== requestGeneration.current) return;
      setCredentialView({ credential, error: "", phase: "copied" });
      setPromptCollapsed(true);
      onPlanUpdate((current) => ({ ...current, hasCopied: true }));
    } catch (reason) {
      if (generation !== requestGeneration.current) return;
      setCredentialView({
        credential: credentialAccepted ? credential : null,
        error: reason instanceof Error ? reason.message : String(reason),
        phase: "error",
      });
    }
  };

  const checkCandidates = async () => {
    if (!signedIn || !plan.hasCopied || checking) return;
    setChecking(true);
    setCheckMessage("");
    try {
      const response = await launchApi.candidates();
      if (response.candidates.length > 0) {
        onCandidates(response);
      } else {
        setCheckMessage(
          "Still waiting — no tested Agent candidate has arrived on this account yet.",
        );
      }
    } catch (reason) {
      setCheckMessage(
        reason instanceof Error
          ? reason.message
          : "Galactic could not check this account yet.",
      );
    } finally {
      setChecking(false);
    }
  };

  const copyBusy = credentialView.phase === "issuing" ||
    credentialView.phase === "copying";

  return (
    <section
      aria-labelledby="auth-funnel-handoff-heading"
      className="auth-funnel-handoff-panel"
    >
      <h1 id="auth-funnel-handoff-heading">
        {authFunnelDisplayName(plan)} is planned. Hand it off.
      </h1>
      <ol className="auth-funnel-handoff-steps">
        <li>
          <StepNumber value={1} />
          <div>
            <h2>Create your account</h2>
            <p>The key is issued to your account, not to this page.</p>
            {signedIn
              ? (
                <div className="auth-funnel-account-confirmed" role="status">
                  <span aria-hidden="true" />
                  Account confirmed with passwordless sign in
                </div>
              )
              : (
                <button
                  className="auth-funnel-primary"
                  onClick={onSignIn}
                  type="button"
                >
                  Create an account
                </button>
              )}
          </div>
        </li>
        <li>
          <StepNumber value={2} />
          <div>
            <h2>Paste the starter prompt into your coding agent</h2>
            <p>Claude Code, Codex, Cursor, or whatever you write code in.</p>

            {promptCollapsed
              ? (
                <div className="auth-funnel-prompt-collapsed">
                  <span>
                    Starter prompt · {preview.split("\n").length} lines ·{" "}
                    {signedIn ? "purpose-bound key included" : "key pending"}
                  </span>
                  <button
                    onClick={() => setPromptCollapsed(false)}
                    type="button"
                  >
                    Show prompt
                  </button>
                </div>
              )
              : (
                <pre className="auth-funnel-prompt">
                  <HighlightedPrompt
                    description={description}
                    prompt={preview}
                  />
                </pre>
              )}

            <div className="auth-funnel-copy-row">
              <button
                className={`auth-funnel-primary ${
                  credentialView.phase === "copied" ? "is-copied" : ""
                }`}
                disabled={!signedIn || copyBusy}
                onClick={() => void copyPrompt()}
                type="button"
              >
                {credentialView.phase === "issuing"
                  ? "Preparing secure prompt…"
                  : credentialView.phase === "copying"
                  ? "Copying…"
                  : credentialView.phase === "copied"
                  ? "Copied ✓"
                  : "Copy prompt"}
              </button>
              {!signedIn
                ? (
                  <span>
                    Create your account first — the key completes the prompt.
                  </span>
                )
                : (
                  <span>
                    The purpose-bound key expires 60 minutes after issue.
                  </span>
                )}
            </div>
            {credentialView.error
              ? (
                <p className="auth-funnel-inline-error" role="alert">
                  {credentialView.error}
                </p>
              )
              : null}
          </div>
        </li>
        <li>
          <StepNumber value={3} />
          <div>
            <h2>Your coding agent builds and reports back</h2>
            <p>
              It stages and tests an exact release, then submits it for your
              review. Nothing deploys from the coding-agent handoff.
            </p>
            {plan.hasCopied
              ? (
                <>
                  <div className="auth-funnel-check-row">
                    <button
                      className="auth-funnel-primary"
                      disabled={checking}
                      onClick={() => void checkCandidates()}
                      type="button"
                    >
                      See what it built
                    </button>
                    {checking
                      ? (
                        <span className="auth-funnel-checking" role="status">
                          <span aria-hidden="true" />
                          checking your account…
                        </span>
                      )
                      : null}
                  </div>
                  {checkMessage
                    ? (
                      <p
                        className="auth-funnel-waiting"
                        role={checkMessage.startsWith("Still waiting")
                          ? "status"
                          : "alert"}
                      >
                        <span aria-hidden="true" />
                        {checkMessage}
                      </p>
                    )
                    : null}
                </>
              )
              : (
                <p className="auth-funnel-waiting">
                  <span aria-hidden="true" />
                  Still waiting — nothing has been deployed yet
                </p>
              )}
          </div>
        </li>
      </ol>
      <span className="sr-only">
        Funnel location: {location.pathname}
      </span>
    </section>
  );
}

function StepNumber({ value }: { value: number }): ReactElement {
  return <span className="auth-funnel-step-number">{value}</span>;
}

function HighlightedPrompt({
  description,
  prompt,
}: {
  description: string;
  prompt: string;
}): ReactElement {
  const index = prompt.indexOf(description);
  if (index < 0) return <>{prompt}</>;
  return (
    <>
      {prompt.slice(0, index)}
      <mark>{description}</mark>
      {prompt.slice(index + description.length)}
    </>
  );
}

function CandidateReview({
  error,
  loading,
  location,
  navigate,
  onReload,
  response,
}: {
  error: string;
  loading: boolean;
  location: { pathname: string; search: string };
  navigate: LaunchNavigate;
  onReload: () => Promise<void>;
  response?: LaunchCandidateListResponse;
}): ReactElement {
  if (!response && loading) {
    return (
      <section className="auth-funnel-review-loading" aria-live="polite">
        <span aria-hidden="true" />
        Loading your exact-tested Agents…
      </section>
    );
  }
  return (
    <CandidateInvitations
      checkoutReturnPath={authFunnelHref(location, "review")}
      error={error || undefined}
      location={location}
      navigate={navigate}
      onReload={onReload}
      response={response}
      variant="funnel"
    />
  );
}

export async function writeAuthFunnelPrompt(prompt: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(prompt);
    return;
  }
  if (typeof document === "undefined") {
    throw new Error("Clipboard access is unavailable.");
  }
  const textarea = document.createElement("textarea");
  textarea.value = prompt;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable.");
}
