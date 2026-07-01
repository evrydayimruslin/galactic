# Data worker relight — close the cross-tenant R2 hole

The `ultralight-data` worker (`worker/`) is the tenant-isolated R2/D1 data plane.
The API worker mints a per-tenant proof token (`X-Tenant-Token`) on every data
call; the data worker verifies it, so a leaked `WORKER_SECRET` (which is exposed
inside the sandbox) alone **cannot** forge cross-tenant data access.

Enforcement is gated by `DATA_TENANT_ENFORCE=1` (already set in
`worker/wrangler.toml`) **plus** a shared `DATA_TENANT_SECRET` that must be set on
**both** workers. Until it is, the running data worker predates the enforcement
code (there was no CI to deploy it), so enforcement is effectively **fail-open**.
These steps light it up.

## One-time relight (run in order)

1. Generate a strong secret:

   ```sh
   openssl rand -hex 32   # copy the output
   ```

2. Set it on the API worker (mints tokens) **and** the data worker (verifies
   them) — the **same** value on both:

   ```sh
   cd api    && npx wrangler secret put DATA_TENANT_SECRET   # paste value
   cd worker && npx wrangler secret put DATA_TENANT_SECRET   # paste SAME value
   ```

3. Deploy the **API** worker so it mints real tokens (normal API deploy / release
   tag).

4. Deploy the **data** worker so it verifies + enforces:
   - CI: Actions → **Data Worker Deploy** → *Run workflow* (workflow_dispatch), or
   - manually: `cd worker && npx wrangler deploy`

   **Order matters:** the API worker must be minting real tokens (step 3) before
   the data worker starts enforcing (step 4), or cross-worker calls 403 briefly.

## Verify

- A data call with a valid token succeeds; a forged/absent token → **403**.
- If you deploy the data worker **without** a non-default `DATA_TENANT_SECRET` it
  returns **503** (`tenant enforcement misconfigured`) by design — that's the
  footgun guard telling you step 2 wasn't done on this worker.

## Why the deploy is manual-only

The data worker fails **closed** in production. Auto-deploying it before the
secret is set would 503 the entire data plane, so `data-worker-deploy.yml` only
deploys on `workflow_dispatch` (its verify/dry-run still runs on push/PR).
