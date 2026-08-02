// WO-6 PR A: promotion-time concept extraction from the compiled manifest.
//
// Structure declares identity (docs/POLICY_PILLAR_ARCHITECTURE.md §13.2):
// `concept: true` on a schema property = the field IS the concept named by
// its slugified property name; `concept: "other-slug"` = identity with a
// different name. Prose in function/property descriptions carries [[slug]]
// association mentions. Extraction is pure and defensive — manifests are
// author-controlled input, so unknown shapes are skipped, invalid concept
// slugs become warnings, and nothing here ever throws into the commit path.

import {
  CONCEPT_SLUG_PATTERN,
  extractConceptMentions,
  slugifyIdentifier,
} from "./concept-mentions.ts";
import {
  type ConceptSurfaceType,
  type ReindexMention,
  reindexSurface,
  seedConceptDescription,
} from "./agent-concepts.ts";

export interface ManifestConceptSurface {
  surfaceType: ConceptSurfaceType;
  surfaceId: string;
  mentions: ReindexMention[];
}

export interface ManifestConceptExtraction {
  surfaces: ManifestConceptSurface[];
  /** `concept: true` seeds: field description → concept page, only-if-blank. */
  seeds: Array<{ slug: string; description: string }>;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 2000 ? trimmed : `${trimmed.slice(0, 1999)}…`;
}

/** Walk one function's args properties (one level deep — arg objects are the
 * policy-relevant surface; nested shapes can come later without breaking
 * anything recorded now). */
function extractFromProperties(
  functionName: string,
  properties: Record<string, unknown>,
  releaseId: string | null,
  out: ManifestConceptExtraction,
): void {
  for (const [propertyName, rawSchema] of Object.entries(properties)) {
    if (!isRecord(rawSchema)) continue;
    const fieldPath = `args.${propertyName}`;
    const surfaceId = `${functionName}.${propertyName}`;
    const mentions: ReindexMention[] = [];
    const description = typeof rawSchema.description === "string"
      ? rawSchema.description
      : "";
    for (
      const mention of extractConceptMentions(description, {
        blockSplit: "whole",
      })
    ) {
      mentions.push({ ...mention, releaseId, fieldPath });
    }
    const conceptKey = rawSchema.concept;
    if (conceptKey === true || typeof conceptKey === "string") {
      const slug = conceptKey === true
        ? slugifyIdentifier(propertyName)
        : conceptKey;
      if (!slug || !CONCEPT_SLUG_PATTERN.test(slug)) {
        out.warnings.push(
          `Function ${functionName}: property ${propertyName} declares ` +
            `an invalid concept slug (${String(conceptKey)}) — skipped.`,
        );
      } else {
        mentions.push({
          slug,
          blockId: propertyName,
          blockText: truncate(
            description || `Declared concept for ${fieldPath}.`,
          ),
          identity: true,
          releaseId,
          fieldPath,
        });
        // Only `concept: true` seeds: the field IS that concept, so its
        // description is the page's first draft. The string form names a
        // DIFFERENT concept whose page the field description does not own.
        if (conceptKey === true && description.trim()) {
          out.seeds.push({ slug, description: truncate(description) });
        }
      }
    }
    if (mentions.length > 0) {
      out.surfaces.push({ surfaceType: "schema_field", surfaceId, mentions });
    }
  }
}

/** Pure extraction over a compiled manifest's function declarations. */
export function extractManifestConceptSurfaces(
  manifest: unknown,
  releaseId: string | null,
): ManifestConceptExtraction {
  const out: ManifestConceptExtraction = {
    surfaces: [],
    seeds: [],
    warnings: [],
  };
  if (!isRecord(manifest)) return out;
  const functions = isRecord(manifest.functions) ? manifest.functions : {};
  for (const [functionName, rawFn] of Object.entries(functions)) {
    if (!isRecord(rawFn)) continue;
    const description = typeof rawFn.description === "string"
      ? rawFn.description
      : "";
    const fnMentions = extractConceptMentions(description, {
      blockSplit: "whole",
    }).map((mention) => ({ ...mention, releaseId }));
    if (fnMentions.length > 0) {
      out.surfaces.push({
        surfaceType: "function_description",
        surfaceId: functionName,
        mentions: fnMentions,
      });
    }
    const args = isRecord(rawFn.args) ? rawFn.args : undefined;
    const properties = args && isRecord(args.properties)
      ? args.properties
      : isRecord(rawFn.parameters) && isRecord(rawFn.parameters.properties)
      ? rawFn.parameters.properties
      : undefined;
    if (properties) {
      extractFromProperties(functionName, properties, releaseId, out);
    }
  }
  return out;
}

/**
 * Apply an extraction after a successful promotion. Best-effort by
 * contract: a concept-indexing failure must never fail (or roll back) a
 * committed deployment — it logs and the next promotion re-indexes.
 */
export async function indexReleaseConceptSurfaces(
  userId: string,
  appId: string,
  releaseId: string | null,
  manifest: unknown,
): Promise<void> {
  try {
    const extraction = extractManifestConceptSurfaces(manifest, releaseId);
    for (const warning of extraction.warnings) {
      console.warn(`[CONCEPTS] ${warning}`);
    }
    for (const surface of extraction.surfaces) {
      await reindexSurface(
        userId,
        appId,
        surface.surfaceType,
        surface.surfaceId,
        surface.mentions,
        { createdBy: "schema" },
      );
    }
    for (const seed of extraction.seeds) {
      await seedConceptDescription(userId, appId, seed.slug, seed.description);
    }
  } catch (err) {
    console.error(
      "[CONCEPTS] release concept indexing failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
