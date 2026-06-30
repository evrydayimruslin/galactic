// Executed-bundle integrity (Phase 0 linchpin).
//
// The signed version trust metadata is built from SOURCE files at publish time,
// but the code that actually executes is a separate ESM bundle stored in KV at
// `esm:{appId}:latest`, loaded by the runtime. Several paths rewrite that live
// pointer independently. So "the source we signed" and "the bundle that runs"
// can silently diverge — the trust-card signature attests nothing about
// execution.
//
// This binds them: every write of the live pointer stores the bundle AND a
// signed attestation ({app_id, version, bundle_hash, signed_at} HMAC'd with the
// trust secret) ATOMICALLY in the same KV value via KV metadata, so a reader can
// never observe a new bundle with a stale attestation (or vice versa). At
// execution, the runtime fetches both with one getWithMetadata, recomputes the
// bundle hash, and verifies. The trust secret is the same one trust.ts uses (NOT
// sandbox-exposed), so a KV-tamperer without the secret cannot forge a sidecar.
//
// Rollout is observe -> enforce via EXECUTED_BUNDLE_VERIFY (off | observe |
// enforce, default observe). Backward-compatible: a bundle with no attestation
// (legacy, not yet republished) is grandfathered (no_attestation) in every mode.

import { getEnv } from "../lib/env.ts";
import {
  canonicalJson,
  type ExecutedIntegrity,
  sha256Hex,
  signWithTrustSecret,
} from "./trust.ts";

function liveKey(appId: string): string {
  return `esm:${appId}:latest`;
}

// ── Integrity-secret alarm ───────────────────────────────────────────────────
// If the trust signing secret can't be resolved, signing AND verification both
// fail with status "error" — which never blocks — so `enforce` silently degrades
// to `off`. That must NOT be invisible. We fire a single loud alarm per worker
// instance from the hot paths (per-call spam is pointless once it's known) and a
// re-armed alarm from the hourly self-check so ops sees it every hour until fixed.
let integritySecretAlarmed = false;
function alarmIntegritySecretOnce(context: string, detail?: string): void {
  if (integritySecretAlarmed) return;
  integritySecretAlarmed = true;
  console.error(
    "[BUNDLE-INTEGRITY][ALARM] trust signing secret unresolvable — executed-bundle " +
      "integrity is NOT being enforced (verification returns error, which never blocks)",
    { context, detail },
  );
}

// Ops/startup self-check: confirms the trust secret resolves so `enforce` is
// actually enforcing. Logs an alarm on every failure (intended to be called from
// the hourly cron, so it re-surfaces until fixed). Returns true iff signing works.
export async function assertTrustSecretResolvable(): Promise<boolean> {
  try {
    await signWithTrustSecret("integrity-selfcheck");
    return true;
  } catch (err) {
    console.error(
      "[BUNDLE-INTEGRITY][ALARM] trust signing secret self-check FAILED — " +
        "set TRUST_SIGNING_SECRET (or LIGHT_TRUST_SIGNING_SECRET); enforce is inert until then",
      { detail: err instanceof Error ? err.message : String(err) },
    );
    return false;
  }
}

interface AttestationBody {
  v: 1;
  app_id: string;
  version: string;
  bundle_hash: string;
  signed_at: string;
}
export interface BundleAttestation extends AttestationBody {
  sig: string;
}

function signAttestationBody(body: AttestationBody): Promise<string> {
  return signWithTrustSecret(canonicalJson(body));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function codeCache() {
  return globalThis.__env?.CODE_CACHE;
}

function isAttestation(value: unknown): value is BundleAttestation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.v === 1 && typeof v.app_id === "string" &&
    typeof v.version === "string" && typeof v.bundle_hash === "string" &&
    typeof v.sig === "string" && typeof v.signed_at === "string";
}

