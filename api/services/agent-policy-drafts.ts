import { getEnv } from "../lib/env.ts";

/**
 * WO-F5: unversioned policy drafts — the parking lane between an agent's
 * proposal (`gx.policy propose` / `attach_template`) and the owner's
 * readback-approval, which alone mints immutable agent_policy_sets
 * versions. Service-role REST, injectable for tests.
 */

export interface PolicyDraftRow {
  id: string;
  appId: string;
  userId: string;
  sentence: string;
  template: string | null;
  params: Record<string, unknown>;
  attribution: Record<string, unknown>;
  status: "proposed" | "dismissed" | "superseded";
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDraftServiceOptions {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  randomUUID?: () => string;
}

export class PolicyDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyDraftError";
  }
}

function config(options: PolicyDraftServiceOptions) {
  const supabaseUrl = options.supabaseUrl ?? getEnv("SUPABASE_URL");
  const serviceRoleKey = options.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new PolicyDraftError("Policy drafts are unavailable: no database");
  }
  return { supabaseUrl, serviceRoleKey, fetchFn: options.fetchFn ?? fetch };
}

function parseRow(value: unknown): PolicyDraftRow {
  const row = (Array.isArray(value) ? value[0] : value) as
    | Record<string, unknown>
    | undefined;
  if (!row || typeof row.id !== "string") {
    throw new PolicyDraftError("Policy draft storage returned no row");
  }
  return {
    id: row.id,
    appId: String(row.app_id ?? ""),
    userId: String(row.user_id ?? ""),
    sentence: String(row.sentence ?? ""),
    template: typeof row.template === "string" ? row.template : null,
    params: (row.params ?? {}) as Record<string, unknown>,
    attribution: (row.attribution ?? {}) as Record<string, unknown>,
    status: (row.status === "dismissed" || row.status === "superseded")
      ? row.status
      : "proposed",
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

async function rest(
  cfg: ReturnType<typeof config>,
  method: "GET" | "POST",
  pathAndQuery: string,
  body?: unknown,
): Promise<unknown> {
  const fetchFn = cfg.fetchFn;
  let response: Response;
  try {
    response = await fetchFn(`${cfg.supabaseUrl}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        "Content-Type": "application/json",
        ...(method === "POST" ? { Prefer: "return=representation" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new PolicyDraftError("Policy draft storage did not respond");
  }
  if (!response.ok) {
    throw new PolicyDraftError(
      `Policy draft storage rejected the request (${response.status})`,
    );
  }
  return await response.json();
}

export async function createPolicyDraft(
  input: {
    appId: string;
    userId: string;
    sentence: string;
    template?: string | null;
    params?: Record<string, unknown>;
    attribution: Record<string, unknown>;
  },
  options: PolicyDraftServiceOptions = {},
): Promise<PolicyDraftRow> {
  const sentence = input.sentence.trim();
  if (sentence.length === 0 || sentence.length > 2_000) {
    throw new PolicyDraftError("A draft sentence is required and bounded");
  }
  const cfg = config(options);
  const now = (options.now ? options.now() : new Date()).toISOString();
  const id = (options.randomUUID ?? (() => crypto.randomUUID()))();
  const payload = await rest(cfg, "POST", "agent_policy_drafts", {
    id,
    app_id: input.appId,
    user_id: input.userId,
    sentence,
    template: input.template ?? null,
    params: input.params ?? {},
    attribution: input.attribution,
    status: "proposed",
    created_at: now,
    updated_at: now,
  });
  return parseRow(payload);
}

export async function listPolicyDrafts(
  appId: string,
  options: PolicyDraftServiceOptions = {},
): Promise<PolicyDraftRow[]> {
  const cfg = config(options);
  const payload = await rest(
    cfg,
    "GET",
    `agent_policy_drafts?app_id=eq.${encodeURIComponent(appId)}` +
      `&order=created_at.desc&limit=50`,
  );
  return Array.isArray(payload) ? payload.map((row) => parseRow(row)) : [];
}
