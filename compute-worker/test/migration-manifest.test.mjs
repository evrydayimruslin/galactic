import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMigrationManifest } from "../scripts/hash-migrations.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

describe("Compute migration release manifest", () => {
  it("hashes every SQL migration in deterministic filename order", async () => {
    const root = await mkdtemp(join(tmpdir(), "galactic-migrations-"));
    try {
      const directory = join(root, "supabase", "migrations");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "002_second.sql"), "select 2;\n");
      await writeFile(join(directory, "001_first.sql"), "select 1;\n");
      await writeFile(join(directory, "README.md"), "ignored\n");

      await expect(buildMigrationManifest(root)).resolves.toBe(
        `${sha256("select 1;\n")}  supabase/migrations/001_first.sql\n` +
          `${sha256("select 2;\n")}  supabase/migrations/002_second.sql\n`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("covers the conservation and execution-recovery migrations", async () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const manifest = await buildMigrationManifest(repoRoot);
    expect(manifest).toContain(
      "  supabase/migrations/20260720124500_compute_capacity_conservation.sql\n",
    );
    expect(manifest).toContain(
      "  supabase/migrations/20260720125000_compute_execution_recovery.sql\n",
    );
    const paths = manifest.trimEnd().split("\n").map((line) => line.slice(66));
    expect(paths).toEqual([...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
  });
});
