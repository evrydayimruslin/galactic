// WO-6.1: gx.concepts — the concept graph for connected coding agents and
// owner sessions on the platform MCP. Same objects the Studio glossary and
// the sandbox binding read; ownership is the authorization (the caller must
// own the target agent), and describe attributes its author by auth source
// (account session = owner, connected token = agent).

import {
  type CapabilityContext,
  CapabilityError,
} from "../../../shared/contracts/capabilities.ts";
import { createAppsService } from "../apps.ts";
import {
  aboutConcept,
  AgentConceptValidationError,
  describeConcept,
  listConcepts,
  suggestConcepts,
} from "../agent-concepts.ts";

interface OwnedApp {
  id: string;
  owner_id: string;
}

export interface ConceptsCapabilityDependencies {
  resolveApp?: (userId: string, appIdOrSlug: string) => Promise<OwnedApp>;
  list?: typeof listConcepts;
  about?: typeof aboutConcept;
  suggest?: typeof suggestConcepts;
  describe?: typeof describeConcept;
}

async function resolveOwnedApp(
  userId: string,
  appIdOrSlug: string,
): Promise<OwnedApp> {
  const apps = createAppsService();
  let app = await apps.findById(appIdOrSlug) as OwnedApp | null;
  if (!app) app = await apps.findBySlug(userId, appIdOrSlug) as OwnedApp | null;
  if (!app) {
    throw new CapabilityError("not_found", `Agent not found: ${appIdOrSlug}`);
  }
  if (app.owner_id !== userId) {
    throw new CapabilityError("forbidden", "You do not own this Agent.");
  }
  return app;
}

function requireAuthenticated(ctx: CapabilityContext): void {
  if (
    ctx.provisional ||
    (ctx.authSource !== "supabase" && ctx.authSource !== "api_token" &&
      ctx.authSource !== "builder_handoff")
  ) {
    throw new CapabilityError(
      "forbidden",
      "Concepts are available only to the authenticated Agent owner.",
    );
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CapabilityError("invalid_input", `${label} is required.`);
  }
  return value.trim();
}

export async function conceptsCapability(
  args: Record<string, unknown>,
  ctx: CapabilityContext,
  deps: ConceptsCapabilityDependencies = {},
): Promise<unknown> {
  requireAuthenticated(ctx);
  const action = typeof args.action === "string" ? args.action : "list";
  const agentRef = requiredString(args.agent_id, "agent_id");
  const app = await (deps.resolveApp ?? resolveOwnedApp)(ctx.userId, agentRef);

  try {
    switch (action) {
      case "list": {
        const concepts = await (deps.list ?? listConcepts)(
          ctx.userId,
          app.id,
        );
        return { concepts, generatedAt: new Date().toISOString() };
      }
      case "about": {
        const about = await (deps.about ?? aboutConcept)(
          ctx.userId,
          app.id,
          requiredString(args.slug, "slug"),
        );
        if (!about) {
          throw new CapabilityError(
            "not_found",
            "No such concept. Writing [[slug]] anywhere creates it.",
          );
        }
        return about;
      }
      case "suggest": {
        const suggestions = await (deps.suggest ?? suggestConcepts)(
          ctx.userId,
          app.id,
          requiredString(args.text, "text"),
          {
            limit: typeof args.limit === "number" ? args.limit : undefined,
            // No owner email on this surface: suggest ranks verbatim/alias
            // matches only; semantic ranking lives in the sandbox binding
            // and Studio, where the BYOK route is resolvable.
          },
        );
        return { suggestions, generatedAt: new Date().toISOString() };
      }
      case "describe": {
        const concept = await (deps.describe ?? describeConcept)(
          ctx.userId,
          app.id,
          requiredString(args.slug, "slug"),
          {
            ...(typeof args.title === "string" || args.title === null
              ? { title: args.title as string | null }
              : {}),
            ...(typeof args.description === "string" ||
                args.description === null
              ? { description: args.description as string | null }
              : {}),
            ...(Array.isArray(args.aliases)
              ? { aliases: args.aliases.map(String) }
              : {}),
            author: ctx.authSource === "supabase" ? "owner" : "agent",
            // Embedding degrades to 'pending' without a BYOK route here;
            // the owner's next Studio description save embeds it.
            userEmail: "",
          },
        );
        return { concept };
      }
      default:
        throw new CapabilityError(
          "invalid_input",
          'action must be one of: "list", "about", "suggest", "describe".',
        );
    }
  } catch (err) {
    if (err instanceof AgentConceptValidationError) {
      throw new CapabilityError("invalid_input", err.message);
    }
    throw err;
  }
}
