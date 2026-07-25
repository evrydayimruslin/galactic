// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyOperatorItemAttentionAction,
  OperatorItemAttentionStateError,
} from "./operator-item-attention-state.ts";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-24T18:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    item_id: ITEM_ID,
    user_id: USER_ID,
    state: "open",
    read_at: "2026-07-24T18:00:00.000Z",
    snoozed_until: null,
    dismissed_at: null,
    created_at: "2026-07-24T17:00:00.000Z",
    updated_at: "2026-07-24T18:00:00.000Z",
    ...overrides,
  };
}

const dependencies = {
  now: NOW,
  supabaseUrl: "https://supabase.test",
  serviceRoleKey: "service-role-test",
};

Deno.test("operator item Attention applies an owner-scoped presentation action", async () => {
  let request: Request | null = null;
  const result = await applyOperatorItemAttentionAction(
    {
      userId: USER_ID,
      itemId: ITEM_ID,
      action: "snooze",
      snoozedUntil: "2026-07-24T19:00:00.000Z",
    },
    {
      ...dependencies,
      fetchFn: (input, init) => {
        request = new Request(input, init);
        return Promise.resolve(Response.json([row({
          state: "snoozed",
          snoozed_until: "2026-07-24T19:00:00.000Z",
        })]));
      },
    },
  );
  assertEquals(result, {
    itemId: ITEM_ID,
    attention: {
      state: "snoozed",
      readAt: "2026-07-24T18:00:00.000Z",
      snoozedUntil: "2026-07-24T19:00:00.000Z",
      dismissedAt: null,
    },
  });
  assertEquals(
    request?.url,
    "https://supabase.test/rest/v1/rpc/apply_operator_item_attention_action",
  );
  assertEquals(await request!.json(), {
    p_user_id: USER_ID,
    p_item_id: ITEM_ID,
    p_action: "snooze",
    p_snoozed_until: "2026-07-24T19:00:00.000Z",
  });
});

Deno.test("operator item Attention rejects malformed or excessive snoozes before storage", async () => {
  let fetched = false;
  for (
    const snoozedUntil of [
      "2026-07-24T17:00:00.000Z",
      "2026-09-24T18:00:00.000Z",
      "not-a-date",
    ]
  ) {
    const error = await assertRejects(
      () =>
        applyOperatorItemAttentionAction(
          {
            userId: USER_ID,
            itemId: ITEM_ID,
            action: "snooze",
            snoozedUntil,
          },
          {
            ...dependencies,
            fetchFn: () => {
              fetched = true;
              return Promise.resolve(Response.json([row()]));
            },
          },
        ),
      OperatorItemAttentionStateError,
    );
    assertEquals(error.code, "INVALID_REQUEST");
  }
  assertEquals(fetched, false);
});

Deno.test("operator item Attention fails closed on cross-owner and malformed states", async () => {
  const crossOwner = await assertRejects(
    () =>
      applyOperatorItemAttentionAction(
        {
          userId: USER_ID,
          itemId: ITEM_ID,
          action: "dismiss",
        },
        {
          ...dependencies,
          fetchFn: () =>
            Promise.resolve(Response.json([row({
              user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              state: "dismissed",
              dismissed_at: "2026-07-24T18:00:00.000Z",
            })])),
        },
      ),
    OperatorItemAttentionStateError,
  );
  assertEquals(crossOwner.code, "INVALID_RESPONSE");

  const malformedOwner = await assertRejects(
    () =>
      applyOperatorItemAttentionAction(
        {
          userId: USER_ID,
          itemId: ITEM_ID,
          action: "mark_read",
        },
        {
          ...dependencies,
          fetchFn: () =>
            Promise.resolve(Response.json([row({
              user_id: "not-a-user-id",
            })])),
        },
      ),
    OperatorItemAttentionStateError,
  );
  assertEquals(malformedOwner.code, "INVALID_RESPONSE");
  assertEquals(malformedOwner.status, 503);

  const missing = await assertRejects(
    () =>
      applyOperatorItemAttentionAction(
        {
          userId: USER_ID,
          itemId: ITEM_ID,
          action: "dismiss",
        },
        {
          ...dependencies,
          fetchFn: () => Promise.resolve(Response.json([])),
        },
      ),
    OperatorItemAttentionStateError,
  );
  assertEquals(missing.code, "NOT_FOUND");
});
