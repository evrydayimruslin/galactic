import { getEnv } from "../lib/env.ts";
import { reindexProseSurface } from "./agent-concepts.ts";
import { createNotification, resolveNotificationIncidentByDedupe } from "./notifications.ts";
import type {
  LaunchAgentKnowledgeFact,
  LaunchAgentKnowledgeProjection,
  LaunchAgentKnowledgeQuestion,
} from "../../shared/contracts/launch.ts";

// WO-5 Knowledge-lite (docs/AGENT_STUDIO_LAUNCH_WORK_ORDERS.md).
//
// Facts and open questions are probabilistic guidance — reference material
// the agent is given, not enforced policy. Everything here is owner-plane:
// the tables are service-role-only and every query filters by owner. Alerts
// integration follows the summons rule: a BLOCKING question mints one
// deduped notification incident that auto-resolves when the question is
// answered or dismissed — pointers, never residences.

const FACT_LIMIT = 200;
const QUESTION_LIMIT = 100;

export const KNOWLEDGE_QUESTION_ALERT_PREFIX = "knowledge_question";

export class AgentKnowledgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKnowledgeValidationError";
  }
}

interface FactRow {
  id: string;
  slug: string;
  title: string | null;
  content: string;
  source: "owner" | "agent";
  status: "active" | "retired";
  revision: number;
  created_at: string;
  updated_at: string;
}

interface QuestionRow {
  id: string;
  question: string;
  context: string | null;
  status: "open" | "answered" | "dismissed";
  ask_count: number;
  blocking: boolean;
  first_asked_at: string;
  last_asked_at: string;
  answered_fact_id: string | null;
}

function supabaseHeaders(extra?: Record<string, string>) {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(extra || {}),
  };
}

function restUrl(path: string): string {
  return `${getEnv("SUPABASE_URL")}/rest/v1/${path}`;
}

