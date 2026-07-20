// Apps Service
// Handles app CRUD operations via Supabase

import { getEnv } from "../lib/env.ts";
import type { App, AppWithDraft } from "../../shared/types/index.ts";
import {
  searchToolSemanticEmbeddings,
  type ToolSemanticEmbeddingRow,
  type ToolSemanticEmbeddingSearchOptions,
  type ToolSemanticEmbeddingSearchResult,
  type ToolSemanticEmbeddingUpsertParams,
  upsertToolSemanticEmbedding,
} from "./embedding.ts";
import {
  PUBLIC_APP_RESPONSE_SELECT,
  PUBLIC_APP_SERVING_SELECT,
  PUBLIC_DISCOVERY_APP_SELECT,
  type PublicAppResponse,
  type PublicAppServing,
  type PublicDiscoveryApp,
} from "./public-apps.ts";

function toPgVector(embedding: number[]): string {
  return `[${embedding.filter(Number.isFinite).join(",")}]`;
}

// Postgres rejects a non-uuid value in a `uuid = eq.` filter with SQLSTATE
// 22P02 ("invalid input syntax for type uuid"). We treat that as "not found"
// on id lookups so id-or-slug resolvers fall through to a slug lookup.
const UUID_SYNTAX_ERROR_RE = /22P02|invalid input syntax for type uuid/i;

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

interface OwnedAppDeletionResult {
  deleted: boolean;
  reclaimedBytes: number;
}

export class AppDeletionConflictError extends Error {
  constructor() {
    super("A concurrent app or owner lifecycle change is in progress");
    this.name = "AppDeletionConflictError";
  }
}

const APP_DELETE_MAX_ATTEMPTS = 3;
const APP_DELETE_RETRYABLE_CODE = /"code"\s*:\s*"(?:40001|55P03)"/u;

function waitForAppDeleteRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
}

export class AppsService {
  private supabaseUrl: string;
  private supabaseKey: string;

  constructor(config: SupabaseConfig) {
    this.supabaseUrl = config.url;
    this.supabaseKey = config.serviceKey;
  }

