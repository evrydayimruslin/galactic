#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const EXPECTED_SYFT_CREATOR = "Tool: syft-1.44.0";
const EXPECTED_DENO_VERSION = "2.9.3";
const MISCLASSIFIED_DENO_VERSION = "0.77.0";
const DENO_SOURCE_INFO =
  "acquired package info from the following paths: /usr/local/bin/deno";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function denoCoordinates(version) {
  return {
    cpe: `cpe:2.3:a:deno:deno:${version}:*:*:*:*:*:*:*`,
    purl: `pkg:generic/deno@${version}`,
  };
}

function requireExternalReference(pkg, category, type) {
  if (!Array.isArray(pkg.externalRefs)) {
    throw new Error("Syft Deno package omitted external references.");
  }
  const matches = pkg.externalRefs.filter(
    (reference) =>
      isRecord(reference) &&
      reference.referenceCategory === category &&
      reference.referenceType === type,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Deno ${type} reference; found ${matches.length}.`,
    );
  }
  return matches[0];
}

export function normalizeSyftSpdx(input) {
  if (!isRecord(input) || input.spdxVersion !== "SPDX-2.3") {
    throw new Error("Expected a Syft SPDX 2.3 document.");
  }
  if (
    !isRecord(input.creationInfo) ||
    !Array.isArray(input.creationInfo.creators) ||
    !input.creationInfo.creators.includes(EXPECTED_SYFT_CREATOR)
  ) {
    throw new Error(`Expected ${EXPECTED_SYFT_CREATOR} provenance.`);
  }
  if (!Array.isArray(input.packages)) {
    throw new Error("Syft SPDX document omitted packages.");
  }

  const document = structuredClone(input);
  const candidates = document.packages.filter(
    (pkg) =>
      isRecord(pkg) &&
      pkg.name === "deno" &&
      pkg.sourceInfo === DENO_SOURCE_INFO,
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one Syft Deno package from /usr/local/bin/deno; found ${candidates.length}.`,
    );
  }

  const pkg = candidates[0];
  if (typeof pkg.SPDXID !== "string" || !pkg.SPDXID.startsWith("SPDXRef-Package-")) {
    throw new Error("Syft Deno package omitted a valid SPDX identifier.");
  }
  if (
    pkg.versionInfo !== MISCLASSIFIED_DENO_VERSION &&
    pkg.versionInfo !== EXPECTED_DENO_VERSION
  ) {
    throw new Error(
      `Unexpected Syft Deno version: ${String(pkg.versionInfo)}.`,
    );
  }

  const cpeReference = requireExternalReference(pkg, "SECURITY", "cpe23Type");
  const purlReference = requireExternalReference(pkg, "PACKAGE-MANAGER", "purl");
  const originalVersion = pkg.versionInfo;
  const originalCoordinates = denoCoordinates(originalVersion);
  if (
    cpeReference.referenceLocator !== originalCoordinates.cpe ||
    purlReference.referenceLocator !== originalCoordinates.purl
  ) {
    throw new Error("Syft Deno coordinates do not match its reported version.");
  }

  const correctedCoordinates = denoCoordinates(EXPECTED_DENO_VERSION);
  pkg.versionInfo = EXPECTED_DENO_VERSION;
  cpeReference.referenceLocator = correctedCoordinates.cpe;
  purlReference.referenceLocator = correctedCoordinates.purl;

  return {
    document,
    evidence: {
      schema_version: 1,
      correction_applied: originalVersion !== EXPECTED_DENO_VERSION,
      package_spdx_id: pkg.SPDXID,
      package_path: "/usr/local/bin/deno",
      classifier: "syft-1.44.0 binary-classifier-cataloger",
      reason:
        "Syft selected an embedded Deno/0.77.0 token instead of the independently pinned and runtime-smoked Deno 2.9.3 release.",
      original: {
        version: originalVersion,
        ...originalCoordinates,
      },
      normalized: {
        version: EXPECTED_DENO_VERSION,
        ...correctedCoordinates,
      },
    },
  };
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  const evidencePath = process.argv[4];
  if (!inputPath || !outputPath || !evidencePath) {
    throw new Error(
      "Usage: normalize-syft-spdx.mjs <raw-spdx-json> <normalized-spdx-json> <correction-evidence-json>",
    );
  }

  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const { document, evidence } = normalizeSyftSpdx(input);
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
