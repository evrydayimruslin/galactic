function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`expected SQL to include ${expected}`);
  }
}

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260730130000_membership_deployment_enforcement.sql",
    import.meta.url,
  ),
);

function policyBody(name: string): string {
  const marker = `CREATE POLICY ${name}`;
  const start = migration.indexOf(marker);
  if (start < 0) throw new Error(`missing SQL policy: ${name}`);

  const end = migration.indexOf(";", start);
  if (end < 0) throw new Error(`unterminated SQL policy: ${name}`);

  return migration.slice(start, end + 1).replace(/\s+/g, " ").trim();
}

Deno.test("membership deployment app reads exclude soft-deleted rows", () => {
  const owner = policyBody("apps_owner_select");
  assertStringIncludes(
    owner,
    "auth.uid() = owner_id AND deleted_at IS NULL",
  );

  const publicRead = policyBody("apps_public_select");
  assertStringIncludes(
    publicRead,
    "visibility = 'public' AND deleted_at IS NULL",
  );
});
