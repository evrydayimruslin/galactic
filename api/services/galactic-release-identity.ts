import { canonicalJson, sha256Hex } from "./trust.ts";
import { GALACTIC_SANDBOX_TEMPLATE_VERSION } from "../runtime/runtime-contract.ts";
import { compareCanonicalStrings } from "./canonical-order.ts";

/**
 * These are protocol revisions, not marketing versions. Any change that can
 * alter compiled bytes, available bindings, or qualification semantics must
 * bump the corresponding value and therefore force a fresh gx.test.
 */
export const GALACTIC_COMPILER_REVISION = "galactic-compiler/v1alpha1.3";
export const GALACTIC_RUNTIME_CONTRACT_REVISION =
  `dynamic-worker/${GALACTIC_SANDBOX_TEMPLATE_VERSION}+gx-test-v3`;
export const GALACTIC_BASIC_POLICY_REVISION = "basic-conformance/3";

interface PreparedReleaseArtifact {
  name: string;
  content: Uint8Array | string;
}

export interface GalacticPreparedReleaseIdentity {
  source_hash: string;
  document_digest: string;
  prepared_artifact_digest: string;
  executable_digest: string;
  compiler_revision: string;
  runtime_revision: string;
  release_digest: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_REVISION_LENGTH = 128;

function assertDigest(label: string, value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertRevision(label: string, value: string): void {
  if (
    !value ||
    value.length > MAX_REVISION_LENGTH ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is not a valid protocol revision`);
  }
}

/**
 * Hash the exact named bytes that the upload path will persist. Names are part
 * of the identity, duplicates fail closed, and artifact bodies never enter an
 * attestation or diagnostic.
 */
export async function computePreparedArtifactDigest(
  artifacts: PreparedReleaseArtifact[],
): Promise<string> {
  const seen = new Set<string>();
  const hashes: Array<[string, string]> = [];
  for (
    const artifact of [...artifacts].sort((left, right) =>
      compareCanonicalStrings(left.name, right.name)
    )
  ) {
    if (!artifact.name || seen.has(artifact.name)) {
      throw new Error(
        artifact.name
          ? `Duplicate prepared release artifact: ${artifact.name}`
          : "Prepared release artifact name is required",
      );
    }
    seen.add(artifact.name);
    hashes.push([artifact.name, await sha256Hex(artifact.content)]);
  }
  if (hashes.length === 0) {
    throw new Error("Prepared release artifact set must not be empty");
  }
  return await sha256Hex(canonicalJson(hashes));
}

export async function computeGalacticReleaseIdentity(input: {
  sourceHash: string;
  documentDigest: string;
  artifacts: PreparedReleaseArtifact[];
  executable: Uint8Array | string;
  compilerRevision?: string;
  runtimeRevision?: string;
}): Promise<GalacticPreparedReleaseIdentity> {
  const compilerRevision = input.compilerRevision ??
    GALACTIC_COMPILER_REVISION;
  const runtimeRevision = input.runtimeRevision ??
    GALACTIC_RUNTIME_CONTRACT_REVISION;
  assertDigest("sourceHash", input.sourceHash);
  assertDigest("documentDigest", input.documentDigest);
  assertRevision("compilerRevision", compilerRevision);
  assertRevision("runtimeRevision", runtimeRevision);
  const preparedArtifactDigest = await computePreparedArtifactDigest(
    input.artifacts,
  );
  const executableDigest = await sha256Hex(input.executable);
  const subject = {
    schema_version: 1,
    source_hash: input.sourceHash,
    document_digest: input.documentDigest,
    prepared_artifact_digest: preparedArtifactDigest,
    executable_digest: executableDigest,
    compiler_revision: compilerRevision,
    runtime_revision: runtimeRevision,
  };
  return {
    source_hash: input.sourceHash,
    document_digest: input.documentDigest,
    prepared_artifact_digest: preparedArtifactDigest,
    executable_digest: executableDigest,
    compiler_revision: compilerRevision,
    runtime_revision: runtimeRevision,
    release_digest: await sha256Hex(canonicalJson(subject)),
  };
}

export async function computeQualificationReportDigest(
  report: unknown,
): Promise<string> {
  return await sha256Hex(canonicalJson(report));
}
