// Cloudflare Workers entrypoint for HTTP requests and scheduled jobs.

import type { Env } from '../lib/env.ts';
import { createApp } from '../handlers/app.ts';

import { processHostingBilling } from '../services/hosting-billing.ts';
import { runAutoHealing } from '../services/auto-healing.ts';
import { processHeldPayouts } from '../services/payout-processor.ts';
import { expireMarketplaceBids } from '../services/marketplace-maintenance.ts';
import { sweepExpiredCallLogs } from '../services/call-log-store.ts';
import { sweepExpiredNotifications } from '../services/notifications.ts';
import { processNullEmbeddings } from '../services/embedding-processor.ts';
import { processGpuBuilds } from '../services/gpu/benchmark.ts';
import { runD1BillingCycle } from '../services/d1-billing.ts';
import { cleanupStaleJobs } from '../services/async-jobs.ts';
import {
  releaseExpiredCloudUsageHolds,
  type CloudUsageHoldReleaseJobResult,
} from '../services/cloud-usage-reconciliation.ts';
import { runRoutineExecutorCycle } from '../services/routine-executor.ts';
import { isRoutinesEnabled } from '../services/routines-feature-flag.ts';
import { dispatchPendingEvents } from '../services/agent-events.ts';
import { refreshAppHealthView } from '../services/app-health.ts';
import { reconcileConnectVerification } from '../services/connect-verification.ts';
import {
  assertTrustSecretResolvable,
  backfillExecutedBundleAttestations,
} from '../services/executed-bundle.ts';
import { getEnv } from '../lib/env.ts';
import { applyCorsHeaders, buildCorsPreflightResponse } from '../services/cors.ts';
import { createServerLogger } from '../services/logging.ts';

// RPC entrypoints exposed through ctx.exports for dynamic worker bindings.
export { DatabaseBinding } from './bindings/database-binding.ts';
export { FixtureDatabaseBinding } from './bindings/fixture-database-binding.ts';
export { AppDataBinding } from './bindings/appdata-binding.ts';
export { AIBinding } from './bindings/ai-binding.ts';
export { MemoryBinding } from './bindings/memory-binding.ts';
export { RunsBinding } from './bindings/runs-binding.ts';
export { NetworkBinding } from './bindings/network-binding.ts';
export { EventsBinding } from './bindings/events-binding.ts';
export { OutboundBinding } from './bindings/outbound-binding.ts';
export { CredentialBinding } from './bindings/credential-binding.ts';

// ============================================
// SECURITY & CORS HEADERS
// ============================================

const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

const requestLogger = createServerLogger('REQ');
const cronLogger = createServerLogger('CRON');

// ============================================
// WORKER EXPORT
// ============================================

