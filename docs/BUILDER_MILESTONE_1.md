# Builder Milestone 1

Milestone 1 reduces coding-agent context and retransmission by adding three
composable primitives. Existing `files` workflows remain supported.

## Content-addressed staged bundles

```ts
const staged = await gx.stage({ files });

const tested = await gx.test({
  bundle_id: staged.bundle_id,
  function_name: "extract_invoice",
  test_args: fixture,
});

await gx.upload({
  bundle_id: staged.bundle_id,
  test_attestation: tested.test_attestation,
  name: "Invoice Agent",
});
```

An incremental edit sends only changed source:

```ts
const next = await gx.stage({
  base_bundle_id: staged.bundle_id,
  files: [{ path: "index.ts", content: nextIndexSource }],
  delete_paths: ["obsolete.ts"],
});
```

Bundle IDs are deterministic over the ordered path/content-hash set. Manifests
and blobs are owner-scoped in R2. Bundle resolution checks expiry, blob hashes,
byte sizes, and the complete decoded source hash before test or upload. Staging
leases are short-lived; deployed version metadata retains `bundle_id` and
`source_hash` as lineage while deployed source remains in version storage.

Every new incremental manifest refreshes each unique referenced blob before the
manifest is published. This prevents an unchanged, older blob from expiring
while a newer manifest still references it. Identical contents across multiple
paths are stored and refreshed once.

`gx.stage` returns:

```ts
{
  bundle_id,
  source_hash,
  file_count,
  size_bytes,
  changed_files,
  reused_files,
  deleted_files,
  created_at,
  expires_at,
}
```

`gx.stage` is fail-closed behind a distributed limit of 10 requests per owner
per minute and an atomic active-object quota: 100 MiB and 10,000 unique
owner-scoped blobs/manifests. Admission happens before the first R2 write.
Content hashes reused by multiple bundles count once; their reservation is
extended when the object is refreshed. Each publication gets its own opaque
reservation claim, so a failed R2 write can release that claim without
shortening a pre-existing or concurrent claim for reused content. The quota
ledger retains successful reservations for eight days—the exact seven-day R2
lifecycle plus one day of asynchronous collector margin.

Each resolved bundle may contain at most 50 files and 50 MiB of decoded source.
Every path must use an allowed Galactic source/configuration extension; the same
admission policy applies to initial and incremental stages.

WebAssembly source is byte-oriented: `.wasm` files must be sent with
`encoding: "base64"`. Galactic decodes them once and carries the exact bytes
through source hashing, stage quota, blob storage, incremental resolution,
testing, upload storage, and signed artifact hashes. Base64-encoded text is
decoded as UTF-8 and remains hash-equivalent to the same source sent as text.

Production must keep an R2 lifecycle rule on the shared app bucket for the
`staged-bundles/` prefix that deletes objects after exactly seven days. The
public API lease is 24 hours. Verify the rule during release operations with:

```sh
npx wrangler r2 bucket lifecycle list ultralight-apps
```

The API rejects an expired manifest even before the lifecycle collector removes
its objects. A shorter physical rule can invalidate a live API lease. Do not
apply the rule to `apps/`, which contains deployed source.

## Coding capsule

```ts
const full = await gx.project({
  app_id,
  view: "coding_capsule",
});

const changed = await gx.project({
  app_id,
  view: "coding_capsule",
  since_revision: full.revision,
});
```

The capsule is the compact snapshot a coding agent previously had to assemble
from `gx.discover({scope:"inspect"})`, `gx.download`, `gx.routine`, `gx.grants`,
and owner web surfaces. It includes:

- identity, directive, and live/candidate release state;
- function input/output contracts;
- schema-only storage information;
- configured routines and manifest routine templates;
- permissions, access policy, network policy, and cross-Agent wiring;
- the effective secret-free default inference route (billing mode, provider,
  upstream provider, model, and whether its required configuration is present)
  plus installer model overrides;
- declared settings and key presence, never values;
- recent failure summaries;
- source file hashes and staged-bundle lineage.

