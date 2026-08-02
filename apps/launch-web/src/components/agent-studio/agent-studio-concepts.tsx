import { type ReactElement, useEffect, useState } from "react";

import type {
  LaunchAgentConcept,
  LaunchAgentConceptAbout,
} from "../../../../../shared/contracts/launch.ts";
import { launchApi } from "../../lib/api";

// WO-6 PR C: the concept glossary — Knowledge's second act. Everything here
// is a projection of writing: mentions carry their enclosing blocks, the
// page is canonical prose, provisional/orphan concepts surface for the
// housekeeping loop. Layers stay labeled (schema identities vs prose
// mentions); nothing here mutates the graph except owner prose.

type GlossaryConcept = LaunchAgentConcept & { mentionCount: number };

interface AgentStudioConceptsApi {
  list: (locator: string) => Promise<{ concepts: GlossaryConcept[] }>;
  about: (locator: string, slug: string) => Promise<LaunchAgentConceptAbout>;
  describe: (
    locator: string,
    slug: string,
    request: { description?: string | null; title?: string | null },
  ) => Promise<{ concept: LaunchAgentConcept }>;
}

const defaultConceptsApi: AgentStudioConceptsApi = {
  list: (locator) => launchApi.agentConcepts(locator),
  about: (locator, slug) => launchApi.agentConceptAbout(locator, slug),
  describe: (locator, slug, request) =>
    launchApi.describeAgentConcept(locator, slug, request),
};

const SURFACE_LABELS: Record<string, string> = {
  schema_field: "Declared in the release schema",
  function_description: "Function descriptions",
  fact: "Facts",
  question: "Open questions",
  mission: "Mission",
  memory: "Agent memory",
  activity_summary: "Run summaries",
  concept_page: "Other concept pages",
  d1: "Agent data",
};