export default {
  /**
   * HTTP request handler — replaces Deno.serve()
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Make env available globally for all downstream code
    globalThis.__env = env;
    globalThis.__ctx = ctx;

    const url = new URL(request.url);
    const standardHeaders = securityHeaders;
    requestLogger.info('Incoming request', {
      method: request.method,
      path: url.pathname,
      embed: url.searchParams.get('embed') === '1',
    });

    // Reject oversized request bodies early (50 MB limit)
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 50 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: 'Request body too large' }),
        {
          status: 413,
          headers: (() => {
            const headers = new Headers({
              'Content-Type': 'application/json',
              ...standardHeaders,
            });
            applyCorsHeaders(headers, request);
            return headers;
          })(),
        },
      );
    }

    // Handle platform-global CORS preflight. App HTTP routes resolve their
    // own route policy inside handlers/app.ts so public API CORS can be
    // scoped per function.
    const isHttpRoute = url.pathname.startsWith('/http/');
    if (request.method === 'OPTIONS' && !isHttpRoute) {
      const response = buildCorsPreflightResponse(request);
      for (const [key, value] of Object.entries(standardHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    }

    try {
      const app = createApp();
      const response = await app.handle(request);

      // Apply standard headers to all responses
      for (const [key, value] of Object.entries(standardHeaders)) {
        // Skip X-Frame-Options for embed mode (desktop app iframe)
        if (key === 'X-Frame-Options' && url.searchParams.get('embed') === '1') continue;
        response.headers.set(key, value);
      }
      if (!isHttpRoute) {
        applyCorsHeaders(response.headers, request);
      }

      return response;
    } catch (err) {
      requestLogger.error('Unhandled request error', {
        method: request.method,
        path: url.pathname,
        error: err,
      });

      // Never leak internal error messages to clients
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: (() => {
            const headers = new Headers({
              'Content-Type': 'application/json',
              ...standardHeaders,
            });
            applyCorsHeaders(headers, request);
            return headers;
          })(),
        },
      );
    }
  },

  /**
   * Queue consumer — durable async execution (PR3) and event-bus dispatch
   * (PR4), routed by source queue. Exec messages carry { jobId }; event
   * messages carry { eventId }. Claims on the backing rows are the
   * at-most-once guards; post-claim failures never retry the message.
   * Awaiting before ack is what lets >120s work complete — there is no
   * response boundary here.
   */
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
    globalThis.__env = env;
    globalThis.__ctx = ctx;

    let process: (body: unknown) => Promise<'ack' | 'retry'>;
    if (batch.queue.includes('ultralight-exec')) {
      ({ processExecMessage: process } = await import(
        '../services/async-exec-consumer.ts'
      ));
    } else if (batch.queue.includes('ultralight-events')) {
      ({ processEventMessage: process } = await import(
        '../services/agent-events-consumer.ts'
      ));
    } else {
      cronLogger.error('Message from unknown queue dropped', {
        queue: batch.queue,
      });
      for (const message of batch.messages) message.ack();
      return;
    }

    for (const message of batch.messages) {
      try {
        const outcome = await process(message.body);
        if (outcome === 'retry') {
          message.retry({
            delaySeconds: Math.min(30 * message.attempts, 300),
          });
        } else {
          message.ack();
        }
      } catch (err) {
        // Consumers handle their own failures; this is a backstop.
        cronLogger.error('Queue message processing crashed', { error: err });
        message.ack();
      }
    }
  },

  /**
   * Scheduled (cron) handler — replaces setInterval background jobs.
   * Each cron trigger routes to the appropriate job functions.
   * Uses ctx.waitUntil() to avoid blocking the scheduler.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    globalThis.__env = env;
    globalThis.__ctx = ctx;

    cronLogger.info('Cron trigger received', {
      schedule: event.cron,
      scheduled_at: new Date(event.scheduledTime).toISOString(),
    });

    switch (event.cron) {
      // Every minute: high-frequency jobs
      case '* * * * *':
        ctx.waitUntil(runMinuteJobs());
        break;

      // Every 5 minutes: D1 billing cycle + trust health view refresh.
      // Health is refreshed at 5-min cadence (not 30) so the rolling 1h window
      // — whose now()-1h boundary freezes at refresh time — stays honest rather
      // than lagging up to half its own width.
      case '*/5 * * * *':
        ctx.waitUntil(
          runD1BillingCycle().catch(err =>
            cronLogger.error('D1 billing cron failed', {
              schedule: event.cron,
              error: err,
            })
          )
        );
        ctx.waitUntil(
          refreshAppHealthView().catch(err =>
            cronLogger.error('App health refresh cron failed', {
              schedule: event.cron,
              error: err,
            })
          )
        );
        break;

      // Every hour: billing + payouts
      case '0 * * * *':
        ctx.waitUntil(runHourlyJobs());
        break;

      // Every 30 minutes: auto-healing
      case '*/30 * * * *':
        ctx.waitUntil(
          runAutoHealing().catch(err =>
            cronLogger.error('Auto-healing cron failed', {
              schedule: event.cron,
              error: err,
            })
          )
        );
        break;

      default:
        cronLogger.warn('Unknown cron trigger', { schedule: event.cron });
    }
  },
};

// ============================================
// JOB GROUPINGS
// ============================================

/**
 * Jobs that run every minute.
 * All run concurrently via Promise.allSettled (failures don't block others).
 */