It excludes source contents, secrets, stored application data, full logs, and
reasoning traces. Revisions are content-addressed. `since_revision` returns a
nested delta plus JSON Pointer `removed_paths`, or `not_modified: true`.
Arrays are replaced as units rather than item-diffed. Revisions are owner/app
scoped and have a 30-day logical lease. Equivalent set-like platform rows are
sorted before hashing, so database return order does not create a false
revision. A canonical capsule is limited to 2 MiB. Request a new full capsule
if a prior revision is invalid, expired, or no longer available. Agent deletion
attempts immediate capsule cleanup; the exact 31-day `project-capsules/`
lifecycle rule is the physical-retention backstop if that best-effort cleanup
is temporarily unavailable.

Full response:

```ts
{
  view: "coding_capsule",
  app_id,
  revision,
  revision_created_at,
  revision_expires_at,
  capsule,
}
```

Delta response:

```ts
{
  view: "coding_capsule",
  app_id,
  revision,
  revision_created_at,
  revision_expires_at,
  since_revision,
  not_modified,
  delta,
  removed_paths,
}
```

Production must keep a second, prefix-scoped R2 lifecycle rule that deletes
`project-capsules/` objects after exactly 31 days. The API's 30-day lease is
authoritative; the extra day is collector margin. Never apply either Builder
lifecycle rule to deployed source under `apps/`.

Use `gx.project` to orient and decide what changed. Use `gx.download` only when
the source itself is needed.

## Native structured output

```ts
const response = await galactic.ai({
  messages: [
    { role: "user", content: documentText },
  ],
  output_schema: {
    name: "invoice",
    strict: true,
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        total: { type: "number" },
      },
      required: ["id", "total"],
      additionalProperties: false,
    },
  },
});

const invoice = response.output;
```

Galactic translates `output_schema` to the provider's native strict
`json_schema` response format in both the in-process and dynamic-worker AI
paths. It parses and verifies the result again before exposing
`response.output`. The direct per-Agent `ultralight.ai` MCP tool advertises and
forwards the same contract. Galactic never falls back to “return JSON”
prompting.

Structured-output failures retain an error code on the thrown runtime error:

- `invalid_output_schema`
- `structured_output_unsupported`
- `structured_output_invalid_json`
- `structured_output_schema_mismatch`

`strict` may be omitted or `true`; `false` is rejected. The schema is limited
to 64 KiB and depth 32; the structured result is limited to 2 MiB, depth 64,
50,000 combined traversal/schema steps, and 16 MiB of cumulative canonical
comparison work. `$ref` must target the local schema and reference cycles are
rejected.

Provider work is charged or recorded before Galactic performs its final local
validation. A provider result that fails the schema therefore still reports
and settles the provider's token usage; schema mismatch does not make completed
inference free.

Galactic admits an explicit, locally enforced JSON Schema subset:

- metadata/definitions: `$schema`, `$id`, `$anchor`, `$comment`, `$defs`,
  `definitions`, `$ref`, `title`, `description`, `default`, `examples`,
  `deprecated`, `readOnly`, and `writeOnly`;
- core composition: `type`, `const`, `enum`, `allOf`, `anyOf`, `oneOf`, and
  `not`;
- strings/numbers: `minLength`, `maxLength`, `minimum`, `maximum`,
  `exclusiveMinimum`, `exclusiveMaximum`, and `multipleOf`;
- arrays: `minItems`, `maxItems`, `uniqueItems`, `prefixItems`, and `items`;
- objects: `minProperties`, `maxProperties`, `required`, `properties`, and
  `additionalProperties`.

Every other keyword—including `pattern`, `format`, `contains`,
`patternProperties`, `propertyNames`, conditionals, and remote references—is
rejected before provider or billing work. This is deliberate: Galactic never
claims a value was verified for an assertion its local validator ignored.

Provider-reported input/output token counts remain the authoritative usage
numbers. Estimated credit cost continues to use those counts and the platform's
model pricing table. Post-provider JSON/schema failures retain that usage for
host-side billing, receipts, and direct protocol responses; deployed Agent SDK
calls surface the failure as an exception with a stable `code`.