  private async fetchSingle<T>(url: URL): Promise<T | null> {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`App fetch failed: ${error}`);
    }

    const results = await response.json() as T[];
    return results[0] ?? null;
  }

  /**
   * Create a new app record
   */
  async create(app: Partial<AppWithDraft>): Promise<App> {
    const url = `${this.supabaseUrl}/rest/v1/apps`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify(app),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`App create failed: ${error}`);
    }

    const results = await response.json() as App[];
    return results[0];
  }

  /**
   * Find app by ID
   */
  async findById(appId: string): Promise<AppWithDraft | null> {
    const url = new URL(`${this.supabaseUrl}/rest/v1/apps`);
    url.searchParams.set("id", `eq.${appId}`);
    url.searchParams.set("deleted_at", "is.null");
    url.searchParams.set("select", "*");
    url.searchParams.set("limit", "1");
    try {
      return await this.fetchSingle<AppWithDraft>(url);
    } catch (err) {
      // A non-uuid ref (e.g. a slug handed to an id-or-slug resolver) makes
      // Postgres reject the id filter with 22P02. Treat as "not found" so the
      // resolver falls through to its slug lookup rather than leaking the raw
      // Postgres error to the caller.
      if (err instanceof Error && UUID_SYNTAX_ERROR_RE.test(err.message)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Find a public or unlisted app by ID using an explicit safe public response shape.
   */
  async findPublicById(appId: string): Promise<PublicAppResponse | null> {
    const url = new URL(`${this.supabaseUrl}/rest/v1/apps`);
    url.searchParams.set("id", `eq.${appId}`);
    url.searchParams.set("deleted_at", "is.null");
    url.searchParams.set("visibility", "in.(public,unlisted)");
    url.searchParams.set("select", PUBLIC_APP_RESPONSE_SELECT);
    url.searchParams.set("limit", "1");
    return this.fetchSingle<PublicAppResponse>(url);
  }

  /**
   * Find a public or unlisted app by ID using the safe serving shape used by
   * public page, docs, dashboard, and download/code routes.
   */
  async findPublicServingById(appId: string): Promise<PublicAppServing | null> {
    const url = new URL(`${this.supabaseUrl}/rest/v1/apps`);
    url.searchParams.set("id", `eq.${appId}`);
    url.searchParams.set("deleted_at", "is.null");
    url.searchParams.set("visibility", "in.(public,unlisted)");
    url.searchParams.set("select", PUBLIC_APP_SERVING_SELECT);
    url.searchParams.set("limit", "1");
    return this.fetchSingle<PublicAppServing>(url);
  }

  /**
   * List apps for a user
   */
  async listByOwner(userId: string): Promise<App[]> {
    const url = new URL(`${this.supabaseUrl}/rest/v1/apps`);
    url.searchParams.set("owner_id", `eq.${userId}`);
    url.searchParams.set("select", "*");
    url.searchParams.set("deleted_at", "is.null");
    url.searchParams.set("order", "created_at.desc");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`App list failed: ${error}`);
    }

    return await response.json() as App[];
  }

  /**
   * Update app
   */
  async update(appId: string, updates: Partial<AppWithDraft>): Promise<App> {
    const url = new URL(`${this.supabaseUrl}/rest/v1/apps`);
    url.searchParams.set("id", `eq.${appId}`);

    const response = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        ...updates,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`App update failed: ${error}`);
    }

    const results = await response.json() as App[];
    return results[0];
  }

  /**
   * Increment run count using Supabase RPC for atomic increment
   */
  async incrementRuns(appId: string): Promise<void> {
    // Use Supabase RPC to atomically increment the counter
    const url = `${this.supabaseUrl}/rest/v1/rpc/increment_app_runs`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ app_id: appId }),
    });

    if (!response.ok) {
      const error = await response.text();
      // Log but don't throw - run counting shouldn't break execution
      console.error(`App increment runs failed: ${error}`);
    }
  }

  /**
   * Atomically increment impressions_total + impressions_7d.
   * Called on non-bot /app/:id visits. Fire-and-forget semantics —
   * analytics failures must never break page rendering.
   */
  async incrementImpression(appId: string): Promise<void> {
    const url = `${this.supabaseUrl}/rest/v1/rpc/increment_app_impression`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ app_id: appId }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`App increment impression failed: ${error}`);
    }
  }

  /**
   * Find app by slug for a specific owner
   */
  async findBySlug(ownerId: string, slug: string): Promise<App | null> {
    const url = new URL(`${this.supabaseUrl}/rest/v1/apps`);
    url.searchParams.set("owner_id", `eq.${ownerId}`);
    url.searchParams.set("slug", `eq.${slug}`);
    url.searchParams.set("select", "*");
    url.searchParams.set("limit", "1");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`App fetch by slug failed: ${error}`);
    }

    const results = await response.json() as App[];
    return results[0] ?? null;
  }

  /**
   * Does ANY app (across all owners) already use this slug?
   * Used to mint globally-unique slugs at create time. The DB constraint is
   * only per-owner unique, but the public resolver (fetchToolByLocator) does a
   * global `slug=eq` lookup, so new slugs must be globally unique to resolve
   * unambiguously.
   */
  async slugExists(slug: string): Promise<boolean> {
    const url = new URL(`${this.supabaseUrl}/rest/v1/apps`);
    url.searchParams.set("slug", `eq.${slug}`);
    url.searchParams.set("select", "id");
    url.searchParams.set("limit", "1");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Slug existence check failed: ${error}`);
    }

    const results = await response.json() as Array<{ id: string }>;
    return results.length > 0;
  }

  /**
   * List public apps
   */
  async listPublic(limit = 100): Promise<PublicDiscoveryApp[]> {
    const url = new URL(`${this.supabaseUrl}/rest/v1/apps`);
    url.searchParams.set("visibility", "eq.public");
    url.searchParams.set("deleted_at", "is.null");
    url.searchParams.set("select", PUBLIC_DISCOVERY_APP_SELECT);
    url.searchParams.set("order", "runs_30d.desc");
    url.searchParams.set("limit", String(limit));

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`App list public failed: ${error}`);
    }

    return await response.json() as PublicDiscoveryApp[];
  }

  /**
   * Soft delete an app
   */
  async softDelete(appId: string): Promise<void> {
    const url = new URL(`${this.supabaseUrl}/rest/v1/apps`);
    url.searchParams.set("id", `eq.${appId}`);

    const response = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`App soft delete failed: ${error}`);
    }
  }

  /**
   * Atomically verifies live ownership, soft-deletes the app, and reclaims its
   * storage accounting. The database RPC is the deletion linearization point:
   * a service-role PATCH filtered only by id would let an ownership transfer
   * race a previously authorized request.
   */
  async softDeleteOwned(
    appId: string,
    ownerId: string,
    deletedAt = new Date().toISOString(),
  ): Promise<OwnedAppDeletionResult> {
    const url = `${this.supabaseUrl}/rest/v1/rpc/soft_delete_owned_app`;
    let response: Response | null = null;
    for (let attempt = 0; attempt < APP_DELETE_MAX_ATTEMPTS; attempt += 1) {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.supabaseKey}`,
          "apikey": this.supabaseKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_user_id: ownerId,
          p_app_id: appId,
          p_deleted_at: deletedAt,
        }),
      });
      if (response.ok) break;
      const error = await response.text();
      if (!APP_DELETE_RETRYABLE_CODE.test(error)) {
        throw new Error(`Owned app soft delete failed: ${error}`);
      }
      response = null;
      if (attempt + 1 < APP_DELETE_MAX_ATTEMPTS) {
        await waitForAppDeleteRetry(attempt);
      }
    }

    if (!response) throw new AppDeletionConflictError();

    const payload = await response.json() as unknown;
    const row = Array.isArray(payload) ? payload[0] : payload;
    if (!row || typeof row !== "object") {
      throw new Error("Owned app soft delete returned no result");
    }
    const result = row as Record<string, unknown>;
    const reclaimedBytes = Number(result.reclaimed_bytes ?? 0);
    if (
      typeof result.deleted !== "boolean" ||
      !Number.isSafeInteger(reclaimedBytes) || reclaimedBytes < 0
    ) {
      throw new Error("Owned app soft delete returned an invalid result");
    }
    return { deleted: result.deleted, reclaimedBytes };
  }

  /**
   * Update embedding for an app
   */
  async updateEmbedding(appId: string, embedding: number[]): Promise<void> {
    // Use RPC function to update embedding (pgvector column)
    const url = `${this.supabaseUrl}/rest/v1/rpc/update_app_embedding`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_app_id: appId,
        p_embedding: toPgVector(embedding),
      }),
    });

    if (!response.ok) {
      // Try direct update as fallback
      const directUrl = new URL(`${this.supabaseUrl}/rest/v1/apps`);
      directUrl.searchParams.set("id", `eq.${appId}`);

      const directResponse = await fetch(directUrl.toString(), {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${this.supabaseKey}`,
          "apikey": this.supabaseKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          skills_embedding: toPgVector(embedding),
          updated_at: new Date().toISOString(),
        }),
      });

      if (!directResponse.ok) {
        console.error("Failed to update embedding");
      }
    }
  }

  /**
   * Search apps by embedding similarity
   */
  async searchByEmbedding(
    queryEmbedding: number[],
    userId: string,
    includePrivate: boolean,
    limit: number,
    minSimilarity: number,
  ): Promise<Array<App & { similarity: number }>> {
    // Use RPC function for vector similarity search
    const url = `${this.supabaseUrl}/rest/v1/rpc/search_apps`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.supabaseKey}`,
        "apikey": this.supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_query_embedding: toPgVector(queryEmbedding),
        p_user_id: includePrivate ? userId : null,
        p_limit: limit,
        p_offset: 0,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Search failed: ${error}`);
    }

    const results = await response.json() as Array<
      App & { similarity: number }
    >;

    // Filter by similarity threshold
    return results.filter((r: { similarity: number }) =>
      r.similarity >= minSimilarity
    );
  }

  async upsertSemanticEmbedding(
    params: ToolSemanticEmbeddingUpsertParams,
  ): Promise<ToolSemanticEmbeddingRow> {
    return await upsertToolSemanticEmbedding(params, {
      supabaseUrl: this.supabaseUrl,
      supabaseKey: this.supabaseKey,
    });
  }

  async searchSemanticEmbeddings(
    queryEmbedding: number[],
    options: ToolSemanticEmbeddingSearchOptions = {},
  ): Promise<ToolSemanticEmbeddingSearchResult[]> {
    return await searchToolSemanticEmbeddings(queryEmbedding, options, {
      supabaseUrl: this.supabaseUrl,
      supabaseKey: this.supabaseKey,
    });
  }
}

// Factory function
export function createAppsService(): AppsService {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("Supabase credentials not configured");
  }

  return new AppsService({ url, serviceKey: key });
}
