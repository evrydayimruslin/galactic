// Library Service
// Generates Skills.md, library.txt, embedding.json per version,
// rebuilds the user-level Library.md from all live app versions,
// and manages the user's memory.md (free-form context).
//
// R2 layout per version:  apps/{appId}/{version}/skills.md, library.txt, embedding.json
// R2 layout per user:     users/{userId}/library.md, users/{userId}/memory.md

import { getEnv } from "../lib/env.ts";
import { createR2Service } from "./storage.ts";
import { createAppsService } from "./apps.ts";
import { parseTypeScript, toSkillsParsed } from "./parser.ts";
import {
  generateManifestFromParseResult,
  mergeManifestWithParseResult,
} from "./app-manifest-generation.ts";
import { generateSkillsMd } from "./docgen.ts";
import {
  createEmbeddingService,
  generateToolSemanticEmbeddingsForApp,
} from "./embedding.ts";
import type {
  App,
  AppWithDraft,
  ParsedSkills,
} from "../../shared/types/index.ts";
import { resolveManifestEnvSchema } from "../../shared/types/index.ts";
import type { ParseResult } from "./parser.ts";

export { generateManifestFromParseResult } from "./app-manifest-generation.ts";

// ============================================
// USER MEMORY.MD: Read / Write / Append
// ============================================

/** Max memory.md size: 50KB. Prevents runaway writes from blowing out context windows or R2 costs. */
const MEMORY_MAX_BYTES = 50 * 1024;

/**
 * Read a user's memory.md from R2.
 * Returns the full markdown content, or null if none exists.
 */
export async function readUserMemory(userId: string): Promise<string | null> {
  const r2Service = createR2Service();
  try {
    return await r2Service.fetchTextFile(`users/${userId}/memory.md`);
  } catch {
    return null;
  }
}

/**
 * Write (overwrite) a user's memory.md in R2.
 * Saves a timestamped snapshot of the previous version before overwriting.
 * Throws if content exceeds 50KB.
 */
export async function writeUserMemory(
  userId: string,
  content: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > MEMORY_MAX_BYTES) {
    throw new Error(
      `memory.md exceeds ${MEMORY_MAX_BYTES / 1024}KB limit (${
        (bytes.length / 1024).toFixed(1)
      }KB). Trim content or use gx.memory.remember for structured data.`,
    );
  }

  const r2Service = createR2Service();

  // Snapshot previous version (fire-and-forget)
  snapshotMemory(r2Service, userId).catch((err) =>
    console.error("Memory snapshot failed:", err)
  );

  await r2Service.uploadFile(`users/${userId}/memory.md`, {
    name: "memory.md",
    content: bytes,
    contentType: "text/markdown",
  });

  // Chunk and upsert content rows + generate embeddings (fire-and-forget)
  upsertMemoryChunks(userId, content).catch((err) =>
    console.error("Memory chunk upsert failed:", err)
  );
}

/**
 * Append a section to a user's memory.md.
 * Creates the file if it doesn't exist.
 * Throws if result would exceed 50KB.
 */
export async function appendUserMemory(
  userId: string,
  section: string,
): Promise<string> {
  const existing = await readUserMemory(userId);
  const separator = existing ? "\n\n" : "";
  const updated =
    (existing || "# Memory\n\nPersonal context and preferences.") + separator +
    section;
  await writeUserMemory(userId, updated);
  return updated;
}

/**
 * Save a timestamped snapshot of the current memory.md before overwriting.
 * Stored at users/{userId}/memory_snapshots/{timestamp}.md
 * Only snapshots if current memory.md exists.
 */
