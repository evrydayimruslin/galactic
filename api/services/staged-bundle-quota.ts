import { getEnv } from '../lib/env.ts';
import { COMBINED_FREE_TIER_BYTES } from '../../shared/types/index.ts';
import type {
  StagedBundleAdmission,
  StagedBundleAdmissionRequest,
  StagedBundleAdmissionReservation,
} from './staged-bundles.ts';

export const DEFAULT_STAGED_BUNDLE_OWNER_QUOTA_BYTES = COMBINED_FREE_TIER_BYTES;
export const DEFAULT_STAGED_BUNDLE_OWNER_QUOTA_OBJECTS = 10_000;

export interface StagedBundleQuotaResult {
  reservationId: string;
  allowed: boolean;
  usedBytes: number;
  reservedBytes: number;
  projectedBytes: number;
  limitBytes: number;
  remainingBytes: number;
  usedObjects: number;
  reservedObjects: number;
  projectedObjects: number;
  limitObjects: number;
  remainingObjects: number;
  retainedUntil: string;
}

export interface StagedBundleQuotaOptions {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  fetchFn?: typeof fetch;
  limitBytes?: number;
  limitObjects?: number;
  randomUUID?: () => string;
}

export interface StagedBundleQuotaCleanupOptions {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  fetchFn?: typeof fetch;
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}

export interface StagedBundleQuotaCleanupResult {
  releasedClaims: number;
  batches: number;
  complete: boolean;
}

export interface StagedBundleQuotaReleaseInput {
  ownerId: string;
  reservationId: string;
}

export class StagedBundleQuotaError extends Error {
  constructor(
    public readonly code:
      | 'quota_exceeded'
      | 'service_unavailable'
      | 'invalid_response'
      | 'invalid_request',
    message: string,
    public readonly result?: StagedBundleQuotaResult,
  ) {
    super(message);
    this.name = 'StagedBundleQuotaError';
  }
}

const RESERVATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireReservationId(value: unknown): string {
  if (typeof value !== 'string' || !RESERVATION_ID_PATTERN.test(value)) {
    throw new StagedBundleQuotaError(
      'invalid_request',
      'Staged bundle quota requires a valid reservation ID',
    );
  }
  return value.toLowerCase();
}

function requireSafeByteCount(value: unknown, field: string): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
    ? Number(value)
    : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new StagedBundleQuotaError(
      'invalid_response',
      `Staged bundle quota returned an invalid ${field}`,
    );
  }
  return parsed;
}

function validateAdmissionRequest(input: StagedBundleAdmissionRequest): void {
  if (!input.ownerId.trim()) {
    throw new StagedBundleQuotaError(
      'invalid_request',
      'Staged bundle quota requires an owner',
    );
  }
  if (!/^gxb1_[a-f0-9]{64}$/.test(input.bundleId)) {
    throw new StagedBundleQuotaError(
      'invalid_request',
      'Staged bundle quota requires a valid bundle ID',
    );
  }
  if (
    !Array.isArray(input.objects) ||
    input.objects.length < 2 ||
    input.objects.length > 51
  ) {
    throw new StagedBundleQuotaError(
      'invalid_request',
      'Staged bundle quota requires 2 to 51 immutable objects',
    );
  }

  const seen = new Set<string>();
  for (const object of input.objects) {
    if (
      !object ||
      !/^(?:blob:[a-f0-9]{64}|manifest:gxb1_[a-f0-9]{64})$/.test(
        object.objectId,
      ) ||
      !Number.isSafeInteger(object.sizeBytes) ||
      object.sizeBytes < 0 ||
      seen.has(object.objectId)
    ) {
      throw new StagedBundleQuotaError(
        'invalid_request',
        'Staged bundle quota objects must have unique immutable IDs and valid byte sizes',
      );
    }
    seen.add(object.objectId);
  }
  if (!seen.has(`manifest:${input.bundleId}`)) {
    throw new StagedBundleQuotaError(
      'invalid_request',
      'Staged bundle quota objects must include the bundle manifest',
    );
  }

  if (!Number.isFinite(Date.parse(input.retainedUntil))) {
    throw new StagedBundleQuotaError(
      'invalid_request',
      'Staged bundle quota requires a valid retention timestamp',
    );
  }
}

