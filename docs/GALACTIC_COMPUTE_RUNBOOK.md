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
| Container application | `galactic-compute-computestandard` | `galactic-compute-staging-computestandard` | Worker name plus lowercase `ComputeStandard` class |
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
not a per-job availability guarantee. The release workflow proves one real
admitted job before it certifies `global`; ongoing mixed direct/queue load
testing must still monitor cold starts, retries, cancellation, teardown, and
recovery traffic. Global platform admission does not opt every Agent in:
owner-controlled per-Agent Compute policy remains disabled by default.

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
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, the target's fixed private
   certification-Agent credentials, the owner-session bootstrap inputs, the
   exact `COMPUTE_EMERGENCY_STOP_TOKEN` and `COMPUTE_CERTIFICATION_TOKEN`
   configured on that target's API Worker, and the repository/environment
   variable `COMPUTE_SANDBOX_BASE_IMAGE`. Environment
   protection rules may add organization-specific review controls, but the
   canonical rollout uses the environment's normal approval policy.
   The base-image variable must be the reviewed complete
   `docker.io/cloudflare/sandbox:0.12.3-python@sha256:<64 lowercase hex>`
   reference. Never substitute an unreviewed digest or a mutable tag.
7. Configure `COMPUTE_JOB_TOKEN_PEPPER`, `COMPUTE_EMERGENCY_STOP_TOKEN`, and
   `COMPUTE_CERTIFICATION_TOKEN` on each API Worker with `wrangler secret put`.
   All three must be independently generated random values of at least 32 bytes.
   Store the emergency token in the approved on-call secret manager and as a
   protected GitHub environment secret; never reuse or expose
   `SUPABASE_SERVICE_ROLE_KEY`. The certification token must also differ from
   that service-role key and the job-token pepper. **Compute Deploy** verifies
   the Worker secret names without reading them. **Compute Canary Rollout** uses the protected
   emergency credential only to authenticate the sanitized latch preflight and
   an explicitly confirmed completed-latch release; it never records the value.
   Likewise, migrations, queues, buckets, lifecycle rules, and environment
   approval policy are operator-provisioned inputs, not deployment side effects.
8. Keep platform admission OFF outside the serialized **Compute Canary
   Rollout** workflow. Do not hand-edit `COMPUTE_ENABLED`,
   `COMPUTE_ENVIRONMENT_DIGEST`, `COMPUTE_ROLLOUT_MODE`, or
   `COMPUTE_CANARY_ALLOWLIST`, or `COMPUTE_CERTIFICATION_PRINCIPAL`.
9. Close or merge PR #172 before the production canary. Review disposition for
   `codex/compute-rpc-boundary-fix`: its admission-boundary intent is superseded
   by the current public-error/RPC boundary implementation; do not merge or use
   that old branch as release evidence.
10. Record the current production API version, Compute Worker version, image
   digest, queue backlog, and count of nonterminal Compute runs before a change.
   This is an observation, not rollback authority. The only rollback target is
   an exact OFF API version captured or uploaded and reverified in the same
   rollout dispatch that may mutate admission.
11. Run the canonical `Supabase DB` (staging) or `Supabase Production DB`
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
   The normal API release workflow may enter this pre-Compute branch only when
   Cloudflare returns the exact missing-Worker response (HTTP `404`, error
   `10007`), the checked-in bootstrap policy explicitly approves the target and
   has not expired, and every version Cloudflare currently reports as
   deployable is admission-off with no binding of any type named
   `COMPUTE_PLANE`. The currently active API must be included in that complete
   deployable inventory and must be one stable version. It still performs a
   real API deployment; it never reports a skipped deploy as success.
   Authentication, rate-limit, transport, malformed-response, inventory gaps,
   or any deployable bound/admission-on version fail closed. The released
   bootstrap version is read back and must have the exact release tag, zero
   environment digest, OFF / `canary` / empty allowlist, preserved private
   Compute Queue and artifact bindings, and no `COMPUTE_PLANE`. The queue,
   both dead-letter queues, and private artifact bucket are preflighted before
   deployment. Remove the temporary policy after Compute is provisioned.
3. Deploy `galactic-compute-staging`; its `CONTROL_PLANE` binding now resolves
   to `ultralight-api-staging` / `ComputeControlPlane`.
4. Add/enable the API's `COMPUTE_PLANE` binding to
   `galactic-compute-staging` / `ComputePlane` and its `COMPUTE_QUEUE` producer;
   redeploy the API with admission still disabled and retain that exact Worker
   version as the immutable rollback target.
