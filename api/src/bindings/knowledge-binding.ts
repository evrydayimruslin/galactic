// RPC Knowledge Binding for Dynamic Workers (WO-5 PR B).
//
// Lets an agent read its OWN Knowledge-lite facts and raise open questions
// mid-run — the agent-side half of the Studio Knowledge pane. The
// (appId, userId) scope is frozen into the binding props host-side; sandbox
// code cannot name another app or user. Authority: knowledge is the app's
// own internal platform store, so it rides the release's DECLARED database
// authority (database.read for facts, database.write for ask) — reusing an
// existing declared effect instead of minting a parallel one keeps the
// never-widen invariant intact with zero manifest-vocabulary changes.

import { WorkerEntrypoint } from "cloudflare:workers";
import { assertExecutionContext } from "../../services/execution-context-registry.ts";
import {
  askAgentKnowledgeQuestion,
  formatKnowledgeFactsBlock,
  listAgentKnowledge,
} from "../../services/agent-knowledge.ts";

interface KnowledgeBindingProps {
  appId: string;
  userId: string;
  // Set for bindings loaded into a REUSABLE isolate (loader.get): every public
  // method then refuses to run without a resolvable per-call context handle.
  requireExecCtx?: boolean;
}

export interface KnowledgeAskResult {
  questionId: string;
  deduped: boolean;
  askCount: number;
  status: string;
}

export interface KnowledgeFactsResult {
  facts: Array<{
    slug: string;
    title: string | null;
    content: string;
    updatedAt: string;
  }>;
  /** Ready-to-inject "## Working knowledge" block with [fact:slug] ids. */
  block: string;
}

export class KnowledgeBinding
  extends WorkerEntrypoint<unknown, KnowledgeBindingProps> {
  /**
   * Record one knowledge gap. Idempotent per normalized question: repeats
   * increment ask_count (and may escalate blocking), never duplicate. A
   * blocking question mints one auto-resolving owner alert host-side.
   */
  async ask(
    input: { question?: unknown; context?: unknown; blocking?: unknown },
    execCtxHandle?: string,
  ): Promise<KnowledgeAskResult> {
    assertExecutionContext(execCtxHandle, this.ctx.props.requireExecCtx);
    const outcome = await askAgentKnowledgeQuestion(
      this.ctx.props.userId,
      this.ctx.props.appId,
      {
        question: typeof input?.question === "string" ? input.question : "",
        context: typeof input?.context === "string" ? input.context : null,
        blocking: input?.blocking === true,
      },
    );
    return {
      questionId: outcome.question.id,
      deduped: outcome.deduped,
      askCount: outcome.question.askCount,
      status: outcome.question.status,
    };
  }

  /** Active facts for this agent, plus the ready-to-inject block. */
  async facts(execCtxHandle?: string): Promise<KnowledgeFactsResult> {
    assertExecutionContext(execCtxHandle, this.ctx.props.requireExecCtx);
    const projection = await listAgentKnowledge(
      this.ctx.props.userId,
      this.ctx.props.appId,
    );
    const active = projection.facts.filter((fact) => fact.status === "active");
    return {
      facts: active.map((fact) => ({
        slug: fact.slug,
        title: fact.title,
        content: fact.content,
        updatedAt: fact.updatedAt,
      })),
      block: formatKnowledgeFactsBlock(active),
    };
  }
}