async function readRows<T>(res: Response, what: string): Promise<T[]> {
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to ${what}: ${err}`);
  }
  return await res.json() as T[];
}

function factProjection(row: FactRow): LaunchAgentKnowledgeFact {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    content: row.content,
    source: row.source,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function questionProjection(row: QuestionRow): LaunchAgentKnowledgeQuestion {
  return {
    id: row.id,
    question: row.question,
    context: row.context,
    status: row.status,
    askCount: row.ask_count,
    blocking: row.blocking,
    firstAskedAt: row.first_asked_at,
    lastAskedAt: row.last_asked_at,
    answeredFactId: row.answered_fact_id,
  };
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

export function slugifyFactTitle(input: string): string {
  const slug = input
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 63);
  return SLUG_PATTERN.test(slug) ? slug : "";
}

/** sha256 hex of the normalized question — the ask idempotency key. */
export async function knowledgeQuestionHash(question: string): Promise<string> {
  const normalized = question.trim().toLowerCase().replaceAll(/\s+/g, " ");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function listAgentKnowledge(
  userId: string,
  appId: string,
): Promise<LaunchAgentKnowledgeProjection> {
  const [facts, questions] = await Promise.all([
    readRows<FactRow>(
      await fetch(
        restUrl(
          `agent_knowledge_facts?app_id=eq.${encodeURIComponent(appId)}` +
            `&user_id=eq.${encodeURIComponent(userId)}` +
            `&select=id,slug,title,content,source,status,revision,created_at,updated_at` +
            `&order=updated_at.desc&limit=${FACT_LIMIT}`,
        ),
        { headers: supabaseHeaders() },
      ),
      "list knowledge facts",
    ),
    readRows<QuestionRow>(
      await fetch(
        restUrl(
          `agent_knowledge_questions?app_id=eq.${encodeURIComponent(appId)}` +
            `&user_id=eq.${encodeURIComponent(userId)}` +
            `&select=id,question,context,status,ask_count,blocking,first_asked_at,last_asked_at,answered_fact_id` +
            `&order=last_asked_at.desc&limit=${QUESTION_LIMIT}`,
        ),
        { headers: supabaseHeaders() },
      ),
      "list knowledge questions",
    ),
  ]);
  return {
    facts: facts.map(factProjection),
    questions: questions.map(questionProjection),
    generatedAt: new Date().toISOString(),
  };
}

/** Owner Teach flow: create or update one fact by slug (revision bumps). */
export async function upsertAgentKnowledgeFact(
  userId: string,
  appId: string,
  input: {
    slug: string;
    title?: string | null;
    content: string;
    source?: "owner" | "agent";
    status?: "active" | "retired";
  },
): Promise<LaunchAgentKnowledgeFact> {
  const slug = String(input.slug || "").trim();
  if (!SLUG_PATTERN.test(slug)) {
    throw new AgentKnowledgeValidationError(
      "Fact slug must be 2-63 chars of lowercase letters, digits, and hyphens.",
    );
  }
  const content = String(input.content || "").trim();
  if (!content || content.length > 2000) {
    throw new AgentKnowledgeValidationError(
      "Fact content must be 1-2000 characters.",
    );
  }
  const existing = await readRows<FactRow>(
    await fetch(
      restUrl(
        `agent_knowledge_facts?app_id=eq.${encodeURIComponent(appId)}` +
          `&user_id=eq.${encodeURIComponent(userId)}` +
          `&slug=eq.${encodeURIComponent(slug)}&select=id,revision&limit=1`,
      ),
      { headers: supabaseHeaders() },
    ),
    "read knowledge fact",
  );
  if (existing[0]) {
    const rows = await readRows<FactRow>(
      await fetch(
        restUrl(
          `agent_knowledge_facts?id=eq.${encodeURIComponent(existing[0].id)}` +
            `&user_id=eq.${encodeURIComponent(userId)}`,
        ),
        {
          method: "PATCH",
          headers: supabaseHeaders({ Prefer: "return=representation" }),
          body: JSON.stringify({
            title: input.title ?? null,
            content,
            status: input.status ?? "active",
            revision: existing[0].revision + 1,
            updated_at: new Date().toISOString(),
          }),
        },
      ),
      "update knowledge fact",
    );
    if (!rows[0]) throw new Error("Knowledge fact update returned no row");
    const updated = factProjection(rows[0]);
    // WO-6: facts are a parsed concept surface — reindex on every edit so
    // removed brackets self-heal (mentions are derived from current text).
    await reindexProseSurface(
      userId,
      appId,
      "fact",
      updated.slug,
      `${updated.title ? `${updated.title}: ` : ""}${updated.content}`,
      "whole",
    );
    return updated;
  }
  const rows = await readRows<FactRow>(
    await fetch(restUrl("agent_knowledge_facts"), {
      method: "POST",
      headers: supabaseHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({
        app_id: appId,
        user_id: userId,
        slug,
        title: input.title ?? null,
        content,
        source: input.source ?? "owner",
      }),
    }),
    "create knowledge fact",
  );
  if (!rows[0]) throw new Error("Knowledge fact create returned no row");
  const created = factProjection(rows[0]);
  await reindexProseSurface(
    userId,
    appId,
    "fact",
    created.slug,
    `${created.title ? `${created.title}: ` : ""}${created.content}`,
    "whole",
  );
  return created;
}

/**
 * Record one knowledge gap. Idempotent per (app, normalized question): a
 * repeat ask increments ask_count and may escalate blocking false→true,
 * never duplicates. A blocking question mints ONE deduped notification
 * (the Alerts pointer); it auto-resolves on answer/dismiss.
 */
export async function askAgentKnowledgeQuestion(
  userId: string,
  appId: string,
  input: { question: string; context?: string | null; blocking?: boolean },
): Promise<{ question: LaunchAgentKnowledgeQuestion; deduped: boolean }> {
  const question = String(input.question || "").trim();
  if (!question || question.length > 500) {
    throw new AgentKnowledgeValidationError(
      "A knowledge question must be 1-500 characters.",
    );
  }
  const context = input.context == null
    ? null
    : String(input.context).slice(0, 1000);
  const blocking = input.blocking === true;
  const hash = await knowledgeQuestionHash(question);

  const insert = await fetch(restUrl("agent_knowledge_questions"), {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({
      app_id: appId,
      user_id: userId,
      question,
      context,
      content_hash: hash,
      blocking,
    }),
  });
  let row: QuestionRow;
  let deduped = false;
  if (insert.ok) {
    row = ((await insert.json()) as QuestionRow[])[0];
  } else if (insert.status === 409) {
    await insert.body?.cancel();
    deduped = true;
    const existing = await readRows<QuestionRow>(
      await fetch(
        restUrl(
          `agent_knowledge_questions?app_id=eq.${encodeURIComponent(appId)}` +
            `&content_hash=eq.${hash}&select=id,ask_count,blocking,question,context,status,first_asked_at,last_asked_at,answered_fact_id&limit=1`,
        ),
        { headers: supabaseHeaders() },
      ),
      "read knowledge question",
    );
    if (!existing[0]) throw new Error("Duplicate question row not found");
    const updated = await readRows<QuestionRow>(
      await fetch(
        restUrl(
          `agent_knowledge_questions?id=eq.${
            encodeURIComponent(existing[0].id)
          }`,
        ),
        {
          method: "PATCH",
          headers: supabaseHeaders({ Prefer: "return=representation" }),
          body: JSON.stringify({
            ask_count: existing[0].ask_count + 1,
            last_asked_at: new Date().toISOString(),
            // Escalate-only: a repeat non-blocking ask never clears an
            // existing blocking signal.
            blocking: existing[0].blocking || blocking,
          }),
        },
      ),
      "update knowledge question",
    );
    if (!updated[0]) throw new Error("Question update returned no row");
    row = updated[0];
  } else {
    const err = await insert.text().catch(() => insert.statusText);
    throw new Error(`Failed to record knowledge question: ${err}`);
  }

  if (row.blocking && row.status === "open") {
    // Pointer, not residence: dedupe key ties the alert to this question so
    // answer/dismiss can resolve it mechanically. createNotification is
    // itself deduped, so repeat asks never double-alert.
    await createNotification({
      userId,
      agentId: appId,
      kind: "knowledge_question",
      severity: "warning",
      title: "Your agent hit a question it needs answered",
      body: row.question,
      entityType: "app",
      entityId: appId,
      dedupeKey: `${KNOWLEDGE_QUESTION_ALERT_PREFIX}:${appId}:${row.id}`,
    });
  }

  return { question: questionProjection(row), deduped };
}

/** Owner answers a question: the answer becomes (or updates) a fact, the
 * question closes, and the alert pointer auto-resolves. */
export async function answerAgentKnowledgeQuestion(
  userId: string,
  appId: string,
  questionId: string,
  input: { content: string; slug?: string; title?: string | null },
): Promise<{
  question: LaunchAgentKnowledgeQuestion;
  fact: LaunchAgentKnowledgeFact;
}> {
  const rows = await readRows<QuestionRow>(
    await fetch(
      restUrl(
        `agent_knowledge_questions?id=eq.${encodeURIComponent(questionId)}` +
          `&app_id=eq.${encodeURIComponent(appId)}` +
          `&user_id=eq.${encodeURIComponent(userId)}` +
          `&select=id,question,context,status,ask_count,blocking,first_asked_at,last_asked_at,answered_fact_id&limit=1`,
      ),
      { headers: supabaseHeaders() },
    ),
    "read knowledge question",
  );
  const existing = rows[0];
  if (!existing) {
    throw new AgentKnowledgeValidationError("Question not found.");
  }
  const slug = input.slug?.trim() || slugifyFactTitle(existing.question) ||
    `question-${existing.id.slice(0, 8)}`;
  const fact = await upsertAgentKnowledgeFact(userId, appId, {
    slug,
    title: input.title ?? existing.question.slice(0, 120),
    content: input.content,
    source: "owner",
  });
  const updated = await readRows<QuestionRow>(
    await fetch(
      restUrl(
        `agent_knowledge_questions?id=eq.${encodeURIComponent(existing.id)}`,
      ),
      {
        method: "PATCH",
        headers: supabaseHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify({
          status: "answered",
          answered_fact_id: fact.id,
        }),
      },
    ),
    "answer knowledge question",
  );
  if (!updated[0]) throw new Error("Question answer returned no row");
  await resolveNotificationIncidentByDedupe(
    userId,
    `${KNOWLEDGE_QUESTION_ALERT_PREFIX}:${appId}:${existing.id}`,
    "Question answered in Studio Knowledge.",
  ).catch(() => 0);
  return { question: questionProjection(updated[0]), fact };
}

export async function dismissAgentKnowledgeQuestion(
  userId: string,
  appId: string,
  questionId: string,
): Promise<LaunchAgentKnowledgeQuestion> {
  const updated = await readRows<QuestionRow>(
    await fetch(
      restUrl(
        `agent_knowledge_questions?id=eq.${encodeURIComponent(questionId)}` +
          `&app_id=eq.${encodeURIComponent(appId)}` +
          `&user_id=eq.${encodeURIComponent(userId)}&status=eq.open`,
      ),
      {
        method: "PATCH",
        headers: supabaseHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify({ status: "dismissed" }),
      },
    ),
    "dismiss knowledge question",
  );
  if (!updated[0]) {
    throw new AgentKnowledgeValidationError("Open question not found.");
  }
  await resolveNotificationIncidentByDedupe(
    userId,
    `${KNOWLEDGE_QUESTION_ALERT_PREFIX}:${appId}:${questionId}`,
    "Question dismissed in Studio Knowledge.",
  ).catch(() => 0);
  return questionProjection(updated[0]);
}

/**
 * Injection block for wake context (stable fact ids make future citation
 * parsing possible): consumed by scaffold templates and the PR-B SDK.
 */
export function formatKnowledgeFactsBlock(
  facts: readonly LaunchAgentKnowledgeFact[],
): string {
  const active = facts.filter((fact) => fact.status === "active");
  if (active.length === 0) return "";
  const lines = active.map((fact) =>
    `[fact:${fact.slug}] ${fact.title ? `${fact.title}: ` : ""}${fact.content}`
  );
  return `## Working knowledge\n${lines.join("\n")}`;
}