function parseQuotaResult(
  value: unknown,
  expectedReservationId: string,
  expectedRetainedUntil: string,
  expectedLimitBytes: number,
  expectedLimitObjects: number,
): StagedBundleQuotaResult {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new StagedBundleQuotaError(
      'invalid_response',
      'Staged bundle quota returned no admission decision',
    );
  }
  const record = row as Record<string, unknown>;
  if (
    typeof record.reservation_id !== 'string' ||
    record.reservation_id.toLowerCase() !== expectedReservationId
  ) {
    throw new StagedBundleQuotaError(
      'invalid_response',
      'Staged bundle quota returned an invalid reservation ID',
    );
  }
  if (typeof record.allowed !== 'boolean') {
    throw new StagedBundleQuotaError(
      'invalid_response',
      'Staged bundle quota returned an invalid admission decision',
    );
  }
  if (
    typeof record.retained_until !== 'string' ||
    !Number.isFinite(Date.parse(record.retained_until))
  ) {
    throw new StagedBundleQuotaError(
      'invalid_response',
      'Staged bundle quota returned an invalid retention timestamp',
    );
  }
  const retainedUntil = record.retained_until;
  if (
    Date.parse(retainedUntil) !== Date.parse(expectedRetainedUntil)
  ) {
    throw new StagedBundleQuotaError(
      'invalid_response',
      'Staged bundle quota changed the requested retention timestamp',
    );
  }
  const result = {
    reservationId: expectedReservationId,
    allowed: record.allowed,
    usedBytes: requireSafeByteCount(record.used_bytes, 'used byte count'),
    reservedBytes: requireSafeByteCount(
      record.reserved_bytes,
      'reserved byte count',
    ),
    projectedBytes: requireSafeByteCount(
      record.projected_bytes,
      'projected byte count',
    ),
    limitBytes: requireSafeByteCount(record.limit_bytes, 'byte limit'),
    remainingBytes: requireSafeByteCount(
      record.remaining_bytes,
      'remaining byte count',
    ),
    usedObjects: requireSafeByteCount(record.used_objects, 'used object count'),
    reservedObjects: requireSafeByteCount(
      record.reserved_objects,
      'reserved object count',
    ),
    projectedObjects: requireSafeByteCount(
      record.projected_objects,
      'projected object count',
    ),
    limitObjects: requireSafeByteCount(
      record.limit_objects,
      'object limit',
    ),
    remainingObjects: requireSafeByteCount(
      record.remaining_objects,
      'remaining object count',
    ),
    retainedUntil,
  };
  const shouldAllow = result.projectedBytes <= result.limitBytes &&
    result.projectedObjects <= result.limitObjects;
  const expectedRemainingBytes = result.allowed
    ? result.limitBytes - result.projectedBytes
    : Math.max(0, result.limitBytes - result.usedBytes);
  const expectedRemainingObjects = result.allowed
    ? result.limitObjects - result.projectedObjects
    : Math.max(0, result.limitObjects - result.usedObjects);
  if (
    result.limitBytes !== expectedLimitBytes ||
    result.limitObjects !== expectedLimitObjects ||
    result.projectedBytes !== result.usedBytes + result.reservedBytes ||
    result.projectedObjects !== result.usedObjects + result.reservedObjects ||
    result.allowed !== shouldAllow ||
    result.remainingBytes !== expectedRemainingBytes ||
    result.remainingObjects !== expectedRemainingObjects
  ) {
    throw new StagedBundleQuotaError(
      'invalid_response',
      'Staged bundle quota returned an inconsistent admission decision',
    );
  }
  return result;
}

/**
 * Atomically reserves the owner-scoped physical R2 objects referenced by one
 * new staged manifest. The backing RPC deduplicates content hashes across
 * bundles and extends the lease of every blob that stageBundle renews in R2.
 */
