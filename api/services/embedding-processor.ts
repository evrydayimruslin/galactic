// Embedding Processor Service
// Background job that finds content rows with NULL embeddings and fills them.
// Runs every 10 seconds. Processes up to 100 rows per batch using embedBatch().
// Same startup pattern as hosting-billing.ts and auto-healing.ts.

import { getEnv } from "../lib/env.ts";
import {
  createEmbeddingService,
  generateToolSemanticEmbeddingsForApp,
  type ToolSemanticEmbeddingAppInfo,
} from "./embedding.ts";

// ============================================
// CONFIG
// ============================================

/** How often to check for pending embeddings */
const INTERVAL_MS = 10_000; // 10 seconds

/** Max rows to process per batch (matches OpenAI batch limit) */
const BATCH_SIZE = 100;

/** Startup delay to let the server warm up */
const STARTUP_DELAY_MS = 30_000; // 30 seconds

// ============================================
// PROCESSOR
// ============================================

interface PendingRow {
  id: string;
  type: string;
  slug: string;
  embedding_text: string;
}

interface SemanticBackfillAppRow extends ToolSemanticEmbeddingAppInfo {
  current_version: string | null;
}

export interface ToolSemanticBackfillResult {
  processed: number;
  readyCount: number;
  failedCount: number;
  skippedCount: number;
}

/**
 * Process all content rows that have embedding_text but NULL embedding.
 * Returns the number of rows successfully embedded.
 */
export async function processNullEmbeddings(): Promise<number> {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return 0;

  const embeddingService = createEmbeddingService();
  if (!embeddingService) return 0;

  const headers = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  // Fetch rows with NULL embedding but non-NULL embedding_text
  let pending: PendingRow[];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/content` +
        `?embedding=is.null` +
        `&embedding_text=not.is.null` +
        `&select=id,type,slug,embedding_text` +
        `&order=updated_at.desc` +
        `&limit=${BATCH_SIZE}`,
      { headers },
    );
    if (!res.ok) {
      console.error(
        "[EMBED-PROC] Failed to fetch pending rows:",
        await res.text(),
      );
      return 0;
    }
    pending = await res.json();
  } catch (err) {
    console.error("[EMBED-PROC] Fetch error:", err);
    return 0;
  }

  if (pending.length === 0) return 0;

  // Extract texts for batch embedding (cap each at 6000 words)
  const texts = pending.map((row) => {
    const words = row.embedding_text.split(/\s+/).slice(0, 6000);
    return words.join(" ");
  });

  // Filter out empty texts
  const validIndices: number[] = [];
  const validTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].trim().length > 0) {
      validIndices.push(i);
      validTexts.push(texts[i]);
    }
  }

  if (validTexts.length === 0) return 0;

  // Batch embed
  let embeddings: Array<{ embedding: number[] }>;
  try {
    embeddings = await embeddingService.embedBatch(validTexts);
  } catch (err) {
    console.error("[EMBED-PROC] Batch embedding failed:", err);
    return 0;
  }

  // Update each row with its embedding
  let updated = 0;
  for (let i = 0; i < validIndices.length; i++) {
    const row = pending[validIndices[i]];
    const emb = embeddings[i];
    if (!emb || !emb.embedding || emb.embedding.length === 0) continue;

    try {
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/content?id=eq.${row.id}`,
        {
          method: "PATCH",
          headers: { ...headers, "Prefer": "return=minimal" },
          body: JSON.stringify({
            embedding: JSON.stringify(emb.embedding),
          }),
        },
      );
      if (patchRes.ok) {
        updated++;
      } else {
        console.error(
          `[EMBED-PROC] Patch failed for ${row.id}:`,
          await patchRes.text(),
        );
      }
    } catch (err) {
      console.error(`[EMBED-PROC] Patch error for ${row.id}:`, err);
    }
  }

  if (updated > 0) {
    const types = [
      ...new Set(
        pending.filter((_, i) => validIndices.includes(i)).map((r) => r.type),
      ),
    ].join(", ");
    console.log(
      `[EMBED-PROC] Embedded ${updated}/${validTexts.length} rows (types: ${types})`,
    );
  }

  return updated;
}

/**
 * Operator-triggered backfill for app/function semantic index rows.
 * This intentionally does not run on the 10s content embedding interval because
 * provider calls are not free even when billing idempotency prevents duplicate
 * Light charges.
 */
export async function processToolSemanticEmbeddingBackfill(
  options: {
    limit?: number;
    appId?: string | null;
    visibility?: "private" | "unlisted" | "public" | "all";
  } = {},
): Promise<ToolSemanticBackfillResult> {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { processed: 0, readyCount: 0, failedCount: 0, skippedCount: 0 };
  }

  const headers = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  const url = new URL(`${SUPABASE_URL}/rest/v1/apps`);
  url.searchParams.set("deleted_at", "is.null");
  url.searchParams.set(
    "select",
    [
      "id",
      "owner_id",
      "slug",
      "name",
      "description",
      "tags",
      "manifest",
      "skills_parsed",
      "skills_md",
      "current_version",
      "app_type",
    ].join(","),
  );
  url.searchParams.set("order", "updated_at.desc");
  url.searchParams.set(
    "limit",
    String(Math.min(Math.max(options.limit || 20, 1), 100)),
  );
  if (options.appId) {
    url.searchParams.set("id", `eq.${options.appId}`);
  }
  if (options.visibility && options.visibility !== "all") {
    url.searchParams.set("visibility", `eq.${options.visibility}`);
  }

  let apps: SemanticBackfillAppRow[] = [];
  try {
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      console.error(
        "[EMBED-PROC] Failed to fetch semantic backfill apps:",
        await res.text(),
      );
      return { processed: 0, readyCount: 0, failedCount: 0, skippedCount: 0 };
    }
    apps = await res.json();
  } catch (err) {
    console.error("[EMBED-PROC] Semantic backfill fetch error:", err);
    return { processed: 0, readyCount: 0, failedCount: 0, skippedCount: 0 };
  }

  let processed = 0;
  let readyCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const app of apps) {
    try {
      const result = await generateToolSemanticEmbeddingsForApp({
        app,
        appVersion: app.current_version || "unversioned",
      });
      processed++;
      readyCount += result.readyCount;
      failedCount += result.failedCount;
      skippedCount += result.skippedCount;
    } catch (err) {
      processed++;
      failedCount++;
      console.error("[EMBED-PROC] Semantic backfill app failed:", {
        app_id: app.id,
        error: err,
      });
    }
  }

  if (processed > 0) {
    console.log(
      `[EMBED-PROC] Semantic backfill processed ${processed} app(s): ready=${readyCount}, failed=${failedCount}, skipped=${skippedCount}`,
    );
  }

  return { processed, readyCount, failedCount, skippedCount };
}

// ============================================
// JOB LIFECYCLE
// ============================================

export function startEmbeddingProcessorJob(): void {
  console.log("[EMBED-PROC] Starting embedding processor (every 10s)");

  // First run after startup delay
  setTimeout(async () => {
    try {
      const count = await processNullEmbeddings();
      if (count > 0) {
        console.log(`[EMBED-PROC] First run: processed ${count} rows`);
      }
    } catch (err) {
      console.error("[EMBED-PROC] First run failed:", err);
    }
  }, STARTUP_DELAY_MS);

  // Then every 10 seconds
  setInterval(async () => {
    try {
      await processNullEmbeddings();
    } catch (err) {
      console.error("[EMBED-PROC] Scheduled run failed:", err);
    }
  }, INTERVAL_MS);
}
