// Open-code verification (Phase 2 trust signal).
//
// The platform signs each published version's per-file artifact_hashes +
// description_hash (Phase 0, HMAC — platform-only verifiable) and separately
// signs the executed ESM bundle. gx.verify ties them together into one
// platform-ATTESTED verdict an Agent can read before calling:
//   - executed_bundle_ok : the live executing bundle matches its signed attestation
//   - published_signature_valid : the published trust metadata is intact + ours
//   - files_match (open code only) : every downloadable source file hashes to the
//     signed artifact_hashes — so "the code you can read IS the code that runs".
// The verdict is itself signed so an Agent can trust it came from the platform.

import type { App, VersionTrustMetadata } from "../../shared/types/index.ts";
import { getEnv } from "../lib/env.ts";
import { createR2Service } from "./storage.ts";
import {
  canonicalJson,
  getLatestVersionTrust,
  sha256Hex,
  signWithTrustSecret,
  verifyVersionTrustSignature,
} from "./trust.ts";
import {
  type BundleVerifyStatus,
  loadLiveExecutedBundle,
  verifyExecutedBundle,
} from "./executed-bundle.ts";

const INTERNAL_ARTIFACTS = ["skills.md", "library.txt", "embedding.json"];

export interface DownloadedFile {
  path: string;
  content: string;
  // The R2 relative key the bytes came from (e.g. `_source_index.ts`). This is
  // the key the file was SIGNED under in artifact_hashes — matching must use it,
  // not the display path, so the readable SOURCE is matched against its own
  // signed hash and not the executed bundle's.
  sourceKey: string;
}

// Read the original SOURCE files for a version from R2 — the readable source an
// open-code Agent exposes. A bundled app stores BOTH the executed bundle (e.g.
// `index.ts`) AND the original source (`_source_index.ts`) under one prefix;
// we return ONLY the source (drop the bundle sibling) so the minified executed
// bundle is never served or attested as readable source. Factored so download
// AND verify hash exactly the same bytes.
export async function readVersionSourceFiles(
  appId: string,
  version: string,
): Promise<DownloadedFile[]> {
  const storageKey = `apps/${appId}/${version}/`;
  const r2Service = createR2Service();
  const fileKeys = await r2Service.listFiles(storageKey);
  const relativePaths = fileKeys.map((k) => k.replace(storageKey, ""));

  // Each `_source_<entry>` original implies TWO generated artifacts written by
  // the upload pipeline that are NOT readable source and must be dropped: the
  // IIFE bundle `<entry>` and the ESM bundle `<entryBase>.esm.js`. We drop those
  // exact names only — a normal source file that merely CONTAINS "_source_"
  // mid-name (e.g. my_source_file.ts) is kept and verified like any other.
  const generatedBundles = new Set<string>();
  for (const r of relativePaths) {
    if (!r.startsWith("_source_")) continue;
    const entry = r.replace(/^_source_/, "");
    generatedBundles.add(entry); // IIFE bundle
    generatedBundles.add(entry.replace(/\.(tsx?|jsx?)$/, ".esm.js")); // ESM bundle
  }

  const files: DownloadedFile[] = [];
  for (const relativePath of relativePaths) {
    const isOriginal = relativePath.startsWith("_source_");
    const cleanPath = isOriginal ? relativePath.replace(/^_source_/, "") : relativePath;
    if (INTERNAL_ARTIFACTS.includes(cleanPath)) continue;
    // Drop generated bundles (only matched when a `_source_` original exists).
    if (!isOriginal && generatedBundles.has(relativePath)) continue;
    try {
      const content = await r2Service.fetchTextFile(storageKey + relativePath);
      files.push({ path: cleanPath, content, sourceKey: relativePath });
    } catch {
      // skip unreadable
    }
  }
  return files;
}

export interface FileHashMatch {
  path: string;
  sha256: string;
  published_sha256: string | null;
  matches: boolean;
}

export interface FileMatchResult {
  files: FileHashMatch[];
  all_match: boolean;
}

