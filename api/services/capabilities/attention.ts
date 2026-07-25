import {
  type CapabilityContext,
  CapabilityError,
} from "../../../shared/contracts/capabilities.ts";
import type {
  LaunchOperatorAttentionActionResponse,
  LaunchOperatorAttentionProjection,
  LaunchOperatorItemActionResponse,
} from "../../../shared/contracts/launch.ts";
import { getEnv } from "../../lib/env.ts";
import {
  applyOperatorItemAttentionAction,
} from "../operator-item-attention-state.ts";
import { executeOperatorItemRemediation } from "../operator-item-execution.ts";
import {
  type OperatorAttentionAgent,
  readOperatorAttentionPage,
} from "../operator-item-reader.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PRESENTATION_ACTIONS = new Set([
  "mark_read",
  "mark_unread",
  "snooze",
  "reopen",
  "dismiss",
]);

interface AttentionCapabilityDependencies {
  listAgents?: (userId: string) => Promise<OperatorAttentionAgent[]>;
  read?: typeof readOperatorAttentionPage;
  applyAttention?: typeof applyOperatorItemAttentionAction;
  execute?: typeof executeOperatorItemRemediation;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CapabilityError("invalid_input", `${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CapabilityError("invalid_input", `${label} is required.`);
  }
  return value.trim();
}

function positiveLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
    value > 100
  ) {
    throw new CapabilityError(
      "invalid_input",
      "limit must be an integer from 1 to 100.",
    );
  }
  return value;
}

function requireOwnerOperator(ctx: CapabilityContext, mutation: boolean): void {
  if (
    ctx.provisional ||
    (ctx.authSource !== "supabase" && ctx.authSource !== "api_token")
  ) {
    throw new CapabilityError(
      "forbidden",
      "Attention is available only to the authenticated account operator.",
    );
  }
  if (mutation && ctx.authSource !== "supabase") {
    throw new CapabilityError(
      "forbidden",
      "Changing Attention or running remediation requires an authenticated Galactic account session.",
    );
  }
}

function serviceError(error: unknown): never {
  if (error instanceof CapabilityError) throw error;
  const status = typeof error === "object" && error !== null &&
      typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : 500;
  const message = error instanceof Error
    ? error.message
    : "Canonical Attention is temporarily unavailable.";
  throw new CapabilityError(
    status === 400
      ? "invalid_input"
      : status === 403
      ? "forbidden"
      : status === 404
      ? "not_found"
      : status === 409
      ? "conflict"
      : "internal",
    status >= 500 ? "Canonical Attention is temporarily unavailable." : message,
  );
}

async function listOwnerPrivateAgents(
  userId: string,
): Promise<OperatorAttentionAgent[]> {
  const baseUrl = getEnv("SUPABASE_URL").replace(/\/+$/u, "");
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !serviceRoleKey) {
    throw new CapabilityError(
      "internal",
      "Canonical Attention is temporarily unavailable.",
    );
  }
  const query = new URLSearchParams({
    owner_id: `eq.${userId}`,
    visibility: "eq.private",
    deleted_at: "is.null",
    select: "id,slug,name",
    order: "id.asc",
  });
  const response = await fetch(`${baseUrl}/rest/v1/apps?${query.toString()}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json",
      "Cache-Control": "no-store",
    },
  }).catch(() => null);
  if (!response?.ok) {
    await response?.text().catch(() => "");
    throw new CapabilityError(
      "internal",
      "Canonical Attention is temporarily unavailable.",
    );
  }
  let rows: unknown;
  try {
    rows = await response.json();
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) {
    throw new CapabilityError(
      "internal",
      "Canonical Attention is temporarily unavailable.",
    );
  }
  const agents: OperatorAttentionAgent[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new CapabilityError(
        "internal",
        "Canonical Attention is temporarily unavailable.",
      );
    }
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !== "id,name,slug" ||
      typeof row.id !== "string" || !UUID.test(row.id) ||
      (row.slug !== null && typeof row.slug !== "string") ||
      (row.name !== null && typeof row.name !== "string")
    ) {
      throw new CapabilityError(
        "internal",
        "Canonical Attention is temporarily unavailable.",
      );
    }
    const id = row.id.toLowerCase();
    if (seen.has(id)) {
      throw new CapabilityError(
        "internal",
        "Canonical Attention is temporarily unavailable.",
      );
    }
    seen.add(id);
    const slug = typeof row.slug === "string" && row.slug ? row.slug : id;
    agents.push({
      id,
      slug,
      name: typeof row.name === "string" && row.name ? row.name : slug,
    });
  }
  return agents;
}

/**
 * Surface-neutral owner Attention capability.
 *
 * Every client receives the canonical diagnosis, semantic targets, standard
 * labels, required authority, and side-effect classification. No client
 * reverse-engineers prose and no developer payload becomes executable intent.
 */
export async function attentionCapability(
  args: Record<string, unknown>,
  ctx: CapabilityContext,
  dependencies: AttentionCapabilityDependencies = {},
): Promise<
  | LaunchOperatorAttentionProjection
  | LaunchOperatorAttentionActionResponse
  | LaunchOperatorItemActionResponse
> {
  const action = typeof args.action === "string" ? args.action : "list";
  const mutation = action !== "list";
  requireOwnerOperator(ctx, mutation);

  try {
    if (action === "list") {
      const listAgents = dependencies.listAgents ?? listOwnerPrivateAgents;
      const agents = await listAgents(ctx.userId);
      const requestedAgentId = args.agent_id === undefined
        ? null
        : uuid(args.agent_id, "agent_id");
      if (
        requestedAgentId &&
        !agents.some((agent) => agent.id === requestedAgentId)
      ) {
        throw new CapabilityError("not_found", "Agent not found.");
      }
      const cursor = args.cursor === undefined
        ? null
        : string(args.cursor, "cursor");
      return await (dependencies.read ?? readOperatorAttentionPage)(
        ctx.userId,
        agents,
        requestedAgentId,
        {
          cursor,
          limit: positiveLimit(args.limit),
        },
      );
    }

    if (PRESENTATION_ACTIONS.has(action)) {
      const itemId = uuid(args.item_id, "item_id");
      return await (
        dependencies.applyAttention ?? applyOperatorItemAttentionAction
      )({
        userId: ctx.userId,
        itemId,
        action,
        ...(args.snoozed_until !== undefined
          ? { snoozedUntil: args.snoozed_until }
          : {}),
      });
    }

    if (action === "run_once") {
      return await (dependencies.execute ?? executeOperatorItemRemediation)({
        userId: ctx.userId,
        itemId: uuid(args.item_id, "item_id"),
        remediationId: string(args.remediation_id, "remediation_id"),
        idempotencyKey: uuid(args.idempotency_key, "idempotency_key"),
        expectedRevision: string(args.expected_revision, "expected_revision"),
        authSource: ctx.authSource,
      });
    }

    throw new CapabilityError(
      "invalid_input",
      `Unknown Attention action "${action}".`,
    );
  } catch (error) {
    serviceError(error);
  }
}
