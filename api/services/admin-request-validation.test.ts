import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import {
  validateApproveAssessmentRequest,
  validateCreateGapRequest,
  validateFlashTrainingExportUrl,
  validateRecordAssessmentRequest,
  validateSetAppCategoryRequest,
  validateSetAppFeaturedRequest,
  validateTopUpBalanceRequest,
  validateUpdateBillingConfigRequest,
  validateUpdateGapRequest,
} from "./admin-request-validation.ts";
import { RequestValidationError } from "./request-validation.ts";

Deno.test("admin request validation: flash training export normalizes query filters", () => {
  const payload = validateFlashTrainingExportUrl(
    new URL(
      "https://example.com/api/admin/flash-training/export?format=ndjson&datasetFormat=openai_messages&filterMode=human_accepted&componentId=flash_broker.analyze&componentIds=flash_broker.read_response,flash_broker.analyze&schemaId=flash_broker.analyze.v1&capability=escalation_selection&includeTools=true&includeIncomplete=false&conversationId=conv-1&since=2026-05-01T00:00:00Z&until=2026-05-06T00:00:00Z&limit=250",
    ),
  );

  assertEquals(payload, {
    captureFilters: {
      conversationId: "conv-1",
      anonUserId: undefined,
      source: undefined,
      since: "2026-05-01T00:00:00Z",
      until: "2026-05-06T00:00:00Z",
      limit: 250,
    },
    datasetOptions: {
      filterMode: "human_accepted",
      componentIds: ["flash_broker.analyze", "flash_broker.read_response"],
      schemaIds: ["flash_broker.analyze.v1"],
      capabilities: ["escalation_selection"],
      includeIncomplete: false,
    },
    responseFormat: "jsonl",
    datasetFormat: "openai_messages",
    includeTools: true,
  });
});

Deno.test("admin request validation: flash training export rejects invalid query params", async () => {
  await assertRejects(
    async () => {
      validateFlashTrainingExportUrl(
        new URL(
          "https://example.com/api/admin/flash-training/export?format=csv",
        ),
      );
    },
    RequestValidationError,
    "format must be one of",
  );

  await assertRejects(
    async () => {
      validateFlashTrainingExportUrl(
        new URL(
          "https://example.com/api/admin/flash-training/export?limit=1001",
        ),
      );
    },
    RequestValidationError,
    "limit must be 1000 or less",
  );

  await assertRejects(
    async () => {
      validateFlashTrainingExportUrl(
        new URL(
          "https://example.com/api/admin/flash-training/export?unknown=1",
        ),
      );
    },
    RequestValidationError,
    "Unsupported query parameter",
  );
});

Deno.test("admin request validation: create gap normalizes severity and source ids", async () => {
  const payload = await validateCreateGapRequest(
    new Request("https://example.com/api/admin/gaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Launch blocker",
        description: "A serious platform issue",
        severity: "high",
        points_value: 250,
        season: 2,
        source_shortcoming_ids: [
          "11111111-1111-4111-8111-111111111111",
          "11111111-1111-4111-8111-111111111111",
        ],
        source_query_ids: ["22222222-2222-4222-8222-222222222222"],
      }),
    }),
  );

  assertEquals(payload, {
    title: "Launch blocker",
    description: "A serious platform issue",
    severity: "high",
    pointsValue: 250,
    season: 2,
    sourceShortcomingIds: ["11111111-1111-4111-8111-111111111111"],
    sourceQueryIds: ["22222222-2222-4222-8222-222222222222"],
  });
});