5. Run connectivity and denial probes through internal operator code. The
   Compute Worker's public/default fetch must still return `404`.
6. Refresh the fixed private `examples/compute-certification` Agent while
   admission is still off. Promote the exact tested candidate through its
   short-lived owner session, then verify the live executable version, the
   exact three-function export set, deterministic fixture identity, paused
   Policy Pillar routine, and a `developer-v1` / browser+shell / no-secret
   manifest ceiling. The reviewed promotion profile accepts no caller-selected
   directory, functions, tools, routine, or source files.
7. Dispatch `staging_canary` from `main`. Upload one exact-SHA API version with
   `COMPUTE_ENABLED=1`, `COMPUTE_ROLLOUT_MODE=canary`, the sole derived
   certification owner/Agent pair in both the allowlist and certification
   principal, and the certified image digest. Read back one stable 100% API
   version and require the certified Compute version to remain unchanged. The
   same dispatch captures its own admission-OFF rollback version before the
   upload.
8. Through a short-lived owner session, run the full deployed certification
   suite on that Agent. Require the fixed toolchain, async marker, real browser
   HTTPS, artifact round trip, nonzero exit, timeout, idempotent cancellation,
   HTTPS/private-network boundaries, raw-TCP denial, and Policy Pillar allow/
   deny paths. Then use the dedicated read-only certification bearer to bind
   every run to persisted receipts, one economic backing, conservation,
   artifact metadata, zero terminal tokens, a clear stop latch, and clean
   health counters. Cleanup must also prove exact numeric zero active Compute
   runs and exact numeric zero active routine runs for the fixed fixture. Any
   ambiguous upload, readback, scenario, accounting snapshot, cleanup, or
   final-fence result promotes the same-dispatch OFF API version.
9. Repeat the migration/API-OFF/fixed-fixture sequence in production from the
   immutable release tag, then dispatch `production_canary` with the successful
   staging run as predecessor. After its certification succeeds, keep the exact
   canary API/Compute pair under active production probes for at least 24
   elapsed hours. Dispatch `production_global` with that production canary run
   as predecessor only after the active-soak verifier accepts every probe and
   deployment inventory entry. The global dispatch revalidates the live
   canary, the active soak, all bound evidence, and the full production-global
   certification before it leaves admission global; any ambiguity promotes the
   OFF version captured by that dispatch.

Normal subsequent releases do not need the bootstrap omission. Deploy order is
database migration, API control plane with admission off, Compute Worker/image,
API exact environment digest with admission still off, fixed certification
fixture refresh, staged policy enablement, deployed scenario certification,
operator snapshot verification, and the final live-version fence.

Use **Actions → Compute Deploy** only when the image, Compute Worker, schema, or
other release inputs actually changed. Its current `preserve_off` evidence
certifies the immutable image/Compute version, exact private bindings, schema,
retention policy, and an admission-OFF API state. A Compute Deploy artifact is
valid execution-plane evidence, but its API version is never rollback authority
for a later admission dispatch.

The August restoration does **not** run Compute Deploy and does not build, push,
or redeploy an image or Compute Worker. Release evidence proves the already-live
Compute digest. **Compute Canary Rollout** uploads full immutable API versions,
but permits only these five policy binding values to differ from the live API:

- `COMPUTE_ENABLED`;
- `COMPUTE_ENVIRONMENT_DIGEST`;
- `COMPUTE_ROLLOUT_MODE`;
- `COMPUTE_CANARY_ALLOWLIST`; and
- `COMPUTE_CERTIFICATION_PRINCIPAL`.

The last value is the exact derived `owner_uuid/agent_uuid` for the fixed
certification Agent. It remains populated for `production_global`, where the
admission canary allowlist is intentionally empty, and is explicitly empty on
new OFF anchors. The API uses it to scope the read-only certification bearer;
the bearer cannot request another account, Agent, or run set.

The validator requires the API script ETag, every non-policy binding (including
secret names), script runtime exports, source-owned SQLite `GxTestSession`, live
Compute version/tag/ETag/bindings, Container digest, and one-version/100-percent
deployments to remain exact. Production always passes an explicit empty
Wrangler environment (`--env ""`); staging always passes `--env staging`.

### Fail-safe admission disable

Use **Actions → Compute Canary Rollout → `revert_off`** to stop new admission.
For staging, dispatch from `main` and type `revert-staging-off`; for production,
dispatch from the exact immutable `v*` tag and type `revert-production-off`.
Supply the successful Compute Deploy evidence run and the last successful
same-target rollout run when one exists. Leave the predecessor blank only for
first-canary or cancelled-run recovery; `revert_off` then derives and verifies
a fresh compatible OFF anchor from the exact live API/Compute pair.

