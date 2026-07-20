function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`expected SQL to include ${expected}`);
  }
}

function assert(condition: unknown, message = "assertion failed"): void {
  if (!condition) throw new Error(message);
}

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260720123000_owned_app_soft_delete.sql",
    import.meta.url,
  ),
);

Deno.test("owned app deletion rechecks ownership under one row lock", () => {
  assertStringIncludes(migration, "app.owner_id = p_user_id");
  assertStringIncludes(migration, "app.deleted_at IS NULL");
  assertStringIncludes(migration, "FOR UPDATE");
  assertStringIncludes(
    migration,
    "SET deleted_at = COALESCE(p_deleted_at, now())",
  );
  assertStringIncludes(migration, "storage_bytes = 0");
  assertStringIncludes(migration, "owner.storage_used_bytes");
  assertStringIncludes(migration, "RETURN QUERY SELECT false, 0::bigint");
});

Deno.test("owned app deletion fails fast instead of inverting user-delete locks", () => {
  const appLock = migration.indexOf("FOR UPDATE;");
  const ownerLookup = migration.indexOf("FROM public.users AS owner");
  const ownerLock = migration.indexOf(
    "FOR NO KEY UPDATE NOWAIT",
    ownerLookup,
  );
  const appMutation = migration.indexOf("UPDATE public.apps AS app");
  assert(
    appLock < ownerLookup && ownerLookup < ownerLock && ownerLock < appMutation,
    "soft deletion must lock app then fail-fast on the owner before mutation",
  );
  assertStringIncludes(migration, "EXCEPTION WHEN lock_not_available");
  assertStringIncludes(migration, "ERRCODE = '40001'");
});

Deno.test("owned app deletion remains compatible with Compute owner key-share locks", () => {
  assertStringIncludes(migration, "FOR NO KEY UPDATE NOWAIT");
  if (
    migration.includes(
      "FROM public.users AS owner\n    WHERE owner.id = p_user_id\n    FOR UPDATE",
    )
  ) {
    throw new Error(
      "owner storage mutation must not take a key-changing row lock",
    );
  }
});

Deno.test("owned app deletion RPC is service-role-only", () => {
  assertStringIncludes(
    migration,
    "FROM PUBLIC, anon, authenticated, service_role",
  );
  assertStringIncludes(
    migration,
    "TO service_role",
  );
});
