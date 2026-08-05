import { createHash } from "node:crypto";

const CANONICAL_VERSION_RE =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMPUTE_CERTIFICATION_DOCUMENT_SHA256 =
  "1decb2b1b2229cbe1b01c6332a9cc9f5dc24a9a95d71a1510f730e6529bb170c";
const COMPUTE_CERTIFICATION_MANIFEST_SHA256 =
  "9701d4a0b2d6d476abcebc6af6c1cc8c55e80a534e5ae133a523d2c3efb79b7a";

const COMPUTE_CERTIFICATION_SCENARIOS = Object.freeze([
  "sync_toolchain",
  "async_echo",
  "browser_https",
  "artifact_producer",
  "artifact_consumer",
  "exit_23",
  "timeout",
  "cancellable",
  "https_egress_boundaries",
  "raw_tcp_denied",
]);

const INTERFACE_DEMO_FIXTURE = Object.freeze({
  name: "interface-demo",
  directory: "examples/interface-demo",
  uploadName: "Interface Demo (smoke)",
  permission: "compute:exec",
  functionName: "run_compute_smoke",
  testFunctionName: "get_greeting",
  testArgs: Object.freeze({ name: "smoke" }),
  exports: Object.freeze(["get_greeting", "roll_dice", "run_compute_smoke"]),
  profile: "developer-v1",
  tools: Object.freeze(["shell"]),
  secrets: Object.freeze([]),
  contractPath: "manifest.json",
  sourcePaths: null,
  requiresInterface: true,
  requiresIdentityProbe: false,
});

const COMPUTE_CERTIFICATION_FIXTURE = Object.freeze({
  name: "compute-certification",
  directory: "examples/compute-certification",
  uploadName: "Compute Certification",
  permission: "compute:exec",
  functionName: "run_compute_certification",
  testFunctionName: "fixture_identity",
  testArgs: Object.freeze({}),
  exports: Object.freeze([
    "fixture_identity",
    "run_compute_certification",
    "run_compute_policy_probe",
  ]),
  profile: "developer-v1",
  tools: Object.freeze(["browser", "shell"]),
  secrets: Object.freeze([]),
  contractPath: "galactic.yaml",
  sourcePaths: Object.freeze(["galactic.yaml", "index.ts"]),
  requiresInterface: false,
  requiresIdentityProbe: true,
});

const REVIEWED_FIXTURES = Object.freeze({
  [INTERFACE_DEMO_FIXTURE.name]: INTERFACE_DEMO_FIXTURE,
  [COMPUTE_CERTIFICATION_FIXTURE.name]: COMPUTE_CERTIFICATION_FIXTURE,
});

// Kept as the default/exported compatibility contract for existing callers.
export const REVIEWED_COMPUTE_FIXTURE = INTERFACE_DEMO_FIXTURE;

export function reviewedFixtureProfile(name = INTERFACE_DEMO_FIXTURE.name) {
  const fixture = REVIEWED_FIXTURES[name];
  if (!fixture) {
    throw new Error(`Unknown reviewed fixture profile ${JSON.stringify(name)}.`);
  }
  return fixture;
}

function reviewFlags(fixture) {
  return {
    "--reviewed-permission": fixture.permission,
    "--reviewed-function": fixture.functionName,
    "--reviewed-compute-profile": fixture.profile,
    "--reviewed-compute-tools": fixture.tools.join(","),
    "--reviewed-compute-secrets": fixture.secrets.length === 0
      ? "none"
      : fixture.secrets.join(","),
  };
}

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

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