export function AgentStudioConcepts({
  agentLocator,
  api = defaultConceptsApi,
  initialConcepts = null,
  initialAbout = null,
}: {
  agentLocator: string;
  /** DI seams for tests. */
  api?: AgentStudioConceptsApi;
  initialConcepts?: GlossaryConcept[] | null;
  initialAbout?: LaunchAgentConceptAbout | null;
}): ReactElement {
  const [concepts, setConcepts] = useState<GlossaryConcept[] | null>(
    initialConcepts,
  );
  const [about, setAbout] = useState<LaunchAgentConceptAbout | null>(
    initialAbout,
  );
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const reloadGlossary = () => {
    api.list(agentLocator).then(
      (response) => setConcepts(response.concepts),
      (reason) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Concepts are unavailable right now.",
        ),
    );
  };
  useEffect(reloadGlossary, [agentLocator]);

  const openConcept = (slug: string) => {
    setError("");
    setEditing(false);
    api.about(agentLocator, slug).then(
      (loaded) => {
        setAbout(loaded);
        setDraft(loaded.concept.description ?? "");
      },
      (reason) =>
        setError(
          reason instanceof Error ? reason.message : "Concept unavailable.",
        ),
    );
  };

  const saveDescription = async () => {
    if (!about || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.describe(agentLocator, about.concept.slug, {
        description: draft.trim() || null,
      });
      setEditing(false);
      openConcept(about.concept.slug);
      reloadGlossary();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Saving failed.");
    } finally {
      setBusy(false);
    }
  };

  const provisionalCount =
    concepts?.filter((concept) => concept.status === "provisional").length ??
      0;

  if (about) {
    const { concept, mentionGroups, relatedConcepts } = about;
    return (
      <div className="agent-studio-concepts">
        <button
          className="agent-studio-concepts-back"
          onClick={() => setAbout(null)}
          type="button"
        >
          ← All concepts
        </button>
        <h3 className="agent-studio-concept-title">
          <code>[[{concept.slug}]]</code>
          {concept.title ? <span>{concept.title}</span> : null}
          <em data-status={concept.status}>{concept.status}</em>
        </h3>
        {error ? <p className="agent-studio-concepts-error">{error}</p> : null}
        {editing
          ? (
            <div className="agent-studio-concept-edit">
              <textarea
                aria-label="Concept description"
                onChange={(event) => setDraft(event.currentTarget.value)}
                value={draft}
              />
              <div>
                <button disabled={busy} onClick={() => void saveDescription()} type="button">
                  {busy ? "Saving…" : "Save description"}
                </button>
                <button
                  disabled={busy}
                  onClick={() => setEditing(false)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
              <small>
                Prose here links too — mention another concept with
                [[brackets]] and the pages connect.
              </small>
            </div>
          )
          : (
            <div className="agent-studio-concept-description">
              {concept.description
                ? <p>{concept.description}</p>
                : (
                  <p className="agent-studio-concepts-empty">
                    No description yet — the agent receives richer context
                    once this page says what the concept means.
                  </p>
                )}
              <button onClick={() => setEditing(true)} type="button">
                {concept.description ? "Edit description" : "Write description"}
              </button>
              {concept.embeddingStatus === "pending"
                ? (
                  <small>
                    Embedding pending — semantic matching picks this up on the
                    next description save.
                  </small>
                )
                : null}
            </div>
          )}
        {concept.aliases.length > 0
          ? (
            <p className="agent-studio-concept-aliases">
              Also answers to:{" "}
              {concept.aliases.map((alias) => `[[${alias}]]`).join(", ")}
            </p>
          )
          : null}
        {mentionGroups.map((group) => (
          <section key={group.surfaceType}>
            <div className="agent-studio-section-label">
              {SURFACE_LABELS[group.surfaceType] ?? group.surfaceType}
            </div>
            <ul className="agent-studio-concept-mentions">
              {group.mentions.map((mention) => (
                <li key={`${mention.surfaceId}:${mention.blockId}`}>
                  <p>{mention.blockText}</p>
                  <small>
                    {mention.identity
                      ? `declared identity · ${mention.fieldPath ?? mention.surfaceId}`
                      : mention.surfaceId}
                  </small>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {relatedConcepts.length > 0
          ? (
            <p className="agent-studio-concept-related">
              Appears alongside:{" "}
              {relatedConcepts.map((related) => (
                <button
                  key={related.slug}
                  onClick={() => openConcept(related.slug)}
                  type="button"
                >
                  [[{related.slug}]]
                </button>
              ))}
            </p>
          )
          : null}
      </div>
    );
  }

  return (
    <div className="agent-studio-concepts">
      <div className="agent-studio-section-label">
        Concepts{concepts && concepts.length > 0 ? ` · ${concepts.length}` : ""}
        {provisionalCount > 0
          ? (
            <em className="agent-studio-concepts-provisional">
              {provisionalCount} awaiting a description
            </em>
          )
          : null}
      </div>
      {error ? <p className="agent-studio-concepts-error">{error}</p> : null}
      {concepts && concepts.length === 0
        ? (
          <p className="agent-studio-concepts-empty">
            Nothing linked yet. Write [[brackets]] in facts, mission, or
            memory — or declare `concept: true` on a schema field — and the
            glossary builds itself.
          </p>
        )
        : null}
      {concepts && concepts.length > 0
        ? (
          <ul className="agent-studio-concepts-list">
            {concepts.map((concept) => (
              <li key={concept.id}>
                <button
                  onClick={() => openConcept(concept.slug)}
                  type="button"
                >
                  <code>[[{concept.slug}]]</code>
                  <span>
                    {concept.title ??
                      concept.description?.slice(0, 80) ??
                      "No description yet"}
                  </span>
                  <small>
                    {concept.mentionCount} mention{concept.mentionCount === 1 ? "" : "s"}
                    {concept.status === "provisional" ? " · provisional" : ""}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )
        : null}
      {!concepts && !error
        ? <p className="agent-studio-concepts-empty">Loading concepts…</p>
        : null}
    </div>
  );
}
