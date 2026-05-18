// Admin Handler
// Protected endpoints for platform administration.
// Auth: Bearer token must match SUPABASE_SERVICE_ROLE_KEY (service-to-service).
//
// Endpoints:
//   POST  /api/admin/gaps               — Create a gap
//   PATCH /api/admin/gaps/:id           — Update a gap
//   POST  /api/admin/assess/:id         — Trigger/record assessment for a gap submission
//   POST  /api/admin/approve/:id        — Approve an assessment (writes points)
//   POST  /api/admin/reject/:id         — Reject an assessment
//   POST  /api/admin/balance/:userId    — Top up a user's Light balance
//   POST  /api/admin/fee-waiver-credits/grant — Grant publisher fee-waiver credit
//   GET   /api/admin/fee-waiver-credits/:publisherUserId — Inspect publisher fee-waiver credit
//   POST  /api/admin/cleanup-provisionals — Delete expired provisional users
//   GET   /api/admin/billing-config — Read Light economics config
//   PATCH /api/admin/billing-config — Update Light economics config
//   GET   /api/admin/cloud-economics — Cloud usage, call receipt, and fee summary
//   GET   /api/admin/payouts/reconciliation — Payout liability/retry summary
//   POST  /api/admin/payouts/process — Process or retry due payout operations
//   GET   /api/admin/analytics?days=30  — Distribution pipeline analytics dashboard
//   GET   /api/admin/capture/overview   — Capture health and aggregate inspection
//   GET   /api/admin/capture/conversation/:id — Inspect one captured conversation
//   GET   /api/admin/capture/export     — Export captured threads/messages/events/artifacts
//   GET   /api/admin/flash-training/export — Export Flash fine-tuning dataset rows

import { error, json } from './response.ts';
import { unsuspendContent } from '../services/hosting-billing.ts';
import { getEnv } from '../lib/env.ts';
import {
  buildCaptureExport,
  captureExportToJsonl,
  type CaptureInspectionFilters,
  getCaptureOverview,
  inspectCaptureConversation,
} from '../services/capture-inspection.ts';
import {
  getSensitiveRouteClientKey,
  withSensitiveRouteRateLimit,
} from '../services/sensitive-route-rate-limit.ts';
import { RequestValidationError } from '../services/request-validation.ts';
import {
  validateApproveAssessmentRequest,
  validateCreateGapRequest,
  validateRecordAssessmentRequest,
  validateSetAppCategoryRequest,
  validateSetAppFeaturedRequest,
  validateFlashTrainingExportUrl,
  validateGrantFeeWaiverCreditRequest,
  validateTopUpBalanceRequest,
  validateUpdateBillingConfigRequest,
  validateUpdateGapRequest,
} from '../services/admin-request-validation.ts';
import {
  buildFlashTrainingDatasetFromBundle,
  flashTrainingDatasetToJsonl,
} from '../services/flash-training-dataset.ts';
import {
  getBillingConfig,
  normalizeBillingConfigRow,
  toPublicBillingConfig,
} from '../services/billing-config.ts';
import {
  getPublisherFeeWaiverCredit,
  grantPublisherFeeWaiverCredit,
} from '../services/fee-waivers.ts';
import { getPlatformBalance } from '../services/stripe-connect.ts';
import { processHeldPayouts } from '../services/payout-processor.ts';

interface UserIdRow {
  id: string;
}

interface TopAppCallRow {
  app_id: string | null;
  app_name: string | null;
  user_id: string;
  success: boolean | null;
}

interface SearchQueryRow {
  query: string;
  top_similarity: number | null;
  result_count: number | null;
}

interface ConversionEventRow {
  merge_method: string;
  time_to_convert_minutes: number | null;
  calls_as_provisional: number | null;
  first_app_id: string | null;
  first_app_name: string | null;
}

interface ProvisionalAnalyticsRow {
  id: string;
  provisional_created_at?: string | null;
  last_active_at: string | null;
}

interface TemplateFetchRow {
  id: string;
  provisional_created: boolean | null;
  created_at: string;
}

interface CallSummaryRow {
  user_id: string;
  success: boolean | null;
  source?: string | null;
}

interface UpdatedAppRow {
  id: string;
  category?: string | null;
  featured_at?: string | null;
}

interface AdminPayoutRow {
  id: string;
  user_id: string;
  amount_light: number | null;
  gross_cents: number | null;
  platform_fee_light: number | null;
  fee_estimate_cents: number | null;
  stripe_fee_cents: number | null;
  net_cents: number | null;
  status: string;
  release_at: string | null;
  created_at: string;
  completed_at: string | null;
  payout_run_id: string | null;
  scheduled_payout_date: string | null;
  payout_cutoff_at: string | null;
  payout_policy_version: number | null;
  stripe_transfer_id: string | null;
  stripe_payout_id: string | null;
  stripe_transfer_status: string | null;
  stripe_payout_status: string | null;
  stripe_transfer_attempts: number | null;
  stripe_payout_attempts: number | null;
  stripe_transfer_amount_cents: number | null;
  stripe_payout_amount_cents: number | null;
  processor_claimed_at: string | null;
  failure_reason: string | null;
  stripe_transfer_error?: unknown;
  stripe_payout_error?: unknown;
}

interface AdminPayoutRunRow {
  id: string;
  scheduled_for: string;
  cutoff_at: string;
  policy_version: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface AdminFeeWaiverEventRow {
  id: string;
  created_at: string;
  payer_user_id: string;
  publisher_user_id: string;
  app_id: string | null;
  transaction_kind: string;
  gross_light: number | null;
  fee_rate: number | null;
  fee_would_have_been_light: number | null;
  fee_waived_light: number | null;
  platform_fee_charged_light: number | null;
  waiver_source: string;
}

interface AdminCloudUsageEventRow {
  id: string;
  created_at: string;
  payer_user_id: string | null;
  sponsor_user_id: string | null;
  caller_user_id: string | null;
  owner_user_id: string | null;
  app_id: string | null;
  function_name: string | null;
  receipt_id: string | null;
  source: string;
  resource: string;
  units: number | null;
  cloud_units: number | null;
  amount_light: number | null;
  billing_config_version: number | null;
  metadata?: Record<string, unknown> | null;
}

interface AdminCallReceiptRow {
  id: string;
  created_at: string;
  app_id: string | null;
  app_name: string | null;
  method: string | null;
  source: string | null;
  success: boolean | null;
  call_charge_light: number | null;
  app_price_light: number | null;
  app_charge_light: number | null;
  infra_charge_light: number | null;
  platform_fee_light: number | null;
  developer_net_light: number | null;
  cloud_units: number | null;
  cloud_charge_light: number | null;
  cloud_owner_sponsored: boolean | null;
  free_call: boolean | null;
}

function getSupabaseEnv() {
  const SUPABASE_URL = getEnv('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  return { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
}

function dbHeaders(key: string) {
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
  };
}

function writeHeaders(key: string) {
  return {
    ...dbHeaders(key),
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
}

function authenticateAdmin(request: Request): boolean {
  const { SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  return !!token && token === SUPABASE_SERVICE_ROLE_KEY;
}

function withAdminSensitiveRouteRateLimit(
  request: Request,
  route:
    | 'admin:gaps_create'
    | 'admin:gaps_update'
    | 'admin:assess'
    | 'admin:approve'
    | 'admin:reject'
    | 'admin:balance_topup'
    | 'admin:fee_waiver_credit_grant'
    | 'admin:billing_config_update'
    | 'admin:cleanup_provisionals'
    | 'admin:app_category'
    | 'admin:app_featured'
    | 'admin:payout_process',
  handler: () => Promise<Response> | Response,
): Promise<Response> {
  return withSensitiveRouteRateLimit(
    `admin:${getSensitiveRouteClientKey(request)}`,
    route,
    handler,
  );
}

export async function handleAdmin(request: Request): Promise<Response> {
  if (!authenticateAdmin(request)) {
    return error('Unauthorized: invalid service secret', 401);
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // POST /api/admin/gaps — Create a gap
  if (path === '/api/admin/gaps' && method === 'POST') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:gaps_create',
      () => createGap(request),
    );
  }

  // PATCH /api/admin/gaps/:id — Update a gap
  const gapMatch = path.match(/^\/api\/admin\/gaps\/([0-9a-f-]+)$/);
  if (gapMatch && method === 'PATCH') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:gaps_update',
      () => updateGap(request, gapMatch[1]),
    );
  }

