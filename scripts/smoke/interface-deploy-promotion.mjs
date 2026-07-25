import { createHash } from "node:crypto";

const CANONICAL_VERSION_RE =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const REVIEWED_COMPUTE_FIXTURE = Object.freeze({
  permission: "compute:exec",
  functionName: "run_compute_smoke",
  profile: "developer-v1",
  tools: Object.freeze(["shell"]),
  secrets: Object.freeze([]),
});

const REVIEW_FLAGS = Object.freeze({
  "--reviewed-permission": REVIEWED_COMPUTE_FIXTURE.permission,
  "--reviewed-function": REVIEWED_COMPUTE_FIXTURE.functionName,
  "--reviewed-compute-profile": REVIEWED_COMPUTE_FIXTURE.profile,
  "--reviewed-compute-tools": "shell",
  "--reviewed-compute-secrets": "none",
});

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exactStrings(value, expected, label) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((item, index) => item !== expected[index])
  ) {
    throw new Error(`${label} must be exactly ${JSON.stringify(expected)}.`);
  }
}

function parsedManifest(value, label) {
  let manifest = value;
  if (typeof value === "string") {
    try {
      manifest = JSON.parse(value);
    } catch {
      throw new Error(`${label} is not valid JSON.`);
    }
  }
  return record(manifest, label);
}

export function reviewedPromotionConfig({
  args,
  ownerAccessToken,
  appId,
  allowCreate,
}) {
  const enabled = args.has("--promote-reviewed");
  if (!enabled) return { enabled: false };
  if (allowCreate) {
    throw new Error(
      "--promote-reviewed cannot be combined with --allow-create.",
    );
  }
  if (!UUID_RE.test(String(appId || ""))) {
    throw new Error(
      "--promote-reviewed requires the exact existing fixture UUID.",
    );
  }
  if (!String(ownerAccessToken || "").trim()) {
    throw new Error(
      "--promote-reviewed requires GALACTIC_OWNER_ACCESS_TOKEN from the owner-session helper.",
    );
  }
  for (const [flag, expected] of Object.entries(REVIEW_FLAGS)) {
    if (args.get(flag) !== expected) {
      throw new Error(
        `${flag} must explicitly acknowledge ${JSON.stringify(expected)}.`,
      );
    }
  }
  return {
    enabled: true,
    appId,
    ownerAccessToken: String(ownerAccessToken).trim(),
  };
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function incrementVersion(version) {
  const parts = version.split(".").map(Number);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index] < 999_999_999) {
      parts[index] += 1;
      return parts.join(".");
    }
    parts[index] = 0;
  }
  throw new Error("The smoke fixture exhausted the canonical version range.");
}

export function nextFixtureVersion(app) {
  const projection = record(app, "Fixture projection");
  const versions = [...new Set([
    ...(Array.isArray(projection.versions) ? projection.versions : []),
    projection.current_version,
  ])]
    .map((version) => String(version || ""))
    .filter((version) => CANONICAL_VERSION_RE.test(version))
    .sort(compareVersions);
  return versions.length === 0
    ? "1.0.1"
    : incrementVersion(versions.at(-1));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function computeRawSourceHash(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Fixture source files are required.");
  }
  const seen = new Set();
  const canonical = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => {
      if (
        typeof file?.path !== "string" ||
        typeof file?.content !== "string" ||
        seen.has(file.path)
      ) {
        throw new Error("Fixture source paths and contents must be unique strings.");
      }
      seen.add(file.path);
      return [file.path, sha256(file.content)];
    });
  return sha256(JSON.stringify(canonical));
}

export function fixtureRefreshPlan({ app, home, appId, sourceHash }) {
  const projection = record(app, "Fixture projection");
  const snapshot = record(home, "Agent Home snapshot");
  if (projection.id !== appId || snapshot.agent?.id !== appId) {
    throw new Error("Fixture projections did not resolve the exact Agent.");
  }
  const live = snapshot.release?.live;
  if (live?.sourceFingerprint === sourceHash) {
    if (
      live.version !== projection.current_version ||
      live.executedVersion !== live.version ||
      live.integrity !== "verified"
    ) {
      throw new Error(
        "The exact source is marked live but its executable version is not verified.",
      );
    }
    return { action: "reuse_live", version: live.version };
  }
  const candidate = snapshot.release?.candidate;
  if (candidate?.sourceFingerprint === sourceHash) {
    if (candidate.canPromote !== true) {
      throw new Error("The exact tested fixture candidate cannot be promoted.");
    }
    return { action: "promote_candidate", version: candidate.version };
  }
  const candidateCount = snapshot.release?.candidateCount;
  if (!Number.isInteger(candidateCount) || candidateCount < 0) {
    throw new Error("Agent Home returned an invalid staged candidate count.");
  }
  if (candidateCount >= 3) {
    throw new Error(
      "The fixture has three unrelated staged candidates. Refusing to delete or bypass owner drafts.",
    );
  }
  return { action: "upload", version: nextFixtureVersion(projection) };
}