// Write (or repoint) the live executed bundle together with its signed
// attestation in ONE atomic KV write (the attestation rides in KV metadata, well
// under the 1KB limit). Use this everywhere `esm:{appId}:latest` is written.
// If signing fails (e.g. a misconfigured trust secret), the bundle is written
// with NO metadata — the runtime grandfathers it (no_attestation) rather than
// blocking the live write; it never lands a new bundle with a stale attestation.
export async function putLiveExecutedBundle(input: {
  appId: string;
  version: string;
  esmCode: string;
}): Promise<void> {
  const cache = codeCache();
  if (!cache?.put) return;
  let attestation: BundleAttestation | undefined;
  try {
    const body: AttestationBody = {
      v: 1,
      app_id: input.appId,
      version: input.version,
      bundle_hash: await sha256Hex(input.esmCode),
      signed_at: new Date().toISOString(),
    };
    attestation = { ...body, sig: await signAttestationBody(body) };
  } catch (err) {
    // Writing the bundle unattested must not brick the live deploy, but a
    // sign-failure here means a freshly-published app will run as no_attestation
    // — invisible if it stays a debug warn. Escalate to the integrity alarm so a
    // misconfigured/rotated trust secret surfaces at publish time, not silently.
    const detail = err instanceof Error ? err.message : String(err);
    alarmIntegritySecretOnce("putLiveExecutedBundle", detail);
    console.error("[BUNDLE-ATTEST][ALARM] sign failed; writing bundle UNATTESTED", {
      appId: input.appId,
      error: detail,
    });
  }
  await cache.put(
    liveKey(input.appId),
    input.esmCode,
    attestation ? { metadata: attestation } : undefined,
  );
}

// Fetch the live bundle + its attestation atomically (one read). Used by every
// execution path so the bytes that run are exactly the bytes that get verified.
export async function loadLiveExecutedBundle(
  appId: string,
): Promise<{ code: string | null; attestation: BundleAttestation | null }> {
  const cache = codeCache();
  if (cache?.getWithMetadata) {
    const { value, metadata } = await cache.getWithMetadata<BundleAttestation>(
      liveKey(appId),
    );
    return {
      code: typeof value === "string" ? value : null,
      attestation: isAttestation(metadata) ? metadata : null,
    };
  }
  // Fallback for a cache without metadata support (tests/mocks): no attestation.
  const code = cache?.get ? await cache.get(liveKey(appId)) : null;
  return { code: typeof code === "string" ? code : null, attestation: null };
}

export type BundleVerifyStatus =
  | "ok"
  | "no_attestation"
  | "bad_signature"
  | "hash_mismatch"
  | "version_mismatch"
  | "error";

export interface BundleVerifyResult {
  status: BundleVerifyStatus;
  detail?: string;
}

export type ExecutedBundleVerifyMode = "off" | "observe" | "enforce";

export function executedBundleVerifyMode(): ExecutedBundleVerifyMode {
  const raw = (getEnv("EXECUTED_BUNDLE_VERIFY") || "observe").toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "observe";
}

// Second-stage rollout knob for the "strip-the-sidecar" defense. By default a
// bundle with NO attestation is grandfathered (legacy apps published before the
// attestation existed). But once every live bundle has been backfilled with an
// attestation (backfillExecutedBundleAttestations), a NEW no_attestation bundle
// can only mean someone wrote the live KV pointer WITHOUT a sidecar — the cheap
// way to dodge enforcement (stripping is easier than forging). Flip this to "1"
// AFTER the backfill confirms zero legitimate no_attestation bundles remain;
// then no_attestation becomes a hard block under enforce. Mirrors the
// observe->enforce rollout of EXECUTED_BUNDLE_VERIFY itself.
// Internal-only (read by handleExecutedBundleVerdict); not part of the module's
// public surface.
function executedBundleRequireAttestation(): boolean {
  const raw = (getEnv("EXECUTED_BUNDLE_REQUIRE_ATTESTATION") || "").toLowerCase();
  return raw === "1" || raw === "true";
}

// The states that BLOCK execution under enforce: only signature + content
// mismatches, which prove the executed bytes are not what was signed.
//
// version_mismatch is intentionally NOT a hard block. The live KV pointer and the
// DB current_version update non-atomically during publish/gx.set, and the two
// paths update in OPPOSITE orders (publish: DB-then-KV; gx.set: KV-then-DB), so a
// concurrent run can see att.version either older OR newer than current_version
// for a sub-second window — no direction-based rule avoids spuriously blocking a
// legitimate deploy. So a version skew is DETECTED and warned (a SUSTAINED
// mismatch indicates a real downgrade/replay; a transient one is a benign deploy
// window), while sig+hash do the hard blocking. A fully-blocking downgrade
// defense needs atomic version tracking (a deferred enhancement).
export function isExecutedBundleViolation(
  status: BundleVerifyStatus,
  requireAttestation = false,
): boolean {
  if (status === "bad_signature" || status === "hash_mismatch") return true;
  // When attestation is required (post-backfill), an unattested live bundle is a
  // stripped sidecar, not a benign legacy bundle — block it.
  if (requireAttestation && status === "no_attestation") return true;
  return false;
}

