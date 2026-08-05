#!/usr/bin/env node

import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

const MAX_CA_FILE_BYTES = 1024 * 1024;
const MAX_CA_CERTIFICATES = 32;
const CERTIFICATE_PATTERN =
  /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/gu;

function fail(message) {
  throw new Error(message);
}

function readCertificates(caFile) {
  const size = statSync(caFile).size;
  if (size === 0 || size > MAX_CA_FILE_BYTES) {
    fail(`CA bundle size must be between 1 and ${MAX_CA_FILE_BYTES} bytes`);
  }

  const pem = readFileSync(caFile, "utf8");
  const certificates = [];
  const seen = new Set();
  let cursor = 0;
  let match;

  while ((match = CERTIFICATE_PATTERN.exec(pem)) !== null) {
    if (pem.slice(cursor, match.index).trim() !== "") {
      fail("CA bundle contains data outside a CERTIFICATE block");
    }
    cursor = CERTIFICATE_PATTERN.lastIndex;

    const encoded = match[1].replace(/[\t\n\r ]/gu, "");
    if (
      encoded.length === 0 ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
    ) {
      fail("CA bundle contains a malformed base64 certificate");
    }

    const der = Buffer.from(encoded, "base64");
    if (der.toString("base64") !== encoded) {
      fail("CA bundle contains non-canonical base64");
    }

    let certificate;
    try {
      certificate = new X509Certificate(der);
    } catch {
      fail("CA bundle contains an invalid X.509 certificate");
    }
    if (!certificate.ca) {
      fail("CA bundle contains a certificate that is not a CA");
    }

    const canonical = certificate.raw.toString("base64");
    if (!seen.has(canonical)) {
      seen.add(canonical);
      certificates.push(canonical);
      if (certificates.length > MAX_CA_CERTIFICATES) {
        fail(`CA bundle exceeds ${MAX_CA_CERTIFICATES} certificates`);
      }
    }
  }

  if (pem.slice(cursor).trim() !== "") {
    fail("CA bundle contains trailing data outside a CERTIFICATE block");
  }
  if (certificates.length === 0) {
    fail("CA bundle contains no certificates");
  }
  return certificates;
}

function writePolicy(policyFile, certificates) {
  if (!isAbsolute(policyFile)) {
    fail("Chrome policy path must be absolute");
  }

  const policyDirectory = dirname(policyFile);
  const previousUmask = process.umask(0o022);
  try {
    mkdirSync(policyDirectory, { recursive: true, mode: 0o755 });
  } finally {
    process.umask(previousUmask);
  }
  chmodSync(policyDirectory, 0o755);

  const temporaryDirectory = mkdtempSync(
    join(policyDirectory, ".galactic-ca-policy-"),
  );
  const temporaryFile = join(temporaryDirectory, basename(policyFile));
  try {
    writeFileSync(
      temporaryFile,
      `${JSON.stringify({ CACertificates: certificates }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    chmodSync(temporaryFile, 0o444);
    renameSync(temporaryFile, policyFile);
    chmodSync(policyFile, 0o444);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function writeNssCertificates(certificateDirectory, certificates) {
  if (!isAbsolute(certificateDirectory)) {
    fail("Chrome NSS certificate directory must be absolute");
  }
  const previousUmask = process.umask(0o077);
  try {
    mkdirSync(certificateDirectory, { recursive: true, mode: 0o700 });
  } finally {
    process.umask(previousUmask);
  }
  chmodSync(certificateDirectory, 0o700);
  if (readdirSync(certificateDirectory).length !== 0) {
    fail("Chrome NSS certificate directory must be empty");
  }
  certificates.forEach((certificate, index) => {
    const lines = certificate.match(/.{1,64}/gu);
    if (!lines) fail("Chrome NSS certificate encoding is empty");
    const certificateFile = join(
      certificateDirectory,
      `ca-${String(index + 1).padStart(2, "0")}.crt`,
    );
    writeFileSync(
      certificateFile,
      `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
      { encoding: "utf8", flag: "wx", mode: 0o400 },
    );
    chmodSync(certificateFile, 0o400);
  });
}

function main() {
  const [, , caFile, policyFile, nssCertificateDirectory] = process.argv;
  if (
    !caFile || !policyFile ||
    !(process.argv.length === 4 ||
      process.argv.length === 5 && nssCertificateDirectory)
  ) {
    fail(
      "usage: configure-chrome-ca-policy.mjs CA_FILE POLICY_FILE [NSS_CERTIFICATE_DIRECTORY]",
    );
  }
  const certificates = readCertificates(caFile);
  writePolicy(policyFile, certificates);
  if (nssCertificateDirectory) {
    writeNssCertificates(nssCertificateDirectory, certificates);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Chrome CA trust configuration failed: ${message}`);
  process.exitCode = 1;
}
