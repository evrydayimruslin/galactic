import { assertEquals, assertRejects } from 'https://deno.land/std@0.210.0/assert/mod.ts';
import type { StagedBundleAdmissionRequest } from './staged-bundles.ts';
import {
  cleanupExpiredStagedBundleStorage,
  createStagedBundleQuotaAdmission,
  releaseStagedBundleStorageReservation,
  reserveStagedBundleStorage,
  StagedBundleQuotaError,
} from './staged-bundle-quota.ts';

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const BUNDLE_ID = `gxb1_${'b'.repeat(64)}`;
const RETAINED_UNTIL = '2026-08-04T12:00:00.000Z';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';

function admissionRequest(): StagedBundleAdmissionRequest {
  return {
    ownerId: OWNER_ID,
    bundleId: BUNDLE_ID,
    objects: [
      { objectId: `blob:${'a'.repeat(64)}`, sizeBytes: 120 },
      { objectId: `manifest:${BUNDLE_ID}`, sizeBytes: 80 },
    ],
    retainedUntil: RETAINED_UNTIL,
  };
}

Deno.test('staged bundle quota reserves immutable objects through the service-role RPC', async () => {
  let calledUrl = '';
  let calledInit:
    | {
      method?: string;
      headers?: HeadersInit;
      body?: BodyInit | null;
    }
    | undefined;
  const result = await reserveStagedBundleStorage(admissionRequest(), {
    supabaseUrl: 'https://supabase.test/',
    serviceRoleKey: 'service-role',
    limitBytes: 1_000,
    limitObjects: 50,
    randomUUID: () => RESERVATION_ID,
    fetchFn: ((input, init) => {
      calledUrl = String(input);
      calledInit = init as typeof calledInit;
      return Promise.resolve(Response.json([{
        reservation_id: RESERVATION_ID,
        allowed: true,
        used_bytes: '300',
        reserved_bytes: '200',
        projected_bytes: '500',
        limit_bytes: '1000',
        remaining_bytes: '500',
        used_objects: '3',
        reserved_objects: '2',
        projected_objects: '5',
        limit_objects: '50',
        remaining_objects: '45',
        retained_until: RETAINED_UNTIL,
      }]));
    }) as typeof fetch,
  });

  assertEquals(
    calledUrl,
    'https://supabase.test/rest/v1/rpc/reserve_staged_bundle_storage',
  );
  assertEquals(calledInit?.method, 'POST');
  assertEquals(
    (calledInit?.headers as Record<string, string>).Authorization,
    'Bearer service-role',
  );
  assertEquals(JSON.parse(String(calledInit?.body)), {
    p_owner_id: OWNER_ID,
    p_reservation_id: RESERVATION_ID,
    p_objects: [
      { object_id: `blob:${'a'.repeat(64)}`, size_bytes: 120 },
      { object_id: `manifest:${BUNDLE_ID}`, size_bytes: 80 },
    ],
    p_retained_until: RETAINED_UNTIL,
    p_limit_bytes: 1_000,
    p_limit_objects: 50,
  });
  assertEquals(result, {
    reservationId: RESERVATION_ID,
    allowed: true,
    usedBytes: 300,
    reservedBytes: 200,
    projectedBytes: 500,
    limitBytes: 1_000,
    remainingBytes: 500,
    usedObjects: 3,
    reservedObjects: 2,
    projectedObjects: 5,
    limitObjects: 50,
    remainingObjects: 45,
    retainedUntil: RETAINED_UNTIL,
  });
});

Deno.test('staged bundle quota admission rejects an atomic over-quota decision', async () => {
  const admit = createStagedBundleQuotaAdmission({
    supabaseUrl: 'https://supabase.test',
    serviceRoleKey: 'service-role',
    limitBytes: 1_000,
    limitObjects: 10_000,
    randomUUID: () => RESERVATION_ID,
    fetchFn: (() =>
      Promise.resolve(Response.json([{
        reservation_id: RESERVATION_ID,
        allowed: false,
        used_bytes: 950,
        reserved_bytes: 200,
        projected_bytes: 1150,
        limit_bytes: 1000,
        remaining_bytes: 50,
        used_objects: 9_999,
        reserved_objects: 2,
        projected_objects: 10_001,
        limit_objects: 10_000,
        remaining_objects: 1,
        retained_until: RETAINED_UNTIL,
      }]))) as typeof fetch,
  });

  const error = await assertRejects(
    () => admit(admissionRequest()),
    StagedBundleQuotaError,
    'quota exceeded',
  );
  assertEquals(error.code, 'quota_exceeded');
  assertEquals(error.result?.projectedBytes, 1_150);
  assertEquals(error.result?.projectedObjects, 10_001);
});

Deno.test('staged bundle quota release is scoped to the exact reservation token', async () => {
  let calledUrl = '';
  let calledBody: Record<string, unknown> | undefined;
  const released = await releaseStagedBundleStorageReservation({
    ownerId: OWNER_ID,
    reservationId: RESERVATION_ID,
  }, {
    supabaseUrl: 'https://supabase.test/',
    serviceRoleKey: 'service-role',
    fetchFn: ((input, init) => {
      calledUrl = String(input);
      calledBody = JSON.parse(String(init?.body));
      return Promise.resolve(Response.json(2));
    }) as typeof fetch,
  });

  assertEquals(released, 2);
  assertEquals(
    calledUrl,
    'https://supabase.test/rest/v1/rpc/release_staged_bundle_storage_reservation',
  );
  assertEquals(calledBody, {
    p_owner_id: OWNER_ID,
    p_reservation_id: RESERVATION_ID,
  });
});