// Hash each returned file and match it against the SIGNED published
// artifact_hashes, keyed by the file's ACTUAL signed key (sourceKey, e.g.
// `_source_index.ts`) — not the display path, so the readable source is matched
// against its own signed hash and never against the executed bundle's. all_match
// requires every returned file to anchor to a signed hash (a returned-but-
// unsigned file => not a full match — conservative, so divergence can never read
// as "verified").
export async function matchFilesAgainstHashes(
  files: Array<{ path: string; content: string; sourceKey?: string }>,
  artifactHashes: Record<string, string>,
): Promise<FileMatchResult> {
  const out: FileHashMatch[] = [];
  for (const file of files) {
    const sha = await sha256Hex(file.content);
    const published = (file.sourceKey ? artifactHashes[file.sourceKey] : undefined) ??
      artifactHashes[file.path] ??
      artifactHashes[`_source_${file.path}`] ?? null;
    out.push({
      path: file.path,
      sha256: sha,
      published_sha256: published,
      matches: published !== null && published === sha,
    });
  }
  return {
    files: out,
    all_match: out.length > 0 && out.every((f) => f.matches),
  };
}

export function getVersionTrust(
  app: Pick<App, "current_version" | "version_metadata">,
  version: string,
): VersionTrustMetadata | null {
  const metadata = Array.isArray(app.version_metadata) ? app.version_metadata : [];
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i];
    if (entry?.version === version && entry.trust) return entry.trust;
  }
  // Fall back to the current-version trust when the requested version IS current.
  if (version === app.current_version) return getLatestVersionTrust(app);
  return null;
}

export interface VerificationVerdict {
  schema_version: 1;
  app_id: string;
  name: string;
  version: string;
  open_code: boolean;
  integrity: {
    executed_bundle_status: BundleVerifyStatus | "unknown";
    executed_bundle_ok: boolean;
    published_signature_valid: boolean;
    manifest_hash: string | null;
    description_hash: string | null;
    artifact_hash: string | null;
    artifact_count: number;
    signer: string | null;
    signed_at: string | null;
  };
  // Open code only: did every downloadable source file match the signed hashes?
  // null when the code is not open (integrity verified, files not inspected).
  files_match: boolean | null;
  file_matches: Array<{ path: string; matches: boolean }> | null;
  // Per-file signed hashes, so an open-code downloader can independently match.
  artifact_hashes: Record<string, string>;
  // The headline: is this Agent's executing code provably the signed, published
  // code? (signature valid AND executed bundle matches its attestation).
  verified: boolean;
  guidance: string;
  verdict_signature: {
    algorithm: "HMAC-SHA256";
    signer: "light-platform";
    verified_at: string;
    signature: string;
  };
}

function buildGuidance(
  verified: boolean,
  openCode: boolean,
  filesMatch: boolean | null,
): string {
  if (!verified) {
    if (openCode && filesMatch === false) {
      return "NOT verified: integrity checks passed, but at least one downloadable " +
        "source file did NOT match the signed hashes — the source you can read " +
        "differs from what runs. Treat with caution.";
    }
    if (openCode && filesMatch === null) {
      return "NOT verified: the open source could not be read to confirm it against " +
        "the signed hashes (try again). Treated as unverified.";
    }
    return "NOT verified: the executing bundle could not be confirmed against a " +
      "signed attestation (legacy, unsigned, or tampered). Treat with caution.";
  }
  if (openCode) {
    return "Verified: the executing code matches its signed attestation AND every " +
      "downloadable source file matches the signed hashes — read it with gx.download.";
  }
  return "Verified: the executing code matches its signed attestation. Source is " +
    "not open for download, so per-file inspection is unavailable.";
}

// Short-TTL cache for the open-code file match — each entry is keyed by the
// version's artifact_hash, so a re-publish (new signed bytes => new hash) is a
// cache miss; only repeated verifies of the SAME signed version are served warm.
const FILE_MATCH_TTL_MS = 60_000;
const FILE_MATCH_CACHE = new Map<
  string,
  { at: number; filesMatch: boolean; fileMatches: Array<{ path: string; matches: boolean }> }
>();

export function __resetFileMatchCacheForTest(): void {
  FILE_MATCH_CACHE.clear();
}

async function openCodeFilesMatch(
  appId: string,
  version: string,
  trust: VersionTrustMetadata,
): Promise<{ filesMatch: boolean; fileMatches: Array<{ path: string; matches: boolean }> }> {
  const key = `${appId}:${version}:${trust.artifact_hash ?? ""}`;
  const cached = FILE_MATCH_CACHE.get(key);
  if (cached && Date.now() - cached.at < FILE_MATCH_TTL_MS) {
    return { filesMatch: cached.filesMatch, fileMatches: cached.fileMatches };
  }
  const source = await readVersionSourceFiles(appId, version);
  const matched = await matchFilesAgainstHashes(source, trust.artifact_hashes);
  const result = {
    filesMatch: matched.all_match,
    fileMatches: matched.files.map((f) => ({ path: f.path, matches: f.matches })),
  };
  FILE_MATCH_CACHE.set(key, { at: Date.now(), ...result });
  return result;
}