  // POST /api/admin/assess/:id — Record assessment for a gap_assessment
  const assessMatch = path.match(/^\/api\/admin\/assess\/([0-9a-f-]+)$/);
  if (assessMatch && method === 'POST') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:assess',
      () => recordAssessment(request, assessMatch[1]),
    );
  }

  // POST /api/admin/approve/:id — Approve assessment, grant points
  const approveMatch = path.match(/^\/api\/admin\/approve\/([0-9a-f-]+)$/);
  if (approveMatch && method === 'POST') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:approve',
      () => approveAssessment(request, approveMatch[1]),
    );
  }

  // POST /api/admin/reject/:id — Reject assessment
  const rejectMatch = path.match(/^\/api\/admin\/reject\/([0-9a-f-]+)$/);
  if (rejectMatch && method === 'POST') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:reject',
      () => rejectAssessment(rejectMatch[1]),
    );
  }

  // POST /api/admin/balance/:userId — Top up Light balance
  const balanceMatch = path.match(/^\/api\/admin\/balance\/([0-9a-f-]+)$/);
  if (balanceMatch && method === 'POST') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:balance_topup',
      () => topUpBalance(request, balanceMatch[1]),
    );
  }

  // POST /api/admin/fee-waiver-credits/grant — Grant publisher fee-waiver credit
  if (path === '/api/admin/fee-waiver-credits/grant' && method === 'POST') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:fee_waiver_credit_grant',
      () => grantFeeWaiverCredit(request),
    );
  }

  // GET /api/admin/fee-waiver-credits/:publisherUserId — Inspect fee-waiver credit
  const feeCreditMatch = path.match(
    /^\/api\/admin\/fee-waiver-credits\/([0-9a-f-]+)$/,
  );
  if (feeCreditMatch && method === 'GET') {
    return getAdminFeeWaiverCredit(url, feeCreditMatch[1]);
  }

  // POST /api/admin/cleanup-provisionals — Delete expired provisional users
  if (path === '/api/admin/cleanup-provisionals' && method === 'POST') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:cleanup_provisionals',
      () => cleanupProvisionals(),
    );
  }

  // GET/PATCH /api/admin/billing-config — Read or update Light economics
  if (path === '/api/admin/billing-config' && method === 'GET') {
    return getAdminBillingConfig();
  }
  if (path === '/api/admin/billing-config' && method === 'PATCH') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:billing_config_update',
      () => updateBillingConfig(request),
    );
  }

  // GET /api/admin/cloud-economics — cloud usage and receipt economics
  if (path === '/api/admin/cloud-economics' && method === 'GET') {
    return getCloudEconomics(url);
  }

  // GET /api/admin/payouts/reconciliation — payout liabilities and retry state
  if (path === '/api/admin/payouts/reconciliation' && method === 'GET') {
    return getPayoutReconciliation(url);
  }

  // POST /api/admin/payouts/process — process or retry due payout work
  if (path === '/api/admin/payouts/process' && method === 'POST') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:payout_process',
      () => processPayoutsAdmin(request),
    );
  }

  // PATCH /api/admin/apps/:appId/category — Set app category
  const categoryMatch = path.match(
    /^\/api\/admin\/apps\/([0-9a-f-]+)\/category$/,
  );
  if (categoryMatch && method === 'PATCH') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:app_category',
      () => setAppCategory(request, categoryMatch[1]),
    );
  }

  // PATCH /api/admin/apps/:appId/featured — Toggle featured status
  const featuredMatch = path.match(
    /^\/api\/admin\/apps\/([0-9a-f-]+)\/featured$/,
  );
  if (featuredMatch && method === 'PATCH') {
    return withAdminSensitiveRouteRateLimit(
      request,
      'admin:app_featured',
      () => setAppFeatured(request, featuredMatch[1]),
    );
  }

  // GET /api/admin/analytics — Distribution pipeline analytics dashboard
  if (path === '/api/admin/analytics' && method === 'GET') {
    const days = parseInt(url.searchParams.get('days') || '30', 10);
    return getAnalytics(days);
  }

  // GET /api/admin/capture/overview — capture health and aggregates
  if (path === '/api/admin/capture/overview' && method === 'GET') {
    return handleCaptureOverview(url);
  }

  // GET /api/admin/capture/export — JSON/JSONL export bundle
  if (path === '/api/admin/capture/export' && method === 'GET') {
    return handleCaptureExport(url);
  }

  // GET /api/admin/flash-training/export — Flash fine-tune dataset export
  if (path === '/api/admin/flash-training/export' && method === 'GET') {
    return handleFlashTrainingExport(url);
  }

  // GET /api/admin/capture/conversation/:id — full conversation inspection
  const captureConversationPrefix = '/api/admin/capture/conversation/';
  if (path.startsWith(captureConversationPrefix) && method === 'GET') {
    const conversationId = decodeURIComponent(
      path.slice(captureConversationPrefix.length),
    );
    if (!conversationId) return error('Missing conversation id', 400);
    return handleCaptureConversation(conversationId);
  }

  return error('Admin endpoint not found', 404);
}

function captureFiltersFromUrl(url: URL): CaptureInspectionFilters {
  return {
    conversationId: url.searchParams.get('conversationId') || undefined,
    anonUserId: url.searchParams.get('anonUserId') || undefined,
    source: url.searchParams.get('source') || undefined,
    since: url.searchParams.get('since') || undefined,
    until: url.searchParams.get('until') || undefined,
    limit: Number(url.searchParams.get('limit') || undefined),
  };
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'capture';
}

async function handleCaptureOverview(url: URL): Promise<Response> {
  try {
    return json(await getCaptureOverview(captureFiltersFromUrl(url)));
  } catch (err) {
    console.error('[ADMIN] capture overview failed:', err);
    return error('Capture overview failed', 500);
  }
}

async function handleCaptureConversation(
  conversationId: string,
): Promise<Response> {
  try {
    return json({
      success: true,
      capture: await inspectCaptureConversation(conversationId),
    });
  } catch (err) {
    console.error('[ADMIN] capture conversation inspection failed:', err);
    return error('Capture conversation inspection failed', 500);
  }
}