Deno.test('quota admission returns a compensating release for its own token', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const admit = createStagedBundleQuotaAdmission({
    supabaseUrl: 'https://supabase.test',
    serviceRoleKey: 'service-role',
    limitBytes: 1_000,
    limitObjects: 50,
    randomUUID: () => RESERVATION_ID,
    fetchFn: ((input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      if (url.endsWith('/reserve_staged_bundle_storage')) {
        return Promise.resolve(Response.json([{
          reservation_id: RESERVATION_ID,
          allowed: true,
          used_bytes: 0,
          reserved_bytes: 200,
          projected_bytes: 200,
          limit_bytes: 1_000,
          remaining_bytes: 800,
          used_objects: 0,
          reserved_objects: 2,
          projected_objects: 2,
          limit_objects: 50,
          remaining_objects: 48,
          retained_until: RETAINED_UNTIL,
        }]));
      }
      return Promise.resolve(Response.json(2));
    }) as typeof fetch,
  });

  const reservation = await admit(admissionRequest());
  if (!reservation) throw new Error('admission did not return a reservation');
  await reservation.release();

  assertEquals(calls.length, 2);
  assertEquals(calls[1].body, {
    p_owner_id: OWNER_ID,
    p_reservation_id: RESERVATION_ID,
  });
});

Deno.test('staged bundle quota fails closed when storage admission is unavailable', async () => {
  const error = await assertRejects(
    () =>
      reserveStagedBundleStorage(admissionRequest(), {
        supabaseUrl: 'https://supabase.test',
        serviceRoleKey: 'service-role',
        randomUUID: () => RESERVATION_ID,
        fetchFn: (() =>
          Promise.resolve(
            new Response('database unavailable', { status: 503 }),
          )) as typeof fetch,
      }),
    StagedBundleQuotaError,
    'temporarily unavailable',
  );
  assertEquals(error.code, 'service_unavailable');
  assertEquals(error.message.includes('database unavailable'), false);
});

Deno.test('staged bundle quota rejects duplicate objects before the RPC', async () => {
  const request = admissionRequest();
  request.objects.push({ ...request.objects[0] });
  let called = false;

  const error = await assertRejects(
    () =>
      reserveStagedBundleStorage(request, {
        supabaseUrl: 'https://supabase.test',
        serviceRoleKey: 'service-role',
        randomUUID: () => RESERVATION_ID,
        fetchFn: (() => {
          called = true;
          return Promise.resolve(Response.json([]));
        }) as typeof fetch,
      }),
    StagedBundleQuotaError,
    'unique immutable IDs',
  );
  assertEquals(error.code, 'invalid_request');
  assertEquals(called, false);
});

Deno.test('staged bundle quota fails closed on an inconsistent RPC decision', async () => {
  const error = await assertRejects(
    () =>
      reserveStagedBundleStorage(admissionRequest(), {
        supabaseUrl: 'https://supabase.test',
        serviceRoleKey: 'service-role',
        limitBytes: 1_000,
        limitObjects: 50,
        randomUUID: () => RESERVATION_ID,
        fetchFn: (() =>
          Promise.resolve(Response.json([{
            reservation_id: RESERVATION_ID,
            allowed: true,
            used_bytes: 950,
            reserved_bytes: 200,
            projected_bytes: 1_150,
            limit_bytes: 1_000,
            remaining_bytes: 0,
            used_objects: 3,
            reserved_objects: 2,
            projected_objects: 5,
            limit_objects: 50,
            remaining_objects: 45,
            retained_until: RETAINED_UNTIL,
          }]))) as typeof fetch,
      }),
    StagedBundleQuotaError,
    'inconsistent admission decision',
  );
  assertEquals(error.code, 'invalid_response');
});

Deno.test('staged bundle quota cleanup drains bounded RPC batches', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const deletionCounts = [3, 1];
  const result = await cleanupExpiredStagedBundleStorage({
    supabaseUrl: 'https://supabase.test/',
    serviceRoleKey: 'service-role',
    now: new Date('2026-08-05T00:00:00.000Z'),
    batchSize: 3,
    maxBatches: 4,
    fetchFn: ((input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return Promise.resolve(Response.json(deletionCounts.shift()));
    }) as typeof fetch,
  });

  assertEquals(result, {
    releasedClaims: 4,
    batches: 2,
    complete: true,
  });
  assertEquals(calls, [
    {
      url: 'https://supabase.test/rest/v1/rpc/cleanup_staged_bundle_storage_reservations',
      body: {
        p_cutoff: '2026-08-05T00:00:00.000Z',
        p_limit: 3,
      },
    },
    {
      url: 'https://supabase.test/rest/v1/rpc/cleanup_staged_bundle_storage_reservations',
      body: {
        p_cutoff: '2026-08-05T00:00:00.000Z',
        p_limit: 3,
      },
    },
  ]);
});

Deno.test('staged bundle quota cleanup reports when its bounded pass has more work', async () => {
  let calls = 0;
  const result = await cleanupExpiredStagedBundleStorage({
    supabaseUrl: 'https://supabase.test',
    serviceRoleKey: 'service-role',
    batchSize: 2,
    maxBatches: 2,
    fetchFn: (() => {
      calls += 1;
      return Promise.resolve(Response.json(2));
    }) as typeof fetch,
  });

  assertEquals(result, {
    releasedClaims: 4,
    batches: 2,
    complete: false,
  });
  assertEquals(calls, 2);
});