export async function reserveStagedBundleStorage(
  input: StagedBundleAdmissionRequest,
  options: StagedBundleQuotaOptions = {},
): Promise<StagedBundleQuotaResult> {
  validateAdmissionRequest(input);
  const reservationId = requireReservationId(
    (options.randomUUID ?? (() => crypto.randomUUID()))(),
  );
  const limitBytes = options.limitBytes ??
    DEFAULT_STAGED_BUNDLE_OWNER_QUOTA_BYTES;
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw new StagedBundleQuotaError(
      'invalid_request',
      'Staged bundle owner quota must be a positive safe integer',
    );
  }
  const limitObjects = options.limitObjects ??
    DEFAULT_STAGED_BUNDLE_OWNER_QUOTA_OBJECTS;
  if (!Number.isSafeInteger(limitObjects) || limitObjects <= 0) {
    throw new StagedBundleQuotaError(
      'invalid_request',
      'Staged bundle owner object quota must be a positive safe integer',
    );
  }

  const supabaseUrl = options.supabaseUrl ?? getEnv('SUPABASE_URL');
  const serviceRoleKey = options.serviceRoleKey ??
    getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new StagedBundleQuotaError(
      'service_unavailable',
      'Staged bundle storage admission is not configured',
    );
  }

  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)(
      `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/reserve_staged_bundle_storage`,
      {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_owner_id: input.ownerId,
          p_reservation_id: reservationId,
          p_objects: input.objects.map((object) => ({
            object_id: object.objectId,
            size_bytes: object.sizeBytes,
          })),
          p_retained_until: input.retainedUntil,
          p_limit_bytes: limitBytes,
          p_limit_objects: limitObjects,
        }),
      },
    );
  } catch (error) {
    console.error('[STAGED-BUNDLE-QUOTA] Admission request failed', error);
    throw new StagedBundleQuotaError(
      'service_unavailable',
      'Staged bundle storage admission is temporarily unavailable',
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('[STAGED-BUNDLE-QUOTA] Admission RPC failed', {
      status: response.status,
      detail,
    });
    throw new StagedBundleQuotaError(
      'service_unavailable',
      'Staged bundle storage admission is temporarily unavailable',
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new StagedBundleQuotaError(
      'invalid_response',
      'Staged bundle storage admission returned invalid JSON',
    );
  }
  return parseQuotaResult(
    payload,
    reservationId,
    input.retainedUntil,
    limitBytes,
    limitObjects,
  );
}

/**
 * Compensates a failed R2 publication by releasing exactly one admission
 * claim. The backing RPC keeps any pre-existing or concurrent claims for the
 * same content-addressed objects, then removes only objects with no claims.
 */
export async function releaseStagedBundleStorageReservation(
  input: StagedBundleQuotaReleaseInput,
  options: StagedBundleQuotaOptions = {},
): Promise<number> {
  if (typeof input.ownerId !== 'string' || !input.ownerId.trim()) {
    throw new StagedBundleQuotaError(
      'invalid_request',
      'Staged bundle quota release requires an owner',
    );
  }
  const reservationId = requireReservationId(input.reservationId);
  const supabaseUrl = options.supabaseUrl ?? getEnv('SUPABASE_URL');
  const serviceRoleKey = options.serviceRoleKey ??
    getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new StagedBundleQuotaError(
      'service_unavailable',
      'Staged bundle storage release is not configured',
    );
  }

  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)(
      `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/release_staged_bundle_storage_reservation`,
      {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_owner_id: input.ownerId,
          p_reservation_id: reservationId,
        }),
      },
    );
  } catch (error) {
    console.error('[STAGED-BUNDLE-QUOTA] Release request failed', error);
    throw new StagedBundleQuotaError(
      'service_unavailable',
      'Staged bundle storage release is temporarily unavailable',
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('[STAGED-BUNDLE-QUOTA] Release RPC failed', {
      status: response.status,
      detail,
    });
    throw new StagedBundleQuotaError(
      'service_unavailable',
      'Staged bundle storage release is temporarily unavailable',
    );
  }

  const value = await response.json().catch(() => null);
  const released = typeof value === 'number'
    ? value
    : typeof value === 'string'
    ? Number(value)
    : NaN;
  if (!Number.isSafeInteger(released) || released < 0 || released > 51) {
    throw new StagedBundleQuotaError(
      'invalid_response',
      'Staged bundle storage release returned an invalid claim count',
    );
  }
  return released;
}

