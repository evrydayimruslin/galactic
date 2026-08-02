// RPC Concepts Binding for Dynamic Workers (WO-6 PR B).
//
// The agent-side half of the concept graph: read a concept's assembled
// neighborhood (about), rank candidate concepts for a text blob (suggest),
// and author description prose (describe — attributed to the agent). The
// (appId, userId) scope is frozen into the binding props host-side; sandbox
// code cannot name another app or user. Authority rides the release's
// DECLARED database effect (database.read for about/suggest,
// database.write for describe) — the PR #191 knowledge-binding precedent:
// reusing a declared effect keeps never-widen intact with zero manifest
// vocabulary changes.

import { WorkerEntrypoint } from "cloudflare:workers";
import { assertExecutionContext } from "../../services/execution-context-registry.ts";
import {
  aboutConcept,
  describeConcept,
  suggestConcepts,
} from "../../services/agent-concepts.ts";
import type {
  LaunchAgentConcept,
  LaunchAgentConceptAbout,
  LaunchAgentConceptSuggestion,
} from "../../../shared/contracts/launch.ts";

interface ConceptsBindingProps {
  appId: string;
  userId: string;
  /** Owner email for BYOK embedding-route resolution (semantic suggest).
   * Empty string = no route; semantic ranking degrades to verbatim/alias
   * and description edits store embedding_status 'pending'. */
  userEmail?: string;
  requireExecCtx?: boolean;
}

export class ConceptsBinding
  extends WorkerEntrypoint<unknown, ConceptsBindingProps> {
  /** Assembled neighborhood for one slug (aliases resolve). Null when the
   * concept does not exist — the agent decides whether to create it by
   * simply writing `[[slug]]` somewhere. */
  async about(
    slug: unknown,
    execCtxHandle?: string,
  ): Promise<LaunchAgentConceptAbout | null> {
    assertExecutionContext(execCtxHandle, this.ctx.props.requireExecCtx);
    return await aboutConcept(
      this.ctx.props.userId,
      this.ctx.props.appId,
      typeof slug === "string" ? slug : "",
    );
  }

  /** Ranked candidates for a text blob: verbatim/alias basis first, then
   * embedding similarity within one pinned model space. */
  async suggest(
    input: { text?: unknown; limit?: unknown },
    execCtxHandle?: string,
  ): Promise<{ suggestions: LaunchAgentConceptSuggestion[] }> {
    assertExecutionContext(execCtxHandle, this.ctx.props.requireExecCtx);
    const suggestions = await suggestConcepts(
      this.ctx.props.userId,
      this.ctx.props.appId,
      typeof input?.text === "string" ? input.text : "",
      {
        limit: typeof input?.limit === "number" ? input.limit : undefined,
        userEmail: this.ctx.props.userEmail || undefined,
      },
    );
    return { suggestions };
  }

  /** Agent-authored description/title/alias edits, attributed as such.
   * Embedding rides the owner's BYOK route when resolvable; otherwise the
   * page stores 'pending' and the write still succeeds. */
  async describe(
    input: {
      slug?: unknown;
      title?: unknown;
      description?: unknown;
      aliases?: unknown;
    },
    execCtxHandle?: string,
  ): Promise<{ concept: LaunchAgentConcept }> {
    assertExecutionContext(execCtxHandle, this.ctx.props.requireExecCtx);
    const concept = await describeConcept(
      this.ctx.props.userId,
      this.ctx.props.appId,
      typeof input?.slug === "string" ? input.slug : "",
      {
        ...(typeof input?.title === "string" || input?.title === null
          ? { title: input.title as string | null }
          : {}),
        ...(typeof input?.description === "string" ||
            input?.description === null
          ? { description: input.description as string | null }
          : {}),
        ...(Array.isArray(input?.aliases)
          ? { aliases: input.aliases.map(String) }
          : {}),
        author: "agent",
        userEmail: this.ctx.props.userEmail ?? "",
      },
    );
    return { concept };
  }
}