async function runMinuteJobs(): Promise<void> {
  const baseUrl = getEnv('BASE_URL');

  const results = await Promise.allSettled([
    cleanupStaleJobs(),
    releaseExpiredCloudUsageHolds(),
    processNullEmbeddings(),
    processGpuBuilds(),
    // Platform-owned durable routines: LIVE in prod and staging (both declare
    // ROUTINES_ENABLED="1" and ship the routines schema). The flag is the
    // operational kill switch — when off, the executor skips instead of
    // querying absent tables every minute.
    isRoutinesEnabled() ? runRoutineExecutorCycle({ baseUrl }) : Promise.resolve(null),
    dispatchPendingEvents(), // cross-Agent pub/sub event fan-out
  ]);

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const names = [
        'asyncJobCleanup',
        'cloudUsageHoldRelease',
        'embeddingProcessor',
        'gpuBuildProcessor',
        'routineExecutor',
        'agentEventDispatch',
      ];
      cronLogger.error('Minute cron job failed', {
        job: names[i],
        error: result.reason,
      });
    } else {
      const releaseResult = i === 1 && isCloudUsageHoldReleaseJobResult(result.value)
        ? result.value
        : null;
      if (releaseResult && releaseResult.failed_count > 0) {
        cronLogger.warn('Cloud usage hold release completed in degraded mode', {
          job: 'cloudUsageHoldRelease',
          failed_count: releaseResult.failed_count,
          released_count: releaseResult.released_count,
          skipped_count: releaseResult.skipped_count,
          errors: releaseResult.errors,
        });
      } else if (releaseResult && releaseResult.released_count > 0) {
        cronLogger.info('Released expired cloud usage holds', {
          job: 'cloudUsageHoldRelease',
          released_count: releaseResult.released_count,
          skipped_count: releaseResult.skipped_count,
          released_amount_light: releaseResult.released_amount_light,
        });
      }
    }
  }
}

function isCloudUsageHoldReleaseJobResult(value: unknown): value is CloudUsageHoldReleaseJobResult {
  return typeof value === 'object' &&
    value !== null &&
    'released_count' in value &&
    'failed_count' in value;
}

/**
 * Jobs that run every hour.
 */
async function runHourlyJobs(): Promise<void> {
  const results = await Promise.allSettled([
    processHostingBilling(),
    processHeldPayouts(),
    expireMarketplaceBids(),
    // Call-log retention: delete run-log blobs older than 7 days and credit the
    // bytes back to each owner's data-storage allowance.
    sweepExpiredCallLogs(),
    // Notification inbox retention: delete owner notifications older than 90 days.
    sweepExpiredNotifications(),
    // Backstop the account.updated webhook: re-pull live Connect status for
    // connected sellers whose snapshot has gone stale, so a "verified" badge
    // can't strand true after Stripe disables payouts with no fresh webhook.
    reconcileConnectVerification(),
    // Executed-bundle integrity ops: (1) re-arm the alarm every hour if the
    // trust signing secret can't resolve (enforce would silently degrade to off);
    // (2) when EXECUTED_BUNDLE_BACKFILL=1, attest any still-unattested live
    // bundles so the legacy cohort becomes enforce-protected (idempotent — safe
    // to leave on, flip off once it reports 0 attested).
    (async () => {
      await assertTrustSecretResolvable();
      const backfillFlag = (getEnv('EXECUTED_BUNDLE_BACKFILL') || '').toLowerCase();
      if (backfillFlag === '1' || backfillFlag === 'true') {
        await backfillExecutedBundleAttestations();
      }
    })(),
  ]);

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const names = ['hostingBilling', 'payoutProcessor', 'marketplaceBidExpiry', 'callLogRetentionSweep', 'connectVerificationReconcile', 'executedBundleIntegrity'];
      cronLogger.error('Hourly cron job failed', {
        job: names[i],
        error: result.reason,
      });
    } else if (i === 0 && typeof result.value === 'object' && result.value !== null && 'degraded' in result.value && (result.value.degraded || result.value.errors.length > 0)) {
      cronLogger.warn('Hosting billing completed in degraded mode', {
        job: 'hostingBilling',
        errors: result.value.errors,
      });
    }
  }
}