// Memoize verdicts within a worker instance. The attestation is written
// ATOMICALLY with the bytes, so a given sig uniquely identifies (bytes, version)
// — caching by sig + expectedVersion lets repeat executions skip the full-bundle
// re-hash. INVARIANT: callers must pass the esmCode + attestation from the SAME
// loadLiveExecutedBundle read (every production path does), so a cached verdict
// for a sig always corresponds to those exact bytes. Bounded; cleared wholesale
// when full (a perf cache, not a security store — correctness never depends on
// it, and "error" verdicts are never cached).
const VERDICT_CACHE = new Map<string, BundleVerifyStatus>();
const VERDICT_CACHE_MAX = 1000;

// Verify the bytes about to execute against their atomically-loaded attestation.
// `attestation` comes from loadLiveExecutedBundle (same read as the bytes).
// `expectedVersion`, when provided (the app's DB current_version), rejects a
// downgrade to an old validly-signed version.
export async function verifyExecutedBundle(input: {
  appId: string;
  esmCode: string;
  attestation: BundleAttestation | null;
  expectedVersion?: string | null;
}): Promise<BundleVerifyResult> {
  const { appId, esmCode, attestation, expectedVersion } = input;
  if (!attestation) return { status: "no_attestation" };
  if (attestation.app_id !== appId) {
    return { status: "bad_signature", detail: "app_id mismatch" };
  }

  const cacheKey = `${appId}:${attestation.sig}:${expectedVersion ?? ""}`;
  const cached = VERDICT_CACHE.get(cacheKey);
  if (cached !== undefined) return { status: cached };

  const result = await computeVerdict(esmCode, attestation, expectedVersion);
  if (result.status !== "error") {
    if (VERDICT_CACHE.size >= VERDICT_CACHE_MAX) VERDICT_CACHE.clear();
    VERDICT_CACHE.set(cacheKey, result.status);
  }
  return result;
}

async function computeVerdict(
  esmCode: string,
  att: BundleAttestation,
  expectedVersion: string | null | undefined,
): Promise<BundleVerifyResult> {
  const { sig, ...body } = att;
  let expectedSig: string;
  try {
    expectedSig = await signAttestationBody(body);
  } catch (err) {
    // Trust secret unavailable — cannot verify, but must not brick execution.
    // This is the silent-degrade-to-off condition: alarm once so it's visible.
    alarmIntegritySecretOnce(
      "verifyExecutedBundle",
      err instanceof Error ? err.message : String(err),
    );
    return { status: "error", detail: "signing unavailable" };
  }
  if (!timingSafeEqual(sig, expectedSig)) return { status: "bad_signature" };

  let actualHash: string;
  try {
    actualHash = await sha256Hex(esmCode);
  } catch {
    return { status: "error", detail: "hash failed" };
  }
  if (actualHash !== att.bundle_hash) {
    return {
      status: "hash_mismatch",
      detail: `attested ${att.bundle_hash.slice(0, 12)} != actual ${actualHash.slice(0, 12)}`,
    };
  }
  // Downgrade/replay DETECTION (non-blocking — see isExecutedBundleViolation):
  // warns when the live attestation's version disagrees with the app's DB
  // current_version. Sustained = likely a real downgrade; transient = deploy skew.
  if (expectedVersion && att.version !== expectedVersion) {
    return {
      status: "version_mismatch",
      detail: `attested ${att.version} != current ${expectedVersion}`,
    };
  }
  return { status: "ok" };
}

// Apply the observe/enforce policy + standardized logging to a verdict, shared
// by every execution path. Returns true iff the caller must REFUSE execution
// (enforce + a real violation). Logging: violations/errors warn in any mode;
// benign legacy no_attestation is silent in observe but warned under enforce so
// un-attested live bundles are visible before/after the flip.
export function handleExecutedBundleVerdict(
  appId: string,
  verdict: BundleVerifyResult,
  mode: ExecutedBundleVerifyMode,
): boolean {
  if (verdict.status === "ok") return false;
  const requireAttestation = executedBundleRequireAttestation();
  const block = mode === "enforce" &&
    isExecutedBundleViolation(verdict.status, requireAttestation);
  if (verdict.status !== "no_attestation" || mode === "enforce") {
    console.warn("[BUNDLE-VERIFY] executed bundle not verified-ok", {
      appId,
      status: verdict.status,
      detail: verdict.detail,
      mode,
      blocked: block,
    });
  }
  return block;
}

