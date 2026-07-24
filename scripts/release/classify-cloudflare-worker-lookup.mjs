#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function classifyCloudflareWorkerLookup(httpStatus, payload) {
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    throw new Error("Cloudflare Worker lookup returned an invalid HTTP status.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Cloudflare Worker lookup returned malformed JSON.");
  }
  if (
    typeof payload.success !== "boolean" ||
    !Array.isArray(payload.errors) ||
    !Object.hasOwn(payload, "result")
  ) {
    throw new Error("Cloudflare Worker lookup returned malformed JSON.");
  }
  const errors = payload.errors;
  const deployments = payload.result?.deployments;
  if (
    httpStatus >= 200 &&
    httpStatus < 300 &&
    payload.success === true &&
    errors.length === 0 &&
    payload.result &&
    typeof payload.result === "object" &&
    !Array.isArray(payload.result) &&
    Array.isArray(deployments) &&
    deployments.length > 0 &&
    deployments.every((deployment) =>
      deployment &&
      typeof deployment === "object" &&
      !Array.isArray(deployment) &&
      Array.isArray(deployment.versions) &&
      deployment.versions.length > 0
    )
  ) {
    return "bound";
  }

  if (
    httpStatus === 404 &&
    payload.success === false &&
    errors.length === 1 &&
    errors[0] &&
    typeof errors[0] === "object" &&
    errors[0].code === 10007 &&
    payload.result === null
  ) {
    return "bootstrap";
  }

  const codes = errors.map((error) =>
    error && typeof error === "object" ? error.code : null
  );
  throw new Error(
    `Cloudflare Worker lookup failed closed (HTTP ${httpStatus}, ` +
      `success=${String(payload.success)}, errors=${JSON.stringify(codes)}).`,
  );
}

function main(argv) {
  if (argv.length !== 2) {
    throw new Error(
      "Usage: classify-cloudflare-worker-lookup.mjs <http-status> <json-file>",
    );
  }
  const httpStatus = Number(argv[0]);
  let payload;
  try {
    payload = JSON.parse(readFileSync(resolve(argv[1]), "utf8"));
  } catch {
    throw new Error("Cloudflare Worker lookup returned malformed JSON.");
  }
  console.log(classifyCloudflareWorkerLookup(httpStatus, payload));
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