export function validateReviewedComputeManifest(value) {
  const manifest = parsedManifest(value, "Compute fixture manifest");
  exactStrings(
    manifest.permissions,
    [REVIEWED_COMPUTE_FIXTURE.permission],
    "Compute fixture permissions",
  );
  const compute = record(manifest.compute, "Compute fixture ceiling");
  if (compute.profile !== REVIEWED_COMPUTE_FIXTURE.profile) {
    throw new Error("Compute fixture profile is not developer-v1.");
  }
  exactStrings(
    compute.tools,
    REVIEWED_COMPUTE_FIXTURE.tools,
    "Compute fixture tools",
  );
  exactStrings(
    compute.secrets,
    REVIEWED_COMPUTE_FIXTURE.secrets,
    "Compute fixture secrets",
  );
  const functions = record(
    manifest.functions,
    "Compute fixture functions",
  );
  const smokeFunction = record(
    functions[REVIEWED_COMPUTE_FIXTURE.functionName],
    "Compute fixture release function",
  );
  if (smokeFunction.uses_compute !== true) {
    throw new Error("Compute fixture release function must declare uses_compute.");
  }
  return manifest;
}

export function validateStagedPromotion({
  upload,
  home,
  appId,
  version,
  sourceHash,
}) {
  const result = record(upload, "Fixture upload result");
  if (
    result.app_id !== appId ||
    result.version !== version ||
    result.live_version === version ||
    result.is_live !== false ||
    result.deduplicated === true
  ) {
    throw new Error(
      "The fixture upload did not return the exact non-live reviewed version.",
    );
  }
  const snapshot = record(home, "Agent Home snapshot");
  if (snapshot.agent?.id !== appId) {
    throw new Error("Agent Home returned a different fixture.");
  }
  if (
    snapshot.release?.candidate?.version !== version ||
    snapshot.release.candidate.sourceFingerprint !== sourceHash ||
    snapshot.release.candidate.canPromote !== true
  ) {
    throw new Error(
      "The exact uploaded fixture version is not the promotable tested candidate.",
    );
  }
  if (typeof snapshot.revision !== "string" || !snapshot.revision) {
    throw new Error("Agent Home did not return a promotion revision.");
  }
  return snapshot;
}

export function promotionAction(home, version, idempotencyKey) {
  if (!UUID_RE.test(String(idempotencyKey || ""))) {
    throw new Error("Promotion idempotency key must be a UUID.");
  }
  return {
    action: "promote_candidate",
    expectedRevision: home.revision,
    idempotencyKey,
    version,
  };
}

export function validatePromotedComputeFixture({
  app,
  home,
  functions,
  settings,
  appId,
  version,
  sourceHash,
}) {
  const appProjection = record(app, "Promoted fixture projection");
  if (
    appProjection.id !== appId ||
    appProjection.visibility !== "private" ||
    appProjection.current_version !== version
  ) {
    throw new Error("The exact private fixture version is not live.");
  }
  validateReviewedComputeManifest(appProjection.manifest);
  if (
    !Array.isArray(appProjection.exports) ||
    !appProjection.exports.includes(REVIEWED_COMPUTE_FIXTURE.functionName)
  ) {
    throw new Error("The live fixture export list omits run_compute_smoke.");
  }

  const snapshot = record(home, "Promoted Agent Home snapshot");
  if (
    snapshot.agent?.id !== appId ||
    snapshot.release?.live?.version !== version ||
    snapshot.release.live.sourceFingerprint !== sourceHash ||
    snapshot.release.live.executedVersion !== version ||
    snapshot.release.live.integrity !== "verified"
  ) {
    throw new Error(
      "Agent Home did not verify the exact promoted executable version.",
    );
  }

  const functionProjection = record(
    functions,
    "Promoted fixture function projection",
  );
  if (
    functionProjection.agent?.id !== appId ||
    !Array.isArray(functionProjection.functions) ||
    !functionProjection.functions.some((entry) =>
      entry?.name === REVIEWED_COMPUTE_FIXTURE.functionName
    )
  ) {
    throw new Error("The promoted fixture does not expose run_compute_smoke.");
  }

  const settingsProjection = record(
    settings,
    "Promoted fixture Compute settings",
  );
  const computeSettings = record(
    settingsProjection.settings,
    "Promoted fixture Compute policy",
  );
  if (computeSettings.enabled !== false) {
    throw new Error(
      "The dedicated Compute release fixture must be disabled before admission.",
    );
  }
  const ceiling = record(
    computeSettings.manifestCeiling,
    "Promoted fixture manifest ceiling",
  );
  if (
    ceiling.enabled !== true ||
    ceiling.profile !== REVIEWED_COMPUTE_FIXTURE.profile
  ) {
    throw new Error("The live Compute manifest ceiling is not enabled.");
  }
  exactStrings(
    ceiling.tools,
    REVIEWED_COMPUTE_FIXTURE.tools,
    "Live Compute manifest tools",
  );
  exactStrings(
    ceiling.secrets,
    REVIEWED_COMPUTE_FIXTURE.secrets,
    "Live Compute manifest secrets",
  );
}
