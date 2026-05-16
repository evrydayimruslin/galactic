// GPU Compute Runtime — Async Build Processor & Benchmark Pipeline
//
// Background job that drives GPU functions through the lifecycle:
//   building → benchmarking → live
//
// Registered from the Worker scheduled/runtime path in api/src/worker-entry.ts.
// Follows the setTimeout + setInterval pattern from embedding-processor.ts.

import type { GpuType, GpuConfig, BenchmarkStats } from './types.ts';
import { getGpuVram, GPU_RATE_TABLE } from './types.ts';
import { getGPUProvider, isGpuAvailable } from './provider-singleton.ts';
import { createR2Service } from '../storage.ts';
import { getEnv } from '../../lib/env.ts';
import { isGpuSupportEnabled } from './feature-flag.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Polling interval for the build processor. */
const INTERVAL_MS = 15_000; // 15 seconds

/** Delay before first run (let server warm up). */
const STARTUP_DELAY_MS = 60_000; // 1 minute

/** Number of benchmark runs per function. */
const BENCHMARK_RUNS = 5;

/** Minimum successful runs required for benchmark to pass. */
const MIN_SUCCESSFUL_RUNS = 3;

/** Max apps to process per cycle (prevents long-running cycles). */
const BATCH_LIMIT = 5;

// ---------------------------------------------------------------------------
// Job Entry Point
// ---------------------------------------------------------------------------

/**
 * Start the GPU build processor background job.
 *
 * Called from the Worker runtime startup path. Polls every 15s for
 * apps in 'building' or 'benchmarking' status and drives them forward.
 */