async function handleCaptureExport(url: URL): Promise<Response> {
  try {
    const filters = captureFiltersFromUrl(url);
    const bundle = await buildCaptureExport(filters);
    const format = url.searchParams.get('format') || 'json';

    if (format === 'jsonl' || format === 'ndjson') {
      const label = sanitizeFilenamePart(
        filters.conversationId || filters.anonUserId || filters.source ||
          'capture-export',
      );
      return new Response(captureExportToJsonl(bundle), {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="${label}.jsonl"`,
        },
      });
    }

    return json({ success: true, capture: bundle });
  } catch (err) {
    console.error('[ADMIN] capture export failed:', err);
    return error('Capture export failed', 500);
  }
}

async function handleFlashTrainingExport(url: URL): Promise<Response> {
  try {
    const params = validateFlashTrainingExportUrl(url);
    const bundle = await buildCaptureExport(params.captureFilters);
    const dataset = buildFlashTrainingDatasetFromBundle(bundle, {
      ...params.datasetOptions,
      generatedAt: bundle.export_meta.generated_at,
    });
    const exportSummary = {
      response_format: params.responseFormat,
      dataset_format: params.datasetFormat,
      include_tools: params.includeTools,
      preview_only: true,
      capture_filters: params.captureFilters,
      filter: dataset.filter,
      capture_meta: bundle.export_meta,
    };

    if (params.responseFormat === 'jsonl') {
      const label = sanitizeFilenamePart(
        params.datasetOptions.componentIds?.[0] ||
          params.captureFilters.conversationId ||
          params.captureFilters.anonUserId ||
          params.captureFilters.source ||
          'flash-training',
      );
      return new Response(
        flashTrainingDatasetToJsonl(dataset, {
          format: params.datasetFormat,
          includeTools: params.includeTools,
        }),
        {
          headers: {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition':
              `attachment; filename="${label}-${params.datasetFormat}.jsonl"`,
            'X-Ultralight-Flash-Examples': String(dataset.example_count),
            'X-Ultralight-Flash-Filtered-Out': String(
              dataset.filtered_out_example_count,
            ),
          },
        },
      );
    }

    return json({
      success: true,
      export: exportSummary,
      flash_training: dataset,
    });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('[ADMIN] Flash training export failed:', err);
    return error('Flash training export failed', 500);
  }
}

async function cleanupProvisionals(): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();

  try {
    // Get IDs of provisionals about to be deleted (for auth.users cleanup)
    const listRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?provisional=eq.true&last_active_at=lt.${
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      }&select=id`,
      { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
    );

    const toDelete = listRes.ok ? await listRes.json() as UserIdRow[] : [];

    // Run the cleanup RPC (deletes from public.users, cascades to tokens)
    const rpcRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/cleanup_expired_provisionals`,
      {
        method: 'POST',
        headers: writeHeaders(SUPABASE_SERVICE_ROLE_KEY),
        body: '{}',
      },
    );

    const deletedCount = rpcRes.ok ? await rpcRes.json() as number : 0;

    // Delete from auth.users (best-effort, non-blocking)
    let authDeleted = 0;
    for (const user of (toDelete || [])) {
      try {
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
          },
        });
        authDeleted++;
      } catch {}
    }

    return json({
      deleted_users: deletedCount,
      auth_entries_cleaned: authDeleted,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[ADMIN] Cleanup provisionals failed:', err);
    return error('Cleanup failed', 500);
  }
}

// ============================================
// CREATE GAP
// ============================================

async function createGap(request: Request): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  try {
    const body = await validateCreateGapRequest(request);
    const payload = {
      title: body.title,
      description: body.description,
      severity: body.severity,
      points_value: body.pointsValue,
      season: body.season,
      status: 'open',
      source_shortcoming_ids: body.sourceShortcomingIds,
      source_query_ids: body.sourceQueryIds,
    };

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/gaps`,
      {
        method: 'POST',
        headers: writeHeaders(SUPABASE_SERVICE_ROLE_KEY),
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      return error(`Failed to create gap: ${err}`, 500);
    }

    const rows = await res.json() as
      | Record<string, unknown>[]
      | Record<string, unknown>;
    const created = Array.isArray(rows) ? rows[0] : rows;
    return json({ success: true, gap: created }, 201);
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('[ADMIN] createGap failed:', err);
    return error('Failed to create gap', 500);
  }
}

// ============================================
// UPDATE GAP
// ============================================

async function updateGap(request: Request, gapId: string): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  try {
    const body = await validateUpdateGapRequest(request);
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (body.title !== undefined) update.title = body.title;
    if (body.description !== undefined) update.description = body.description;
    if (body.severity !== undefined) update.severity = body.severity;
    if (body.pointsValue !== undefined) update.points_value = body.pointsValue;
    if (body.season !== undefined) update.season = body.season;
    if (body.status !== undefined) update.status = body.status;
    if (body.sourceShortcomingIds !== undefined) {
      update.source_shortcoming_ids = body.sourceShortcomingIds;
    }
    if (body.sourceQueryIds !== undefined) {
      update.source_query_ids = body.sourceQueryIds;
    }
    if (body.fulfilledByAppId !== undefined) {
      update.fulfilled_by_app_id = body.fulfilledByAppId;
    }
    if (body.fulfilledByUserId !== undefined) {
      update.fulfilled_by_user_id = body.fulfilledByUserId;
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/gaps?id=eq.${gapId}`,
      {
        method: 'PATCH',
        headers: writeHeaders(SUPABASE_SERVICE_ROLE_KEY),
        body: JSON.stringify(update),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      return error(`Failed to update gap: ${err}`, 500);
    }

    const rows = await res.json() as
      | Record<string, unknown>[]
      | Record<string, unknown>;
    return json({ success: true, gap: Array.isArray(rows) ? rows[0] : rows });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('[ADMIN] updateGap failed:', err);
    return error('Failed to update gap', 500);
  }
}

// ============================================
// RECORD ASSESSMENT
// ============================================

async function recordAssessment(
  request: Request,
  assessmentId: string,
): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  try {
    const body = await validateRecordAssessmentRequest(request);
    const update: Record<string, unknown> = {};
    if (body.agentScore !== undefined) update.agent_score = body.agentScore;
    if (body.agentNotes !== undefined) update.agent_notes = body.agentNotes;
    if (body.proposedPoints !== undefined) {
      update.proposed_points = body.proposedPoints;
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/gap_assessments?id=eq.${assessmentId}`,
      {
        method: 'PATCH',
        headers: writeHeaders(SUPABASE_SERVICE_ROLE_KEY),
        body: JSON.stringify(update),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      return error(`Failed to update assessment: ${err}`, 500);
    }

    const rows = await res.json() as
      | Record<string, unknown>[]
      | Record<string, unknown>;
    return json({
      success: true,
      assessment: Array.isArray(rows) ? rows[0] : rows,
    });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('[ADMIN] recordAssessment failed:', err);
    return error('Failed to update assessment', 500);
  }
}

// ============================================
// APPROVE ASSESSMENT
// ============================================

async function approveAssessment(
  request: Request,
  assessmentId: string,
): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const headers = writeHeaders(SUPABASE_SERVICE_ROLE_KEY);

  try {
    const body = await validateApproveAssessmentRequest(request);

    // 1. Fetch the assessment
    const assessRes = await fetch(
      `${SUPABASE_URL}/rest/v1/gap_assessments?id=eq.${assessmentId}&select=*&limit=1`,
      { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
    );
    if (!assessRes.ok) return error('Failed to fetch assessment', 500);
    const assessments = await assessRes.json() as Array<{
      id: string;
      gap_id: string;
      app_id: string;
      user_id: string;
      proposed_points: number | null;
      status: string;
    }>;
    if (assessments.length === 0) return error('Assessment not found', 404);
    const assessment = assessments[0];

    if (assessment.status === 'approved') {
      return error('Assessment already approved', 409);
    }

    const awardedPoints = body.awardedPoints ?? assessment.proposed_points ??
      100;
    const reviewedBy = body.reviewedBy || 'admin';

    // 2. Update assessment to approved
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/gap_assessments?id=eq.${assessmentId}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          status: 'approved',
          awarded_points: awardedPoints,
          reviewed_by: reviewedBy,
          reviewed_at: new Date().toISOString(),
        }),
      },
    );
    if (!updateRes.ok) return error('Failed to approve assessment', 500);

    // 3. Write points to ledger
    const pointsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/points_ledger`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          user_id: assessment.user_id,
          amount: awardedPoints,
          reason: `Gap fulfilled: ${assessment.gap_id}`,
          gap_assessment_id: assessmentId,
          season: 1, // TODO: read from active season
        }),
      },
    );
    if (!pointsRes.ok) {
      console.error(
        '[ADMIN] Failed to write points ledger:',
        await pointsRes.text(),
      );
    }

    // 4. Update gap status to fulfilled
    await fetch(
      `${SUPABASE_URL}/rest/v1/gaps?id=eq.${assessment.gap_id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          status: 'fulfilled',
          fulfilled_by_app_id: assessment.app_id,
          fulfilled_by_user_id: assessment.user_id,
          updated_at: new Date().toISOString(),
        }),
      },
    ).catch(() => {});

    return json({
      success: true,
      awarded_points: awardedPoints,
      user_id: assessment.user_id,
      gap_id: assessment.gap_id,
    });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('[ADMIN] approveAssessment failed:', err);
    return error('Failed to approve assessment', 500);
  }
}

