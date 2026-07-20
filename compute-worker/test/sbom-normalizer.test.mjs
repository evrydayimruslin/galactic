import { describe, expect, it } from "vitest";

import { normalizeSyftSpdx } from "../scripts/normalize-syft-spdx.mjs";

function denoPackage(version = "0.77.0") {
  return {
    name: "deno",
    SPDXID: "SPDXRef-Package-binary-deno-test",
    versionInfo: version,
    sourceInfo:
      "acquired package info from the following paths: /usr/local/bin/deno",
    externalRefs: [
      {
        referenceCategory: "SECURITY",
        referenceType: "cpe23Type",
        referenceLocator: `cpe:2.3:a:deno:deno:${version}:*:*:*:*:*:*:*`,
      },
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:generic/deno@${version}`,
      },
    ],
  };
}

function document(pkg = denoPackage()) {
  return {
    spdxVersion: "SPDX-2.3",
    creationInfo: {
      creators: ["Organization: Anchore, Inc", "Tool: syft-1.44.0"],
    },
    packages: [pkg],
  };
}

describe("Syft SPDX normalization", () => {
  it("retains the raw input and records the exact Deno coordinate correction", () => {
    const input = document();
    const { document: normalized, evidence } = normalizeSyftSpdx(input);

    expect(input.packages[0].versionInfo).toBe("0.77.0");
    expect(normalized.packages[0].versionInfo).toBe("2.9.3");
    expect(normalized.packages[0].externalRefs).toEqual([
      expect.objectContaining({
        referenceLocator: "cpe:2.3:a:deno:deno:2.9.3:*:*:*:*:*:*:*",
      }),
      expect.objectContaining({
        referenceLocator: "pkg:generic/deno@2.9.3",
      }),
    ]);
    expect(evidence).toMatchObject({
      schema_version: 1,
      correction_applied: true,
      original: { version: "0.77.0" },
      normalized: { version: "2.9.3" },
    });
  });

  it("accepts an already-correct future Syft result without claiming a correction", () => {
    const { evidence } = normalizeSyftSpdx(document(denoPackage("2.9.3")));
    expect(evidence.correction_applied).toBe(false);
  });

  it("fails closed on an unexpected Deno version", () => {
    expect(() => normalizeSyftSpdx(document(denoPackage("2.8.0")))).toThrow(
      "Unexpected Syft Deno version",
    );
  });

  it("fails closed when the version and vulnerability coordinates disagree", () => {
    const pkg = denoPackage();
    pkg.externalRefs[1].referenceLocator = "pkg:generic/deno@2.9.3";
    expect(() => normalizeSyftSpdx(document(pkg))).toThrow(
      "coordinates do not match",
    );
  });

  it("fails closed when package identity is ambiguous", () => {
    const input = document();
    input.packages.push(denoPackage());
    expect(() => normalizeSyftSpdx(input)).toThrow("found 2");
  });
});
