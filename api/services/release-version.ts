import { isCanonicalAppVersion } from "../../shared/contracts/manifest.ts";

export interface InitialReleaseVersionState {
  current_version: string;
  versions: string[];
}

/** Keep the database live pointer/list aligned with the versioned R2 + KV key. */
export function initialReleaseVersionState(
  version: unknown,
): InitialReleaseVersionState {
  if (!isCanonicalAppVersion(version)) {
    throw new Error(
      "version must be canonical x.y.z numeric semver (for example 1.2.3)",
    );
  }
  return { current_version: version, versions: [version] };
}
