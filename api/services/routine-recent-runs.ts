// Flight-recorder read-back: an agent's recent routine runs (+ recorded
// steps) for ONE (app, user) pair. Consumed by the RUNS sandbox binding
// (api/src/bindings/runs-binding.ts) with the scope frozen into binding props
// host-side — sandbox code can never name another app or user. Kept as a
// plain service with an injectable fetch so it is unit-testable outside the
// Cloudflare runtime.

import { getEnv } from "../lib/env.ts";

export interface RecentRunStep {
  run_id: string;
  step_index: number;
  function_name: string;
  status: string;
  duration_ms: number | null;
  cost_light: number | null;
  args_preview: Record<string, unknown> | null;
  result_preview: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface RecentRun {
  id: string;
  routine_id: string;
  routine_name: string | null;
  status: string;
  trigger: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  total_light: number | null;
  summary: string | null;
  error: Record<string, unknown> | null;
  steps: RecentRunStep[];
}

interface RoutineIdRow {
  id: string;
  name: string | null;
}

const RECENT_RUNS_MAX = 20;
const MAX_ROUTINES = 25;
const MAX_STEPS = 200;

interface RecentRunsDeps {
  fetchFn?: typeof fetch;
}

async function supabaseRows<T>(
  pathAndQuery: string,
  fetchFn: typeof fetch,
): Promise<T[]> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetchFn(
    `${getEnv("SUPABASE_URL")}/rest/v1/${pathAndQuery}`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`runs.recent query failed (${res.status}): ${detail}`);
  }
  const value = await res.json();
  return Array.isArray(value) ? (value as T[]) : [];
}

// Bounded (≤20 runs, ≤200 steps; previews were clipped at write time) and only
// reachable from flag-opted apps, so deliberately unmetered in v1.
export async function fetchRecentRunsForApp(
  appId: string,
  userId: string,
  limit?: number,
  deps: RecentRunsDeps = {},
): Promise<{ runs: RecentRun[] }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const lim = Math.max(
    1,
    Math.min(RECENT_RUNS_MAX, Math.floor(Number(limit) || 10)),
  );

  // 1. This app's routines owned by the current user. Scope rides BOTH
  //    filters from the caller-supplied (host-frozen) identifiers.
  const routines = await supabaseRows<RoutineIdRow>(
    `user_routines?composer_app_id=eq.${encodeURIComponent(appId)}` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&deleted_at=is.null&select=id,name&limit=${MAX_ROUTINES}`,
    fetchFn,
  );
  if (routines.length === 0) return { runs: [] };
  const nameByRoutine = new Map(routines.map((r) => [r.id, r.name]));
  const routineIds = routines.map((r) => encodeURIComponent(r.id)).join(",");

  // 2. Most recent runs across those routines.
  const runs = await supabaseRows<Omit<RecentRun, "routine_name" | "steps">>(
    `routine_runs?routine_id=in.(${routineIds})` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&select=id,routine_id,status,trigger,started_at,completed_at,duration_ms,total_light,summary,error` +
      `&order=created_at.desc&limit=${lim}`,
    fetchFn,
  );
  if (runs.length === 0) return { runs: [] };
  const runIds = runs.map((r) => encodeURIComponent(r.id)).join(",");

  // 3. Recorded steps: cross-agent call contributions, the root handler
  //    record, and flight-recorded galactic.ai() exchanges.
  const steps = await supabaseRows<RecentRunStep>(
    `routine_run_steps?run_id=in.(${runIds})` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&select=run_id,step_index,function_name,status,duration_ms,cost_light,args_preview,result_preview,error,metadata` +
      `&order=step_index.asc&limit=${MAX_STEPS}`,
    fetchFn,
  );
  const stepsByRun = new Map<string, RecentRunStep[]>();
  for (const step of steps) {
    const bucket = stepsByRun.get(step.run_id) ?? [];
    bucket.push(step);
    stepsByRun.set(step.run_id, bucket);
  }

  return {
    runs: runs.map((run) => ({
      ...run,
      routine_name: nameByRoutine.get(run.routine_id) ?? null,
      steps: stepsByRun.get(run.id) ?? [],
    })),
  };
}
