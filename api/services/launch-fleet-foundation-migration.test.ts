import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const attributionMigration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260717140000_agent_notification_attribution.sql",
    import.meta.url,
  ),
);

const fleetMigration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260717141000_launch_fleet_snapshot.sql",
    import.meta.url,
  ),
);

Deno.test("Agent notification attribution migration is additive and nullable", () => {
  assertStringIncludes(
    attributionMigration,
    "ADD COLUMN IF NOT EXISTS agent_id uuid;",
  );
  assertEquals(
    /agent_id\s+uuid\s+NOT\s+NULL/i.test(attributionMigration),
    false,
    "historical or deleted Agents must not make the rollout fail",
  );
  assertEquals(
    /DROP\s+(?:COLUMN|TABLE)|ALTER\s+COLUMN\s+agent_id\s+SET\s+NOT\s+NULL/i
      .test(attributionMigration),
    false,
    "the attribution rollout must remain additive",
  );
});

Deno.test("Agent notification attribution safely backfills app and routine alerts", () => {
  assertStringIncludes(
    attributionMigration,
    "WHERE notifications.agent_id IS NULL",
  );
  assertStringIncludes(
    attributionMigration,
    "notifications.entity_type = 'app'",
  );
  assertStringIncludes(
    attributionMigration,
    "notifications.entity_id = apps.id::text",
  );
  assertStringIncludes(
    attributionMigration,
    "notifications.user_id = apps.owner_id",
  );
  assertStringIncludes(
    attributionMigration,
    "notifications.entity_type = 'routine'",
  );
  assertStringIncludes(
    attributionMigration,
    "notifications.entity_id = routines.id::text",
  );
  assertStringIncludes(
    attributionMigration,
    "notifications.user_id = routines.user_id",
  );
  assertStringIncludes(
    attributionMigration,
    "routines.composer_app_id IS NOT NULL",
  );
  assertStringIncludes(
    attributionMigration,
    "apps.owner_id = notifications.user_id",
  );
});

Deno.test("Agent notification attribution keeps referential history and indexed owner filters", () => {
  assertStringIncludes(
    attributionMigration,
    "FOREIGN KEY (agent_id) REFERENCES public.apps(id)\n      ON DELETE SET NULL NOT VALID",
  );
  assertStringIncludes(
    attributionMigration,
    "VALIDATE CONSTRAINT user_notifications_agent_id_fkey",
  );
  assertStringIncludes(
    attributionMigration,
    "WHERE conrelid = 'public.user_notifications'::regclass",
  );
  assertStringIncludes(
    attributionMigration,
    "conname = 'user_notifications_agent_id_fkey'",
  );
  assertStringIncludes(
    attributionMigration,
    "CREATE INDEX IF NOT EXISTS idx_user_notifications_user_agent_created",
  );
  assertStringIncludes(
    attributionMigration,
    "ON public.user_notifications (user_id, agent_id, created_at DESC)",
  );
  assertStringIncludes(
    attributionMigration,
    "CREATE INDEX IF NOT EXISTS idx_user_notifications_user_agent_unread",
  );
  assertStringIncludes(
    attributionMigration,
    "WHERE agent_id IS NOT NULL AND read_at IS NULL",
  );
});

Deno.test("Fleet snapshot RPC is private-owner scoped and service-role only", () => {
  assertStringIncludes(
    fleetMigration,
    "CREATE OR REPLACE FUNCTION public.get_launch_fleet_snapshot(\n  p_user_id uuid",
  );
  assertStringIncludes(fleetMigration, "STABLE\nSECURITY DEFINER");
  assertStringIncludes(fleetMigration, "SET search_path = public");
  assertStringIncludes(fleetMigration, "apps.owner_id = p_user_id");
  assertStringIncludes(fleetMigration, "apps.visibility = 'private'");
  assertStringIncludes(fleetMigration, "apps.deleted_at IS NULL");
  assertStringIncludes(fleetMigration, "routines.user_id = p_user_id");
  assertStringIncludes(fleetMigration, "runs.user_id = p_user_id");
  assertStringIncludes(fleetMigration, "notifications.user_id = p_user_id");
  assertStringIncludes(
    fleetMigration,
    "routines.metadata->>'launch_managed' = 'true'",
  );
  assertStringIncludes(
    fleetMigration,
    "routines.metadata->>'launch_primary' = 'true'",
  );
  assertEquals(
    fleetMigration.includes("routines.metadata->>'source' = 'ul.routine'"),
    false,
    "source metadata alone must not elevate an unrelated routine into Agent Home",
  );

  const revoke = fleetMigration.indexOf(
    "REVOKE ALL ON FUNCTION public.get_launch_fleet_snapshot(uuid)",
  );
  const grant = fleetMigration.indexOf(
    "GRANT EXECUTE ON FUNCTION public.get_launch_fleet_snapshot(uuid)",
  );
  assert(revoke >= 0 && grant > revoke, "RPC must revoke before granting");
  assertStringIncludes(
    fleetMigration,
    "FROM PUBLIC, anon, authenticated;",
  );
  assertStringIncludes(fleetMigration, "TO service_role;");
  assertEquals(
    /GRANT\s+EXECUTE[\s\S]*?TO\s+(?:PUBLIC|anon|authenticated)/i.test(
      fleetMigration,
    ),
    false,
    "browser roles must never execute the SECURITY DEFINER projection",
  );
});