The dispatch first fences the current API/Compute/Container pair. If admission
is enabled, it uploads and byte-verifies a fresh OFF version in that same
dispatch; if it is already OFF, the live version is captured as a no-op anchor.
Only then may it promote the exact anchor at 100 percent. The historical OFF API
inside Compute Deploy evidence is deliberately ignored. This prevents the
July 31 failure mode in which an older OFF version predated the current Durable
Object graph. **Compute Admission is a blocked legacy path; its first step exits
before checkout or Cloudflare access.**

After OFF is verified, `revert_off` also runs certification cleanup-only: the
fixed Agent's Compute policy is disabled and its managed Policy Pillar routine
is paused with the function policy restored to its managed `free` baseline.
Cleanup is not complete until its evidence reports exact numeric zero for both
active Compute runs and active routine runs on the fixed fixture.
Normal certification refuses to mutate a fixture that does not begin at that
baseline. This makes a fresh cleanup-only dispatch deterministic even when the
original runner was killed before it could persist in-memory state. Cleanup is
required in cancelled-run
recovery because a killed certification runner may not have reached its own
`finally` cleanup.

Post-promotion readback requires the exact OFF ID, one version at 100 percent,
unchanged Compute and Container identities, `COMPUTE_ENABLED=0`, `canary`, and
an empty allowlist. The switch stops **new admission only**; accepted work
continues to drain. Use the separately authenticated emergency stop below when
accepted execution must also be terminated.

Every attempt uploads sanitized request, release-provenance, certified-version,
promotion, and postcondition evidence for 90 days. Secret values and unfiltered
Worker version metadata stay in runner temporary storage.

The rollout workflow compensates to its same-dispatch OFF anchor after any
ambiguous promotion, certification, snapshot, cleanup, latch, or final-fence result. GitHub Actions
cannot guarantee compensation after a runner is killed. Treat a lost or
cancelled mutating run as an incident: inspect Cloudflare's one-version/100%
state, then immediately dispatch a new `revert_off` with predecessor blank.
That recovery dispatch still requires successful Compute release evidence and
creates its own fresh compatible OFF anchor. Never use a historical tag lookup,
`wrangler rollback`, “previous,” or a cancelled run as rollback authority.
If staging `main` advanced after the failed mutation, set `recovery_source_sha`
to the failed rollout's exact `head_sha`. The workflow accepts it only for
`revert_off`, requires the SHA to be the current ref or an ancestor in the same
repository, installs its independently pinned dependencies with lifecycle
scripts disabled and without deployment credentials, and uses that checkout
only for the OFF upload. The Cloudflare version tag and committed rollout
evidence record that upload source SHA separately from the workflow dispatch
SHA. Current validators
still require the resulting version's script ETag and all non-policy execution
metadata to match the live API before it can receive traffic.

The independent **Compute CI** workflow runs its lightweight Worker, CLI,
API/Compute bridge, and production/staging dry-run contracts automatically for
relevant pull requests and `main` pushes. A manual dispatch runs those contracts
first and then adds the locked image build, smoke, SBOM, checksum-pinned Grype
gate, and evidence packet; that heavy job never publishes or deploys an image.
The restoration workflow intentionally does not dispatch the heavy job or treat
today's working-tree image inputs as evidence about the already-live digest. In
particular, a newer CLI package version in source does not imply that version
exists in the certified image; reconcile such image contract drift in the next
Compute image release, not in this vars-only restoration. Compute CI and
Compute Deploy retain the unfiltered JSON finding set and fail before image
push/deploy on any CRITICAL or fixable HIGH finding.
Any temporary exception must identify one exact
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

Dispatch **Compute Canary Rollout** in this exact order. Each dispatch uses the
same API deployment lock as API Deploy, Compute Deploy, and emergency disable;
`cancel-in-progress` is false.

