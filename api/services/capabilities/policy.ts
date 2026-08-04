// WO-F5: gx.policy — the coding agent's window onto its Agent's policy
// plane. It can READ the overlay merged over declarations, ATTACH the one
// pre-compiled starter template (consequence-group-scoped: guarded groups
// go to 'ask'), and PROPOSE a natural-language boundary as an unversioned
// draft. It can never approve, activate, or edit live policy — immutable
// policy-set versions mint only through the owner's readback-approval.
// Ownership is the authorization (a funnel handoff credential belongs to
// the provisional owner, so it reaches exactly its own Agent).

import {
  type CapabilityContext,
  CapabilityError,
} from "../../../shared/contracts/capabilities.ts";
import { createAppsService } from "../apps.ts";
import {
  createPolicyDraft,
  listPolicyDrafts,
  type PolicyDraftServiceOptions,
} from "../agent-policy-drafts.ts";
import {
  buildFunctionPolicyProjections,
  classifyFunctionConsequence,
  declaredFunctionFactsFromApp,
  type DeclaredFunctionFacts,
  PolicyConflictError,
  setFunctionPolicy,
} from "../policy-gate.ts";

export const POLICY_STARTER_TEMPLATE = "ask-before-consequential-v1";
/** Consequence groups the starter template guards (goes to 'ask'). */
export const POLICY_STARTER_GUARDED_GROUPS = [
  "spend",
  "external_side_effect",
] as const;

interface OwnedApp {
  id: string;
  owner_id: string;
  [key: string]: unknown;
}

export interface PolicyCapabilityDependencies {
  resolveApp?: (userId: string, appIdOrSlug: string) => Promise<OwnedApp>;
  declaredFunctions?: (app: OwnedApp) => DeclaredFunctionFacts[];
  projections?: typeof buildFunctionPolicyProjections;
  setPolicy?: typeof setFunctionPolicy;
  createDraft?: typeof createPolicyDraft;
  listDrafts?: typeof listPolicyDrafts;
  draftOptions?: PolicyDraftServiceOptions;
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
  // builder_handoff is deliberately allowed: the funnel's coding agent
  // attaches the starter policy during the build. No ctx.provisional block —
  // funnel sessions belong to provisional owners by design; ownership
  // scoping above is the boundary that matters.
  if (
    ctx.authSource !== "supabase" && ctx.authSource !== "api_token" &&
    ctx.authSource !== "builder_handoff"
  ) {
    throw new CapabilityError(
      "forbidden",
      "gx.policy is available only to the Agent's owner or its build session.",
    );
  }
}

/** Every declared function's facts, from the app's manifest. */
function allDeclaredFunctionFacts(app: OwnedApp): DeclaredFunctionFacts[] {
  let manifest = app.manifest;
  if (typeof manifest === "string") {
    try {
      manifest = JSON.parse(manifest);
    } catch {
      manifest = null;
    }
  }
  const functions = manifest && typeof manifest === "object" &&
      !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>).functions
    : null;
  if (!functions || typeof functions !== "object" || Array.isArray(functions)) {
    return [];
  }
  const facts: DeclaredFunctionFacts[] = [];
  for (const name of Object.keys(functions)) {
    const fact = declaredFunctionFactsFromApp(
      app as { manifest?: unknown; pricing_config?: unknown },
      name,
    );
    if (fact) facts.push(fact);
  }
  return facts;
}

function attribution(ctx: CapabilityContext): Record<string, unknown> {
  return {
    kind: ctx.authSource === "builder_handoff" ? "agent" : "user",
    userId: ctx.userId,
    authSource: ctx.authSource ?? "unknown",
    via: "gx.policy",
  };
}

