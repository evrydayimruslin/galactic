import { getEnv } from '../lib/env.ts';
import type { RoutineTraceContext } from './routine-trace.ts';

export type RoutineBudgetReservationKind = 'app_call' | 'ai_call';

export interface RoutineBudgetReservation {
  id: string;
  key: string;
  reservedLight: number;
  callsUsed: number;
  callsLimit: number;
  lightUsed: number;
  lightReserved: number;
  lightLimit: number;
}

export interface RoutineBudgetAdmission {
  allowed: boolean;
  code:
    | 'ok'
    | 'routine_budget_calls_exhausted'
    | 'routine_budget_light_exhausted'
    | 'routine_budget_policy_missing'
    | 'routine_budget_reservation_in_flight'
    | 'routine_budget_reservation_finalized'
    | 'routine_run_not_active';
  message: string;
  reservation: RoutineBudgetReservation | null;
}

interface RoutineBudgetDeps {
  fetchFn?: typeof fetch;
  supabaseUrl?: string;
  serviceRoleKey?: string;
}

function budgetRpc(
  name: string,
  body: Record<string, unknown>,
  deps: RoutineBudgetDeps,
): Promise<Response> {
  const baseUrl = deps.supabaseUrl ?? getEnv('SUPABASE_URL');
  const key = deps.serviceRoleKey ?? getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!baseUrl || !key) {
    throw new Error('Routine budget database is not configured');
  }
  return (deps.fetchFn ?? fetch)(
    `${baseUrl.replace(/\/+$/, '')}/rest/v1/rpc/${name}`,
    {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

interface AdmissionRow {
  allowed?: boolean;
  code?: string;
  message?: string;
  reservation_id?: string | null;
  reservation_key?: string | null;
  reserved_light?: number | null;
  calls_used?: number | null;
  calls_limit?: number | null;
  light_used?: number | null;
  light_reserved?: number | null;
  light_limit?: number | null;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Atomically admits one billable operation before it executes. The database
 * locks the authoritative routine + run, applies run/day/month/call ceilings,
 * and creates an idempotent reservation. Infrastructure errors throw: callers
 * must fail closed whenever a routine context is present.
 */
export async function reserveRoutineRunBudget(input: {
  userId: string;
  routine: RoutineTraceContext;
  reservationKey: string;
  kind: RoutineBudgetReservationKind;
  reserveLight: number;
  expiresAt?: string;
}, deps: RoutineBudgetDeps = {}): Promise<RoutineBudgetAdmission> {
  const key = input.reservationKey.trim();
  if (!key) throw new Error('reservationKey is required');
  const reserveLight = finiteNonNegative(input.reserveLight, 'reserveLight');
  const response = await budgetRpc('reserve_routine_run_budget', {
    p_routine_id: input.routine.routineId,
    p_routine_run_id: input.routine.routineRunId,
    p_user_id: input.userId,
    p_reservation_key: key,
    p_kind: input.kind,
    p_reserve_light: reserveLight,
    p_expires_at: input.expiresAt ??
      new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  }, deps);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Routine budget admission unavailable (${response.status}): ${detail}`,
    );
  }
  const payload = await response.json().catch(() => null);
  const row = (Array.isArray(payload) ? payload[0] : payload) as
    | AdmissionRow
    | null;
  if (!row || typeof row.allowed !== 'boolean') {
    throw new Error('Routine budget admission returned no decision');
  }
  const code =
    (typeof row.code === 'string'
      ? row.code
      : 'routine_budget_policy_missing') as RoutineBudgetAdmission['code'];
  if (row.allowed) {
    if (
      typeof row.reservation_id !== 'string' || !row.reservation_id ||
      typeof row.reservation_key !== 'string' || row.reservation_key !== key ||
      typeof row.reserved_light !== 'number' ||
      !Number.isFinite(row.reserved_light) || row.reserved_light < 0 ||
      row.reserved_light + Number.EPSILON < reserveLight
    ) {
      throw new Error(
        'Routine budget admission returned an invalid or undersized reservation',
      );
    }
  }
  const reservation = row.allowed && row.reservation_id && row.reservation_key
    ? {
      id: row.reservation_id,
      key: row.reservation_key,
      reservedLight: numberOrZero(row.reserved_light),
      callsUsed: numberOrZero(row.calls_used),
      callsLimit: numberOrZero(row.calls_limit),
      lightUsed: numberOrZero(row.light_used),
      lightReserved: numberOrZero(row.light_reserved),
      lightLimit: numberOrZero(row.light_limit),
    }
    : null;
  return {
    allowed: row.allowed,
    code,
    message: typeof row.message === 'string'
      ? row.message
      : row.allowed
      ? 'Routine budget reserved.'
      : 'Routine budget denied this operation.',
    reservation,
  };
}

async function mutateReservation(
  rpc: 'settle_routine_run_budget_reservation' | 'release_routine_run_budget_reservation',
  input: {
    reservationId: string;
    userId: string;
    actualLight?: number;
    applySpend?: boolean;
  },
  deps: RoutineBudgetDeps,
): Promise<void> {
  const response = await budgetRpc(rpc, {
    p_reservation_id: input.reservationId,
    p_user_id: input.userId,
    ...(rpc === 'settle_routine_run_budget_reservation'
      ? {
        p_actual_light: finiteNonNegative(
          input.actualLight ?? 0,
          'actualLight',
        ),
        p_apply_spend: input.applySpend === true,
      }
      : {}),
  }, deps);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Routine budget reservation update failed (${response.status}): ${detail}`,
    );
  }
}

export function settleRoutineRunBudgetReservation(input: {
  reservationId: string;
  userId: string;
  actualLight: number;
  /** AI spend is not part of an app-call receipt, so it is applied directly. */
  applySpend?: boolean;
}, deps: RoutineBudgetDeps = {}): Promise<void> {
  return mutateReservation(
    'settle_routine_run_budget_reservation',
    input,
    deps,
  );
}

export function releaseRoutineRunBudgetReservation(input: {
  reservationId: string;
  userId: string;
}, deps: RoutineBudgetDeps = {}): Promise<void> {
  return mutateReservation(
    'release_routine_run_budget_reservation',
    input,
    deps,
  );
}
