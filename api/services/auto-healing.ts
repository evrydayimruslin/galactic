// Auto-Healing Service — Detection Only
// Detects failing MCP functions and records health events.
// Does NOT patch or deploy — agents read events via ul.logs({ health: true })
// and fix issues themselves.
// Runs periodically alongside the billing loop.

import { getEnv } from '../lib/env.ts';

// ============================================
// CONFIG
// ============================================

/** Minimum calls in the detection window before we consider error rate meaningful */
const MIN_CALLS_FOR_DETECTION = 5;

/** Error rate threshold to trigger a health event (0.0-1.0). 50% = half of calls failing. */
const ERROR_RATE_THRESHOLD = 0.5;

/** Detection window: look at calls from the last N hours */
const DETECTION_WINDOW_HOURS = 2;

/** Cooldown: don't re-flag the same function within N hours */
const DETECTION_COOLDOWN_HOURS = 6;

/** Max health events per app per day (prevent noise) */
const MAX_EVENTS_PER_DAY = 5;

// ============================================
// TYPES
// ============================================

interface FailingFunction {
  app_id: string;
  function_name: string;
  total_calls: number;
  failed_calls: number;
  error_rate: number;
  common_error: string;
  error_samples: Array<{
    error_message: string;
    // Redacted to a type-shape (keys + value types, never values) so the raw
    // end-user input never lands in the owner-readable app_health_events.error_sample.
    input_shape: unknown;
    created_at: string;
  }>;
}

export interface AutoHealingReport {
  detected: number;
  skipped: number;
  results: Array<{
    app_id: string;
    function_name: string;
    status: 'detected' | 'skipped' | 'cooldown';
    error_rate?: number;
    common_error?: string;
  }>;
  errors: string[];
}

// ============================================
// MAIN ENTRY
// ============================================

/**
 * Run the failure detection cycle.
 * Called periodically (every 30 min) by the job scheduler.
 * Detects failing functions and records health events.
 * Agents fix issues themselves via ul.logs({ health: true }) + ul.upload.
 */
export async function runAutoHealing(): Promise<AutoHealingReport> {
  const report: AutoHealingReport = {
    detected: 0,
    skipped: 0,
    results: [],
    errors: [],
  };

  const SUPABASE_URL = getEnv('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    report.errors.push('Missing Supabase config');
    return report;
  }

  const headers = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    // ── Step 1: Detect failing functions ──
    const failing = await detectFailingFunctions(SUPABASE_URL, headers);

    if (failing.length === 0) {
      console.log('[AUTO-HEAL] No failing functions detected.');
      return report;
    }

    console.log(`[AUTO-HEAL] Detected ${failing.length} failing function(s).`);

    // ── Step 2: Filter out cooldowns and rate limits ──
    const candidates = await filterCandidates(failing, SUPABASE_URL, headers);

    // ── Step 3: Record health events for each candidate ──
    const writeHeaders = {
      ...headers,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };

    for (const fn of candidates) {
      try {
        // Record the detection event
        const eventRes = await fetch(`${SUPABASE_URL}/rest/v1/app_health_events`, {
          method: 'POST',
          headers: writeHeaders,
          body: JSON.stringify({
            app_id: fn.app_id,
            function_name: fn.function_name,
            status: 'detected',
            error_rate: fn.error_rate,
            total_calls: fn.total_calls,
            failed_calls: fn.failed_calls,
            common_error: fn.common_error.slice(0, 1000),
            error_sample: fn.error_samples.slice(0, 5),
          }),
        });

        if (!eventRes.ok) {
          const err = await eventRes.text();
          report.errors.push(`Failed to create health event for ${fn.app_id}/${fn.function_name}: ${err}`);
          continue;
        }

        // Update app health_status to 'unhealthy'
        await fetch(
          `${SUPABASE_URL}/rest/v1/apps?id=eq.${fn.app_id}`,
          {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ health_status: 'unhealthy' }),
          }
        ).catch(() => {});

        report.detected++;
        report.results.push({
          app_id: fn.app_id,
          function_name: fn.function_name,
          status: 'detected',
          error_rate: fn.error_rate,
          common_error: fn.common_error,
        });

        console.log(`[AUTO-HEAL] Flagged ${fn.function_name} on ${fn.app_id} (${(fn.error_rate * 100).toFixed(0)}% error rate)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push(`Recording event for ${fn.app_id}/${fn.function_name}: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`Detection cycle error: ${msg}`);
    console.error('[AUTO-HEAL] Cycle error:', err);
  }

  console.log(`[AUTO-HEAL] Complete: ${report.detected} detected, ${report.skipped} skipped.`);
  return report;
}