async function snapshotMemory(
  r2Service: ReturnType<typeof createR2Service>,
  userId: string,
): Promise<void> {
  let existing: string;
  try {
    existing = await r2Service.fetchTextFile(`users/${userId}/memory.md`);
  } catch {
    return; // nothing to snapshot
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await r2Service.uploadFile(`users/${userId}/memory_snapshots/${ts}.md`, {
    name: `${ts}.md`,
    content: new TextEncoder().encode(existing),
    contentType: "text/markdown",
  });
}

// ============================================
// CONTENT TABLE UPSERT + EMBEDDING
// ============================================

/**
 * Upsert a content row in the content table and generate an embedding.
 * Used for memory.md and library.md indexing into the unified content layer.
 * Fire-and-forget safe — all errors logged but not thrown.
 */
async function upsertContentWithEmbedding(
  userId: string,
  type: "memory_md" | "library_md",
  slug: string,
  content: string,
  sizeBytes: number,
): Promise<void> {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

  const headers = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates",
  };

  // Generate embedding text: prefix + first ~500 words
  const prefix = type === "memory_md"
    ? "User memory and preferences: "
    : "User app library and capabilities: ";
  const words = content.split(/\s+/).slice(0, 6000);
  const embeddingText = prefix + words.join(" ");

  // Generate embedding
  let embedding: number[] | null = null;
  const embeddingService = createEmbeddingService();
  if (embeddingService) {
    try {
      const result = await embeddingService.embed(embeddingText);
      embedding = result.embedding;
    } catch (err) {
      console.error(`Failed to generate ${type} embedding:`, err);
    }
  }

  // Upsert content row
  const title = type === "memory_md" ? "Memory" : "Library";
  const row: Record<string, unknown> = {
    owner_id: userId,
    type: type,
    slug: slug,
    title: title,
    description: type === "memory_md"
      ? "Personal context, preferences, and notes"
      : "Compiled app library and capabilities",
    visibility: "private",
    size: sizeBytes,
    embedding_text: embeddingText,
    updated_at: new Date().toISOString(),
  };

  if (embedding) {
    row.embedding = JSON.stringify(embedding);
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/content?on_conflict=owner_id,type,slug`,
      {
        method: "POST",
        headers: headers,
        body: JSON.stringify(row),
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error(`Content upsert failed for ${type}:`, errText);
    }
  } catch (err) {
    console.error(`Content upsert fetch failed for ${type}:`, err);
  }
}

// ============================================
// MEMORY.MD CHUNKING
// ============================================

/**
 * Split memory.md into chunks on ## headers, delete old chunks, and upsert new ones.
 * Each chunk gets its own row in content table for precise semantic search.
 * Fire-and-forget safe — all errors logged but not thrown.
 */
async function upsertMemoryChunks(
  userId: string,
  content: string,
): Promise<void> {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

  const headers = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  // Step 1: Chunk the content
  const chunks = chunkMemoryContent(content);

  // Step 2: Delete ALL existing memory chunks for this user
  try {
    const delRes = await fetch(
      `${SUPABASE_URL}/rest/v1/content?owner_id=eq.${userId}&type=eq.memory_md&slug=like._memory*`,
      {
        method: "DELETE",
        headers: { ...headers, "Prefer": "return=minimal" },
      },
    );
    if (!delRes.ok) {
      console.error("Memory chunk cleanup failed:", await delRes.text());
    }
  } catch (err) {
    console.error("Memory chunk cleanup fetch failed:", err);
  }

  if (chunks.length === 0) return;

  // Step 3: Batch-embed all chunks
  const embeddingService = createEmbeddingService();
  let embeddings: Array<{ embedding: number[] }> = [];

  if (embeddingService) {
    const embeddingTexts = chunks.map((chunk, i) =>
      `User memory (section ${i + 1}/${chunks.length}): ${chunk.text}`
    );
    try {
      const BATCH_SIZE = 100;
      for (let i = 0; i < embeddingTexts.length; i += BATCH_SIZE) {
        const batch = embeddingTexts.slice(i, i + BATCH_SIZE);
        const results = await embeddingService.embedBatch(batch);
        embeddings.push(...results);
      }
    } catch (err) {
      console.error("Memory chunk batch embedding failed:", err);
      // Embeddings stay empty — processor will fill them later via NULL check
    }
  }

  // Step 4: Upsert each chunk as a content row
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const slug = `_memory_chunk_${i}`;
    const embeddingText = `User memory (section ${
      i + 1
    }/${chunks.length}): ${chunk.text}`;
    const row: Record<string, unknown> = {
      owner_id: userId,
      type: "memory_md",
      slug: slug,
      title: chunk.title || `Memory section ${i + 1}`,
      description: `Memory chunk: ${chunk.title || "untitled"}`,
      visibility: "private",
      size: new TextEncoder().encode(chunk.text).length,
      embedding_text: embeddingText,
      updated_at: new Date().toISOString(),
    };

    const emb = embeddings[i];
    if (emb && emb.embedding && emb.embedding.length > 0) {
      row.embedding = JSON.stringify(emb.embedding);
    }
    // If no embedding, leave NULL for background processor to fill

    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/content?on_conflict=owner_id,type,slug`,
        {
          method: "POST",
          headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
          body: JSON.stringify(row),
        },
      );
      if (!res.ok) {
        console.error(
          `Memory chunk upsert failed for ${slug}:`,
          await res.text(),
        );
      }
    } catch (err) {
      console.error(`Memory chunk upsert fetch failed for ${slug}:`, err);
    }
  }
}

