#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_PATH_PREFIX = "supabase/migrations/";

export async function buildMigrationManifest(repoRoot) {
  const root = resolve(repoRoot);
  const migrationsDirectory = resolve(root, "supabase/migrations");
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

  if (names.length === 0) {
    throw new Error("No Supabase SQL migrations were found.");
  }

  const lines = [];
  for (const name of names) {
    if (!/^[0-9A-Za-z._-]+\.sql$/u.test(name)) {
      throw new Error(`Unsafe migration filename: ${name}`);
    }
    const absolutePath = resolve(migrationsDirectory, name);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Migration must be a regular file: ${name}`);
    }
    const digest = createHash("sha256")
      .update(await readFile(absolutePath))
      .digest("hex");
    lines.push(`${digest}  ${MANIFEST_PATH_PREFIX}${name}`);
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const repoRoot = process.argv[2];
  const outputPath = process.argv[3];
  if (!repoRoot) {
    throw new Error("Usage: hash-migrations.mjs <repo-root> [output-file]");
  }
  const manifest = await buildMigrationManifest(repoRoot);
  if (outputPath) {
    await writeFile(outputPath, manifest, { encoding: "utf8", flag: "wx" });
  } else {
    process.stdout.write(manifest);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
