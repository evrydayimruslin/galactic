import { type ReactElement, useEffect, useState } from "react";

import type {
  LaunchAgentKnowledgeFact,
  LaunchAgentKnowledgeProjection,
  LaunchAgentKnowledgeQuestion,
} from "../../../../../shared/contracts/launch.ts";
import { launchApi } from "../../lib/api";
import { AgentStudioConcepts } from "./agent-studio-concepts";
import { StudioPageHeader } from "./agent-studio-overview";

// WO-5 Knowledge-lite pane. Probabilistic by decision: facts are guidance
// the agent is given, and the copy below says exactly what is absent
// (citations, contradictions — pillar work). Alerts stay pointers: a
// blocking question's alert auto-resolves when it is answered here.

interface AgentStudioKnowledgeApi {
  load: (locator: string) => Promise<LaunchAgentKnowledgeProjection>;
  teach: (
    locator: string,
    request: { slug: string; title?: string | null; content: string },
  ) => Promise<{ fact: LaunchAgentKnowledgeFact }>;
  answer: (
    locator: string,
    questionId: string,
    request: { content: string },
  ) => Promise<{
    question: LaunchAgentKnowledgeQuestion;
    fact: LaunchAgentKnowledgeFact;
  }>;
  dismiss: (
    locator: string,
    questionId: string,
  ) => Promise<{ question: LaunchAgentKnowledgeQuestion }>;
}

const defaultKnowledgeApi: AgentStudioKnowledgeApi = {
  load: (locator) => launchApi.agentKnowledge(locator),
  teach: (locator, request) =>
    launchApi.upsertAgentKnowledgeFact(locator, request),
  answer: (locator, questionId, request) =>
    launchApi.answerAgentKnowledgeQuestion(locator, questionId, request),
  dismiss: (locator, questionId) =>
    launchApi.dismissAgentKnowledgeQuestion(locator, questionId),
};

function factSourceLabel(fact: LaunchAgentKnowledgeFact): string {
  return fact.source === "owner" ? "you wrote this" : "learned by the agent";
}