export async function policyCapability(
  args: Record<string, unknown>,
  ctx: CapabilityContext,
  deps: PolicyCapabilityDependencies = {},
): Promise<Record<string, unknown>> {
  requireAuthenticated(ctx);
  const agentLocator = typeof args.agent_id === "string" ? args.agent_id : "";
  if (!agentLocator) {
    throw new CapabilityError("invalid_input", "agent_id is required.");
  }
  const resolve = deps.resolveApp ?? resolveOwnedApp;
  const app = await resolve(ctx.userId, agentLocator);
  const action = typeof args.action === "string" ? args.action : "read";

  const declared = (deps.declaredFunctions ?? allDeclaredFunctionFacts)(app);
  const project = deps.projections ?? buildFunctionPolicyProjections;

  if (action === "read") {
    const [projections, drafts] = await Promise.all([
      project({
        userId: ctx.userId,
        appId: app.id,
        functions: declared,
        release: null,
      }),
      (deps.listDrafts ?? listPolicyDrafts)(app.id, deps.draftOptions ?? {}),
    ]);
    return {
      policies: projections.map((row) => ({
        functionName: row.functionName,
        consequence: row.consequence,
        policy: row.policy,
        updatedBy: row.updatedBy,
      })),
      drafts: drafts.map((draft) => ({
        id: draft.id,
        sentence: draft.sentence,
        template: draft.template,
        status: draft.status,
        createdAt: draft.createdAt,
      })),
      note:
        "Approving, activating, or editing live policy is owner-only in the Studio.",
    };
  }

  if (action === "attach_template") {
    const template = typeof args.template === "string"
      ? args.template
      : POLICY_STARTER_TEMPLATE;
    if (template !== POLICY_STARTER_TEMPLATE) {
      throw new CapabilityError(
        "invalid_input",
        `Unknown template. Available: ${POLICY_STARTER_TEMPLATE}`,
      );
    }
    if (declared.length === 0) {
      throw new CapabilityError(
        "invalid_input",
        "This Agent declares no functions yet — upload the candidate first, then attach.",
      );
    }
    const seed = typeof args.seed === "string" && args.seed.trim().length > 0
      ? args.seed.trim()
      : null;
    const projections = await project({
      userId: ctx.userId,
      appId: app.id,
      functions: declared,
      release: null,
    });
    const guarded = new Set<string>(POLICY_STARTER_GUARDED_GROUPS);
    const written: Array<{ functionName: string; policy: string }> = [];
    const skipped: Array<{ functionName: string; reason: string }> = [];
    const write = deps.setPolicy ?? setFunctionPolicy;
    for (const row of projections) {
      if (!guarded.has(row.consequence)) {
        skipped.push({
          functionName: row.functionName,
          reason: `ungoverned group: ${row.consequence}`,
        });
        continue;
      }
      if (row.policy === "ask" || row.policy === "off") {
        skipped.push({
          functionName: row.functionName,
          reason: `already ${row.policy}`,
        });
        continue;
      }
      const isDefault = row.updatedBy.kind === "system";
      try {
        await write({
          userId: ctx.userId,
          appId: app.id,
          functionName: row.functionName,
          policy: "ask",
          expectedRevision: isDefault ? null : row.revision,
          declarationHash: row.declarationHash,
          actor: { ...attribution(ctx), template, seed },
        });
        written.push({ functionName: row.functionName, policy: "ask" });
      } catch (cause) {
        if (cause instanceof PolicyConflictError) {
          skipped.push({
            functionName: row.functionName,
            reason: "concurrent change — re-read and retry",
          });
          continue;
        }
        throw cause;
      }
    }
    const draft = await (deps.createDraft ?? createPolicyDraft)({
      appId: app.id,
      userId: ctx.userId,
      sentence: seed ??
        "Ask me before anything that sends, spends, or writes externally.",
      template,
      params: { guardedGroups: [...POLICY_STARTER_GUARDED_GROUPS], seed },
      attribution: attribution(ctx),
    }, deps.draftOptions ?? {});
    return {
      template,
      guardedGroups: [...POLICY_STARTER_GUARDED_GROUPS],
      written,
      skipped,
      draftId: draft.id,
      note:
        "Guarded functions now hold for approval on autonomous runs. The owner ratifies the sentence into a versioned policy in the Studio.",
    };
  }

  if (action === "propose") {
    const sentence = typeof args.sentence === "string" ? args.sentence : "";
    const draft = await (deps.createDraft ?? createPolicyDraft)({
      appId: app.id,
      userId: ctx.userId,
      sentence,
      template: null,
      params: {},
      attribution: attribution(ctx),
    }, deps.draftOptions ?? {});
    return {
      draftId: draft.id,
      status: draft.status,
      note:
        "Stored as an uncompiled draft. Compilation and approval happen at the owner's readback, on the owner's key.",
    };
  }

  throw new CapabilityError(
    "invalid_input",
    'Unknown action. Use "read", "attach_template", or "propose".',
  );
}