// ============================================
// REJECT ASSESSMENT
// ============================================

async function rejectAssessment(assessmentId: string): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/gap_assessments?id=eq.${assessmentId}`,
    {
      method: 'PATCH',
      headers: writeHeaders(SUPABASE_SERVICE_ROLE_KEY),
      body: JSON.stringify({
        status: 'rejected',
        reviewed_at: new Date().toISOString(),
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    return error(`Failed to reject assessment: ${err}`, 500);
  }

  return json({
    success: true,
    assessment_id: assessmentId,
    status: 'rejected',
  });
}

// ============================================
// TOP UP HOSTING BALANCE (ADMIN)
// ============================================

async function topUpBalance(
  request: Request,
  userId: string,
): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  try {
    const body = await validateTopUpBalanceRequest(request);

    // Credit balance via RPC
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/credit_balance`, {
      method: 'POST',
      headers: writeHeaders(SUPABASE_SERVICE_ROLE_KEY),
      body: JSON.stringify({
        p_user_id: userId,
        p_amount_light: body.amountLight,
      }),
    });

    if (!rpcRes.ok) {
      const err = await rpcRes.text();
      if (err.includes('no rows')) return error('User not found', 404);
      return error('Failed to update balance', 500);
    }

    const result = await rpcRes.json();
    const row = Array.isArray(result) ? result[0] : result;
    const oldBalance = row?.old_balance ?? 0;
    const newBalance = row?.new_balance ?? 0;

    // If was at zero, unsuspend content
    let unsuspended = { apps: 0, pages: 0 };
    if (oldBalance <= 0) {
      unsuspended = await unsuspendContent(userId);
    }

    return json({
      success: true,
      user_id: userId,
      previous_balance_light: oldBalance,
      added_light: body.amountLight,
      new_balance_light: newBalance,
      unsuspended_apps: unsuspended.apps,
      unsuspended_pages: unsuspended.pages,
    });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('[ADMIN] topUpBalance failed:', err);
    return error('Failed to update balance', 500);
  }
}

// ============================================
// FEE-WAIVER CREDIT
// ============================================

async function grantFeeWaiverCredit(request: Request): Promise<Response> {
  try {
    const body = await validateGrantFeeWaiverCreditRequest(request);
    const result = await grantPublisherFeeWaiverCredit({
      publisherUserId: body.publisherUserId,
      amountLight: body.amountLight,
      reason: body.reason,
      createdByUserId: body.createdByUserId,
      referenceTable: body.referenceTable,
      referenceId: body.referenceId,
      metadata: body.metadata,
    });
    return json(result, 201);
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('[ADMIN] grantFeeWaiverCredit failed:', err);
    return error('Failed to grant fee-waiver credit', 500);
  }
}

async function getAdminFeeWaiverCredit(
  url: URL,
  publisherUserId: string,
): Promise<Response> {
  try {
    const parsedLimit = Number(url.searchParams.get('ledger_limit') || 50);
    const ledgerLimit = Number.isInteger(parsedLimit)
      ? Math.max(1, Math.min(parsedLimit, 100))
      : 50;
    return json(await getPublisherFeeWaiverCredit(publisherUserId, {
      ledgerLimit,
    }));
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('[ADMIN] getAdminFeeWaiverCredit failed:', err);
    return error('Failed to fetch fee-waiver credit', 500);
  }
}

// ============================================
// BILLING CONFIG
// ============================================

async function getAdminBillingConfig(): Promise<Response> {
  const config = await getBillingConfig();
  return json({
    config,
    public_config: toPublicBillingConfig(config),
  });
}

async function updateBillingConfig(request: Request): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  try {
    const payload = await validateUpdateBillingConfigRequest(request);
    const headers = writeHeaders(SUPABASE_SERVICE_ROLE_KEY);

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/platform_billing_config?id=eq.singleton&select=*`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(payload),
      },
    );

    if (!patchRes.ok) {
      const err = await patchRes.text();
      return error(`Failed to update billing config: ${err}`, 500);
    }

    let rows = await patchRes.json() as unknown[];
    if (rows.length === 0) {
      const insertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/platform_billing_config?on_conflict=id&select=*`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Prefer': 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify({ id: 'singleton', ...payload }),
        },
      );
      if (!insertRes.ok) {
        const err = await insertRes.text();
        return error(`Failed to create billing config: ${err}`, 500);
      }
      rows = await insertRes.json() as unknown[];
    }

    const config = normalizeBillingConfigRow(
      rows[0] as Parameters<typeof normalizeBillingConfigRow>[0],
    );
    return json({
      success: true,
      config,
      public_config: toPublicBillingConfig(config),
    });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('[ADMIN] updateBillingConfig failed:', err);
    return error('Failed to update billing config', 500);
  }
}

// ============================================
// CLOUD ECONOMICS
// ============================================

function addToCloudEconomicsBucket(
  bucket: Record<
    string,
    { event_count: number; units: number; cloud_units: number; amount_light: number }
  >,
  key: string | null | undefined,
  event: Pick<AdminCloudUsageEventRow, 'units' | 'cloud_units' | 'amount_light'>,
) {
  const name = key || 'unknown';
  if (!bucket[name]) {
    bucket[name] = {
      event_count: 0,
      units: 0,
      cloud_units: 0,
      amount_light: 0,
    };
  }
  bucket[name].event_count += 1;
  bucket[name].units += lightAmount(event.units);
  bucket[name].cloud_units += lightAmount(event.cloud_units);
  bucket[name].amount_light += lightAmount(event.amount_light);
}

