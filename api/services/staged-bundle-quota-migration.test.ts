import { assert, assertFalse, assertStringIncludes } from 'jsr:@std/assert';

const migration = await Deno.readTextFile(
  new URL(
    '../../supabase/migrations/20260727120000_staged_bundle_storage_quota.sql',
    import.meta.url,
  ),
);

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`missing SQL function: ${name}`);
  const next = migration.indexOf(
    '\nCREATE OR REPLACE FUNCTION public.',
    start + 1,
  );
  return migration.slice(start, next < 0 ? migration.length : next);
}

Deno.test('staged bundle quota stores unique objects and reservation claims', () => {
  assertStringIncludes(
    migration,
    'CREATE TABLE public.staged_bundle_storage_objects',
  );
  assertStringIncludes(migration, 'PRIMARY KEY (owner_id, object_id)');
  assertStringIncludes(
    migration,
    'CREATE TABLE public.staged_bundle_storage_reservations',
  );
  assertStringIncludes(
    migration,
    'PRIMARY KEY (owner_id, reservation_id, object_id)',
  );
  assertStringIncludes(
    migration,
    'manifest:gxb1_[0-9a-f]{64}',
  );
  assertStringIncludes(
    migration,
    'ALTER TABLE public.staged_bundle_storage_objects ENABLE ROW LEVEL SECURITY',
  );
  assertStringIncludes(
    migration,
    'staged_bundle_storage_reservations_expiry_idx',
  );
});

Deno.test('staged bundle quota serializes owner admission and discards expired leases', () => {
  const reserve = functionBody('reserve_staged_bundle_storage');
  const ownerLock = reserve.indexOf('FOR NO KEY UPDATE');
  const expiryDelete = reserve.indexOf(
    'DELETE FROM public.staged_bundle_storage_reservations',
  );
  const usageRead = reserve.indexOf(
    'SELECT COALESCE(sum(stored.size_bytes), 0)',
  );

  assert(ownerLock >= 0, 'owner admission must take a distributed row lock');
  assert(
    ownerLock < expiryDelete && expiryDelete < usageRead,
    'owner lock and expiry cleanup must precede quota projection',
  );
  assertStringIncludes(reserve, 'reservation.retained_until <= v_now');
  assertStringIncludes(reserve, "p_retained_until > v_now + interval '9 days'");
});

Deno.test('staged bundle quota projects new objects and claims every reused object', () => {
  const reserve = functionBody('reserve_staged_bundle_storage');
  assertStringIncludes(reserve, 'stored.object_id = requested.object_id');
  assertStringIncludes(reserve, 'stored.object_id IS NULL');
  assertStringIncludes(
    reserve,
    'v_projected_bytes := v_used_bytes + v_reserved_bytes',
  );
  assertStringIncludes(
    reserve,
    'v_projected_objects := v_used_objects + v_reserved_objects',
  );
  assertStringIncludes(reserve, 'OR v_projected_objects > p_limit_objects');
  assertStringIncludes(reserve, 'ON CONFLICT (owner_id, object_id) DO UPDATE');
  assertStringIncludes(
    reserve,
    'INSERT INTO public.staged_bundle_storage_reservations',
  );
  assertStringIncludes(
    reserve,
    'ON CONFLICT (owner_id, reservation_id, object_id) DO UPDATE',
  );
  assertStringIncludes(
    reserve,
    'GREATEST(\n        reservation.retained_until,\n        EXCLUDED.retained_until',
  );

  const denial = reserve.indexOf(
    'IF v_projected_bytes > p_limit_bytes',
  );
  const mutation = reserve.indexOf(
    'INSERT INTO public.staged_bundle_storage_objects',
  );
  assert(
    denial >= 0 && denial < mutation,
    'quota denial must happen before any lease mutation',
  );
});

Deno.test('staged bundle quota release removes only one reservation claim', () => {
  const release = functionBody(
    'release_staged_bundle_storage_reservation',
  );
  assertStringIncludes(release, 'FOR NO KEY UPDATE');
  assertStringIncludes(
    release,
    'reservation.reservation_id = p_reservation_id',
  );
  assertStringIncludes(
    release,
    'DELETE FROM public.staged_bundle_storage_reservations',
  );
  assertStringIncludes(
    release,
    'NOT EXISTS (\n      SELECT 1\n      FROM public.staged_bundle_storage_reservations',
  );
  assertFalse(
    release.includes('stored.object_id = ANY'),
    'release must not delete a caller-provided set of shared object IDs',
  );
});

Deno.test('staged bundle quota mutation is service-role only', () => {
  assertStringIncludes(
    migration,
    'FROM PUBLIC, anon, authenticated, service_role',
  );
  assertStringIncludes(
    migration,
    'uuid, uuid, jsonb, timestamptz, bigint, integer',
  );
  assertStringIncludes(migration, 'uuid, uuid');
  assertStringIncludes(migration, 'timestamptz, integer');
  assertStringIncludes(
    migration,
    'TO service_role',
  );
  assertFalse(migration.includes('TO anon;'));
  assertFalse(migration.includes('TO authenticated;'));
});

Deno.test('staged bundle quota has bounded concurrent expiry cleanup', () => {
  const cleanup = functionBody('cleanup_staged_bundle_storage_reservations');
  assertStringIncludes(cleanup, 'p_limit NOT BETWEEN 1 AND 50000');
  assertStringIncludes(cleanup, 'ORDER BY\n      reservation.retained_until');
  assertStringIncludes(cleanup, 'LIMIT p_limit');
  assertStringIncludes(cleanup, 'FOR UPDATE SKIP LOCKED');
  assertStringIncludes(cleanup, 'FOR NO KEY UPDATE');
  assertStringIncludes(
    cleanup,
    'DELETE FROM public.staged_bundle_storage_reservations',
  );
  assertStringIncludes(cleanup, 'stored.owner_id = ANY(v_owner_ids)');
});