Deno.test("admin request validation: billing config accepts rates and policy copy", async () => {
  const payload = await validateUpdateBillingConfigRequest(
    new Request("https://example.com/api/admin/billing-config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canonical_light_per_usd: 100,
        wallet_light_per_usd: 100,
        wire_light_per_usd: 100,
        payout_light_per_usd: 100,
        platform_fee_rate: 0.15,
        min_withdrawal_light: 5000,
        card_minimum_cents: 2500,
        wire_minimum_cents: 2500,
        cloud_unit_light_per_1k: 1,
        worker_ms_per_cloud_unit: 250,
        capacity_rate_card_version: 1,
        capacity_d1_read_light_per_million_rows: 0.1,
        capacity_d1_write_light_per_million_rows: 100,
        capacity_kv_read_light_per_million_operations: 50,
        capacity_kv_write_light_per_million_operations: 500,
        capacity_kv_delete_light_per_million_operations: 500,
        capacity_kv_list_light_per_million_operations: 500,
        capacity_r2_class_a_light_per_million_operations: 450,
        capacity_r2_class_b_light_per_million_operations: 36,
        capacity_r2_delete_light_per_million_operations: 0,
        capacity_queue_light_per_million_operations: 40,
        d1_read_rows_per_cloud_unit: 100,
        d1_write_rows_per_cloud_unit: 1,
        r2_ops_per_cloud_unit: 1,
        kv_ops_per_cloud_unit: 1,
        widget_pulls_per_cloud_unit: 1,
        storage_free_bytes: 104857600,
        storage_light_per_gb_month: 100,
        publish_deposit_enabled: false,
        publisher_min_publish_balance_light: 1000,
        published_hosting_meter_enabled: false,
        payout_policy_copy: "Payouts run monthly.",
      }),
    }),
  );

  assertEquals(payload, {
    canonical_light_per_usd: 100,
    wallet_light_per_usd: 100,
    wire_light_per_usd: 100,
    payout_light_per_usd: 100,
    platform_fee_rate: 0.15,
    min_withdrawal_light: 5000,
    card_minimum_cents: 2500,
    wire_minimum_cents: 2500,
    cloud_unit_light_per_1k: 1,
    worker_ms_per_cloud_unit: 250,
    capacity_rate_card_version: 1,
    capacity_d1_read_light_per_million_rows: 0.1,
    capacity_d1_write_light_per_million_rows: 100,
    capacity_kv_read_light_per_million_operations: 50,
    capacity_kv_write_light_per_million_operations: 500,
    capacity_kv_delete_light_per_million_operations: 500,
    capacity_kv_list_light_per_million_operations: 500,
    capacity_r2_class_a_light_per_million_operations: 450,
    capacity_r2_class_b_light_per_million_operations: 36,
    capacity_r2_delete_light_per_million_operations: 0,
    capacity_queue_light_per_million_operations: 40,
    d1_read_rows_per_cloud_unit: 100,
    d1_write_rows_per_cloud_unit: 1,
    r2_ops_per_cloud_unit: 1,
    kv_ops_per_cloud_unit: 1,
    widget_pulls_per_cloud_unit: 1,
    storage_free_bytes: 104857600,
    storage_light_per_gb_month: 100,
    publish_deposit_enabled: false,
    publisher_min_publish_balance_light: 1000,
    published_hosting_meter_enabled: false,
    payout_policy_copy: "Payouts run monthly.",
  });

  await assertRejects(
    () =>
      validateUpdateBillingConfigRequest(
        new Request("https://example.com/api/admin/billing-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet_light_per_usd: 95.5 }),
        }),
      ),
    RequestValidationError,
    "wallet_light_per_usd must be an integer Light-per-USD rate",
  );

  await assertRejects(
    () =>
      validateUpdateBillingConfigRequest(
        new Request("https://example.com/api/admin/billing-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ worker_ms_per_cloud_unit: 250.5 }),
        }),
      ),
    RequestValidationError,
    "worker_ms_per_cloud_unit must be an integer",
  );

  await assertRejects(
    () =>
      validateUpdateBillingConfigRequest(
        new Request("https://example.com/api/admin/billing-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publish_deposit_enabled: "false" }),
        }),
      ),
    RequestValidationError,
    "publish_deposit_enabled must be a boolean",
  );

  await assertRejects(
    () =>
      validateUpdateBillingConfigRequest(
        new Request("https://example.com/api/admin/billing-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      ),
    RequestValidationError,
    "At least one billing config field is required",
  );
});

Deno.test("admin request validation: update gap rejects empty and validates status", async () => {
  await assertRejects(
    () =>
      validateUpdateGapRequest(
        new Request("https://example.com/api/admin/gaps/id", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      ),
    RequestValidationError,
    "At least one gap field is required",
  );

  const payload = await validateUpdateGapRequest(
    new Request("https://example.com/api/admin/gaps/id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "fulfilled",
        fulfilled_by_app_id: "33333333-3333-4333-8333-333333333333",
        fulfilled_by_user_id: null,
      }),
    }),
  );

  assertEquals(payload, {
    status: "fulfilled",
    fulfilledByAppId: "33333333-3333-4333-8333-333333333333",
    fulfilledByUserId: null,
  });
});

Deno.test("admin request validation: assessment updates require at least one field", async () => {
  await assertRejects(
    () =>
      validateRecordAssessmentRequest(
        new Request("https://example.com/api/admin/assess/id", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      ),
    RequestValidationError,
    "At least one of agent_score, agent_notes, proposed_points required",
  );

  const payload = await validateRecordAssessmentRequest(
    new Request("https://example.com/api/admin/assess/id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_score: 92,
        proposed_points: 400,
      }),
    }),
  );

  assertEquals(payload, {
    agentScore: 92,
    proposedPoints: 400,
  });
});

Deno.test("admin request validation: approve assessment, topup, and app curation are strongly typed", async () => {
  const approvePayload = await validateApproveAssessmentRequest(
    new Request("https://example.com/api/admin/approve/id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        awarded_points: 500,
        reviewed_by: "launch-admin",
      }),
    }),
  );
  assertEquals(approvePayload, {
    awardedPoints: 500,
    reviewedBy: "launch-admin",
  });

  const topupPayload = await validateTopUpBalanceRequest(
    new Request("https://example.com/api/admin/balance/user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_light: 2500 }),
    }),
  );
  assertEquals(topupPayload, { amountLight: 2500 });

  const categoryPayload = await validateSetAppCategoryRequest(
    new Request("https://example.com/api/admin/apps/id/category", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "ops" }),
    }),
  );
  assertEquals(categoryPayload, { category: "ops" });

  const featuredPayload = await validateSetAppFeaturedRequest(
    new Request("https://example.com/api/admin/apps/id/featured", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featured: true }),
    }),
  );
  assertEquals(featuredPayload, { featured: true });

  await assertRejects(
    () =>
      validateSetAppFeaturedRequest(
        new Request("https://example.com/api/admin/apps/id/featured", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ featured: "yes" }),
        }),
      ),
    RequestValidationError,
    "featured must be a boolean",
  );
});