/**
 * Split memory content into chunks on ## headers.
 * Fallback: 1,000-word chunks if no ## headers found.
 * Each chunk capped at 6,000 words for embedding model limit.
 */
function chunkMemoryContent(
  content: string,
): Array<{ title: string; text: string }> {
  if (!content || content.trim().length === 0) return [];

  const sections: Array<{ title: string; text: string }> = [];
  const lines = content.split("\n");
  let currentTitle = "";
  let currentLines: string[] = [];
  let foundH2 = false;

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)$/);
    if (h2Match) {
      foundH2 = true;
      // Save previous section if any
      if (currentLines.length > 0) {
        const text = currentLines.join("\n").trim();
        if (text.length > 0) {
          sections.push({
            title: currentTitle || "Overview",
            text: text,
          });
        }
      }
      currentTitle = h2Match[1];
      currentLines = [line]; // include the header in the chunk text
    } else {
      currentLines.push(line);
    }
  }

  // Capture final section
  if (currentLines.length > 0) {
    const text = currentLines.join("\n").trim();
    if (text.length > 0) {
      sections.push({
        title: currentTitle || "Overview",
        text: text,
      });
    }
  }

  // Fallback: if no ## headers found, chunk by 1,000 words
  if (!foundH2 && sections.length > 0) {
    const fullText = sections[0].text;
    const words = fullText.split(/\s+/);
    if (words.length > 1000) {
      const chunked: Array<{ title: string; text: string }> = [];
      const CHUNK_SIZE = 1000;
      for (let i = 0; i < words.length; i += CHUNK_SIZE) {
        const chunkWords = words.slice(i, i + CHUNK_SIZE);
        chunked.push({
          title: `Section ${Math.floor(i / CHUNK_SIZE) + 1}`,
          text: chunkWords.join(" "),
        });
      }
      return chunked.map((s) => ({
        title: s.title,
        text: s.text.split(/\s+/).slice(0, 6000).join(" "),
      }));
    }
  }

  // Cap each chunk at 6,000 words
  return sections.map((s) => ({
    title: s.title,
    text: s.text.split(/\s+/).slice(0, 6000).join(" "),
  }));
}

// ============================================
// PER-VERSION: Skills + Library Entry + Embedding
// ============================================

export interface VersionArtifacts {
  skillsMd: string | null;
  libraryTxt: string | null;
  embeddingJson: number[] | null;
  semanticEmbeddings?: {
    readyCount: number;
    failedCount: number;
    skippedCount: number;
  };
}

