# Galactic Compute v1: Cloudflare provisioning and rollout runbook

Status: implementation runbook. Production enablement is blocked until every
launch gate in this document is evidenced in staging.

This runbook provisions the disposable Linux body behind
`galactic.compute()`. Cloudflare Containers and the Sandbox SDK are available
on the Workers Paid plan. The release workflow builds and smokes the image,
pushes it to Cloudflare's registry, resolves its immutable digest, and deploys
that digest; a working Docker-compatible engine is therefore required.
See Cloudflare's current [Containers overview](https://developers.cloudflare.com/containers/),
[Containers deployment guide](https://developers.cloudflare.com/containers/get-started/),
and [Sandbox SDK overview](https://developers.cloudflare.com/sandbox/).

## Non-negotiable runtime boundary

- The API Worker is the control plane. It authenticates the parent execution,
  checks the exact Agent/function/owner policy, reserves usage, admits a run,
  mints the opaque job token, resolves explicitly bound secrets, settles usage,
  and writes the receipt.
- `galactic-compute` is a private execution plane. It may claim an admitted run,
  stage artifacts, start `developer-v1`, execute, capture outputs,
  and report completion. It has no ambient Supabase, Cloudflare, human,
  account, Agent, or provider credentials; it receives only the explicit
  Agent-configured secret values bound to that lease long enough to stage them
  for the body.
- A body receives only its short-lived opaque job token plus secret values the
  owner explicitly mapped to that Agent/function. The body cannot authorize
  itself; every `gx` call is re-authorized by the API control plane.
- There is no public Compute Worker route. Its default HTTP handler returns
  `404`; API-to-execution calls use a named service binding, and body-to-API
  calls use intercepted `https://galactic.internal/v1/*` traffic over another
  named service binding.
- R2 is private. Artifacts are served through authorized API responses, not a
  public bucket or R2 development URL.
- Admission is off until the whole chain is ready. A deployed image by itself
  is not a launch.

Cloudflare service bindings make Worker-to-Worker calls without a public URL,
and named `WorkerEntrypoint` exports let each service expose only its internal
role. See [Service binding RPC and named entrypoints](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/).

## Deployed topology

```text
Agent function
  -> API Worker / ComputeBinding
       -> policy + secret metadata + reserve + run ledger (Supabase)
       -> COMPUTE_QUEUE (Cloudflare Queue producer)
       -> COMPUTE_PLANE.executeRun/cancelRun (private named service binding)
            -> galactic-compute / ComputePlane
                 -> ComputeStandard Durable Object + Sandbox container
                 -> COMPUTE_ARTIFACTS (private R2 binding)

Disposable body
  -> gx + opaque lease token
  -> https://galactic.internal/v1/* (Sandbox outbound interception)
  -> CONTROL_PLANE / ComputeControlPlane (private named service binding)
  -> token introspection + exact server-side authority + receipts/artifacts
```

The SDK transport must remain `SANDBOX_TRANSPORT=rpc`. Cloudflare recommends
RPC and removed the older transports from post-July 9, 2026 SDK releases. RPC
also multiplexes file and command operations over one connection. See
[Sandbox transport modes](https://developers.cloudflare.com/sandbox/configuration/transport/).

## Resource inventory

Production and staging use separate queues, buckets, Workers, and container
capacity. They must be in the same Cloudflare account as their corresponding
API Worker so service bindings stay private.

| Resource | Production | Staging | Source of truth |
|---|---|---|---|
| API Worker | `ultralight-api` | `ultralight-api-staging` | API Wrangler config |
| API private entrypoint | `ComputeControlPlane` | `ComputeControlPlane` | API Worker export |
| Compute Worker | `galactic-compute` | `galactic-compute-staging` | `compute-worker/wrangler*.toml` |
| Compute private entrypoint | `ComputePlane` | `ComputePlane` | `compute-worker/src/index.ts` |
| Dispatch queue | `galactic-compute` | `galactic-compute-staging` | Worker configs |
| Dead-letter queue | `galactic-compute-dlq` | `galactic-compute-staging-dlq` | Worker configs |
| Reconciliation dead-letter queue | `galactic-compute-reconciliation-dlq` | `galactic-compute-staging-reconciliation-dlq` | API Worker config |
| Artifact bucket | `galactic-compute-artifacts` | `galactic-compute-artifacts-staging` | Worker configs |
| Sandbox DO binding | `COMPUTE_STANDARD` | `COMPUTE_STANDARD` | Compute Worker config |
| Container class | `ComputeStandard` | `ComputeStandard` | Compute Worker source/config |
| Instance type | `standard-1` | `standard-1` | Compute Worker config |
| Maximum instances | `20` | `5` | Compute Worker config |
| Queue consumer max concurrency | `15` | `3` | Compute Worker config |
| Direct/recovery instance headroom | `5` | `2` | maximum minus queue concurrency |
| Runtime profile | `developer-v1` | `developer-v1` | pinned Docker image |
| Maximum artifact budget | `1 GiB` | `1 GiB` | shared v1 contract and SQL policy |
| Required live workspace reserve | `512 MiB` | `512 MiB` | Compute executor preflight |
| Sandbox SDK | `0.12.3` | `0.12.3` | package and Docker base image |

Queue consumer `max_concurrency` must remain strictly below Container
`max_instances`. The current `15 < 20` production and `3 < 5` staging limits
keep capacity available for direct synchronous jobs and operational recovery
when async deliveries saturate the queue consumer. This is safety headroom,
not a per-job availability guarantee. Keep production admission in `canary`
until deployed mixed direct/queue load tests prove the margin under cold starts,
retries, cancellation, teardown, and recovery traffic; static configuration is
not evidence for promotion to `global`.

Expected bindings are:

- API Worker: `COMPUTE_QUEUE` producer and `COMPUTE_PLANE` service binding to
  the environment's Compute Worker, named entrypoint `ComputePlane`.
- Compute Worker: `COMPUTE_ARTIFACTS`, `COMPUTE_STANDARD`, and
  `CONTROL_PLANE` service binding to the environment's API Worker, named
  entrypoint `ComputeControlPlane`.

Do not substitute URLs or shared secrets for either service binding.
Cloudflare bindings carry capability without exposing an underlying credential
to the Worker. See [Workers bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/).

## Account prerequisites

Before provisioning either environment:

1. Confirm the target Cloudflare account has Workers Paid and Containers
   enabled. In the dashboard, **Workers & Pages → Containers** must be present.
2. Use Node.js 22 or newer. The pinned Wrangler version rejects Node 20.
3. Install and start Docker Desktop, Colima, or another Docker-compatible
   BuildKit engine.
4. Authenticate Wrangler to the intended account. The deploy identity needs
   Workers Scripts, Containers, Durable Objects, Queues, R2 write, and service
   binding permissions. R2 lifecycle changes specifically require Workers R2
   Storage Write.
5. Confirm staging and production Supabase projects are separate and their
   normal API Worker secrets are already configured. Never copy those secrets
   to the Compute Worker.
6. Configure the GitHub `staging` and `production` environments with
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, at least one required
   reviewer, **Prevent self-review** enabled, administrator bypass disabled,
   and the repository/environment variable `COMPUTE_SANDBOX_BASE_IMAGE`. The
   admission workflow reads the environment protection policy through the
   GitHub API and fails before Cloudflare access unless all three controls are
   present (`required_reviewers`, `prevent_self_review=true`, and
   `can_admins_bypass=false`). The base-image
   variable must be the reviewed complete
   `docker.io/cloudflare/sandbox:0.12.3-python@sha256:<64 lowercase hex>`
   reference. Never substitute an unreviewed digest or a mutable tag.
7. Configure `COMPUTE_JOB_TOKEN_PEPPER` and
   `COMPUTE_EMERGENCY_STOP_TOKEN` on each API Worker with `wrangler secret put`.
   Both must be independently generated random values of at least 32 bytes.
   Store the emergency token in the approved on-call secret manager; never
   reuse or expose `SUPABASE_SERVICE_ROLE_KEY`. The workflow verifies only the
   two secret names and never reads, creates, or replaces their values.
   Likewise, migrations, queues, buckets, lifecycle rules, and environment
   approval policy are operator-provisioned inputs, not deployment side effects.
8. Keep `COMPUTE_ROLLOUT_MODE=canary` and set
   `COMPUTE_CANARY_ALLOWLIST` only to reviewed exact
   `<owner UUID>/<Agent UUID>` pairs before enabling admission. Malformed or
   empty canary configuration fails closed server-side. `global` is a separate
   explicit promotion, not the default.
9. Record the current production API version, Compute Worker version (if any),
   image digest, queue backlog, and count of nonterminal Compute runs before a
   change. This is the rollback baseline.
10. Run the canonical `Supabase DB` (staging) or `Supabase Production DB`
    workflow at the exact Compute release SHA and retain its successful run ID.
    The schema workflows pin Checkout, `supabase/setup-cli`, and Supabase CLI
    `2.109.1`; a Compute release will not accept another workflow, SHA, or a run
    whose environment deploy job did not succeed.

Local preflight:

```bash
node --version
docker info
cd compute-worker
npm ci
npx wrangler whoami
npm run verify
export COMPUTE_SANDBOX_BASE_IMAGE='docker.io/cloudflare/sandbox:0.12.3-python@sha256:<reviewed-digest>'
docker pull "$COMPUTE_SANDBOX_BASE_IMAGE"
./scripts/build-image.sh galactic-compute:developer-v1
./scripts/smoke-image.sh galactic-compute:developer-v1
npx wrangler deploy --config wrangler.staging.toml \
  --dry-run --containers-rollout=none
```

`npm run image:smoke` must verify the pinned coding CLIs, the baked Galactic
CLI/Deno job path, and the actual Chromium installation. A TypeScript pass does
not establish image viability.

## One-time provisioning

Run these against the intended account. They are explicit even where Wrangler
can auto-create a referenced queue; explicit creation prevents a typo from
quietly becoming a third production resource.

```bash
cd compute-worker

# Staging
npx wrangler queues create galactic-compute-staging
npx wrangler queues create galactic-compute-staging-dlq
npx wrangler queues create galactic-compute-staging-reconciliation-dlq
npx wrangler r2 bucket create galactic-compute-artifacts-staging

# Production
npx wrangler queues create galactic-compute
npx wrangler queues create galactic-compute-dlq
npx wrangler queues create galactic-compute-reconciliation-dlq
npx wrangler r2 bucket create galactic-compute-artifacts
```

Verify names before deploying:

```bash
npx wrangler queues list
npx wrangler r2 bucket list
```

The execution consumer uses batch size `1`, batch timeout `1`, three retries,
and the environment's Compute DLQ. The API consumes that DLQ one message at a
time, retries fenced destroy-and-settle reconciliation up to ten times, and
uses the separate reconciliation DLQ as its final evidence sink. Cloudflare
Queues is at-least-once: a delivery can be repeated, so database claims,
fences, terminal transitions, receipts, and settlement remain compare-and-swap
and idempotent. See
[Dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
and [Queue retries](https://developers.cloudflare.com/queues/configuration/batching-retries/).

The v1 public async timeout ceiling is eight minutes (`480000` ms). A push
Queue consumer has a hard 15-minute wall-time limit, so the rest of that
envelope is intentionally retained for the 195-second bounded startup budget,
private control-plane round trips, artifact finalization, settlement, and the
15-second destruction allowance. Treat any configuration or migration that
admits a larger timeout as a release blocker. Jobs that genuinely need longer
durability must move to a later Workflows-backed orchestration path; do not
raise this value on the Queue consumer.

Synchronous Compute defaults to and is capped at 30 seconds of command time.
Admission uses the parent Agent execution's host-derived deadline and refuses
before creating a run or either form of economic backing unless 195 seconds of
startup, the command timeout, 15 seconds of teardown, and 30 seconds of
parent-response headroom all still fit. At the default 30-second command
timeout, the lease reserve is exactly `0.49344` Light:
`(30,000 + 195,000 + 15,000) * 0.000002056`. Exercise both an early successful
sync call and a deliberately late `COMPUTE_SYNC_DEADLINE_REQUIRES_ASYNC`
refusal; a long or composed job belongs on the async path.

### R2 lifecycle

Artifact deletion is controlled by database state and the reconciler, never by
raw object age. A ready output can become a later run's input without copying
the object; an R2 expiry rule could therefore erase a newly authorized input
while both database rows still promise it exists.

The v1 retention contract is fixed and intentionally small:

- a ready output receives an immutable `expires_at` exactly 30 days after its
  ready commit;
- admission accepts only a direct, exact, ready output whose `expires_at` is
  still in the future. An accepted input alias pins that source object until
  the dependent run is terminal, even if the source expires meanwhile;
- terminal input aliases are tombstoned after the reconciler's 15-minute
  safety age. An output is eligible only after expiry, after every ready alias
  is gone, and after any owner-download protection has ended;
- an owner download must atomically lease the ready, unexpired row before R2
  is read. The one-hour deletion lease protects an in-progress response but
  does not extend the artifact's published expiry;
- each owner may retain at most 10,000 physical output objects and 10 GiB of
  physical output bytes. Input aliases share their source and count zero. A
  pending reservation counts immediately, and quota is released only after
  the exact R2 delete is confirmed in `object_deleted_at`;
- tombstoned-but-unconfirmed outputs are retried from a bounded database scan,
  so an R2-success/database-failure split cannot leak quota forever.
- a redacted terminal request is checkpointed under the private
  `_galactic-control/v1/compute-finalization/` prefix immediately before its
  first control-plane call. Redelivery replays this record before claim, then
  deletes it only after the idempotent terminal response is observed;

For v1:

- do **not** configure `deleteObjectsTransition` for `compute-v1/`, a parent
  prefix, a child prefix, or the whole bucket;
- configure an exact one-day `deleteObjectsTransition` only for
  `_galactic-control/v1/compute-finalization/`. One day is longer than every
  v1 run/retry window, so it cannot race an active replay, while bounding a
  checkpoint abandoned after Queue/DLQ exhaustion;
- abort incomplete multipart uploads after at most one day;
- image inputs are versioned through the Container image registry, not stored
  as body-selected R2 toolpacks;
- receipts, reservation state, hashes, ready references, and object tombstones
  remain in the control-plane database and drive reconciler deletion.

```bash
npx wrangler r2 bucket lifecycle add \
  galactic-compute-artifacts-staging compute-incomplete-uploads compute-v1/ \
  --abort-multipart-days 1

npx wrangler r2 bucket lifecycle add \
  galactic-compute-artifacts compute-incomplete-uploads compute-v1/ \
  --abort-multipart-days 1

npx wrangler r2 bucket lifecycle add \
  galactic-compute-artifacts-staging compute-finalization-checkpoints \
  _galactic-control/v1/compute-finalization/ --expire-days 1

npx wrangler r2 bucket lifecycle add \
  galactic-compute-artifacts compute-finalization-checkpoints \
  _galactic-control/v1/compute-finalization/ --expire-days 1

npx wrangler r2 bucket lifecycle list galactic-compute-artifacts-staging
npx wrangler r2 bucket lifecycle list galactic-compute-artifacts
```

The deploy workflow reads canonical lifecycle JSON from the Cloudflare API and
rejects every enabled object-deletion rule whose prefix overlaps `compute-v1/`.
It also requires the one-day incomplete-multipart rule and the exact one-day
private finalization-checkpoint expiry. The database migration,
download lease, alias pin, physical quota, and minute reconciler are the sole
retention authority; changing the 30-day/10-GiB/10,000-object v1 contract needs
a reviewed forward migration and matching public-contract update. See
[R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

Keep both buckets private:

- do not enable an `r2.dev` URL;
- do not attach a custom domain;
- do not add bucket-wide CORS;
- do not mint R2 API credentials for a body;
- expose downloads only through a short-lived, owner-authorized API response.

The deploy and enable workflows query Cloudflare's managed-domain and
custom-domain APIs. They require `result.enabled=false` for the bucket's
managed `r2.dev` domain and an empty custom-domain list; documentation or a
bucket-info listing alone is not accepted as privacy evidence. These are
release/enable gates, not dependencies of emergency admission disable.

## First-deploy ordering

The two Workers have private bindings to one another. Bootstrap without ever
opening a public route:

1. Apply every checked-in migration through the canonical environment schema
   workflow and record its successful exact-SHA run ID.
2. Deploy the API candidate with `ComputeControlPlane` exported and global
   Compute admission disabled. On a first install, omit its outbound
   `COMPUTE_PLANE` binding until the Compute Worker name exists. Read back one
   stable 100% API version and prove OFF / `canary` / empty allowlist before
   starting any Container rollout.
3. Deploy `galactic-compute-staging`; its `CONTROL_PLANE` binding now resolves
   to `ultralight-api-staging` / `ComputeControlPlane`.
4. Add/enable the API's `COMPUTE_PLANE` binding to
   `galactic-compute-staging` / `ComputePlane` and its `COMPUTE_QUEUE` producer;
   redeploy the API with admission still disabled.
5. Run connectivity and denial probes through internal operator code. The
   Compute Worker's public/default fetch must still return `404`.
6. Leave global admission off and complete every denial/connectivity probe that
   does not require admission.
7. Before the first staging enablement, set the server-owned canary allowlist to
   one exact Galactic-owned owner UUID/Agent UUID pair and inspect that Agent's
   enabled function policies. The canary gate is Agent-level; manifest and
   owner policy still provide the exact function-level authority.
8. Enable admission with `COMPUTE_ROLLOUT_MODE=canary` in a separately reviewed
   API deployment, complete the staging launch matrix, then turn admission off
   and verify drain/settlement.
9. Repeat the same migration/API/Compute/API order in production. Do not call
   it a one-Agent canary unless the exact server-side allowlist and that Agent's
   function policies are both evidenced.

Normal subsequent releases do not need the bootstrap omission. Deploy order is
database migration, API control plane with admission off, Compute Worker/image,
API exact environment digest with admission still off, then a separately
reviewed admission change.

Use **Actions → Compute Deploy** for either the one-time bootstrap or a normal
release. Select
`staging` from `main` (or `production` from an immutable `v*` tag), enter the
exact confirmation, provide the canonical successful schema workflow run ID,
attest that migrations and the API bootstrap are ready, then satisfy the
selected GitHub environment's reviewer gate. The workflow:

- on the first mutual-binding install, set `api_control_plane_ready=false` and
  `bootstrap_api_control_plane=true`; this creates the API control-plane target
  before the Compute Worker attempts to bind to it;
- on every normal release, use the inverse:
  `api_control_plane_ready=true` and `bootstrap_api_control_plane=false`.

Do not set both inputs true or both false. The first-install branch is a
one-time bootstrap, not an alternate steady-state deployment order.

1. binds the release to the exact successful schema workflow and environment
   deploy job at the release SHA, then records a deterministic checksum manifest
   of every `supabase/migrations/*.sql` file;
2. verifies Compute plus the API integration and dry-runs both Workers;
3. verifies—but never provisions—the exact queues, private R2 domain state,
   bucket lifecycle, and API token-pepper/emergency-stop secret names;
4. proves that the existing or first-install bootstrap API is one stable,
   admission-OFF version before Compute rollout;
5. builds and smokes the reviewed base image, emits an SPDX SBOM, blocks on
   every CRITICAL and every fixable HIGH vulnerability, pushes it, and resolves the
   Cloudflare registry digest;
6. deploys Compute with the `compute-<git SHA>` Worker-version tag, retries only
   within a bounded first-provisioning window, and polls `wrangler containers
   list --json` until exactly one named application is `active` or `ready` on
   the exact registry digest; then
   redeploys the API with `api-<git SHA>`, the same environment digest, and
   `COMPUTE_ENABLED=0`; verifies both are stable at 100%; verifies the API is
   exactly OFF / `canary` / empty allowlist; and records both exact version IDs
   and tags as the certified release pair; and
7. uploads the immutable evidence packet.

### Admission change workflow

Use **Actions → Compute Admission** only after **Compute Deploy** has completed
with admission off. This workflow is manual-only and serialized with both API
and Compute deployment. Its default action is `disable`; it deliberately has no
`global` enable option in v1.

For `staging`, dispatch from `main`. For `production`, dispatch from the exact
immutable `v*` tag used by Compute Deploy. Then satisfy the selected GitHub
environment's independent reviewer gate and enter the exact confirmation:

- disable: `DISABLE GALACTIC COMPUTE staging` or
  `DISABLE GALACTIC COMPUTE production`;
- enable: `ENABLE GALACTIC COMPUTE CANARY staging` or
  `ENABLE GALACTIC COMPUTE CANARY production`.

Both actions require the successful **Compute Deploy** run ID whose evidence
names the immutable API version certified OFF. An enable request additionally
requires:

- the successful **Compute Deploy** workflow run ID for the exact same git SHA
  and ref;
- explicit confirmation that all Compute migrations represented by that
  release are applied; and
- one to 50 unique canonical lowercase
  `<owner UUID>/<Agent UUID>` pairs. Slugs, wildcards, blank entries, duplicate
  pairs, malformed UUIDs, and an empty canary list fail before deployment.

Before enabling, the workflow verifies the source release run and evidence
artifact, the immutable image/environment digest, the exact certified API and
Compute version IDs and `api-<SHA>` / `compute-<SHA>` tags, the release's full
migration manifest against the current checkout, the exact successful canonical
schema run and deploy job, the artifact retention hash and policy, stable 100%
API/Compute versions and an `active`/`ready` exact-image Container application,
the certified API's OFF / `canary` / empty-allowlist state, exact
private service/queue/R2 bindings, queue/DLQ/bucket existence, safe R2 lifecycle,
disabled `r2.dev` access and no custom R2 domains,
and the presence of the job-token and emergency-stop secret **names**. It never
reads a secret value or receives a database credential. The operator attestation
remains a human assertion about the target database, but release provenance is
machine-bound to the canonical credentialed schema-deploy job and every migration
file, including capacity conservation and execution recovery.

Immediately before enablement, the workflow reads both live deployments again
and requires the exact certified OFF API ID and certified Compute ID at 100%.
It then uploads the enabled API with `--strict`, tag `api-<current SHA>`, only
the reviewed Compute vars changed explicitly, and `--keep-vars` for unrelated
configuration. A post-deploy read verifies the new version tag and all Compute
vars while requiring the certified Compute version to remain fixed.

Disable does not compile or upload source and does not depend on the current API
or Compute deployment being healthy. It resolves the exact certified OFF API
version from the reviewed Compute Deploy evidence, immutably reads that version
back from Cloudflare, verifies its tag/digest/OFF policy, dry-runs promotion,
then runs `wrangler versions deploy <certified-id>@100%`. Compensation after an
ambiguous enable/disable attempt uses the same version promotion and verifies
the exact ID, tag, `COMPUTE_ENABLED=0`, `canary`, and empty allowlist. This
path validates referenced release evidence internally but deliberately does not
compare it with the current checkout or require live Container/R2 readiness, so
a later source change or infrastructure incident cannot disable the fail-safe.
The workflow resolves release provenance before dependency installation, checks
out the certified release SHA into an isolated directory for `disable`, and runs
that release's pinned API/Wrangler lockfile. A broken later `api/package.json`,
lockfile, or source tree therefore does not become disable authority. Enable
continues to require the current checkout to equal the certified release. This
switch stops **new admission only**; accepted work continues to drain. Use the
separately authenticated emergency stop below when accepted execution must also
be terminated.

The compensation is durable once its step starts, but GitHub Actions cannot
guarantee that step will run if the runner is killed after Cloudflare accepts
an enable upload and before control returns to the workflow. Until a remote
control-plane watchdog/enable TTL exists, treat a lost or cancelled enable run
as an incident: immediately dispatch `disable` with the same certified Compute
Deploy run ID and verify the exact OFF-version promotion in Cloudflare. Never
cancel an in-progress enable workflow as an operational rollback mechanism.

Every attempted change uploads a sanitized `compute-admission-*` evidence
artifact containing the request actor/reason/ref, reviewer-policy summary,
selected bindings and exact certified/live version IDs and tags, release
provenance,
resource checks, dry-run output, deploy result, and post-deploy state. Secret
values and unfiltered Worker version metadata remain in runner temporary storage
and are removed before upload. GitHub retains this packet for 90 days; mirror it
to the approved long-term audit store when policy requires longer retention.

The independent **Compute CI** workflow runs the same locked image build,
smoke, SBOM, checksum-pinned Grype gate, Worker tests, and production/staging
dry runs for every relevant pull request. Both workflows retain the unfiltered
JSON finding set and fail before image push/deploy on any CRITICAL or fixable
HIGH finding. Any temporary exception must identify one exact
CVE/package, owner, rationale, and expiry; a blanket severity ignore is not an
acceptable launch gate. Neither workflow discovers or invents the base-image
digest.

Cloudflare notes that a first Container deployment can take several minutes to
become ready. Do not interpret early container errors as a reason to bypass the
private path. The release workflow retries first provisioning for a bounded
window and then fails unless `wrangler containers list --json` reports exactly
one target application as `active` or `ready`, with the exact released image and
an application version. The same exact-image readiness check runs again before
admission enablement. Wrangler 4.112.0's JSON mode returns one API page and
ignores `--per-page`; absence from that page therefore fails closed. Before an
account exceeds that page, replace this read with Cloudflare's supported
paginated application API rather than weakening the exact-name gate.

Record in the release packet:

- git SHA;
- Wrangler and Sandbox SDK versions;
- Dockerfile hash;
- locked toolchain hashes and SPDX SBOM;
- reviewed immutable base-image reference;
- Cloudflare image digest, not only its mutable name;
- API and Compute Worker deployment/version IDs;
- the complete deterministic migration manifest and its checksum, the canonical
  schema workflow/run/deploy-job evidence, and the exact artifact-retention,
  capacity-conservation, and execution-recovery migration checksums;
- resource names and account ID;
- staging smoke run IDs and receipt IDs;
- deployed `df -Pk /workspace` output before and after representative browser,
  office, and artifact jobs;
- cold-start, execution, capture, settlement, and teardown timings.

## Staging launch matrix

Run every case through a real owner-authorized Agent function. Directly calling
the Compute Worker does not exercise admission.

| Case | Required evidence |
|---|---|
| Basic sync | an early `timeout_ms <= 30000` call runs `pwd`, Node, Python, `git`, `rg`, `jq`, SQLite, and DuckDB; exit `0`; receipt settled |
| Late sync refusal | with insufficient parent time remaining, admission returns `COMPUTE_SYNC_DEADLINE_REQUIRES_ASYNC` before a run, hold, token, queue message, or body exists |
| Browser | Playwright launches pinned Chromium, loads an HTTPS page, captures a screenshot artifact |
| Documents/media | one minimal `ffmpeg`, `pandoc`, LibreOffice, Poppler, and Tesseract command |
| Async | admission returns a run ID; `galactic.compute.get()` observes terminal state |
| Input artifact | hash-verified R2 input appears only at its declared workspace path |
| Disk headroom | record live `/workspace` free bytes; an input that would breach the 512 MiB scratch reserve fails before its R2 object is copied or secrets are delivered |
| Output artifact | file and directory capture produce hashes, sizes, exact expiry, owner-authorized links, alias-safe retention, and post-R2 quota release; an over-100-MiB path or over-250-MiB aggregate is omitted with a bounded `stderr` warning and no upload, and the caller verifies the returned artifact set |
| `gx` | budget, current receipt, artifact pull/push, and only authorized platform tools work |
| Secret env | one staging-only canary secret reaches its declared environment name and nowhere else |
| Secret file | one staging-only canary secret is mode `0600` under `/run/galactic/secrets` |
| Secret denial | undeclared/unconfigured/reserved secret names fail before execution; value never appears in response/logs |
| Egress allow | public HTTP(S), Git-over-HTTPS, package registries, and Cloudflare-resolved public names work through the catch-all Worker handler |
| HTTP(S) egress deny | metadata/private literals, every Galactic public control-plane alias, public-to-private redirects, and DNS-rebinding probes cannot reach a private/control-plane origin |
| Raw transport deny | `CONNECT`, custom DNS, raw TCP on 80/443, SSH, and native PostgreSQL/MySQL/Redis ports fail while the private `galactic.internal` route remains healthy |
| WebSocket/Upgrade | a public WSS echo and a Playwright page using WSS work through the pinned runtime, or WSS remains explicitly unsupported for the release; private/Galactic Upgrade targets stay denied |
| Private gateway | `galactic.internal/v1` works only with the lease token and exact server-side authority |
| No ambient authority | body contains no human/Agent bearer, platform key, Supabase key, Cloudflare token, or unrequested provider key |
| Nonzero exit | run completes with its nonzero `exit_code`, stdout/stderr, receipt, and settlement; it is not an infrastructure failure |
| Infra failure | forced image/artifact/control-plane failure yields a classified failure and Alert |
| Timeout | run reaches deadline; whole sandbox is destroyed; reservation is settled/released |
| Cancel | cancel is idempotent, destroys the sandbox, revokes the job token, and writes one receipt |
| Duplicate delivery | replay the same queue message; exactly one claim, execution, receipt, and settlement exist |
| Capacity | exceed staging max concurrency; excess work queues/denies predictably without over-reserving |
| Reconciliation | interrupt completion after execution; sweeper moves the run/hold to a final reconciled state |
| Retention throughput | seed more than one sweep of terminal input aliases plus expired unpinned outputs; every bounded batch advances both categories and physical owner quota is released after exact R2 deletion |
| UI | owner sees status, function, timing, reserved/actual/true-up, failure, receipt/artifacts, and cancel |

For browser and CLI version evidence, capture version output and an actual
operation. `command --version` alone does not prove shared libraries or browser
launch behavior.

### Implemented controls that still require deployed evidence

The code and migrations now include dual reserve/true-up settlement, with
exactly one backing per leased run. Compute invoked from a subscription-backed
parent execution acquires an independent positive-Light reservation against
that execution's authoritative account/root-Agent capacity pool; all other
Compute runs acquire a wallet hold. The independent reservation intentionally
consumes its own account/root-Agent concurrency slot in addition to the parent
execution lease and the Compute policy's body limit. Subscription settlement
records the full actual Compute Light even when it exceeds the initial reserve;
wallet settlement remains bounded by the funded hold. The code also includes
one receipt per run, owner-only management routes, dispatch recovery, stale-run
and DLQ fencing, token revocation, artifact tombstoning, immutable
reserve/commit artifact metadata, bounded cursor-based R2 orphan
reconciliation, and a server-owned immutable environment digest. These
controls are not considered operationally proven until every Galactic Compute
migration in the release applies cleanly to a real staging PostgreSQL instance
and the staging matrix exercises their failure paths against Cloudflare Queues,
Containers, R2, the wallet ledger, and the account/root-Agent capacity windows.

Direct Container internet is disabled. Cloudflare permits its DNS resolver and
routes intercepted HTTP(S) through the exported `ContainerProxy`: the pinned
simple-glob deny list runs first, the exact `galactic.internal` handler runs
second, and a catch-all Worker handler re-originates ordinary public HTTP(S)
with redirects left manual. Both Compute environments require Cloudflare's
`global_fetch_strictly_public` compatibility flag, and the deny list covers
whole Galactic public zones rather than only today's known hosts. With no
`allowedHosts` fallback and
`enableInternet=false`, handler loss fails closed and non-HTTP transports are
denied rather than bypassing Worker policy. The glob matcher is not CIDR-aware,
so literal ranges are expanded as supported host patterns and live staging
must still prove redirect, DNS-rebinding, alternate-DNS, raw-port, and Upgrade
behavior against the deployed Sandbox version. Native remote database and SSH
access are intentionally outside the v1 contract.

Do not infer readiness from TypeScript or image smoke alone. Record migration
apply output, conservation queries, duplicate-delivery evidence, forced body
destruction failures, DLQ replay, and the deployed image digest in the release
packet. These are launch gates, not follow-up polish.

## Owner API contract used by launch-web

The Agent Compute UI intentionally fails closed when these routes are absent.
All routes require the authenticated owner; an installed/non-owner Agent view
must receive `404` or `403` without existence leakage.

| Method | Route | Contract |
|---|---|---|
| `GET` | `/api/launch/agents/:id/compute/settings` | `{ settings, revision }`; manifest ceiling, narrowed owner policy, limits, and secret binding presence/metadata only |
| `PUT` | `/api/launch/agents/:id/compute/settings` | whole narrowed policy with `expectedRevision` and `ownerConfirmed: true`; cannot broaden manifest |
| `GET` | `/api/launch/agents/:id/compute/runs?limit=50&cursor=…` | `{ runs, next_cursor? }`; receipt/artifact links already owner-authorized |
| `POST` | `/api/launch/agents/:id/compute/runs/:runId/cancel` | idempotent owner cancellation; returns updated public run summary |

Secret list/read items are exactly presence-only:

```ts
{
  name: string;
  delivery:
    | { kind: "env"; envName: string }
    | { kind: "file"; path: string };
  configured: boolean;
  version: string;
  updatedAt: string | null;
}
```

No list/read response may gain a `value`, ciphertext, provider key, vault row,
or internal secret ID. The UI uses the existing Agent Variables write-only flow
for values and only declares Compute delivery metadata here.

## Metrics, logs, and alarms

Enable Worker observability in both Compute configs, but log identifiers and
state transitions—not command input, stdout/stderr, request headers, job
tokens, or secret material.

Minimum structured fields:

- event name, environment, run ID, lease ID or one-way digest, Agent ID,
  function name, state/version, queue message ID;
- image digest, placement ID, cold-start and wall timings;
- output byte counts and truncation flags, never output content;
- reserved, actual, released/true-up usage and rate version;
- terminal classification, retryability, and reconciliation source.

Minimum alerts:

| Signal | Page/warn threshold |
|---|---|
| DLQ writes | page on any production message; warning on any staging message |
| Queue oldest age | warning > 2 min; page > 10 min |
| Queue backlog | warning above 2× configured max instances for 5 min |
| Claim without heartbeat | warning at lease heartbeat SLA; auto-reconcile before page |
| Nonterminal past expiry | page if reconciler cannot close within 5 min |
| Settlement pending | warning > 2 min; page > 15 min or any conservation mismatch |
| Reserve/actual/released mismatch | page on any nonzero ledger invariant breach |
| Container start failures | warning > 2% over 15 min; page > 10% over 5 min |
| p95 cold start | warning when it consumes > 25% of default run timeout |
| Forced teardown failure | page on any production occurrence |
| Artifact hash mismatch | page immediately; treat as integrity incident |
| Token introspection denial spike | warning at 3× baseline; investigate theft/replay |
| R2 pending artifact age | warning > 15 min; reconcile/tombstone |
| Tombstoned output without `object_deleted_at` | warning > 15 min; page > 60 min or when owner quota is blocked |
| Retained physical output quota | warn at 80% of 10 GiB or 10,000 objects; reject centrally at 100% |
| R2 reconciliation cursor | warning if `updated_at` does not advance for 10 min; page if the same page still fails after 30 min |

Cloudflare exposes queue backlog count/bytes, oldest-message time, lag, retries,
and outcomes (`success`, `dlq`, `fail`) through dashboard/GraphQL/REST metrics.
See [Queues metrics](https://developers.cloudflare.com/queues/observability/metrics/).

## Reconciliation procedure

Run reconciliation continuously and again before/after each rollout:

1. Find admitted/queued runs older than dispatch SLA. Re-enqueue only through
   the idempotent dispatcher; never create a replacement run.
2. Find provisioning/running runs with expired claims or stale heartbeat.
   Destroy the deterministic sandbox ID, revoke the job token, and CAS the run
   to expired/failed.
3. For every terminal run, require exactly one reservation terminal state and
   exactly one receipt. Missing settlement enters `settlement_pending`; do not
   silently report completion.
4. Verify the receipt has exactly one economic backing: wallet hold XOR
   subscription capacity reservation. Release unused reserve against the same
   backing from which it was drawn. Wallet actual is bounded by its funded hold;
   subscription capacity is trued up to the full actual amount, including an
   overrun above reserve. A pending subscription receipt is retried first by the
   capacity Queue and also by the minute reconciler's bounded database scan;
   it must remain `settlement_pending` until exact idempotent settlement wins.
5. The minute sweeper first retries a bounded set of tombstoned outputs whose
   physical delete is unconfirmed, then releases a bounded set of terminal input
   aliases, and then evaluates expired outputs. It tombstones output rows left
   `pending` for at least 15 minutes only after the run is durably
   stopped/terminal. Every output path tombstones metadata before deleting the
   exact R2 key and records `object_deleted_at` only after that delete succeeds.
   The separate R2 page persists its opaque cursor with a database CAS and may
   delete an old DB-missing object only when the parsed owning run is
   stopped/terminal or absent. Unknown/noncanonical keys, active-run objects,
   unexpired or download-leased outputs, and objects referenced by a ready input
   alias are retained. Download/mount reads separately verify ready object
   size/hash and fail closed; a ready mismatch is an integrity alert and
   operator investigation, not an automatic destructive tombstone.
6. Inspect DLQ messages before replay. Fix the cause, then replay the original
   run ID; never edit a message into a new authority/request.
7. Revoke active job tokens for all terminal or expired runs.
8. Preserve the artifact state-version/tombstone, durable R2 cursor CAS, normal
   run receipt, and aggregate Worker reconciliation log. Never replace these
   with an unaudited direct SQL update or manual bucket deletion.

Read-only triage queries should group nonterminal runs by state/age, terminal
runs lacking a receipt/settlement, active tokens on terminal runs, pending
artifacts by age, terminal ready aliases, expired ready outputs, and deleted
outputs whose `object_deleted_at` remains null. Quota triage must count only
physical output rows with `object_deleted_at IS NULL`; input aliases never add
bytes. Do not perform manual SQL state updates: use the same CAS and ledger
services as normal completion so reservation conservation remains provable.

The R2 orphan sweep depends on the deployed binding's real `list({ prefix,
cursor, limit })` pagination contract. Staging sign-off must prove a truncated
page returns a resumable cursor, a repeated page is idempotent, and deletion is
eventually reflected by listing. A truncated response without a cursor, an R2
failure, or any database-classification failure leaves the cursor unchanged so
the exact page is retried; it never guesses past the failed object.

## Rollout

1. **Dark deploy:** migrations, API, Compute Worker, image, resources, and
   monitors deployed; global admission off.
2. **Canary configuration:** while admission is off, verify one exact
   Galactic-owned owner/Agent UUID pair and that Agent's intended function
   policy, then submit it through **Compute Admission**. Do not mutate rollout
   vars directly in the dashboard.
3. **Internal staging validation:** use the reviewed admission workflow to
   enable the canary, complete the entire matrix, then run it again with the
   default `disable` action and observe all accepted work drain and settle.
4. **Production canary:** repeat with one exact owner/Agent pair, deliberately
   low concurrency, timeout, artifact, and budget ceilings, and no third-party
   secret. Prove the allowlist and function-policy inventory again immediately
   before the change.
5. **Secret validation:** use one purpose-created low-privilege secret with
   easy rotation; confirm env/file delivery, log redaction, and run-scoped
   revocation.
6. **Expansion:** add reviewed exact owner/Agent pairs to the canary allowlist
   only while error, latency, budget conservation, DLQ, reconciliation, and
   cost signals remain green. Keep production in `canary` until mixed direct
   sync and queued async load testing validates the configured capacity
   headroom. Promote rollout mode to `global` only after that evidence and the
   scoped rollout gates pass.
7. **General availability:** only after the admission-off drain drill, token
   revocation, sandbox destruction, complete settlement, and the audited
   emergency-stop/release drill pass.

## Rollback and emergency stop

Rollback is control-plane first. Never begin by deleting containers, queues, or
R2 objects.

1. Disable new Compute admission globally in the API. Owner policies remain
   recorded but cannot start runs. This is an admission kill switch, not an
   execution kill switch: already admitted queued/running jobs continue through
   normal execution, recovery, teardown, and settlement unless step 2 is used.
   The bulk-stop endpoint refuses to start while `COMPUTE_ENABLED=1`; disabling
   admission and stopping accepted execution are deliberately separate acts.
2. To terminate all accepted work, create one UUID for the stop operation and
   send the dedicated emergency-credential request below. The confirmation,
   reason, and `Idempotency-Key` are mandatory. A `202`
   means a bounded batch completed and more targets remain; repeat the *exact*
   request with the same UUID and body until it returns `200` / `completed`.
   A `503` leaves failed targets fenced and auditable; repair the Compute Plane
   dependency and retry the same request. Never create a second operation ID to
   work around an incomplete operation.

```bash
curl --fail-with-body --request POST \
  https://api.connectgalactic.com/api/admin/compute/emergency-stop \
  --header "Authorization: Bearer ${COMPUTE_EMERGENCY_STOP_TOKEN}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: <stop-operation-uuid>" \
  --data '{
    "reason":"pagerduty:<incident-id> — <non-secret incident reason>",
    "confirm":"STOP_ALL_COMPUTE",
    "batch_size":25,
    "max_batches":4
  }'
```

   The API derives `operator_reference` for the durable audit ledger from the
   SHA-256 fingerprint of the configured emergency credential; request JSON
   cannot assert or override it. Credential rotation therefore produces a new
   stable, non-secret audit actor. SQL interlocks both admissions and
   queued-to-provisioning claims with
   operation creation, snapshots a stable cutoff, and fences runs in
   `(created_at, id)` order. The completed operation retains a database
   admission/claim latch, covering API invocations and queue deliveries that
   passed an older feature-flag deployment. For every run that was
   `provisioning` or `running`
   at its fence, the API must receive `destroyed: true` from the deterministic
   Compute coordinator before calling the existing cancellation terminalizer.
   That terminalizer revokes the job token, conserves/releases the reservation,
   and writes the normal receipt. `admitted`/`queued` work cannot claim after
   its stop fence and is settled without inventing a body.
3. Leave the queue, consumer, recovery path, and DLQs running. Late duplicate
   messages encounter the durable stop/terminal state and cannot revive work.
   Do not simulate a stop by deleting Containers, queues, or R2 objects. Owners
   may still use the individual idempotent cancellation route for one run.
4. Audit the operation in `compute_emergency_stop_operations`, its exact target
   set in `compute_emergency_stop_targets`, and the append-only event history in
   `compute_emergency_stop_events`. The operation is complete only when
   `terminalized_count = target_count`, every target has a receipt, no target is
   still `fenced`, no Compute token remains active for a terminal run, and no
   Compute reservation is left `reserved`.
5. Reconcile all reservations and receipts. A rollback is incomplete while any
   hold or `settlement_pending` run remains unexplained.
6. Roll the API and Compute Worker back to their recorded compatible versions.
   Sandbox SDK code and base image must move together.
7. Keep the safe incomplete-multipart rule and the exact private checkpoint
   expiry active, and preserve DB/queue evidence. Do not empty or delete the
   artifact bucket during an incident, and do not add any other
   object-expiration rule.
8. Confirm the Compute Worker still has no public route and the UI now renders
   its fail-closed/unavailable state.
9. Re-enable only after the staging reproduction and full launch matrix pass on
   the exact replacement digest. While `COMPUTE_ENABLED` is still `0`, release
   the completed database latch with a new release idempotency UUID:

```bash
curl --fail-with-body --request POST \
  https://api.connectgalactic.com/api/admin/compute/emergency-stop/<stop-operation-uuid>/release \
  --header "Authorization: Bearer ${COMPUTE_EMERGENCY_STOP_TOKEN}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: <release-request-uuid>" \
  --data '{
    "reason":"pagerduty:<incident-id> — replacement digest passed the recovery matrix",
    "confirm":"RELEASE_COMPUTE_STOP"
  }'
```

   Repeat an uncertain release with the same header and body. Only after the
   release is audited should a separate reviewed deployment re-enable canary
   admission. Release never changes `COMPUTE_ENABLED` itself.

If only the image is bad, disable admission, roll the Compute Worker to the last
known compatible image/version, allow or individually cancel accepted runs as
appropriate, and re-run the validation matrix. Do not mix a new SDK Worker
bundle with an older incompatible Sandbox image; Cloudflare explicitly
requires staged SDK/image transport migrations.

## Evidence checklist

- [ ] Paid-plan/Containers entitlement screenshot or account record
- [ ] Node, Docker, Wrangler, Sandbox SDK, and image tool versions
- [ ] queue/DLQ/bucket inventory for both environments
- [ ] lifecycle rule listing for both buckets
- [ ] managed `r2.dev` disabled and custom-domain list empty for both buckets
- [ ] service binding and named entrypoint configs reviewed
- [ ] no public Compute route/R2 URL evidence
- [ ] full migration manifest plus exact successful canonical schema run/job
- [ ] migration and budget conservation audit
- [ ] local image build and image smoke
- [ ] Compute CI evidence artifact, locked-input hashes, and SPDX SBOM
- [ ] manually approved Compute Deploy evidence artifact
- [ ] exact Container name/image/version reports `active` or `ready`
- [ ] independently approved Compute Admission evidence artifact and exact
      post-deploy canary/off state
- [ ] reviewed immutable Sandbox base-image reference
- [ ] deployed image digest and Container readiness
- [ ] staging matrix run/receipt IDs
- [ ] duplicate-delivery and reconciliation proof
- [ ] retention proof: expired download/admission denial, live alias pin, alias release, tombstone-before-R2 delete, and `object_deleted_at` confirmation
- [ ] per-owner physical quota snapshot (pending + ready + unconfirmed-deleted outputs only; no input-alias double count)
- [ ] log-redaction and no-ambient-credential proof
- [ ] alarms test-fired to the real Alerts/on-call path
- [ ] rollback drill with all holds settled
- [ ] audited emergency bulk-stop drill (claimed-body destroy before receipt)
- [ ] emergency-stop idempotent retry and separate latch-release drill
- [ ] production canary signoff with exact allowlist and function-policy inventory
- [ ] admission-off drain drill (distinct from emergency execution stop)