Deno.test("Fleet snapshot guards the only text-to-UUID cast exactly", () => {
  const casts = fleetMigration.match(/notifications\.entity_id::uuid/g) ?? [];
  assertEquals(casts.length, 1, "all text-to-UUID casts must stay auditable");
  assertStringIncludes(
    fleetMigration,
    "notifications.entity_type = 'routine'",
  );
  assertStringIncludes(
    fleetMigration,
    "notifications.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'",
  );

  const guard = fleetMigration.indexOf("notifications.entity_id ~*");
  const cast = fleetMigration.indexOf("notifications.entity_id::uuid");
  const caseStart = fleetMigration.lastIndexOf("CASE", guard);
  const caseEnd = fleetMigration.indexOf("END", cast);
  assert(
    caseStart >= 0 && guard > caseStart && cast > guard && caseEnd > cast,
    "the anchored UUID guard and cast must remain in the same CASE expression",
  );
});

Deno.test("Fleet snapshot returns deterministic, bounded recent activity", () => {
  assertStringIncludes(
    fleetMigration,
    "row_number() OVER (\n      PARTITION BY activity_candidates.agent_id",
  );
  assertStringIncludes(
    fleetMigration,
    "ORDER BY activity_candidates.created_at DESC, activity_candidates.id DESC",
  );
  assertStringIncludes(fleetMigration, "WHERE ranked_activity.position <= 3");
  assertStringIncludes(
    fleetMigration,
    "ORDER BY ranked_activity.created_at DESC, ranked_activity.id DESC",
  );
  assertEquals(
    /position\s*<=\s*(?:[4-9]|[1-9][0-9]+)/i.test(fleetMigration),
    false,
    "compact cards must never widen their activity payload beyond three rows",
  );
  assertStringIncludes(
    fleetMigration,
    "owned_agents.created_at AS agent_created_at",
  );
  assertStringIncludes(
    fleetMigration,
    "ORDER BY routine_totals.agent_created_at, routine_totals.agent_id",
  );
  assertEquals(
    (fleetMigration.match(/CROSS JOIN LATERAL/g) ?? []).length,
    2,
    "runs and alerts must each be pre-bounded per Agent",
  );
  assertEquals(
    (fleetMigration.match(/LIMIT 3/g) ?? []).length,
    2,
    "each activity source must contribute at most three candidates per Agent",
  );
});

Deno.test("Fleet snapshot batches true Agent capacity without exposing raw Light", () => {
  const returnStart = fleetMigration.indexOf("RETURNS TABLE (");
  const returnEnd = fleetMigration.indexOf(")\nLANGUAGE sql", returnStart);
  const signature = fleetMigration.slice(returnStart, returnEnd);
  for (
    const field of [
      "capacity_state text",
      "capacity_burst_state text",
      "capacity_weekly_state text",
      "capacity_burst_resets_at timestamp with time zone",
      "capacity_weekly_resets_at timestamp with time zone",
      "capacity_next_eligible_at timestamp with time zone",
      "capacity_cap_basis_points integer",
      "capacity_burst_used_percent double precision",
      "capacity_weekly_used_percent double precision",
    ]
  ) {
    assertStringIncludes(signature, field);
  }
  assertEquals(
    /light/i.test(signature),
    false,
    "Fleet RPC must never return private raw-Light limits or usage",
  );
  assertStringIncludes(fleetMigration, "CROSS JOIN account_capacity");
  assertStringIncludes(
    fleetMigration,
    "LEFT JOIN public.agent_capacity_policies AS policies",
  );
  assertStringIncludes(
    fleetMigration,
    "LEFT JOIN public.agent_capacity_windows AS agent_burst",
  );
  assertStringIncludes(
    fleetMigration,
    "LEFT JOIN public.agent_capacity_windows AS agent_weekly",
  );
});

Deno.test("Fleet capacity keeps Free qualitative and paid percentages truthful", () => {
  assertStringIncludes(
    fleetMigration,
    "CASE WHEN plan_code = 'free' THEN NULL ELSE cap_basis_points END",
  );
  assertStringIncludes(
    fleetMigration,
    "CASE WHEN plan_code = 'free' THEN NULL\n      ELSE agent_burst_used * 100.0 / nullif(burst_limit_light, 0) END",
  );
  assertStringIncludes(
    fleetMigration,
    "CASE WHEN plan_code = 'free' THEN NULL\n      ELSE agent_weekly_used * 100.0 / nullif(weekly_limit_light, 0) END",
  );
  assertStringIncludes(
    fleetMigration,
    "account_burst_used >= burst_limit_light",
  );
  assertStringIncludes(
    fleetMigration,
    "agent_burst_used >=\n          burst_limit_light * cap_basis_points / 10000.0",
  );
});

Deno.test("Fleet capacity excludes expired holds even before the reaper runs", () => {
  assertStringIncludes(
    fleetMigration,
    "reservations.status = 'reserved'",
  );
  assertStringIncludes(fleetMigration, "reservations.expires_at > now()");
  assertEquals(
    fleetMigration.includes(
      "burst_window.used_light + burst_window.reserved_light",
    ),
    false,
  );
  assertEquals(
    fleetMigration.includes(
      "agent_burst.used_light + agent_burst.reserved_light",
    ),
    false,
  );
});