/**
 * Auto-generate Skills.md, library.txt, manifest.json, and embedding.json for a specific
 * version of an app. Stores artifacts in R2 at the version's storage key
 * and also updates the app DB record with the latest skills/embedding/manifest.
 *
 * @param app       The app record (needs .id, .name, .slug, .description, .exports)
 * @param storageKey  The R2 prefix for this version, e.g. "apps/{id}/{ver}/"
 * @param _version    Version string (currently unused but kept for future use)
 */
export async function generateSkillsForVersion(
  app: App,
  storageKey: string,
  _version: string,
  options: { persistAppProjection?: boolean } = {},
): Promise<VersionArtifacts> {
  const r2Service = createR2Service();

  // Fetch source code (prefer _source_ file, fall back to bundled)
  let code: string | null = null;
  const entryNames = [
    "_source_index.ts",
    "_source_index.tsx",
    "index.ts",
    "index.tsx",
    "index.js",
    "index.jsx",
  ];
  for (const entry of entryNames) {
    try {
      code = await r2Service.fetchTextFile(`${storageKey}${entry}`);
      break;
    } catch { /* try next */ }
  }

  if (!code) return { skillsMd: null, libraryTxt: null, embeddingJson: null };

  // Parse code → all artifacts derive from ParseResult
  const parseResult = await parseTypeScript(code);

  // Generate manifest: keep rich uploaded manifests when possible, but converge
  // back onto source-derived contracts when the stored manifest is thin or stale.
  const existingManifest = app.manifest
    ? (() => {
      try {
        return JSON.parse(app.manifest!);
      } catch {
        return null;
      }
    })()
    : null;
  const { manifest } = mergeManifestWithParseResult(
    app,
    existingManifest,
    parseResult,
    _version,
    { entryFileName: "index.ts" },
  );

  const manifestJson = JSON.stringify(manifest, null, 2);

  // Generate skills_parsed directly from parser (not from Skills.md round-trip)
  const skillsParsed = toSkillsParsed(parseResult);

  // Generate Skills.md (human-readable docs)
  const skillsMd = generateSkillsMd(app.name || app.slug, parseResult);

  // Generate compact library entry (header + functions summary)
  const libraryTxt = generateLibraryEntry(app, parseResult);

  // Generate subject-level semantic embeddings. The app subject remains the
  // compatibility aggregate persisted to embedding.json and apps.skills_embedding.
  let embeddingJson: number[] | null = null;
  let semanticEmbeddings: VersionArtifacts["semanticEmbeddings"];
  try {
    const searchHints = Array.isArray(app.tags)
      ? app.tags as string[]
      : undefined;
    const result = await generateToolSemanticEmbeddingsForApp({
      app: {
        ...app,
        manifest: manifestJson,
        skills_parsed: skillsParsed,
      },
      appVersion: _version,
      manifest,
      skillsParsed,
      searchHints,
    });
    embeddingJson = result.appEmbedding?.embedding || null;
    semanticEmbeddings = {
      readyCount: result.readyCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
    };
    if (result.failedCount > 0 || result.skippedCount > 0) {
      console.warn("Tool semantic embedding generation incomplete", {
        app_id: app.id,
        version: _version,
        ready_count: result.readyCount,
        failed_count: result.failedCount,
        skipped_count: result.skippedCount,
      });
    }
  } catch (err) {
    console.error("Tool semantic embedding generation failed:", err);
  }

  // Store per-version in R2
  try {
    const uploads = [
      r2Service.uploadFile(`${storageKey}skills.md`, {
        name: "skills.md",
        content: new TextEncoder().encode(skillsMd),
        contentType: "text/markdown",
      }),
      r2Service.uploadFile(`${storageKey}manifest.json`, {
        name: "manifest.json",
        content: new TextEncoder().encode(manifestJson),
        contentType: "application/json",
      }),
    ];
    if (libraryTxt) {
      uploads.push(r2Service.uploadFile(`${storageKey}library.txt`, {
        name: "library.txt",
        content: new TextEncoder().encode(libraryTxt),
        contentType: "text/plain",
      }));
    }
    if (embeddingJson) {
      uploads.push(r2Service.uploadFile(`${storageKey}embedding.json`, {
        name: "embedding.json",
        content: new TextEncoder().encode(JSON.stringify(embeddingJson)),
        contentType: "application/json",
      }));
    }
    await Promise.all(uploads);
  } catch (err) {
    console.error("Failed to store skills artifacts in R2:", err);
  }

  // A staged version must not rewrite the live Agent projection. Its artifacts
  // remain version-addressed in R2 and are projected onto the app row only when
  // that version is promoted.
  if (options.persistAppProjection !== false) {
    try {
      const appsService = createAppsService();
      await appsService.update(app.id, {
        skills_md: skillsMd,
        skills_parsed: skillsParsed,
        manifest: manifestJson,
        env_schema: resolveManifestEnvSchema(manifest),
        docs_generated_at: new Date().toISOString(),
      } as Partial<AppWithDraft>);

      if (embeddingJson) {
        await appsService.updateEmbedding(app.id, embeddingJson);
      }
    } catch (err) {
      console.error("Failed to update app with skills:", err);
    }
  }

  return { skillsMd, libraryTxt, embeddingJson, semanticEmbeddings };
}