Before the first dispatch, provision a distinct
`COMPUTE_CERTIFICATION_TOKEN` secret in both protected GitHub environments and
the matching API Worker. It authenticates the bounded, read-only
`POST /api/admin/compute/certification` snapshot and the sanitized read-only
`GET /api/admin/compute/emergency-stop` latch preflight used by probes. It is
not accepted by either destructive emergency-stop or release POST. Conversely,
the emergency-stop bearer is not accepted by the certification snapshot route.
The snapshot step receives no owner-session, Supabase, Cloudflare, or
emergency-stop secret; the owner suite never receives the certification bearer.
The API must fail closed if this secret equals
`COMPUTE_EMERGENCY_STOP_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, or
`COMPUTE_JOB_TOKEN_PEPPER`; compare them inside the Worker, not by co-locating
the values in an Actions step.
The fixed certification Agent's `run_compute_policy_probe` function must be at
the managed `free` baseline and its certification routine must be paused and
idle before a normal dispatch. Its reviewed authority declares
`notification.owner.write: free` (and therefore the `notify:owner` manifest
permission) because every persistent Launch routine must be able to report to
the owner's inbox. The fixed handler accepts no caller input and does not call
`galactic.notify`; the declaration is the platform-required authority ceiling
that keeps the routine activatable. Before uploading any admission version, the
rollout workflow idempotently creates that account-owned routine from the
live `compute_policy_probe` template when it is missing. It never edits an
existing routine: duplicate names, Agent/template/handler drift, capabilities,
blockers, active runs, or a non-`free` policy fail closed while admission is
still OFF. The suite refuses to mutate any other starting policy; cleanup-only
is the recovery path that restores the fixed paused/idle/`free` invariant.

Provision a separate protected GitHub environment named
`production-compute-probe` for `.github/workflows/compute-probe.yml`. Its
Cloudflare credential is `COMPUTE_PROBE_CLOUDFLARE_TOKEN`, with only the read
permissions needed to inspect Worker versions, deployments, bindings,
Containers, queues, and DLQs. The probe environment must not expose the rollout
`CLOUDFLARE_API_TOKEN`, `COMPUTE_EMERGENCY_STOP_TOKEN`, or any credential that
can upload or promote an API version, change rollout vars, or release a stop
latch. Keep the bounded owner-session and read-only certification credentials
in separate steps under the same credential-domain rules as the rollout. An
OFF production API is a successful probe no-op: record and retain the exact
OFF/live-deployment evidence, admit no job, and do not count that run toward an
active canary soak.

1. **`staging_canary` from `main`:** type `rollout-staging-canary`, supply the
   successful staging `preserve_off` Compute Deploy run, and leave predecessor
   blank. The workflow derives the exact owner/Agent pair from the authenticated
   fixed token; the allowlist is never dispatch input. It refreshes the closed
   `compute-certification` profile, enables only that pair, and runs the
   `staging-full` suite. Ten fixed scenarios plus the managed Policy Pillar run
   must settle and clean up, with both active-run remainder counters exactly
   zero. A separate bearer then reads exactly those eleven run IDs and proves
   persisted accounting, receipts, artifact integrity, latch, tokens, and
   health before the final live fence.
2. **`production_canary` from the immutable `v*` tag:** type
   `rollout-production-canary`, supply the production Compute Deploy run, and
   bind the successful staging-canary run as predecessor. The predecessor must
   have the identical release SHA and combined certification evidence. The
   production canary derives and dogfoods the production owner/Agent pair with
   the `production-canary` profile in the same way.
3. **24-hour active production soak:** do not hold a runner. The dedicated
   probe workflow runs a lifecycle canary every 15 minutes and a real browser
   HTTPS/CA/screenshot probe hourly. The authoritative window begins only when
   the production-canary workflow is successful and its artifact is published;
   probes created during the finalize/upload interval are outside the window.
   A production-global dispatch fails closed unless at least 24 elapsed hours
   after that publication are covered, adjacent lifecycle probes are
   no more than 35 minutes apart, every required hourly browser result exists,
   every probe succeeded, and the final lifecycle probe is no more than 35
   minutes old. Every probe must bind the same API version, Compute version and
   digest, policy, and certification principal as the production-canary
   evidence. The dispatch queue backlog and oldest age must remain zero, DLQ
   depth may not increase from the accepted baseline, and settlement, receipt,
   conservation, cleanup, and reconciliation violations must remain exactly
   zero. The workflow retains each private, hashed probe artifact for 30 days.
   Any production API or Compute deployment during the interval resets the soak
   to that deployment; staging-only deploys do not. A gap, failure, drift,
   missing artifact, incomplete run inventory, or ambiguous result starts a new
   24-hour window.
4. **`production_global` from the same immutable tag:** after the active soak
   passes, type `rollout-production-global` and bind the successful production
   canary. Before receiving any rollout-var mutation credential, the workflow
   downloads the complete probe and API/Compute deployment inventories,
   verifies the 24-hour contract, and binds its deterministic verification
   summary to the rollout evidence. It then requires the exact canary
   API/Compute deployment to remain unchanged, uploads a fresh no-traffic OFF
   rollback anchor in this dispatch, uploads the global/empty-allowlist
   candidate, promotes that exact UUID, re-resolves the same fixed owner/Agent
   identity, runs the complete `production-global` suite and private snapshot,
   and fences everything again.
5. **Operational validation:** keep error, latency, budget conservation, DLQ,
   reconciliation, and cost signals green. Exercise low-privilege secret
   delivery/redaction separately; the release certification intentionally uses
   none.
6. **Rollback readiness:** retain successful rollout run IDs and periodically
   drill `revert_off`, drain, token revocation, sandbox destruction, settlement,
   and emergency stop. Retained OFF IDs are audit evidence only; every new
   rollback dispatch creates or captures its own anchor.

A canary/global dispatch is not successful until every public scenario, Policy
Pillar transition, fixed-fixture cleanup, exact-run operator snapshot, combined
evidence validator, latch check, final version fence, deterministic evidence
manifest, and 90-day artifact upload succeed. Fixed-fixture cleanup includes
strict evidence that active Compute runs and active routine runs both have an
exact numeric remainder of zero. The full suite is not retried:
once it has admitted a run, a second invocation would create a different
economic record. A failed dispatch compensates admission to its same-dispatch
OFF anchor and invokes cleanup-only instead.

The private rollout artifact contains four chained certification files:
`compute-certification-<target>.json`,
`compute-certification-run-ids-<target>.json`,
`compute-certification-snapshot-<target>.json`, and
`compute-certification-verification-<target>.json`. The committed `rollout.json`
references only the combined verification file and its SHA-256. Treat the
snapshot as sensitive operational evidence because it includes owner, receipt,
and accounting identifiers. If snapshot authentication or principal binding
fails, do not rerun the suite inside the failed dispatch or substitute a manual
SQL export. Let compensation restore OFF, correct the protected secret/Worker
principal, and start a fresh serialized dispatch.

## Rollback and emergency stop

Rollback is control-plane first. Never begin by deleting containers, queues, or
R2 objects.

1. Disable new Compute admission globally in the API. Owner policies remain
   recorded but cannot start runs. This is an admission kill switch, not an
   execution kill switch: already admitted queued/running jobs continue through
   normal execution, recovery, teardown, and settlement unless step 2 is used.
   The bulk-stop endpoint refuses to start while `COMPUTE_ENABLED=1`; disabling
   admission and stopping accepted execution are deliberately separate acts.
   Use the serialized `revert_off` stage above; never promote an OFF version
   taken from an older release artifact.
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
6. Keep the API/Compute pair compatible. Admission-only rollback changes the
   five API policy vars and leaves the verified Compute Worker/image untouched.
   If execution-plane bytes are actually bad, perform a separate reviewed
   Compute release; Sandbox SDK code and base image must move together.
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
   release is audited should `staging_canary → production_canary →` a new
   24-hour active production soak `→ production_global` run again from the
   immutable release SHA. Reusing pre-incident probe evidence is forbidden.
   The emergency-stop release route never changes `COMPUTE_ENABLED` itself.

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
- [ ] immutable Compute Deploy evidence artifact
- [ ] staging-canary evidence artifact bound to the exact release SHA
- [ ] production-canary evidence artifact and exact active canary baseline
- [ ] 24 hours of 15-minute lifecycle probes with no gap over 35 minutes
- [ ] hourly browser HTTPS/CA/screenshot evidence and a fresh final probe
- [ ] zero failed probes, API/Compute/digest/policy/principal drift, DLQ growth,
      accounting violations, settlement violations, or reconciliation failures
- [ ] complete API/Compute deployment inventory proving no soak-resetting deploy
- [ ] deterministic active-soak verification bound before mutation credentials
- [ ] private hashed probe evidence retained for 30 days
- [ ] production-global predecessor proof and final live fence
- [ ] same-dispatch OFF rollback anchor (`captured` or verified `uploaded`)
- [ ] exact Container name/image/version reports `active` or `ready`
- [ ] exact canary/global API version and policy-only byte-equivalence evidence
- [ ] public deployed-certification suite and exact run-set checksums
- [ ] private certification snapshot and combined verification checksum
- [ ] exact receipt/backing conservation, zero terminal tokens, clear latch,
      and clean health counters
- [ ] browser/TLS, artifact round-trip, timeout/cancel, egress, raw-TCP, and
      Policy Pillar proofs
- [ ] strict fixed-fixture cleanup evidence with exact numeric zero active
      Compute runs and exact numeric zero active routine runs
- [ ] post-certification live-version fence
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
- [ ] production global-admission postcondition and fixed certification-Agent cleanup
- [ ] admission-off drain drill (distinct from emergency execution stop)
