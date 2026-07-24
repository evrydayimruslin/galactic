#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_COMPUTE_BINDINGS = new Set([
  "services:binding:COMPUTE_PLANE",
  "env.staging.services:binding:COMPUTE_PLANE",
]);

function tableName(block) {
  return block.match(/^\s*\[\[([^\]]+)\]\]/u)?.[1] ?? null;
}

function quotedField(block, field) {
  const pattern = new RegExp(
    `^\\s*${field}\\s*=\\s*["']([^"']+)["']\\s*$`,
    "mu",
  );
  return block.match(pattern)?.[1] ?? null;
}

function computeBindingSignature(block) {
  const table = tableName(block);
  if (!table) return null;

  const binding = quotedField(block, "binding");
  if (
    (table === "services" || table === "env.staging.services") &&
    binding === "COMPUTE_PLANE"
  ) {
    return `${table}:binding:${binding}`;
  }
  return null;
}

export function computeDisabledApiConfig(source) {
  const lines = source.split(/(?<=\n)/u);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line) && current.length > 0) {
      blocks.push(current.join(""));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join(""));

  const removed = [];
  const output = blocks.filter((block) => {
    const signature = computeBindingSignature(block);
    if (!signature) return true;
    removed.push(signature);
    return false;
  }).join("");

  const actual = new Set(removed);
  const missing = [...EXPECTED_COMPUTE_BINDINGS].filter(
    (signature) => !actual.has(signature),
  );
  const unexpected = [...actual].filter(
    (signature) => !EXPECTED_COMPUTE_BINDINGS.has(signature),
  );
  if (
    removed.length !== EXPECTED_COMPUTE_BINDINGS.size ||
    actual.size !== removed.length ||
    missing.length > 0 ||
    unexpected.length > 0
  ) {
    throw new Error(
      `Expected exactly the reviewed Compute-only bindings; ` +
        `removed=${JSON.stringify(removed)}, missing=${JSON.stringify(missing)}, ` +
        `unexpected=${JSON.stringify(unexpected)}`,
    );
  }

  if (/^\s*binding\s*=\s*["']COMPUTE_PLANE["']\s*$/mu.test(output)) {
    throw new Error(
      "A Compute Plane binding remained in the disabled API configuration.",
    );
  }
  return output;
}

function main(argv) {
  if (argv.length !== 2) {
    throw new Error(
      "Usage: write-api-compute-disabled-config.mjs <source> <destination>",
    );
  }
  const sourcePath = resolve(argv[0]);
  const destinationPath = resolve(argv[1]);
  if (sourcePath === destinationPath) {
    throw new Error("Source and destination must be different files.");
  }
  const output = computeDisabledApiConfig(
    readFileSync(sourcePath, "utf8"),
  );
  writeFileSync(destinationPath, output);
  console.log(
    `Wrote Compute-disabled API configuration to ${destinationPath}.`,
  );
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
