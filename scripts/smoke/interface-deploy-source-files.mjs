import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// This smoke intentionally collects its own bundle instead of calling the CLI:
// it exists to catch client-side source drops. Keep the reviewed fixture's
// authored contract formats explicit here so both legacy manifest.json and
// current galactic.yaml releases reach gx.test byte-for-byte.
export const INTERFACE_DEPLOY_SOURCE_EXTENSIONS = Object.freeze([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".css",
  ".html",
  ".yaml",
  ".yml",
]);

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".galactic",
  ".ultralight",
  "dist",
  "build",
]);

export function collectInterfaceDeploySourceFiles(directory) {
  const allowed = new Set(INTERFACE_DEPLOY_SOURCE_EXTENSIONS);
  const files = [];

  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const fullPath = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) walk(fullPath);
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      const extension = lowerName.slice(lowerName.lastIndexOf("."));
      if (!allowed.has(extension)) continue;

      files.push({
        path: relative(directory, fullPath).split(/[\\/]/u).join("/"),
        content: readFileSync(fullPath, "utf8"),
      });
    }
  }

  walk(directory);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
