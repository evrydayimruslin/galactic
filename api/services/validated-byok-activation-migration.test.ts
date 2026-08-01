function assertIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`expected validated BYOK migration to include ${expected}`);
  }
}

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260801010000_validated_byok_activation_gate.sql",
    import.meta.url,
  ),
);

Deno.test("validated BYOK migration persists key and proof in one locked transaction", () => {
  assertIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.save_validated_launch_byok_provider",
  );
  assertIncludes(migration, "FOR UPDATE;");
  assertIncludes(migration, "'validation', p_validation");
  assertIncludes(migration, "byok_enabled = true");
  assertIncludes(
    migration,
    "p_validation->>'policy_version' <> 'launch-byok-v1'",
  );
});

Deno.test("validated BYOK migration gates only new setup-required activation", () => {
  assertIncludes(
    migration,
    "OLD.deployment_state IS DISTINCT FROM 'setup_required'",
  );
  assertIncludes(
    migration,
    "NEW.deployment_state IS DISTINCT FROM 'ready'",
  );
  assertIncludes(migration, "'inference.generate'");
  assertIncludes(migration, "'inference.embed'");
  assertIncludes(migration, "v_validation->'operations' ? 'generate'");
  assertIncludes(migration, "v_validation->'operations' ? 'embed'");
  assertIncludes(migration, "v_user.byok_provider <> 'openrouter'");
});

Deno.test("validated BYOK persistence authority remains service-role only", () => {
  assertIncludes(
    migration,
    ") FROM PUBLIC, anon, authenticated, service_role;",
  );
  assertIncludes(
    migration,
    ") TO service_role;",
  );
  if (/TO authenticated\s*;/u.test(migration)) {
    throw new Error("validated BYOK authority must not be granted to browsers");
  }
});
