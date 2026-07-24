import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCloudflareWorkerVersionInventory,
} from "./parse-cloudflare-worker-version-inventory.mjs";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_VERSION_ID = "22222222-2222-4222-8222-222222222222";

function item(id = VERSION_ID) {
  return { id, number: 1 };
}

function envelope(result) {
  return {
    success: true,
    errors: [],
    messages: [],
    result,
  };
}

test("accepts Cloudflare's documented result.items envelope", () => {
  assert.deepEqual(
    parseCloudflareWorkerVersionInventory(
      envelope({ items: [item(), item(SECOND_VERSION_ID)] }),
    ),
    [item(), item(SECOND_VERSION_ID)],
  );
});

test("accepts the deployable=true legacy result array envelope", () => {
  assert.deepEqual(
    parseCloudflareWorkerVersionInventory(
      envelope([item(), item(SECOND_VERSION_ID)]),
    ),
    [item(), item(SECOND_VERSION_ID)],
  );
});

test("accepts the observed legacy result array envelope without errors", () => {
  assert.deepEqual(
    parseCloudflareWorkerVersionInventory({
      success: true,
      result: [item(), item(SECOND_VERSION_ID)],
    }),
    [item(), item(SECOND_VERSION_ID)],
  );
});

test("accepts a successful known envelope with a null errors marker", () => {
  assert.deepEqual(
    parseCloudflareWorkerVersionInventory({
      success: true,
      errors: null,
      result: { items: [item(), item(SECOND_VERSION_ID)] },
    }),
    [item(), item(SECOND_VERSION_ID)],
  );
});

test("accepts the legacy result array with a null errors marker", () => {
  assert.deepEqual(
    parseCloudflareWorkerVersionInventory({
      success: true,
      errors: null,
      result: [item(), item(SECOND_VERSION_ID)],
    }),
    [item(), item(SECOND_VERSION_ID)],
  );
});

for (
  const [name, payload, message] of [
    ["non-object response", null, /not a JSON object/u],
    [
      "failed response",
      { success: false, errors: [{ code: 10000 }], result: null },
      /success=false, errors=array\(1\)/u,
    ],
    [
      "failed response with null errors",
      { success: false, errors: null, result: [item()] },
      /success=false, errors=null/u,
    ],
    [
      "documented envelope with missing errors",
      { success: true, result: { items: [item()] } },
      /errors=missing/u,
    ],
    [
      "legacy envelope with malformed errors object",
      { success: true, errors: {}, result: [item()] },
      /errors=object/u,
    ],
    [
      "legacy envelope with returned errors",
      { success: true, errors: [{ code: 10000 }], result: [item()] },
      /errors=array\(1\)/u,
    ],
    [
      "unsupported result",
      envelope({ versions: [item()] }),
      /unsupported result envelope/u,
    ],
    [
      "null errors with unsupported result",
      { success: true, errors: null, result: { versions: [item()] } },
      /unsupported result envelope/u,
    ],
    [
      "empty inventory",
      envelope([]),
      /expected 1-100 deployable versions/u,
    ],
    [
      "oversized inventory",
      envelope(
        Array.from({ length: 101 }, (_, index) =>
          item(
            `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          )
        ),
      ),
      /expected 1-100 deployable versions/u,
    ],
    [
      "malformed version ID",
      envelope([item("not-a-version")]),
      /malformed ID/u,
    ],
    [
      "duplicate version ID",
      envelope([item(), item(VERSION_ID.toUpperCase())]),
      /duplicate ID/u,
    ],
  ]
) {
  test(`fails closed on ${name}`, () => {
    assert.throws(
      () => parseCloudflareWorkerVersionInventory(payload),
      message,
    );
  });
}