export async function buildVerificationVerdict(
  app: App,
): Promise<VerificationVerdict> {
  // Verify what actually RUNS. The runtime only ever executes the live bundle
  // (`esm:{appId}:latest`); its signed attestation names the running version, so
  // we anchor the whole verdict to THAT version — not the DB current_version,
  // which can differ transiently (deploy skew) or durably (a gx.set rollback
  // pins KV to an older, still-validly-signed version). This keeps the verdict
  // honest about the bytes actually executing.
  let executedStatus: BundleVerifyStatus | "unknown" = "unknown";
  let version = app.current_version || "";
  try {
    const { code, attestation } = await loadLiveExecutedBundle(app.id);
    if (attestation?.version) version = attestation.version;
    const r = await verifyExecutedBundle({
      appId: app.id,
      esmCode: code ?? "",
      attestation,
      // The attestation's own version => a valid live bundle is never a spurious
      // version_mismatch; legacy (no attestation) => no_attestation, not ok.
      expectedVersion: version,
    });
    executedStatus = r.status;
  } catch {
    executedStatus = "error";
  }
  const executedOk = executedStatus === "ok";

  const trust = getVersionTrust(app, version);
  const signatureValid = trust ? await verifyVersionTrustSignature(trust) : false;

  const openCode = app.download_access === "public";
  let filesMatch: boolean | null = null;
  let fileMatches: Array<{ path: string; matches: boolean }> | null = null;
  if (openCode && trust) {
    try {
      const matched = await openCodeFilesMatch(app.id, version, trust);
      filesMatch = matched.filesMatch;
      fileMatches = matched.fileMatches;
    } catch {
      filesMatch = null;
    }
  }

  // For an open-code app the tool's promise is "the code you can read IS the
  // code that runs", so the headline REQUIRES a positive file match — not merely
  // "not false". filesMatch === null (the source could not be read, e.g. a
  // transient R2 failure) must therefore read as NOT verified, never green.
  const verified = signatureValid && executedOk &&
    (openCode ? filesMatch === true : true);
  const integrity = {
    executed_bundle_status: executedStatus,
    executed_bundle_ok: executedOk,
    published_signature_valid: signatureValid,
    manifest_hash: trust?.manifest_hash ?? null,
    description_hash: trust?.description_hash ?? null,
    artifact_hash: trust?.artifact_hash ?? null,
    artifact_count: trust ? Object.keys(trust.artifact_hashes).length : 0,
    signer: trust?.signature.signer ?? null,
    signed_at: trust?.signature.signed_at ?? null,
  };

  const verifiedAt = new Date().toISOString();
  // Sign a stable, bounded core (artifact_hash already digests the full map).
  const signature = await signWithTrustSecret(canonicalJson({
    schema_version: 1,
    app_id: app.id,
    version,
    open_code: openCode,
    integrity,
    files_match: filesMatch,
    verified,
    verified_at: verifiedAt,
  }));

  return {
    schema_version: 1,
    app_id: app.id,
    name: app.name,
    version,
    open_code: openCode,
    integrity,
    files_match: filesMatch,
    file_matches: fileMatches,
    artifact_hashes: trust?.artifact_hashes ?? {},
    verified,
    guidance: buildGuidance(verified, openCode, filesMatch),
    verdict_signature: {
      algorithm: "HMAC-SHA256",
      signer: "light-platform",
      verified_at: verifiedAt,
      signature,
    },
  };
}

// Record the verified-read (Phase 4 ranking signal). Upsert keeps the latest
// verdict per (app, user, version) so the table is bounded and "distinct
// verifiers" is a clean count. Best-effort: never blocks the verify response.
export async function recordVerification(input: {
  appId: string;
  userId: string;
  version: string;
  verdict: VerificationVerdict;
}): Promise<void> {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  try {
    await fetch(
      `${url}/rest/v1/app_verifications?on_conflict=app_id,user_id,version`,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          app_id: input.appId,
          user_id: input.userId,
          version: input.version || "",
          files_match: input.verdict.files_match,
          executed_bundle_status: input.verdict.integrity.executed_bundle_status,
          signature_valid: input.verdict.integrity.published_signature_valid,
          open_code: input.verdict.open_code,
          verified_at: new Date().toISOString(),
        }),
      },
    );
  } catch (err) {
    console.warn("[VERIFY] recordVerification failed", {
      app_id: input.appId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