// Reduce an arbitrary input value to a redacted TYPE-SHAPE — top-level keys and
// value types, never the values themselves — so failing-call diagnostics can be
// shown to the app owner without leaking the end-user's raw inputs. Depth- and
// key-capped; fails safe to "unknown".
function shapeOfValue(value: unknown, depth = 0): unknown {
  try {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (Array.isArray(value)) {
      if (depth >= 2) return "array";
      return {
        _type: "array",
        length: value.length,
        of: value.length ? shapeOfValue(value[0], depth + 1) : "unknown",
      };
    }
    if (typeof value === "object") {
      if (depth >= 2) return "object";
      const shape: Record<string, unknown> = {};
      for (
        const key of Object.keys(value as Record<string, unknown>).slice(0, 30)
      ) {
        shape[key] = shapeOfValue(
          (value as Record<string, unknown>)[key],
          depth + 1,
        );
      }
      return shape;
    }
    return typeof value; // "string" | "number" | "boolean" | ...
  } catch {
    return "unknown";
  }
}

// ============================================
// STEP 1: DETECT FAILING FUNCTIONS
// ============================================

async function detectFailingFunctions(
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<FailingFunction[]> {
  const cutoff = new Date(Date.now() - DETECTION_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  // Query recent calls and aggregate in JS (PostgREST doesn't support GROUP BY well)
  const res = await fetch(
    `${supabaseUrl}/rest/v1/mcp_call_logs?created_at=gte.${cutoff}&select=app_id,function_name,success,error_message,input_args,created_at&order=created_at.desc&limit=5000`,
    { headers }
  );

  if (!res.ok) {
    throw new Error(`Failed to query call logs: ${await res.text()}`);
  }

  const logs = await res.json() as Array<{
    app_id: string | null;
    function_name: string;
    success: boolean;
    error_message: string | null;
    input_args: unknown;
    created_at: string;
  }>;

  // Aggregate by app_id + function_name
  const agg = new Map<string, {
    app_id: string;
    function_name: string;
    total: number;
    failed: number;
    errors: Map<string, number>;
    samples: Array<{ error_message: string; input_shape: unknown; created_at: string }>;
  }>();

  for (const log of logs) {
    if (!log.app_id) continue;
    const key = `${log.app_id}::${log.function_name}`;
    let entry = agg.get(key);
    if (!entry) {
      entry = {
        app_id: log.app_id,
        function_name: log.function_name,
        total: 0,
        failed: 0,
        errors: new Map(),
        samples: [],
      };
      agg.set(key, entry);
    }

    entry.total++;
    if (!log.success) {
      entry.failed++;
      const errMsg = log.error_message || 'Unknown error';
      entry.errors.set(errMsg, (entry.errors.get(errMsg) || 0) + 1);
      if (entry.samples.length < 5) {
        entry.samples.push({
          error_message: errMsg,
          input_shape: shapeOfValue(log.input_args),
          created_at: log.created_at,
        });
      }
    }
  }

  // Filter to functions exceeding the error rate threshold
  const failing: FailingFunction[] = [];
  for (const entry of agg.values()) {
    if (entry.total < MIN_CALLS_FOR_DETECTION) continue;
    const errorRate = entry.failed / entry.total;
    if (errorRate < ERROR_RATE_THRESHOLD) continue;

    // Find most common error
    let commonError = 'Unknown error';
    let maxCount = 0;
    for (const [msg, count] of entry.errors) {
      if (count > maxCount) {
        commonError = msg;
        maxCount = count;
      }
    }

    failing.push({
      app_id: entry.app_id,
      function_name: entry.function_name,
      total_calls: entry.total,
      failed_calls: entry.failed,
      error_rate: errorRate,
      common_error: commonError,
      error_samples: entry.samples,
    });
  }

  // Sort by error rate descending (worst first)
  failing.sort((a, b) => b.error_rate - a.error_rate);

  return failing;
}

// ============================================
// STEP 2: FILTER CANDIDATES (cooldown + rate limits)
// ============================================

async function filterCandidates(
  failing: FailingFunction[],
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<FailingFunction[]> {
  const candidates: FailingFunction[] = [];

  for (const fn of failing) {
    // Check cooldown: any recent health event for this app+function?
    const cooldownCutoff = new Date(Date.now() - DETECTION_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
    const cooldownRes = await fetch(
      `${supabaseUrl}/rest/v1/app_health_events?app_id=eq.${fn.app_id}&function_name=eq.${encodeURIComponent(fn.function_name)}&created_at=gte.${cooldownCutoff}&limit=1`,
      { headers }
    );

    if (cooldownRes.ok) {
      const events = await cooldownRes.json() as Array<unknown>;
      if (events.length > 0) {
        console.log(`[AUTO-HEAL] Skipping ${fn.function_name} on ${fn.app_id} — cooldown active`);
        continue;
      }
    }

    // Check daily rate limit
    const dayCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const dayRes = await fetch(
      `${supabaseUrl}/rest/v1/app_health_events?app_id=eq.${fn.app_id}&created_at=gte.${dayCutoff}`,
      { headers: { ...headers, 'Prefer': 'count=exact' } }
    );

    if (dayRes.ok) {
      const count = parseInt(dayRes.headers.get('content-range')?.split('/')[1] || '0', 10);
      if (count >= MAX_EVENTS_PER_DAY) {
        console.log(`[AUTO-HEAL] Skipping ${fn.app_id} — daily limit reached (${count}/${MAX_EVENTS_PER_DAY})`);
        continue;
      }
    }

    // Check if app has auto_heal_enabled (opt-out)
    const appRes = await fetch(
      `${supabaseUrl}/rest/v1/apps?id=eq.${fn.app_id}&select=auto_heal_enabled&limit=1`,
      { headers }
    );

    if (appRes.ok) {
      const apps = await appRes.json() as Array<{ auto_heal_enabled: boolean }>;
      if (apps.length > 0 && apps[0].auto_heal_enabled === false) {
        console.log(`[AUTO-HEAL] Skipping ${fn.app_id} — health monitoring disabled by owner`);
        continue;
      }
    }

    candidates.push(fn);
  }

  return candidates;
}

// ============================================
// JOB SCHEDULER
// ============================================

/**
 * Start the health monitoring job.
 * Runs after a startup delay, then every 30 minutes.
 * Detection only — agents handle fixes via ul.logs({ health: true }) + ul.upload.
 */
export function startAutoHealingJob(): void {
  const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  console.log('[AUTO-HEAL] Starting health monitoring job (every 30 min)');

  // First run after 3 minutes (let server warm up)
  setTimeout(async () => {
    try {
      const report = await runAutoHealing();
      if (report.detected > 0) {
        console.log(`[AUTO-HEAL] First run: ${JSON.stringify(report)}`);
      }
    } catch (err) {
      console.error('[AUTO-HEAL] First run failed:', err);
    }
  }, 3 * 60 * 1000);

  // Then every 30 minutes
  setInterval(async () => {
    try {
      await runAutoHealing();
    } catch (err) {
      console.error('[AUTO-HEAL] Scheduled run failed:', err);
    }
  }, INTERVAL_MS);
}
