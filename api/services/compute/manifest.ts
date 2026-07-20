import {
  COMPUTE_EXEC_PERMISSION,
  normalizeManifestComputeConfig,
  type ManifestComputeConfig,
} from "../../../shared/contracts/compute.ts";
import type { AppManifest } from "../../../shared/contracts/manifest.ts";

export class ComputeManifestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ComputeManifestError";
    this.code = code;
  }
}

export interface ComputeManifestApp {
  id: string;
  owner_id: string;
  current_version: string;
  manifest: string | AppManifest | null;
}

export interface LiveComputeManifestAuthority {
  config: ManifestComputeConfig;
  revision: string;
  callerFunction: string;
}

function parseManifest(value: ComputeManifestApp["manifest"]): AppManifest {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ComputeManifestError(
        "COMPUTE_MANIFEST_INVALID",
        "The live Agent manifest is invalid.",
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ComputeManifestError(
      "COMPUTE_MANIFEST_MISSING",
      "The live Agent release does not declare Compute.",
    );
  }
  return parsed as AppManifest;
}

/** Resolve the immutable live-release ceiling for one exact caller function. */
export function resolveLiveComputeManifestAuthority(input: {
  app: ComputeManifestApp;
  ownerUserId: string;
  callerFunction: string;
}): LiveComputeManifestAuthority {
  if (input.app.owner_id !== input.ownerUserId) {
    throw new ComputeManifestError(
      "COMPUTE_OWNER_REQUIRED",
      "Galactic Compute v1 is available only on an Agent owned by the executing account.",
    );
  }
  const manifest = parseManifest(input.app.manifest);
  if (!manifest.permissions?.includes(COMPUTE_EXEC_PERMISSION)) {
    throw new ComputeManifestError(
      "COMPUTE_PERMISSION_REQUIRED",
      `The live Agent release does not grant ${COMPUTE_EXEC_PERMISSION}.`,
    );
  }
  const config = normalizeManifestComputeConfig(manifest.compute);
  if (!config) {
    throw new ComputeManifestError(
      "COMPUTE_CEILING_REQUIRED",
      "The live Agent release has no valid developer-v1 Compute ceiling.",
    );
  }
  const fn = manifest.functions?.[input.callerFunction];
  if (!fn || fn.uses_compute !== true) {
    throw new ComputeManifestError(
      "COMPUTE_CALLER_NOT_DECLARED",
      "This live Agent function is not declared as a Compute caller.",
    );
  }
  if (!input.app.current_version?.trim()) {
    throw new ComputeManifestError(
      "COMPUTE_RELEASE_INVALID",
      "The live Agent release version is unavailable.",
    );
  }
  return {
    config,
    revision: input.app.current_version.trim(),
    callerFunction: input.callerFunction,
  };
}
