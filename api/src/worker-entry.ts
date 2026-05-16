// Cloudflare Workers entrypoint for HTTP requests and scheduled jobs.

import type { Env } from '../lib/env.ts';
import { createApp } from '../handlers/app.ts';

import { processHostingBilling } from '../services/hosting-billing.ts';
import { runAutoHealing } from '../services/auto-healing.ts';
import { processHeldPayouts } from '../services/payout-processor.ts';
import { expireMarketplaceBids } from '../services/marketplace-maintenance.ts';
import { processNullEmbeddings } from '../services/embedding-processor.ts';
import { processGpuBuilds } from '../services/gpu/benchmark.ts';
import { runD1BillingCycle } from '../services/d1-billing.ts';
import { cleanupStaleJobs } from '../services/async-jobs.ts';
import { checkAndRunJobs as checkUserCronJobs } from '../services/cron.ts';
import { getEnv } from '../lib/env.ts';
import { applyCorsHeaders, buildCorsPreflightResponse } from '../services/cors.ts';
import { createServerLogger } from '../services/logging.ts';

// RPC entrypoints exposed through ctx.exports for dynamic worker bindings.
export { DatabaseBinding } from './bindings/database-binding.ts';
export { FixtureDatabaseBinding } from './bindings/fixture-database-binding.ts';
export { AppDataBinding } from './bindings/appdata-binding.ts';
export { AIBinding } from './bindings/ai-binding.ts';
export { MemoryBinding } from './bindings/memory-binding.ts';
export { NetworkBinding } from './bindings/network-binding.ts';

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

      // Every 5 minutes: D1 billing cycle
      case '*/5 * * * *':
        ctx.waitUntil(
          runD1BillingCycle().catch(err =>
            cronLogger.error('D1 billing cron failed', {
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
    processNullEmbeddings(),
    processGpuBuilds(),
    checkUserCronJobs(baseUrl),  // user-facing cron scheduler
  ]);

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const names = ['asyncJobCleanup', 'embeddingProcessor', 'gpuBuildProcessor', 'userCronScheduler'];
      cronLogger.error('Minute cron job failed', {
        job: names[i],
        error: result.reason,
      });
    }
  }
}

/**
 * Jobs that run every hour.
 */
async function runHourlyJobs(): Promise<void> {
  const results = await Promise.allSettled([
    processHostingBilling(),
    processHeldPayouts(),
    expireMarketplaceBids(),
  ]);

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const names = ['hostingBilling', 'payoutProcessor', 'marketplaceBidExpiry'];
      cronLogger.error('Hourly cron job failed', {
        job: names[i],
        error: result.reason,
      });
    } else if (i === 0 && 'degraded' in result.value && (result.value.degraded || result.value.errors.length > 0)) {
      cronLogger.warn('Hosting billing completed in degraded mode', {
        job: 'hostingBilling',
        errors: result.value.errors,
      });
    }
  }
}
