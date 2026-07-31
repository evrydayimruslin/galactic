import type {
  VersionTestQualificationMetadata,
} from "../../shared/types/index.ts";
import {
  computeGalacticReleaseIdentity,
  GALACTIC_BASIC_POLICY_REVISION,
  GALACTIC_COMPILER_REVISION,
  GALACTIC_RUNTIME_CONTRACT_REVISION,
  type GalacticPreparedReleaseIdentity,
} from "./galactic-release-identity.ts";
import { sha256Hex } from "./trust.ts";

interface GalacticPreparedPipelineSubject {
  sourceHash: string;
  documentDigest: string;
  filesToUpload: Array<{ name: string; content: Uint8Array | string }>;
  interfaceArtifacts: Array<{
    name: string;
    content: Uint8Array | string;
  }>;
  esmBundledCode?: string;
}

export function isCurrentGalacticQualification(
  qualification: VersionTestQualificationMetadata,
): boolean {
  return qualification.profile === "basic" &&
    qualification.compiler_revision === GALACTIC_COMPILER_REVISION &&
    qualification.runtime_revision === GALACTIC_RUNTIME_CONTRACT_REVISION &&
    qualification.policy_revision === GALACTIC_BASIC_POLICY_REVISION;
}

export async function computePreparedPipelineReleaseIdentity(
  input: GalacticPreparedPipelineSubject,
): Promise<GalacticPreparedReleaseIdentity> {
  if (!input.esmBundledCode) {
    throw new Error(
      "Galactic qualification requires the prepared ESM executable",
    );
  }
  return await computeGalacticReleaseIdentity({
    sourceHash: input.sourceHash,
    documentDigest: input.documentDigest,
    artifacts: [
      ...input.filesToUpload,
      ...input.interfaceArtifacts.map((artifact) => ({
        name: `interfaces/${artifact.name}`,
        content: artifact.content,
      })),
    ],
    executable: input.esmBundledCode,
  });
}

/**
 * Upload-time anti-TOCTOU check. The signed claim is accepted only when the
 * current compiler produces the exact document and release fingerprints that
 * gx.test signed from the exact source hash.
 */
export async function assertQualificationMatchesPreparedRelease(input: {
  qualification: VersionTestQualificationMetadata;
  prepared: GalacticPreparedPipelineSubject;
}): Promise<GalacticPreparedReleaseIdentity> {
  const { qualification } = input;
  if (
    !isCurrentGalacticQualification(qualification) ||
    qualification.document_digest !== input.prepared.documentDigest
  ) {
    throw new Error(
      "The gx.test qualification was produced for a different Galactic contract or runtime revision. Run gx.test again on the exact files.",
    );
  }

  const identity = await computePreparedPipelineReleaseIdentity(
    input.prepared,
  );
  if (identity.release_digest !== qualification.release_digest) {
    throw new Error(
      "The prepared release differs from the release qualified by gx.test. Run gx.test again on the exact files.",
    );
  }
  return identity;
}

/**
 * Promotion-time storage check for a V2-qualified release.
 *
 * Upload already reproduced the signed release once. Promotion repeats that
 * proof from retained authored source, then uses this function to ensure the
 * staged R2 artifacts, separately stored interface files, and versioned KV
 * executable are still byte-for-byte identical to the reproduced subject.
 * Legacy releases retain their historical rebuild fallback; V2 never does.
 */
export async function assertQualifiedReleaseArtifactsRetained(input: {
  prepared: GalacticPreparedPipelineSubject;
  readVersionArtifact: (name: string) => Promise<Uint8Array>;
  readInterfaceArtifact: (name: string) => Promise<Uint8Array>;
  retainedExecutable: string | null;
}): Promise<string> {
  if (!input.prepared.esmBundledCode) {
    throw new Error(
      "Qualified release promotion requires the prepared ESM executable",
    );
  }

  for (const artifact of input.prepared.filesToUpload) {
    let retained: Uint8Array;
    try {
      retained = await input.readVersionArtifact(artifact.name);
    } catch {
      throw new Error(
        `Qualified release artifact is missing: ${artifact.name}`,
      );
    }
    if (
      await sha256Hex(retained) !== await sha256Hex(artifact.content)
    ) {
      throw new Error(
        `Qualified release artifact differs from gx.test: ${artifact.name}`,
      );
    }
  }

  for (const artifact of input.prepared.interfaceArtifacts) {
    let retained: Uint8Array;
    try {
      retained = await input.readInterfaceArtifact(artifact.name);
    } catch {
      throw new Error(
        `Qualified interface artifact is missing: ${artifact.name}`,
      );
    }
    if (
      await sha256Hex(retained) !== await sha256Hex(artifact.content)
    ) {
      throw new Error(
        `Qualified interface artifact differs from gx.test: ${artifact.name}`,
      );
    }
  }

  if (!input.retainedExecutable) {
    throw new Error(
      "Qualified release executable is missing; re-upload the exact tested release",
    );
  }
  if (
    await sha256Hex(input.retainedExecutable) !==
      await sha256Hex(input.prepared.esmBundledCode)
  ) {
    throw new Error(
      "Qualified release executable differs from gx.test; re-upload the exact tested release",
    );
  }
  return input.retainedExecutable;
}
