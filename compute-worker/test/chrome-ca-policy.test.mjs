import { X509Certificate } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const installer = fileURLToPath(
  new URL(
    "../images/standard/configure-chrome-ca-policy.mjs",
    import.meta.url,
  ),
);
const temporaryRoots = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "galactic-chrome-ca-policy-"));
  temporaryRoots.push(root);
  return root;
}

function runInstaller(caFile, policyFile, nssCertificateDirectory) {
  return spawnSync(process.execPath, [
    installer,
    caFile,
    policyFile,
    ...(nssCertificateDirectory ? [nssCertificateDirectory] : []),
  ], {
    encoding: "utf8",
  });
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Chrome for Testing CA policy installer", () => {
  it("validates, deduplicates, and atomically installs CA certificates", () => {
    const root = temporaryRoot();
    const caFile = join(root, "cloudflare-ca.crt");
    const policyFile = join(root, "policies", "managed", "galactic-ca.json");
    const nssCertificateDirectory = join(root, "nss-certificates");
    writeFileSync(
      caFile,
      `${rootCertificates[0]}\n${rootCertificates[0]}\n${rootCertificates[1]}\n`,
    );

    const result = runInstaller(
      caFile,
      policyFile,
      nssCertificateDirectory,
    );
    expect(result.status, result.stderr).toBe(0);

    const policy = JSON.parse(readFileSync(policyFile, "utf8"));
    expect(policy).toEqual({
      CACertificates: [
        new X509Certificate(rootCertificates[0]).raw.toString("base64"),
        new X509Certificate(rootCertificates[1]).raw.toString("base64"),
      ],
    });
    expect(mode(join(root, "policies", "managed"))).toBe(0o755);
    expect(mode(policyFile)).toBe(0o444);
    expect(readdirSync(join(root, "policies", "managed"))).toEqual([
      "galactic-ca.json",
    ]);
    expect(readdirSync(nssCertificateDirectory)).toEqual([
      "ca-01.crt",
      "ca-02.crt",
    ]);
    expect(new X509Certificate(
      readFileSync(join(nssCertificateDirectory, "ca-01.crt")),
    ).raw.equals(new X509Certificate(rootCertificates[0]).raw)).toBe(true);
    expect(new X509Certificate(
      readFileSync(join(nssCertificateDirectory, "ca-02.crt")),
    ).raw.equals(new X509Certificate(rootCertificates[1]).raw)).toBe(true);
    expect(mode(nssCertificateDirectory)).toBe(0o700);
    expect(mode(join(nssCertificateDirectory, "ca-01.crt"))).toBe(0o400);
  });

  it("fails closed without replacing the last valid policy", () => {
    const root = temporaryRoot();
    const caFile = join(root, "cloudflare-ca.crt");
    const policyDirectory = join(root, "policies", "managed");
    const policyFile = join(policyDirectory, "galactic-ca.json");
    const previousPolicy = '{"CACertificates":["previous"]}\n';
    mkdirSync(policyDirectory, { recursive: true });
    writeFileSync(policyFile, previousPolicy);
    writeFileSync(
      caFile,
      "-----BEGIN CERTIFICATE-----\nnot-base64!\n-----END CERTIFICATE-----\n",
    );

    const result = runInstaller(caFile, policyFile);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("malformed base64 certificate");
    expect(readFileSync(policyFile, "utf8")).toBe(previousPolicy);
  });

  it("rejects non-PEM content surrounding an otherwise valid CA", () => {
    const root = temporaryRoot();
    const caFile = join(root, "cloudflare-ca.crt");
    const policyFile = join(root, "policies", "managed", "galactic-ca.json");
    writeFileSync(caFile, `unexpected\n${rootCertificates[0]}\n`);

    const result = runInstaller(caFile, policyFile);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside a CERTIFICATE block");
    expect(() => statSync(policyFile)).toThrow();
  });
});