export function startGpuBuildProcessorJob(): void {
  if (!isGpuSupportEnabled()) {
    console.log('[GPU-PROC] GPU support disabled, build processor disabled');
    return;
  }

  if (!isGpuAvailable()) {
    console.log('[GPU-PROC] RUNPOD_API_KEY not configured, GPU build processor disabled');
    return;
  }

  console.log('[GPU-PROC] Starting GPU build processor (every 15s)');

  // First run after startup delay
  setTimeout(async () => {
    try {
      await processGpuBuilds();
    } catch (err) {
      console.error('[GPU-PROC] First run failed:', err);
    }
  }, STARTUP_DELAY_MS);

  // Then every 15 seconds
  setInterval(async () => {
    try {
      await processGpuBuilds();
    } catch (err) {
      console.error('[GPU-PROC] Scheduled run failed:', err);
    }
  }, INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Core Processing
// ---------------------------------------------------------------------------

/**
 * Main processing loop. Runs two passes:
 * 1. Check 'building' apps for endpoint activation
 * 2. Run benchmarks on 'benchmarking' apps
 */
export async function processGpuBuilds(): Promise<void> {
  if (!isGpuSupportEnabled()) return;
  await checkBuildingApps();
  await runPendingBenchmarks();
}

// ---------------------------------------------------------------------------
// Phase 1: Check Building Apps
// ---------------------------------------------------------------------------

/**
 * Poll apps with gpu_status='building' to see if their RunPod
 * endpoint has become active. Transition to 'benchmarking' or 'build_failed'.
 */
async function checkBuildingApps(): Promise<void> {
  const apps = await queryAppsByGpuStatus('building', BATCH_LIMIT, true);
  if (apps.length === 0) return;

  const provider = getGPUProvider();

  for (const app of apps) {
    if (!app.gpu_endpoint_id) continue;

    try {
      const status = await provider.getEndpointStatus(app.gpu_endpoint_id);

      if (status.status === 'active') {
        await updateAppGpuStatus(app.id, 'benchmarking');
        console.log(`[GPU-PROC] ${app.id} endpoint active, transitioning to benchmarking`);
      } else if (status.status === 'error' || status.status === 'not_found') {
        await updateAppGpuStatus(app.id, 'build_failed');
        console.log(`[GPU-PROC] ${app.id} endpoint failed: ${status.status}`);
      }
      // 'building' → do nothing, check again next cycle
    } catch (err) {
      console.error(`[GPU-PROC] Error checking endpoint for ${app.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Run Benchmarks
// ---------------------------------------------------------------------------

/**
 * Find apps in 'benchmarking' status and run 5 benchmark executions.
 * Transitions to 'live' on success or 'benchmark_failed' on failure.
 */
async function runPendingBenchmarks(): Promise<void> {
  const apps = await queryAppsByGpuStatus('benchmarking', BATCH_LIMIT);
  if (apps.length === 0) return;

  for (const app of apps) {
    try {
      await benchmarkApp(app);
    } catch (err) {
      console.error(`[GPU-PROC] Benchmark error for ${app.id}:`, err);
      await updateAppGpuStatus(app.id, 'benchmark_failed');
    }
  }
}

/**
 * Run 5 benchmark executions for a single GPU app.
 * Requires at least 3 successful runs to pass.
 */
async function benchmarkApp(app: GpuAppRow): Promise<void> {
  const provider = getGPUProvider();

  if (!app.gpu_endpoint_id || !app.gpu_type) {
    console.error(`[GPU-PROC] ${app.id} missing endpoint_id or gpu_type`);
    await updateAppGpuStatus(app.id, 'benchmark_failed');
    return;
  }

  // Load test_fixture.json from R2
  const { functionName, args } = await loadTestFixture(app.storage_key);
  const maxDurationMs = (app.gpu_config as GpuConfig | null)?.max_duration_ms || 60_000;

  console.log(
    `[GPU-PROC] Starting benchmark for ${app.id}: ` +
    `fn=${functionName}, gpu=${app.gpu_type}, runs=${BENCHMARK_RUNS}`,
  );

  // Run benchmark executions
  const durations: number[] = [];
  let peakVram = 0;
  let failCount = 0;

  for (let i = 0; i < BENCHMARK_RUNS; i++) {
    try {
      const result = await provider.execute({
        endpointId: app.gpu_endpoint_id,
        functionName,
        args,
        maxDurationMs,
        gpuType: app.gpu_type as GpuType,
      });

      if (result.success) {
        durations.push(result.duration_ms);
        peakVram = Math.max(peakVram, result.peak_vram_gb);
        console.log(
          `[GPU-PROC]   Run ${i + 1}/${BENCHMARK_RUNS}: ` +
          `${result.duration_ms.toFixed(1)}ms, vram=${result.peak_vram_gb}GB`,
        );
      } else {
        failCount++;
        console.log(
          `[GPU-PROC]   Run ${i + 1}/${BENCHMARK_RUNS} FAILED: ${result.exit_code}` +
          (result.error ? ` — ${result.error.message}` : ''),
        );
      }
    } catch (err) {
      failCount++;
      console.error(`[GPU-PROC]   Run ${i + 1}/${BENCHMARK_RUNS} ERROR:`, err);
    }
  }

  // Need at least MIN_SUCCESSFUL_RUNS successful runs
  if (durations.length < MIN_SUCCESSFUL_RUNS) {
    await updateAppGpuStatus(app.id, 'benchmark_failed');
    console.log(
      `[GPU-PROC] ${app.id} benchmark failed: ` +
      `only ${durations.length}/${BENCHMARK_RUNS} runs succeeded (need ${MIN_SUCCESSFUL_RUNS})`,
    );
    return;
  }

  // Compute benchmark statistics
  const stats = computeBenchmarkStats(durations, peakVram, app.gpu_type as GpuType);

  // Update app record → live
  await updateAppWithBenchmark(app.id, stats);

  // Update gpu_endpoints row
  await updateGpuEndpointStatus(app.gpu_endpoint_id, 'active');

  console.log(
    `[GPU-PROC] ${app.id} benchmark complete: ` +
    `mean=${stats.mean_ms.toFixed(1)}ms, p95=${stats.p95_ms.toFixed(1)}ms, ` +
    `vram=${stats.peak_vram_gb}GB, suggested_max=${stats.suggested_max_duration_ms}ms` +
    (stats.suggested_gpu_type ? `, over-provisioned → suggest ${stats.suggested_gpu_type}` : ''),
  );
}

// ---------------------------------------------------------------------------
// Benchmark Statistics
// ---------------------------------------------------------------------------

/**
 * Compute BenchmarkStats from a set of successful execution durations.
 *
 * Suggested max_duration_ms formula (from architecture doc):
 *   max(p95 * 2.0, median * 3.0, 1000)
 *
 * GPU over-provisioning check:
 *   If peak VRAM < 50% of current GPU's VRAM, suggest cheapest GPU
 *   with enough capacity (peak * 1.3 for headroom).
 */
export function computeBenchmarkStats(
  durations: number[],
  peakVram: number,
  gpuType: GpuType,
): BenchmarkStats {
  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;

  // Central tendency
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  // P95
  const p95Index = Math.min(Math.ceil(n * 0.95) - 1, n - 1);
  const p95 = sorted[p95Index];

  // Spread
  const variance = sorted.reduce((sum, d) => sum + (d - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const variance_pct = mean > 0 ? (stddev / mean) * 100 : 0;

  // Suggested max_duration_ms
  const suggested_max_duration_ms = Math.ceil(
    Math.max(p95 * 2.0, median * 3.0, 1000),
  );

  // GPU over-provisioning check
  let suggested_gpu_type: GpuType | undefined;
  if (peakVram > 0) {
    const currentVram = getGpuVram(gpuType);
    if (peakVram < currentVram * 0.5) {
      const neededVram = peakVram * 1.3;
      const candidates = (Object.entries(GPU_RATE_TABLE) as [GpuType, { rate_per_ms: number; vram_gb: number }][])
        .filter(([_, entry]) => entry.vram_gb >= neededVram)
        .sort((a, b) => a[1].rate_per_ms - b[1].rate_per_ms);

      if (candidates.length > 0 && candidates[0][0] !== gpuType) {
        suggested_gpu_type = candidates[0][0];
      }
    }
  }

  return {
    runs: n,
    mean_ms: round2(mean),
    median_ms: round2(median),
    p95_ms: round2(p95),
    stddev_ms: round2(stddev),
    variance_pct: round2(variance_pct),
    peak_vram_gb: peakVram,
    suggested_max_duration_ms,
    suggested_gpu_type,
    completed_at: new Date().toISOString(),
  };
}

/** Round to 2 decimal places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Test Fixture Loader
// ---------------------------------------------------------------------------

/**
 * Load test_fixture.json from R2 for benchmark execution.
 * Falls back to { main: {} } if not found or invalid.
 *
 * test_fixture.json format:
 * {
 *   "function_name": { "arg1": "value1", "arg2": 42 }
 * }
 */
async function loadTestFixture(storageKey: string): Promise<{
  functionName: string;
  args: Record<string, unknown>;
}> {
  try {
    const r2 = createR2Service();
    const content = await r2.fetchTextFile(`${storageKey}test_fixture.json`);
    const fixture = JSON.parse(content);

    if (typeof fixture === 'object' && fixture !== null && !Array.isArray(fixture)) {
      const entries = Object.entries(fixture);
      if (entries.length > 0) {
        const [functionName, args] = entries[0];
        return {
          functionName,
          args: (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>,
        };
      }
    }
  } catch {
    // No fixture or invalid JSON — use default
  }

  return { functionName: 'main', args: {} };
}

// ---------------------------------------------------------------------------
// Supabase Helpers
// ---------------------------------------------------------------------------

/** Minimal app row shape for GPU processing queries. */
interface GpuAppRow {
  id: string;
  gpu_endpoint_id: string | null;
  gpu_type: string | null;
  gpu_config: Record<string, unknown> | null;
  storage_key: string;
}

function getSupabaseConfig(): { supabaseUrl: string; supabaseKey: string } | null {
  const supabaseUrl = getEnv('SUPABASE_URL');
  const supabaseKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  return { supabaseUrl, supabaseKey };
}

/**
 * Query apps by gpu_status from Supabase.
 * If requireEndpoint is true, also filters for non-null gpu_endpoint_id.
 */
async function queryAppsByGpuStatus(
  status: string,
  limit: number,
  requireEndpoint = false,
): Promise<GpuAppRow[]> {
  const supabaseConfig = getSupabaseConfig();
  if (!supabaseConfig) return [];
  const { supabaseUrl, supabaseKey } = supabaseConfig;

  const url = new URL(`${supabaseUrl}/rest/v1/apps`);
  url.searchParams.set('gpu_status', `eq.${status}`);
  if (requireEndpoint) {
    url.searchParams.set('gpu_endpoint_id', 'not.is.null');
  }
  url.searchParams.set('select', 'id,gpu_endpoint_id,gpu_type,gpu_config,storage_key');
  url.searchParams.set('limit', String(limit));

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'apikey': supabaseKey,
      },
    });

    if (!response.ok) return [];
    return await response.json() as GpuAppRow[];
  } catch {
    return [];
  }
}

/** Update an app's gpu_status field. */
async function updateAppGpuStatus(appId: string, status: string): Promise<void> {
  const supabaseConfig = getSupabaseConfig();
  if (!supabaseConfig) return;
  const { supabaseUrl, supabaseKey } = supabaseConfig;

  const url = new URL(`${supabaseUrl}/rest/v1/apps`);
  url.searchParams.set('id', `eq.${appId}`);

  await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${supabaseKey}`,
      'apikey': supabaseKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      gpu_status: status,
      updated_at: new Date().toISOString(),
    }),
  });
}

/** Update an app with completed benchmark stats, transitioning to 'live'. */
async function updateAppWithBenchmark(
  appId: string,
  stats: BenchmarkStats,
): Promise<void> {
  const supabaseConfig = getSupabaseConfig();
  if (!supabaseConfig) return;
  const { supabaseUrl, supabaseKey } = supabaseConfig;

  const url = new URL(`${supabaseUrl}/rest/v1/apps`);
  url.searchParams.set('id', `eq.${appId}`);

  await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${supabaseKey}`,
      'apikey': supabaseKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      gpu_status: 'live',
      gpu_benchmark: stats,
      gpu_max_duration_ms: stats.suggested_max_duration_ms,
      updated_at: new Date().toISOString(),
    }),
  });
}

/** Update a gpu_endpoints row status. */
async function updateGpuEndpointStatus(
  endpointId: string,
  status: string,
): Promise<void> {
  const supabaseConfig = getSupabaseConfig();
  if (!supabaseConfig) return;
  const { supabaseUrl, supabaseKey } = supabaseConfig;

  const url = new URL(`${supabaseUrl}/rest/v1/gpu_endpoints`);
  url.searchParams.set('endpoint_id', `eq.${endpointId}`);

  await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${supabaseKey}`,
      'apikey': supabaseKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status,
      build_completed_at: new Date().toISOString(),
    }),
  });
}