// ============================================
// LIBRARY ENTRY (compact per-app)
// ============================================

/**
 * Generate a compact library entry from parse result.
 * This is stored as library.txt per version and compiled into Library.md.
 */
export function generateLibraryEntry(
  app: App,
  parseResult: ParseResult,
): string {
  const lines: string[] = [];
  lines.push(`## ${app.name || app.slug}`);
  if (app.description) lines.push(app.description);
  lines.push("");
  lines.push("Functions:");
  for (const fn of parseResult.functions) {
    const params = fn.parameters.map((p) => p.name).join(", ");
    lines.push(
      `- ${fn.name}(${params}): ${fn.description || "No description"}`,
    );
  }
  lines.push("");
  lines.push(`Dashboard: /http/${app.id}/ui`);
  return lines.join("\n");
}

// ============================================
// USER LIBRARY: Rebuild Library.md
// ============================================

/**
 * Rebuild Library.md for a user from all their live app versions.
 * Reads library.txt from each app's live version in R2,
 * compiles them into a single Library.md, and stores per-user in R2.
 *
 * Fire-and-forget safe — catches all errors.
 */
export async function rebuildUserLibrary(userId: string): Promise<void> {
  const appsService = createAppsService();
  const r2Service = createR2Service();
  const apps = await appsService.listByOwner(userId);

  const libraryParts: string[] = [];

  for (const app of apps) {
    if (!app.current_version || !app.storage_key) continue;

    // Try to read library.txt from live version
    try {
      const libraryTxt = await r2Service.fetchTextFile(
        `${app.storage_key}library.txt`,
      );
      libraryParts.push(libraryTxt);
    } catch {
      // Fall back to inline generation
      libraryParts.push(
        `## ${app.name || app.slug}\n${
          app.description || "No description"
        }\nMCP: /mcp/${app.id}`,
      );
    }

    libraryParts.push(""); // separator
  }

  const libraryMd = `# Library\n\nAll your apps and their capabilities.\n\n${
    libraryParts.join("\n")
  }`;
  const libraryBytes = new TextEncoder().encode(libraryMd);

  // Store per-user in R2
  try {
    await r2Service.uploadFile(`users/${userId}/library.md`, {
      name: "library.md",
      content: libraryBytes,
      contentType: "text/markdown",
    });
  } catch (err) {
    console.error("Failed to store user library:", err);
  }

  // Upsert content row + generate embedding (fire-and-forget)
  upsertContentWithEmbedding(
    userId,
    "library_md",
    "_library",
    libraryMd,
    libraryBytes.length,
  ).catch((err) => console.error("Library content upsert failed:", err));
}