export function AgentStudioKnowledge({
  agentLocator,
  api = defaultKnowledgeApi,
  initialProjection = null,
}: {
  agentLocator: string;
  /** DI seams for tests. */
  api?: AgentStudioKnowledgeApi;
  initialProjection?: LaunchAgentKnowledgeProjection | null;
}): ReactElement {
  const [projection, setProjection] = useState<
    LaunchAgentKnowledgeProjection | null
  >(initialProjection);
  const [error, setError] = useState("");
  const [busyQuestion, setBusyQuestion] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [factSlug, setFactSlug] = useState("");
  const [factContent, setFactContent] = useState("");
  const [teachBusy, setTeachBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const reload = () => {
    api.load(agentLocator).then(
      (loaded) => setProjection(loaded),
      (reason) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Knowledge is unavailable right now.",
        ),
    );
  };
  // Initial load only; mutations call reload() explicitly.
  useEffect(reload, [agentLocator]);

  const openQuestions =
    projection?.questions.filter((question) => question.status === "open") ??
      [];
  const activeFacts =
    projection?.facts.filter((fact) => fact.status === "active") ?? [];

  const answerQuestion = async (question: LaunchAgentKnowledgeQuestion) => {
    const content = (answers[question.id] ?? "").trim();
    if (!content || busyQuestion) return;
    setBusyQuestion(question.id);
    setNotice("");
    try {
      const outcome = await api.answer(agentLocator, question.id, { content });
      setNotice(
        `Taught [fact:${outcome.fact.slug}] — the agent sees it on its next wake.`,
      );
      setAnswers((current) => ({ ...current, [question.id]: "" }));
      reload();
    } catch (reason) {
      setNotice(
        reason instanceof Error ? reason.message : "Answering failed.",
      );
    } finally {
      setBusyQuestion(null);
    }
  };

  const dismissQuestion = async (question: LaunchAgentKnowledgeQuestion) => {
    if (busyQuestion) return;
    setBusyQuestion(question.id);
    setNotice("");
    try {
      await api.dismiss(agentLocator, question.id);
      reload();
    } catch (reason) {
      setNotice(
        reason instanceof Error ? reason.message : "Dismissing failed.",
      );
    } finally {
      setBusyQuestion(null);
    }
  };

  const teachFact = async () => {
    const slug = factSlug.trim();
    const content = factContent.trim();
    if (!slug || !content || teachBusy) return;
    setTeachBusy(true);
    setNotice("");
    try {
      const outcome = await api.teach(agentLocator, { slug, content });
      setNotice(
        `Saved [fact:${outcome.fact.slug}] (revision ${outcome.fact.revision}).`,
      );
      setFactSlug("");
      setFactContent("");
      reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Teaching failed.");
    } finally {
      setTeachBusy(false);
    }
  };

  return (
    <section className="agent-studio-screen">
      <StudioPageHeader
        description="Facts this agent is allowed to state, and the questions it has hit that nobody has answered yet."
        title="Knowledge"
      />
      {error ? <p className="agent-studio-knowledge-error">{error}</p> : null}
      {notice
        ? (
          <p className="agent-studio-knowledge-notice" role="status">
            {notice}
          </p>
        )
        : null}

      <div className="agent-studio-section-label">
        Open questions
        {openQuestions.length > 0 ? ` · ${openQuestions.length}` : ""}
      </div>
      {openQuestions.length === 0
        ? (
          <p className="agent-studio-knowledge-empty">
            Nothing is waiting on you.
          </p>
        )
        : (
          <ul className="agent-studio-knowledge-questions">
            {openQuestions.map((question) => (
              <li key={question.id}>
                <strong>{question.question}</strong>
                {question.context ? <p>{question.context}</p> : null}
                <small>
                  {question.askCount === 1
                    ? "asked once"
                    : `asked ${question.askCount} times`}
                  {question.blocking ? " · holding work" : ""}
                </small>
                <div className="agent-studio-knowledge-answer">
                  <input
                    aria-label={`Answer: ${question.question}`}
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: event.currentTarget.value,
                      }))}
                    placeholder="Answer in one sentence…"
                    value={answers[question.id] ?? ""}
                  />
                  <button
                    disabled={busyQuestion === question.id ||
                      !(answers[question.id] ?? "").trim()}
                    onClick={() => void answerQuestion(question)}
                    type="button"
                  >
                    {busyQuestion === question.id ? "Teaching…" : "Teach it"}
                  </button>
                  <button
                    className="agent-studio-knowledge-dismiss"
                    disabled={busyQuestion === question.id}
                    onClick={() => void dismissQuestion(question)}
                    type="button"
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

      <div className="agent-studio-section-label">
        Facts it knows{activeFacts.length > 0 ? ` · ${activeFacts.length}` : ""}
      </div>
      {activeFacts.length === 0
        ? (
          <p className="agent-studio-knowledge-empty">
            Teach the first fact below — the agent receives every active fact
            on each wake.
          </p>
        )
        : (
          <table className="agent-studio-knowledge-facts">
            <thead>
              <tr>
                <th>Fact</th>
                <th>What it says</th>
                <th>Came from</th>
              </tr>
            </thead>
            <tbody>
              {activeFacts.map((fact) => (
                <tr key={fact.id}>
                  <td>
                    <code>{fact.slug}</code>
                    {fact.title ? <div>{fact.title}</div> : null}
                  </td>
                  <td>{fact.content}</td>
                  <td>{factSourceLabel(fact)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <div className="agent-studio-knowledge-teach">
        <div className="agent-studio-section-label">Add a fact</div>
        <input
          aria-label="Fact slug"
          onChange={(event) => setFactSlug(event.currentTarget.value)}
          placeholder="slug (e.g. check-out)"
          value={factSlug}
        />
        <textarea
          aria-label="Fact content"
          onChange={(event) => setFactContent(event.currentTarget.value)}
          placeholder="What should the agent say about this?"
          value={factContent}
        />
        <button
          disabled={teachBusy || !factSlug.trim() || !factContent.trim()}
          onClick={() => void teachFact()}
          type="button"
        >
          {teachBusy ? "Saving…" : "Save fact"}
        </button>
        <small>Re-using a slug updates that fact and bumps its revision.</small>
      </div>

      <AgentStudioConcepts agentLocator={agentLocator} />

      <div className="agent-studio-contract-note">
        Facts are guidance the agent receives, not enforced policy. Citations
        ("used 61×") and contradiction tracking arrive with runtime policies.
      </div>
    </section>
  );
}