async function getCloudEconomics(url: URL): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const headers = dbHeaders(SUPABASE_SERVICE_ROLE_KEY);
  const periodDays = Math.max(
    1,
    Math.min(parseInt(url.searchParams.get('days') || '30', 10) || 30, 365),
  );
  const limit = Math.max(
    1,
    Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500),
  );
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000)
    .toISOString();

  const eventSelect = [
    'id',
    'created_at',
    'payer_user_id',
    'sponsor_user_id',
    'caller_user_id',
    'owner_user_id',
    'app_id',
    'function_name',
    'receipt_id',
    'source',
    'resource',
    'units',
    'cloud_units',
    'amount_light',
    'billing_config_version',
    'metadata',
  ].join(',');
  const receiptSelect = [
    'id',
    'created_at',
    'app_id',
    'app_name',
    'method',
    'source',
    'success',
    'call_charge_light',
    'app_price_light',
    'app_charge_light',
    'infra_charge_light',
    'platform_fee_light',
    'developer_net_light',
    'cloud_units',
    'cloud_charge_light',
    'cloud_owner_sponsored',
    'free_call',
  ].join(',');

  try {
    const billingConfig = await getBillingConfig();
    const publicConfig = toPublicBillingConfig(billingConfig);
    const [eventsRes, receiptsRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/cloud_usage_events?created_at=gte.${since}&select=${eventSelect}&order=created_at.desc&limit=50000`,
        { headers },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/mcp_call_logs?created_at=gte.${since}&select=${receiptSelect}&order=created_at.desc&limit=50000`,
        { headers },
      ),
    ]);

    const events = await readRows<AdminCloudUsageEventRow>(
      eventsRes,
      'cloud usage events',
    );
    const receipts = await readRows<AdminCallReceiptRow>(
      receiptsRes,
      'call receipts',
    );

    const byResource: Record<
      string,
      { event_count: number; units: number; cloud_units: number; amount_light: number }
    > = {};
    const bySource: Record<
      string,
      { event_count: number; units: number; cloud_units: number; amount_light: number }
    > = {};
    for (const event of events) {
      addToCloudEconomicsBucket(byResource, event.resource, event);
      addToCloudEconomicsBucket(bySource, event.source, event);
    }
    const infraByReceipt = events.reduce<
      Map<string, { amount_light: number; cloud_units: number }>
    >((acc, event) => {
      if (!event.receipt_id) return acc;
      const existing = acc.get(event.receipt_id) || {
        amount_light: 0,
        cloud_units: 0,
      };
      existing.amount_light += lightAmount(event.amount_light);
      existing.cloud_units += lightAmount(event.cloud_units);
      acc.set(event.receipt_id, existing);
      return acc;
    }, new Map());

    const receiptTotals = receipts.reduce(
      (acc, receipt) => {
        const infraFromEvents = infraByReceipt.get(receipt.id);
        const infraLight = infraFromEvents?.amount_light ||
          lightAmount(receipt.infra_charge_light) ||
          lightAmount(receipt.cloud_charge_light);
        const appChargeLight = lightAmount(receipt.app_charge_light) ||
          lightAmount(receipt.call_charge_light);
        acc.app_price_light += lightAmount(receipt.app_price_light);
        acc.app_charge_light += appChargeLight;
        acc.infra_light += infraLight;
        acc.total_light += appChargeLight + infraLight;
        acc.platform_fee_light += lightAmount(receipt.platform_fee_light);
        acc.developer_net_light += lightAmount(receipt.developer_net_light);
        acc.cloud_units += infraFromEvents?.cloud_units ||
          lightAmount(receipt.cloud_units);
        if (receipt.success) acc.successful += 1;
        if (receipt.success === false) acc.failed += 1;
        if (receipt.free_call) acc.free_calls += 1;
        if (receipt.cloud_owner_sponsored) acc.owner_sponsored_infra += 1;
        return acc;
      },
      {
        app_price_light: 0,
        app_charge_light: 0,
        infra_light: 0,
        total_light: 0,
        platform_fee_light: 0,
        developer_net_light: 0,
        cloud_units: 0,
        successful: 0,
        failed: 0,
        free_calls: 0,
        owner_sponsored_infra: 0,
      },
    );

    const appTotals = receipts.reduce<Record<string, {
      app_id: string | null;
      app_name: string | null;
      calls: number;
      app_charge_light: number;
      infra_light: number;
      platform_fee_light: number;
      developer_net_light: number;
    }>>((acc, receipt) => {
      const key = receipt.app_id || 'unknown';
      const infraFromEvents = infraByReceipt.get(receipt.id);
      if (!acc[key]) {
        acc[key] = {
          app_id: receipt.app_id,
          app_name: receipt.app_name,
          calls: 0,
          app_charge_light: 0,
          infra_light: 0,
          platform_fee_light: 0,
          developer_net_light: 0,
        };
      }
      acc[key].calls += 1;
      acc[key].app_charge_light += lightAmount(receipt.app_charge_light) ||
        lightAmount(receipt.call_charge_light);
      acc[key].infra_light += infraFromEvents?.amount_light ||
        lightAmount(receipt.infra_charge_light) ||
        lightAmount(receipt.cloud_charge_light);
      acc[key].platform_fee_light += lightAmount(receipt.platform_fee_light);
      acc[key].developer_net_light += lightAmount(receipt.developer_net_light);
      return acc;
    }, {});

    return json({
      success: true,
      generated_at: new Date().toISOString(),
      period_days: periodDays,
      since,
      billing_config: publicConfig,
      cloud_usage: {
        total_events: events.length,
        total_units: events.reduce(
          (sum, event) => sum + lightAmount(event.units),
          0,
        ),
        total_cloud_units: events.reduce(
          (sum, event) => sum + lightAmount(event.cloud_units),
          0,
        ),
        total_light: events.reduce(
          (sum, event) => sum + lightAmount(event.amount_light),
          0,
        ),
        by_resource: byResource,
        by_source: bySource,
      },
      call_receipts: {
        total: receipts.length,
        ...receiptTotals,
        top_apps: Object.values(appTotals)
          .sort((a, b) =>
            (b.app_charge_light + b.infra_light) -
            (a.app_charge_light + a.infra_light)
          )
          .slice(0, 20),
        recent: receipts.slice(0, limit),
      },
      policy: {
        cloud_unit_rate: publicConfig.labels.cloud_unit_rate,
        worker_unit: publicConfig.labels.worker_unit,
        d1_read_unit: publicConfig.labels.d1_read_unit,
        d1_write_unit: publicConfig.labels.d1_write_unit,
        r2_operation_unit: publicConfig.labels.r2_operation_unit,
        kv_operation_unit: publicConfig.labels.kv_operation_unit,
        widget_pull_unit: publicConfig.labels.widget_pull_unit,
        storage_at_rest: publicConfig.labels.storage_at_rest,
      },
    });
  } catch (err) {
    console.error('[ADMIN] cloud economics failed:', err);
    return error('Cloud economics summary failed', 500);
  }
}

// ============================================
// PAYOUT RECONCILIATION
// ============================================