export function reviewedPromotionConfig({
  args,
  ownerAccessToken,
  appId,
  allowCreate,
  directory,
}) {
  const enabled = args.has("--promote-reviewed");
  if (!enabled) return { enabled: false };
  const fixture = reviewedFixtureProfile(
    args.get("--reviewed-fixture") || INTERFACE_DEMO_FIXTURE.name,
  );
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
  if ((directory || fixture.directory) !== fixture.directory) {
    throw new Error(
      `Reviewed ${fixture.name} promotion requires --dir ${fixture.directory}.`,
    );
  }
  for (const [flag, expected] of Object.entries(reviewFlags(fixture))) {
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
    fixture,
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

export function validateReviewedComputeManifest(
  value,
  fixtureName = INTERFACE_DEMO_FIXTURE.name,
) {
  const fixture = reviewedFixtureProfile(fixtureName);
  const manifest = parsedManifest(value, "Compute fixture manifest");
  exactStrings(
    manifest.permissions,
    [fixture.permission],
    "Compute fixture permissions",
  );
  const compute = record(manifest.compute, "Compute fixture ceiling");
  if (compute.profile !== fixture.profile) {
    throw new Error("Compute fixture profile is not developer-v1.");
  }
  exactStrings(
    compute.tools,
    fixture.tools,
    "Compute fixture tools",
  );
  exactStrings(
    compute.secrets,
    fixture.secrets,
    "Compute fixture secrets",
  );
  const functions = record(
    manifest.functions,
    "Compute fixture functions",
  );
  const smokeFunction = record(
    functions[fixture.functionName],
    "Compute fixture release function",
  );
  if (smokeFunction.uses_compute !== true) {
    throw new Error("Compute fixture release function must declare uses_compute.");
  }
  if (fixture.name === COMPUTE_CERTIFICATION_FIXTURE.name) {
    if (
      manifest.name !== "Compute Certification" ||
      manifest.version !== "1.0.0" ||
      manifest.type !== "mcp" ||
      manifest.entry?.functions !== "index.ts" ||
      Object.keys(manifest.entry).length !== 1 ||
      Object.hasOwn(manifest, "interfaces")
    ) {
      throw new Error("Compute certification manifest identity drifted.");
    }
    exactStrings(
      Object.keys(functions).sort(),
      [...fixture.exports].sort(),
      "Compute certification functions",
    );
    if (
      Object.hasOwn(functions.fixture_identity, "uses_compute") ||
      functions.run_compute_policy_probe?.uses_compute !== true
    ) {
      throw new Error("Compute certification function authority drifted.");
    }
    if (!Array.isArray(manifest.routines) || manifest.routines.length !== 1) {
      throw new Error("Compute certification routine declaration drifted.");
    }
    const routine = record(
      manifest.routines[0],
      "Compute certification routine",
    );
    if (
      routine.id !== "compute_policy_probe" ||
      routine.label !== "Compute policy certification" ||
      routine.handler !== "run_compute_policy_probe" ||
      routine.default_schedule?.every_minutes !== 60 ||
      Object.keys(routine.default_schedule ?? {}).length !== 1 ||
      Object.keys(record(routine.config_schema, "Routine config schema")).length !== 0 ||
      Object.keys(record(routine.default_config, "Routine default config")).length !== 0
    ) {
      throw new Error("Compute certification routine declaration drifted.");
    }
    if (
      sha256(JSON.stringify(canonicalJson(manifest))) !==
        COMPUTE_CERTIFICATION_MANIFEST_SHA256
    ) {
      throw new Error("Compute certification manifest content drifted.");
    }
  }
  return manifest;
}

export function validateReviewedComputeSource(
  value,
  fixtureName = INTERFACE_DEMO_FIXTURE.name,
) {
  const fixture = reviewedFixtureProfile(fixtureName);
  if (fixture.name !== COMPUTE_CERTIFICATION_FIXTURE.name) {
    return validateReviewedComputeManifest(value, fixture.name);
  }
  if (
    typeof value !== "string" ||
    sha256(value) !== COMPUTE_CERTIFICATION_DOCUMENT_SHA256
  ) {
    throw new Error("Compute certification galactic.yaml content drifted.");
  }
  return value;
}

export function validateReviewedFixtureIdentity(
  value,
  fixtureName = INTERFACE_DEMO_FIXTURE.name,
) {
  const fixture = reviewedFixtureProfile(fixtureName);
  if (!fixture.requiresIdentityProbe) return value;
  const identity = record(value, "Reviewed fixture identity");
  if (
    identity.fixture !== "galactic-compute-certification" ||
    identity.schema_version !== 1 ||
    identity.deterministic_artifact_sha256 !==
      "6ad9b8ea5280658dc4b229a2b6180d530c4d3824b541d218266ea6049e8b763b"
  ) {
    throw new Error("Compute certification fixture identity drifted.");
  }
  exactStrings(
    identity.scenarios,
    COMPUTE_CERTIFICATION_SCENARIOS,
    "Compute certification identity scenarios",
  );
  return identity;
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
  fixtureName = INTERFACE_DEMO_FIXTURE.name,
  identity = null,
}) {
  const fixture = reviewedFixtureProfile(fixtureName);
  const appProjection = record(app, "Promoted fixture projection");
  if (
    appProjection.id !== appId ||
    appProjection.visibility !== "private" ||
    appProjection.current_version !== version
  ) {
    throw new Error("The exact private fixture version is not live.");
  }
  validateReviewedComputeManifest(appProjection.manifest, fixture.name);
  if (
    !Array.isArray(appProjection.exports) ||
    (fixture.name === COMPUTE_CERTIFICATION_FIXTURE.name
      ? appProjection.exports.length !== fixture.exports.length ||
        [...fixture.exports].some((name) => !appProjection.exports.includes(name))
      : !appProjection.exports.includes(fixture.functionName))
  ) {
    throw new Error("The live fixture export list does not match the review profile.");
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
    (fixture.name === COMPUTE_CERTIFICATION_FIXTURE.name
      ? functionProjection.functions.length !== fixture.exports.length ||
        fixture.exports.some((name) =>
          !functionProjection.functions.some((entry) => entry?.name === name)
        )
      : !functionProjection.functions.some((entry) =>
        entry?.name === fixture.functionName
      ))
  ) {
    throw new Error("The promoted fixture functions do not match the review profile.");
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
    ceiling.profile !== fixture.profile
  ) {
    throw new Error("The live Compute manifest ceiling is not enabled.");
  }
  exactStrings(
    ceiling.tools,
    fixture.tools,
    "Live Compute manifest tools",
  );
  exactStrings(
    ceiling.secrets,
    fixture.secrets,
    "Live Compute manifest secrets",
  );
  validateReviewedFixtureIdentity(identity, fixture.name);
}