/**
 * Handler integration helper:
 *
 *   stageBundle(store, {
 *     ...input,
 *     admit: createStagedBundleQuotaAdmission(),
 *   })
 */
export function createStagedBundleQuotaAdmission(
  options: StagedBundleQuotaOptions = {},
): StagedBundleAdmission {
  return async (
    input,
  ): Promise<StagedBundleAdmissionReservation> => {
    const result = await reserveStagedBundleStorage(input, options);
    if (!result.allowed) {
      throw new StagedBundleQuotaError(
        'quota_exceeded',
        `Staged bundle storage quota exceeded: ${result.projectedBytes} of ${result.limitBytes} bytes and ${result.projectedObjects} of ${result.limitObjects} objects`,
        result,
      );
    }
    return {
      release: async () => {
        await releaseStagedBundleStorageReservation({
          ownerId: input.ownerId,
          reservationId: result.reservationId,
        }, options);
      },
    };
  };
}

/**
 * Bounded global reconciliation for reservations whose physical R2 retention
 * window has elapsed. Stage admission removes expired rows for the active
 * owner; this hourly backstop also clears owners who never stage again.
 */
export async function cleanupExpiredStagedBundleStorage(
  options: StagedBundleQuotaCleanupOptions = {},
): Promise<StagedBundleQuotaCleanupResult> {
  const supabaseUrl = options.supabaseUrl ?? getEnv('SUPABASE_URL');
  const serviceRoleKey = options.serviceRoleKey ??
    getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new StagedBundleQuotaError(
      'service_unavailable',
      'Staged bundle storage cleanup is not configured',
    );
  }
  const batchSize = options.batchSize ?? 10_000;
  const maxBatches = options.maxBatches ?? 10;
  if (
    !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50_000 ||
    !Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 100
  ) {
    throw new StagedBundleQuotaError(
      'invalid_request',
      'Staged bundle storage cleanup bounds are invalid',
    );
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new StagedBundleQuotaError(
      'invalid_request',
      'Staged bundle storage cleanup requires a valid timestamp',
    );
  }

  let releasedClaims = 0;
  let batches = 0;
  let complete = false;
  for (; batches < maxBatches; batches++) {
    let response: Response;
    try {
      response = await (options.fetchFn ?? fetch)(
        `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/cleanup_staged_bundle_storage_reservations`,
        {
          method: 'POST',
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_cutoff: now.toISOString(),
            p_limit: batchSize,
          }),
        },
      );
    } catch (error) {
      console.error('[STAGED-BUNDLE-QUOTA] Cleanup request failed', error);
      throw new StagedBundleQuotaError(
        'service_unavailable',
        'Staged bundle storage cleanup is temporarily unavailable',
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('[STAGED-BUNDLE-QUOTA] Cleanup RPC failed', {
        status: response.status,
        detail,
      });
      throw new StagedBundleQuotaError(
        'service_unavailable',
        'Staged bundle storage cleanup is temporarily unavailable',
      );
    }

    const value = await response.json().catch(() => null);
    const deleted = typeof value === 'number'
      ? value
      : typeof value === 'string'
      ? Number(value)
      : NaN;
    if (
      !Number.isSafeInteger(deleted) || deleted < 0 || deleted > batchSize
    ) {
      throw new StagedBundleQuotaError(
        'invalid_response',
        'Staged bundle storage cleanup returned an invalid deletion count',
      );
    }
    releasedClaims += deleted;
    if (deleted < batchSize) {
      complete = true;
      batches += 1;
      break;
    }
  }

  return { releasedClaims, batches, complete };
}