// ── Trust-card integrity signal ──────────────────────────────────────────────
// Affordable one-app runtime-integrity check, used by surfaces that build a
// trust card for a SINGLE app (the public Agent page) and can pay one KV read.
// Loads the live bundle + attestation and verifies the bytes against their
// signature. "verified" only when the running bytes match their signed
// attestation; "unverified" when they don't (unattested / mismatch / error);
// "unknown" when there's no live bundle or no KV to read (no claim either way).
//
// Integrity, NOT freshness: we deliberately omit expectedVersion so a benign
// deploy-window version skew never downgrades the chip — the card claims "the
// running bytes are signed + intact"; gx.verify gives the version-anchored verdict.
export async function resolveExecutedIntegrity(
  appId: string,
): Promise<ExecutedIntegrity> {
  const cache = codeCache();
  if (!cache?.getWithMetadata && !cache?.get) return "unknown";
  try {
    const { code, attestation } = await loadLiveExecutedBundle(appId);
    if (code === null) return "unknown";
    const verdict = await verifyExecutedBundle({ appId, esmCode: code, attestation });
    return verdict.status === "ok" ? "verified" : "unverified";
  } catch {
    return "unknown";
  }
}

// ── One-time backfill: attest existing live bundles ──────────────────────────
export interface ExecutedBundleBackfillResult {
  scanned: number;
  attested: number;
  alreadyAttested: number;
  missingBundle: number;
  errors: number;
}

interface BackfillAppRow {
  id: string;
  current_version: string | null;
}

// Re-attest every live bundle that is currently UNATTESTED (the pre-Phase-0
// legacy cohort, and any bundle written while signing was failing). For each
// such app it re-signs the CURRENT live bytes under the app's current_version,
// so going forward they are protected by enforce and — once
// EXECUTED_BUNDLE_REQUIRE_ATTESTATION is flipped on — a later no_attestation can
// only mean a stripped sidecar.
//
// CAVEAT (documented, intentional): this is trust-on-first-attestation of
// whatever is live NOW. It cannot distinguish legit legacy bytes from bytes an
// attacker already swapped, because the executed ESM bundle has no
// independently-recomputable source hash. Run it from a known-good state, soon
// after shipping integrity, before any KV tamper is plausible. Idempotent:
// already-attested bundles are skipped, so it is safe to run repeatedly.
export async function backfillExecutedBundleAttestations(
  opts: { limit?: number } = {},
): Promise<ExecutedBundleBackfillResult> {
  const result: ExecutedBundleBackfillResult = {
    scanned: 0,
    attested: 0,
    alreadyAttested: 0,
    missingBundle: 0,
    errors: 0,
  };
  const cache = codeCache();
  if (!cache?.getWithMetadata) {
    console.warn("[BUNDLE-BACKFILL] CODE_CACHE unavailable; nothing to do");
    return result;
  }

  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.warn("[BUNDLE-BACKFILL] Supabase not configured; nothing to do");
    return result;
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 5000));
  let apps: BackfillAppRow[] = [];
  try {
    const res = await fetch(
      `${url}/rest/v1/apps?select=id,current_version&current_version=not.is.null&limit=${limit}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) {
      console.error("[BUNDLE-BACKFILL] apps query failed", { status: res.status });
      result.errors++;
      return result;
    }
    apps = (await res.json()) as BackfillAppRow[];
  } catch (err) {
    console.error("[BUNDLE-BACKFILL] apps query error", {
      error: err instanceof Error ? err.message : String(err),
    });
    result.errors++;
    return result;
  }

  for (const app of apps) {
    if (!app?.id || !app.current_version) continue;
    result.scanned++;
    try {
      const { code, attestation } = await loadLiveExecutedBundle(app.id);
      if (code === null) {
        result.missingBundle++;
        continue;
      }
      if (attestation) {
        result.alreadyAttested++;
        continue;
      }
      await putLiveExecutedBundle({
        appId: app.id,
        version: app.current_version,
        esmCode: code,
      });
      result.attested++;
    } catch (err) {
      result.errors++;
      console.error("[BUNDLE-BACKFILL] failed to attest app", {
        appId: app.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("[BUNDLE-BACKFILL] complete", result);
  return result;
}

// Test-only: reset the perf cache between cases.
export function __resetVerdictCacheForTest(): void {
  VERDICT_CACHE.clear();
}
