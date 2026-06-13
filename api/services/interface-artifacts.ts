// Interface artifact preparation (Interfaces PR2 — docs/INTERFACE_RELAUNCH_PR_ROADMAP.md).
//
// Manifest-declared interfaces ship as static HTML files inside the app
// bundle. At upload time we validate each declared entry against the
// prepared file set, hash the exact bytes that will ship, and copy them to
// a dedicated content-addressed prefix:
//
//   interfaces/{appId}/{sha256}.html
//
// Interfaces are NEVER served from the bundle path (apps/{appId}/{version}/)
// — the bundle contains app source code, and the sandbox worker (PR3) is
// only allowed to read this prefix. Content addressing makes re-uploads
// idempotent and lets unchanged interfaces keep their URL (and browser
// cache) across app versions.
//
// The returned manifest carries server-stamped `hash` values; anything the
// developer supplied in `hash` is overwritten, never trusted. GPU uploads
// skip this step entirely: their runtime cannot serve the function bridge,
// and the facade (PR4) only surfaces interfaces that carry a stamped hash.

import type {
  AppManifest,
  ManifestInterfaceDeclaration,
} from '../../shared/contracts/manifest.ts';

// One self-contained file per interface; large asset pipelines are out of
// scope for v1 (decision #8 in docs/INTERFACE_RELAUNCH_INVESTIGATION.md).
export const INTERFACE_MAX_BYTES = 1024 * 1024;

const INTERFACE_ARTIFACT_PREFIX = 'interfaces/';

export function interfaceArtifactPrefixForApp(appId: string): string {
  return `${INTERFACE_ARTIFACT_PREFIX}${appId}/`;
}

// Upload flows surface this as a 400 (deploy fails loudly, not silently).
export class InterfaceArtifactError extends Error {
  status = 400;
}

export interface InterfaceArtifactFile {
  // `${sha256}.html`, uploaded under interfaceArtifactPrefixForApp(appId).
  name: string;
  content: Uint8Array;
  contentType: string;
}

interface PreparedInterfaceArtifacts {
  manifest: AppManifest;
  artifacts: InterfaceArtifactFile[];
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

// Validates and hashes against the FINAL prepared upload set (normalized
// names, the exact bytes written to R2), so the artifact can never diverge
// from what shipped. Returns null when the manifest declares no interfaces
// — callers skip with zero behavior change for today's uploads.
export async function prepareInterfaceArtifacts(input: {
  manifest: AppManifest | null | undefined;
  files: Array<{ name: string; content: Uint8Array }>;
}): Promise<PreparedInterfaceArtifacts | null> {
  const manifest = input.manifest;
  if (!manifest?.interfaces?.length) return null;

  const filesByName = new Map(input.files.map((file) => [file.name, file]));
  const artifactsByName = new Map<string, InterfaceArtifactFile>();
  const stamped: ManifestInterfaceDeclaration[] = [];

  for (const declaration of manifest.interfaces) {
    const file = filesByName.get(declaration.entry);
    if (!file) {
      throw new InterfaceArtifactError(
        `Interface "${declaration.id}" entry file not found in upload: ${declaration.entry}`,
      );
    }
    if (file.content.byteLength > INTERFACE_MAX_BYTES) {
      throw new InterfaceArtifactError(
        `Interface "${declaration.id}" entry ${declaration.entry} is ${file.content.byteLength} bytes; ` +
          `interfaces must be a single self-contained file of at most ${INTERFACE_MAX_BYTES} bytes`,
      );
    }

    const digest = await crypto.subtle.digest(
      'SHA-256',
      // Copy into a fresh ArrayBuffer-backed view: digest() rejects views
      // over SharedArrayBuffer and offset views would hash the wrong bytes.
      new Uint8Array(file.content),
    );
    const hash = toHex(digest);
    artifactsByName.set(`${hash}.html`, {
      name: `${hash}.html`,
      content: file.content,
      contentType: 'text/html; charset=utf-8',
    });
    stamped.push({ ...declaration, hash });
  }

  return {
    manifest: { ...manifest, interfaces: stamped },
    artifacts: Array.from(artifactsByName.values()),
  };
}