async function readRows<T>(res: Response, label: string): Promise<T[]> {
  if (!res.ok) {
    throw new Error(`Failed to query ${label}: ${await res.text()}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows as T[] : [];
}

function lightAmount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function centsAmount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function summarizeFeeWaiverEvents(events: AdminFeeWaiverEventRow[]) {
  const bySource: Record<
    string,
    {
      event_count: number;
      fee_would_have_been_light: number;
      fee_waived_light: number;
      platform_fee_charged_light: number;
    }
  > = {};
  const byTransactionKind: Record<
    string,
    {
      event_count: number;
      fee_would_have_been_light: number;
      fee_waived_light: number;
      platform_fee_charged_light: number;
    }
  > = {};

  const add = (
    bucket: typeof bySource,
    key: string | null | undefined,
    event: AdminFeeWaiverEventRow,
  ) => {
    const name = key || 'unknown';
    if (!bucket[name]) {
      bucket[name] = {
        event_count: 0,
        fee_would_have_been_light: 0,
        fee_waived_light: 0,
        platform_fee_charged_light: 0,
      };
    }
    bucket[name].event_count += 1;
    bucket[name].fee_would_have_been_light += lightAmount(
      event.fee_would_have_been_light,
    );
    bucket[name].fee_waived_light += lightAmount(event.fee_waived_light);
    bucket[name].platform_fee_charged_light += lightAmount(
      event.platform_fee_charged_light,
    );
  };

  const totals = events.reduce(
    (acc, event) => {
      acc.event_count += 1;
      acc.gross_light += lightAmount(event.gross_light);
      acc.fee_would_have_been_light += lightAmount(
        event.fee_would_have_been_light,
      );
      acc.fee_waived_light += lightAmount(event.fee_waived_light);
      acc.platform_fee_charged_light += lightAmount(
        event.platform_fee_charged_light,
      );
      add(bySource, event.waiver_source, event);
      add(byTransactionKind, event.transaction_kind, event);
      return acc;
    },
    {
      event_count: 0,
      gross_light: 0,
      fee_would_have_been_light: 0,
      fee_waived_light: 0,
      platform_fee_charged_light: 0,
    },
  );

  return {
    ...totals,
    by_source: bySource,
    by_transaction_kind: byTransactionKind,
    recent_events: events.slice(0, 100),
  };
}

function isRetryablePayout(payout: AdminPayoutRow): boolean {
  const claimIsStale = payout.processor_claimed_at
    ? Date.parse(payout.processor_claimed_at) < Date.now() - 30 * 60 * 1000
    : false;
  return (
    payout.status === 'pending' &&
    (payout.stripe_transfer_status === 'not_started' ||
      payout.stripe_transfer_status === 'failed' ||
      (payout.stripe_transfer_status === 'pending' &&
        !payout.stripe_transfer_id &&
        claimIsStale))
  ) || (
    payout.status === 'processing' &&
    payout.stripe_transfer_status === 'succeeded' &&
    (payout.stripe_payout_status === 'not_started' ||
      payout.stripe_payout_status === 'failed' ||
      (payout.stripe_payout_status === 'pending' &&
        !payout.stripe_payout_id &&
        claimIsStale))
  );
}

async function getPayoutReconciliation(url: URL): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const headers = dbHeaders(SUPABASE_SERVICE_ROLE_KEY);
  const limit = Math.max(
    1,
    Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500),
  );

  const payoutSelect = [
    'id',
    'user_id',
    'amount_light',
    'gross_cents',
    'platform_fee_light',
    'fee_estimate_cents',
    'stripe_fee_cents',
    'net_cents',
    'status',
    'release_at',
    'created_at',
    'completed_at',
    'payout_run_id',
    'scheduled_payout_date',
    'payout_cutoff_at',
    'payout_policy_version',
    'stripe_transfer_id',
    'stripe_payout_id',
    'stripe_transfer_status',
    'stripe_payout_status',
    'stripe_transfer_attempts',
    'stripe_payout_attempts',
    'stripe_transfer_amount_cents',
    'stripe_payout_amount_cents',
    'processor_claimed_at',
    'failure_reason',
    'stripe_transfer_error',
    'stripe_payout_error',
  ].join(',');
  const waiverSelect = [
    'id',
    'created_at',
    'payer_user_id',
    'publisher_user_id',
    'app_id',
    'transaction_kind',
    'gross_light',
    'fee_rate',
    'fee_would_have_been_light',
    'fee_waived_light',
    'platform_fee_charged_light',
    'waiver_source',
  ].join(',');

  try {
    const [earningsRes, payoutsRes, runsRes, waiverEventsRes, stripeBalance] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/users?or=(total_earned_light.gt.0,earned_balance_light.gt.0)&select=total_earned_light,earned_balance_light`,
        { headers },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/payouts?select=${payoutSelect}&order=created_at.desc&limit=10000`,
        { headers },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/payout_runs?select=*&order=scheduled_for.desc&limit=${limit}`,
        { headers },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/platform_fee_waiver_events?select=${waiverSelect}&order=created_at.desc&limit=10000`,
        { headers },
      ),
      getPlatformBalance()
        .then((balance) => ({ available: true, ...balance }))
        .catch((err) => ({
          available: false,
          error: err instanceof Error ? err.message : String(err),
        })),
    ]);

    const earnings = await readRows<{
      total_earned_light: number | null;
      earned_balance_light: number | null;
    }>(earningsRes, 'earnings liability');
    const payouts = await readRows<AdminPayoutRow>(payoutsRes, 'payouts');
    const runs = await readRows<AdminPayoutRunRow>(runsRes, 'payout runs');
    const waiverEvents = await readRows<AdminFeeWaiverEventRow>(
      waiverEventsRes,
      'platform fee waiver events',
    );

    const totalEarnedLight = earnings.reduce(
      (sum, row) => sum + lightAmount(row.total_earned_light),
      0,
    );
    const earnedBalanceLight = earnings.reduce(
      (sum, row) => sum + lightAmount(row.earned_balance_light),
      0,
    );

    const byStatus = payouts.reduce<Record<string, number>>((acc, payout) => {
      acc[payout.status] = (acc[payout.status] || 0) +
        lightAmount(payout.amount_light);
      return acc;
    }, {});
    const transferStates = payouts.reduce<Record<string, number>>(
      (acc, payout) => {
        const state = payout.stripe_transfer_status || 'not_started';
        acc[state] = (acc[state] || 0) + 1;
        return acc;
      },
      {},
    );
    const payoutStates = payouts.reduce<Record<string, number>>((acc, payout) => {
      const state = payout.stripe_payout_status || 'not_started';
      acc[state] = (acc[state] || 0) + 1;
      return acc;
    }, {});

    const retryablePayouts = payouts.filter(isRetryablePayout);
    const heldLight = byStatus.held || 0;
    const pendingLight = byStatus.pending || 0;
    const processingLight = byStatus.processing || 0;
    const liabilityLight = earnedBalanceLight + heldLight + pendingLight +
      processingLight;
    const payoutEconomics = payouts.reduce(
      (acc, payout) => {
        acc.gross_cents += centsAmount(payout.gross_cents);
        acc.fee_estimate_cents += centsAmount(
          payout.fee_estimate_cents ?? payout.stripe_fee_cents,
        );
        acc.net_cents += centsAmount(payout.net_cents);
        acc.actual_transfer_cents += centsAmount(
          payout.stripe_transfer_amount_cents,
        );
        acc.actual_payout_cents += centsAmount(
          payout.stripe_payout_amount_cents,
        );
        return acc;
      },
      {
        gross_cents: 0,
        fee_estimate_cents: 0,
        net_cents: 0,
        actual_transfer_cents: 0,
        actual_payout_cents: 0,
      },
    );

    return json({
      success: true,
      generated_at: new Date().toISOString(),
      liabilities: {
        total_earned_light: totalEarnedLight,
        earned_balance_light: earnedBalanceLight,
        held_payouts_light: heldLight,
        pending_payouts_light: pendingLight,
        processing_payouts_light: processingLight,
        total_liability_light: liabilityLight,
      },
      payout_counts: {
        total: payouts.length,
        retryable: retryablePayouts.length,
        by_status: Object.fromEntries(
          Object.entries(byStatus).map(([status, amountLight]) => [
            status,
            {
              amount_light: amountLight,
              count: payouts.filter((p) => p.status === status).length,
            },
          ]),
        ),
        transfer_states: transferStates,
        payout_states: payoutStates,
      },
      stripe_balance: stripeBalance,
      payout_economics: payoutEconomics,
      fee_waivers: summarizeFeeWaiverEvents(waiverEvents),
      payout_runs: runs,
      retryable_payouts: retryablePayouts.slice(0, limit),
    });
  } catch (err) {
    console.error('[ADMIN] payout reconciliation failed:', err);
    return error('Payout reconciliation failed', 500);
  }
}

async function processPayoutsAdmin(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({})) as {
      payout_run_id?: unknown;
      scheduled_payout_date?: unknown;
      limit?: unknown;
    };
    const payoutRunId = typeof body.payout_run_id === 'string'
      ? body.payout_run_id
      : undefined;
    const scheduledPayoutDate = typeof body.scheduled_payout_date === 'string'
      ? body.scheduled_payout_date
      : undefined;
    const limit = typeof body.limit === 'number'
      ? Math.max(1, Math.min(Math.floor(body.limit), 200))
      : undefined;

    if (payoutRunId && !/^[0-9a-f-]{36}$/i.test(payoutRunId)) {
      return error('Invalid payout_run_id', 400);
    }
    if (
      scheduledPayoutDate &&
      !/^\d{4}-\d{2}-\d{2}$/.test(scheduledPayoutDate)
    ) {
      return error('Invalid scheduled_payout_date', 400);
    }

    const result = await processHeldPayouts({
      payoutRunId,
      scheduledPayoutDate,
      limit,
    });
    return json({ success: true, result });
  } catch (err) {
    console.error('[ADMIN] payout process failed:', err);
    return error('Payout process failed', 500);
  }
}

// ============================================
// ANALYTICS DASHBOARD
// ============================================

async function getAnalytics(days: number): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();

  // Clamp days to reasonable range
  const periodDays = Math.max(1, Math.min(days, 365));
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000)
    .toISOString();

  try {
    // Try the RPC first (requires migration-analytics.sql to be run)
    const rpcRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/get_analytics_summary`,
      {
        method: 'POST',
        headers: writeHeaders(SUPABASE_SERVICE_ROLE_KEY),
        body: JSON.stringify({ p_days: periodDays }),
      },
    );

    if (rpcRes.ok) {
      const rpcData = await rpcRes.json();
      return json({ success: true, analytics: rpcData });
    }

    // RPC not available (migration not run yet) — fall back to direct queries
    console.warn(
      '[ADMIN] Analytics RPC not available, falling back to direct queries',
    );

    // Run all analytics queries in parallel
    const [
      provisionalsRes,
      conversionsRes,
      templateFetchesRes,
      topAppsRes,
      topSearchesRes,
      unmetDemandRes,
      totalCallsRes,
      onboardingCallsRes,
    ] = await Promise.all([
      // Active provisional users
      fetch(
        `${SUPABASE_URL}/rest/v1/users?provisional=eq.true&select=id,provisional_created_at,last_active_at&provisional_created_at=gte.${since}`,
        { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
      ),
      // Conversion events
      fetch(
        `${SUPABASE_URL}/rest/v1/conversion_events?created_at=gte.${since}&select=*&order=created_at.desc&limit=100`,
        { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
      ),
      // Template fetches
      fetch(
        `${SUPABASE_URL}/rest/v1/onboarding_requests?created_at=gte.${since}&select=id,provisional_created,created_at&order=created_at.desc&limit=1000`,
        { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
      ),
      // Top apps by usage
      fetch(
        `${SUPABASE_URL}/rest/v1/mcp_call_logs?created_at=gte.${since}&app_id=not.is.null&select=app_id,app_name,success&order=created_at.desc&limit=10000`,
        { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
      ),
      // Top search queries
      fetch(
        `${SUPABASE_URL}/rest/v1/appstore_queries?created_at=gte.${since}&select=query,top_similarity,result_count&order=created_at.desc&limit=500`,
        { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
      ),
      // Unmet demand (low similarity searches)
      fetch(
        `${SUPABASE_URL}/rest/v1/appstore_queries?created_at=gte.${since}&or=(top_similarity.lt.0.5,result_count.eq.0)&select=query,top_similarity,result_count&order=created_at.desc&limit=200`,
        { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
      ),
      // Total call volume
      fetch(
        `${SUPABASE_URL}/rest/v1/mcp_call_logs?created_at=gte.${since}&select=user_id,success,source&order=created_at.desc&limit=50000`,
        { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
      ),
      // Onboarding template attributed calls
      fetch(
        `${SUPABASE_URL}/rest/v1/mcp_call_logs?created_at=gte.${since}&source=eq.onboarding_template&select=app_id,app_name,user_id,success&order=created_at.desc&limit=5000`,
        { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
      ),
    ]);

    // Parse all responses
    const provisionals = provisionalsRes.ok
      ? await provisionalsRes.json() as ProvisionalAnalyticsRow[]
      : [];
    const conversions = conversionsRes.ok
      ? await conversionsRes.json() as ConversionEventRow[]
      : [];
    const templateFetches = templateFetchesRes.ok
      ? await templateFetchesRes.json() as TemplateFetchRow[]
      : [];
    const appCalls = topAppsRes.ok ? await topAppsRes.json() as TopAppCallRow[] : [];
    const searches = topSearchesRes.ok ? await topSearchesRes.json() as SearchQueryRow[] : [];
    const unmetSearches = unmetDemandRes.ok ? await unmetDemandRes.json() as SearchQueryRow[] : [];
    const allCalls = totalCallsRes.ok ? await totalCallsRes.json() as CallSummaryRow[] : [];
    const onboardingCalls = onboardingCallsRes.ok
      ? await onboardingCallsRes.json() as TopAppCallRow[]
      : [];

    // Aggregate top apps
    const appUsage: Record<
      string,
      {
        app_name: string;
        calls: number;
        unique_users: Set<string>;
        successful: number;
      }
    > = {};
    for (const call of appCalls) {
      if (!call.app_id) continue;
      if (!appUsage[call.app_id]) {
        appUsage[call.app_id] = {
          app_name: call.app_name || 'unknown',
          calls: 0,
          unique_users: new Set(),
          successful: 0,
        };
      }
      appUsage[call.app_id].calls++;
      appUsage[call.app_id].unique_users.add(call.user_id);
      if (call.success) appUsage[call.app_id].successful++;
    }

    const topApps = Object.entries(appUsage)
      .map(([app_id, data]) => ({
        app_id,
        app_name: data.app_name,
        calls: data.calls,
        unique_users: data.unique_users.size,
        successful_calls: data.successful,
        success_rate: data.calls > 0 ? Math.round((data.successful / data.calls) * 100) : 0,
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 20);

    // Aggregate top searches
    const searchCounts: Record<
      string,
      { count: number; totalSim: number; totalResults: number }
    > = {};
    for (const s of searches) {
      if (!searchCounts[s.query]) {
        searchCounts[s.query] = { count: 0, totalSim: 0, totalResults: 0 };
      }
      searchCounts[s.query].count++;
      searchCounts[s.query].totalSim += s.top_similarity || 0;
      searchCounts[s.query].totalResults += s.result_count || 0;
    }
    const topSearches = Object.entries(searchCounts)
      .map(([query, data]) => ({
        query,
        count: data.count,
        avg_similarity: Math.round((data.totalSim / data.count) * 1000) / 1000,
        avg_results: Math.round(data.totalResults / data.count),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // Aggregate unmet demand
    const unmetCounts: Record<string, { count: number; avgSim: number }> = {};
    for (const s of unmetSearches) {
      if (!unmetCounts[s.query]) unmetCounts[s.query] = { count: 0, avgSim: 0 };
      unmetCounts[s.query].count++;
      unmetCounts[s.query].avgSim += s.top_similarity || 0;
    }
    const unmetDemand = Object.entries(unmetCounts)
      .map(([query, data]) => ({
        query,
        count: data.count,
        avg_similarity: Math.round((data.avgSim / data.count) * 1000) / 1000,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // Conversion stats
    const conversionsByMethod: Record<string, number> = {};
    let totalTimeToConvert = 0;
    let timeToConvertCount = 0;
    let totalCallsBeforeConvert = 0;
    for (const c of conversions) {
      conversionsByMethod[c.merge_method] = (conversionsByMethod[c.merge_method] || 0) + 1;
      if (c.time_to_convert_minutes != null) {
        totalTimeToConvert += c.time_to_convert_minutes;
        timeToConvertCount++;
      }
      totalCallsBeforeConvert += c.calls_as_provisional || 0;
    }

    // First app distribution from conversions
    const firstAppCounts: Record<string, { name: string; count: number }> = {};
    for (const c of conversions) {
      if (c.first_app_id) {
        if (!firstAppCounts[c.first_app_id]) {
          firstAppCounts[c.first_app_id] = {
            name: c.first_app_name || 'unknown',
            count: 0,
          };
        }
        firstAppCounts[c.first_app_id].count++;
      }
    }
    const firstAppDistribution = Object.entries(firstAppCounts)
      .map(([app_id, data]) => ({
        app_id,
        app_name: data.name,
        count: data.count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Template fetch → provisional creation rate
    const templateTotal = templateFetches.length;
    const templateToProvisional = templateFetches.filter((f) => f.provisional_created).length;

    // Onboarding template attribution
    const onboardingAppUsage: Record<
      string,
      { app_name: string; calls: number; unique_users: Set<string> }
    > = {};
    for (const call of onboardingCalls) {
      if (!call.app_id) continue;
      if (!onboardingAppUsage[call.app_id]) {
        onboardingAppUsage[call.app_id] = {
          app_name: call.app_name || 'unknown',
          calls: 0,
          unique_users: new Set(),
        };
      }
      onboardingAppUsage[call.app_id].calls++;
      onboardingAppUsage[call.app_id].unique_users.add(call.user_id);
    }
    const onboardingTemplateApps = Object.entries(onboardingAppUsage)
      .map(([app_id, data]) => ({
        app_id,
        app_name: data.app_name,
        calls: data.calls,
        unique_provisional_users: data.unique_users.size,
      }))
      .sort((a, b) => b.calls - a.calls);

    // Overall stats
    const totalCallCount = allCalls.length;
    const uniqueUsers = new Set(allCalls.map((c) => c.user_id)).size;
    const failedCalls = allCalls.filter((c) => !c.success).length;

    const analytics = {
      period_days: periodDays,
      generated_at: new Date().toISOString(),

      // Onboarding funnel
      template_fetches: templateTotal,
      template_to_provisional_rate: templateTotal > 0
        ? Math.round((templateToProvisional / templateTotal) * 1000) / 10
        : 0,

      // Provisionals
      provisionals_created: provisionals.length,
      provisionals_active: provisionals.filter((p) =>
        p.last_active_at &&
        (Date.now() - new Date(p.last_active_at).getTime()) <
          24 * 60 * 60 * 1000
      ).length,

      // Conversions
      conversions_total: conversions.length,
      conversions_by_method: conversionsByMethod,
      avg_time_to_convert_minutes: timeToConvertCount > 0
        ? Math.round(totalTimeToConvert / timeToConvertCount)
        : 0,
      avg_calls_before_convert: conversions.length > 0
        ? Math.round(totalCallsBeforeConvert / conversions.length)
        : 0,
      conversion_rate: provisionals.length > 0
        ? Math.round(
          (conversions.length / (provisionals.length + conversions.length)) *
            1000,
        ) / 10
        : 0,

      // First app attribution
      first_app_distribution: firstAppDistribution,

      // Onboarding template attribution
      onboarding_template_app_usage: onboardingTemplateApps,

      // App usage
      top_apps: topApps,

      // Discovery demand
      top_searches: topSearches,
      unmet_demand: unmetDemand,

      // Overall platform
      total_calls: totalCallCount,
      unique_users: uniqueUsers,
      error_rate_percent: totalCallCount > 0
        ? Math.round((failedCalls / totalCallCount) * 1000) / 10
        : 0,
    };

    return json({ success: true, analytics });
  } catch (err) {
    console.error('[ADMIN] Analytics failed:', err);
    return error('Analytics query failed', 500);
  }
}

// ============================================
// APP CURATION
// ============================================

async function setAppCategory(
  request: Request,
  appId: string,
): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  try {
    const body = await validateSetAppCategoryRequest(request);
    const category = body.category;

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/apps?id=eq.${appId}`,
      {
        method: 'PATCH',
        headers: writeHeaders(SUPABASE_SERVICE_ROLE_KEY),
        body: JSON.stringify({ category }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      return error(`Failed to update category: ${text}`, 500);
    }
    const updated = await res.json() as UpdatedAppRow[];
    return json({
      success: true,
      app_id: appId,
      category,
      app: updated[0] || null,
    });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('[ADMIN] setAppCategory failed:', err);
    return error('Failed to set category', 500);
  }
}

async function setAppFeatured(
  request: Request,
  appId: string,
): Promise<Response> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  try {
    const body = await validateSetAppFeaturedRequest(request);
    const featured_at = body.featured ? new Date().toISOString() : null;

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/apps?id=eq.${appId}`,
      {
        method: 'PATCH',
        headers: writeHeaders(SUPABASE_SERVICE_ROLE_KEY),
        body: JSON.stringify({ featured_at }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      return error(`Failed to update featured status: ${text}`, 500);
    }
    const updated = await res.json() as UpdatedAppRow[];
    return json({
      success: true,
      app_id: appId,
      featured: !!featured_at,
      featured_at,
      app: updated[0] || null,
    });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('[ADMIN] setAppFeatured failed:', err);
    return error('Failed to set featured status', 500);
  }
}
