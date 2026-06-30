# Platform-Management Agents — Design & Plan

> **Status:** Design approved (forward-only model, 2026-06-30). **Phase 0 (remove Installed/Owned tab counts) shipped.** Phases 1–3 pending.
> **Pilot:** pre-install defaults, curated by a *private owner agent* — the first instance of a reusable pattern: **"internal platform API exposed as a regular private agent."**
> Produced by a grounded multi-agent design pass; `file:line` anchors reflect the repo at time of writing.

## Decision register

**Locked with the owner:**
- **Forward-only propagation.** Defaults seed NEW accounts only. Add → future signups; Remove → stop seeding (existing users untouched); Update-for-everyone → normal app versioning (live KV bundle, O(1)). The retention/yank rule is **shelved** — no usage tracking in this pilot.
- **Folders:** desktop-style free-form; schema per-user (Installed) / per-owner (Owned). Tab counts removed (Phase 0).
- **Management surface = a real private owner agent**, not a generic `gx.defaults` platform tool.

**Recommended engineering defaults (proceeding unless overridden):**
single `PLATFORM_OWNER_USER_ID` env value · *wrap* existing admin handlers rather than duplicate · registry apps `connect_gate_exempt` · `deno`-only defaults (reject GPU at add) · drop the paired `app_likes` seed write · dedicated owner-token secret (NOT the service key).

**Open product decisions (deferrable past the pilot):**
- **(G)** First-contact disclosure of seeded defaults ("platform-provided starters you can remove") + a neutral provenance chip styled *distinct* from trust/verified badges.
- **(H)** Surface `description_hash` change on the trust card for defaults (honest signal for silent behavior pushes).
- **(I)** Render a "platform default" badge now vs store-only for later.

---

# Decision Brief — Pre-Install Defaults & the Private Platform-Management Agent Pattern

Forward-only model is settled. Retention/yank is shelved — this brief designs no usage tracking. Everything below keys on `app_id`.

---

## 1) MY TAKE on each locked point

### (a) Defaults pilot — **ENDORSE, with one mandatory rewrite**
Right pilot. It is small, has a clean blast-radius story (forward-only), and exercises every piece of the reusable substrate. But the current provisioner is the worst possible starting point: `DEFAULT_APP_NAMES` is **name-matched** (`request-auth.ts:351-358`), runs a `name=in.(...)` query (`:369-373`), and **silently shrinks** to whatever matches — if any of the 6 rows are renamed/missing/soft-deleted in an environment, `apps.length` is just smaller and the loop seeds fewer apps with no signal. The spec's "key on `app_id`" constraint isn't a nice-to-have; it's a bug fix. **Refinement: the pilot's first commit is replacing name-matching with an id-keyed registry read — do not ship the agent on top of the name-match path.**

What the codebase makes *harder* than the spec assumes: nothing about the pilot is hard, but the provisioner is **fire-and-forget with a single outer `.catch`** (`:346-348`) and a **per-iteration `await` loop with no inner try/catch** (`:378-393`). A mid-loop throw (e.g. an app soft-deleted between the registry read and the write) silently yields a **partial** default set. Today that's masked by the constant; once the set is a DB read it's a live dependency with no alert. Fold a per-app try/catch and a batched upsert into the rewrite (see §2).

### (b) Forward-only propagation + remote-update lever — **ENDORSE the model; REFINE the "free/instant/reversible" claim**
The forward-only model is the strongest trust property here and it is **structurally** true, not just policy: `provisionDefaultApps` is the *only* writer of `source='default'` and only ever runs for a single just-inserted `user_id`, behind the row-absent branch (`:318-321` early-return for existing users; `:346` post-insert). Add → registry row, future signups only. Remove → registry row, stops future seeding, existing libraries untouched. There is **no broadcast/all-users install primitive anywhere** in the codebase — every `user_app_library` write is keyed to the authenticated caller (`apps.ts:902`). Endorsed without reservation.

The remote-update lever is genuinely **O(1), not O(users)**: the runtime resolves code from a single KV key `esm:{appId}:latest` with **no user dimension** (`dynamic-sandbox.ts:129`; `executed-bundle.ts:30-32`, `loadLiveExecutedBundle(appId)`). Library rows are pure membership pointers; one `putLiveExecutedBundle` write reaches 1 or 1M holders. This is the design's best claim and it holds.

But three things the codebase makes **harder than the spec assumes**, and they are the real risks:

1. **The lever is gated, not free.** A public app's version push (`gx.upload` autoLive at `platform-mcp.ts:7030`; `gx.set` at `:9870`) goes through `requirePlatformPublishReadiness`, which blocks on low publisher balance, lapsed Stripe Connect, or a degraded billing check (503 `billing_check_unavailable`). So if the owner's Connect verification lapses, **they cannot ship a fix to — or roll back — a broken default that every seeded user is running.** The spec's "update for everyone needs nothing to design" is true for the *mechanism* but false for *availability*. Refine: registry-listed defaults must be `connect_gate_exempt`, and **rollback must never be billing-gated** (it's a safety op, not a publish).

2. **Propagation is fast-but-eventually-consistent, not "next call everywhere."** KV is edge-replicated; `getCodeCache().invalidate()` is per-isolate only. Say "fast, KV-eventually-consistent," not "instant."

3. **GPU breaks the instant/reversible promise** (1-5 min `gpu_status='building'` window returning `GPU_NOT_READY` to all callers; rollback needs an endpoint rebuild). **Constrain the pilot to `deno` runtime** and reject `runtime='gpu'` at the registry-add endpoint.

Silent propagation of *behavior* changes to platform-curated defaults is the sharpest consent edge (the platform both put it there and can silently change what it does). `description_hash` already exists server-side to make description/tool-shape edits detectable (`trust.ts:274-300`) but **is not rendered in launch-web**. Refine: surface it.

### (c) Private management agent — **ENDORSE; the owner-only check is the whole ballgame and it does not exist yet**
The agent shape is right and the owner's rejection of a generic `gx.defaults` tool is correct (keeps platform-admin authority out of the user-facing `gx.*` surface, which only knows per-app `owner_id`). But the codebase makes this **much harder than the spec implies**: there is **no platform-owner identity anywhere** — grep confirms no `PLATFORM_OWNER_USER_ID`, `is_admin`, `platform_admin`, or role column. Every "owner" check today is per-app `owner_id` (`platform-mcp.ts:6557-6564`). The **only** platform-admin gate is string-equality to `SUPABASE_SERVICE_ROLE_KEY` (`admin.ts:238-243`) — possession == full god-mode (balance, billing, payouts, featured), no audit of *who* acted.

So "owner-only enforced server-side" requires a **net-new trust anchor** plus a **net-new credential carrier**, and the per-app owner gate (the agent is private) is **defense-in-depth only — it must NOT be relied on for platform authority** (it only proves the caller owns *this agent*, not that they may mutate global state).

The hardest sub-problem the spec glosses: **how the agent's function handler reaches an admin endpoint.** The service key never enters the sandbox isolate (`dynamic-sandbox.ts:531-535`, RPC bindings only), and the egress guard does **not** inject auth headers (`outbound-binding.ts:23-36` forwards the request unchanged). Therefore:
- A raw sandbox `fetch` to the public API host arrives **without** any admin bearer → correctly rejected.
- Putting a token in `env.secrets` (the "simpler" path in one design variant) is **a blocker, not a shortcut** — anything in `env.secrets` is sandbox-readable; a co-tenant/compromised function reads it and gets defaults-curation authority.

**Refine to the one safe carrier:** a **host-side RPC binding** (parent isolate, mirroring `charge()` reading the service key at `sandbox.ts:2227`, and `EventsBinding` passing a pre-minted token as a verified prop) that mints an owner-scoped token **from the authenticated execution-context user — never from app args** — and performs the admin fetch itself. App code calls `ADMIN.defaultsAdd(app_id)` and never sees a credential.

### (d) Generalized platform-API-as-private-agent pattern — **ENDORSE; this is the real deliverable**
Defaults is instance #1 of: *private owner-only agent → host-side ADMIN binding mints owner-scoped token from authenticated user → owner-authed `/api/admin/internal/*` endpoint re-verifies the token claim against `PLATFORM_OWNER_USER_ID`.* One audited choke point (`authenticateInternalAdmin`) instead of N tool special-cases, and it doesn't bloat the `gx.*` `tools/list` that's being trimmed. Future internal agents (featured curation, billing-config, payouts) reuse the spine by pointing at their existing `admin.ts` handlers. The pattern is sound **provided** the token is a **distinct source** (new prefix, new secret that is **not** `WORKER_SECRET` — `WORKER_SECRET` is sandbox-readable per `sandbox-actor.ts:21`) and is **rejected everywhere except** the internal-admin routes — extend the existing actor-token door guard at `platform-mcp.ts:3210-3231` so a leaked owner-token can't pivot into `/mcp/platform`.

### (e) Free-form folders + count removal — **ENDORSE; count removal is trivial, folders are a contract-wide change (not launch-web-only)**
Count removal is ~2 LOC: delete the `<span className="library-count">{count}</span>` (`foundation-pages.tsx:3877`) + the `count` calc (`:3845-3847`) + dead CSS `.library-count` (`styles.css:2860-2863`). Ship standalone.

Folders are **moderate and backend-bottlenecked**, not a UI tweak: `LaunchLibraryResponse` carries only `owned/installed/generatedAt` (`shared/contracts/launch.ts:772-776`) and `LaunchAgentSummary` has **no** folder/group field (only `tags?: string[]`, `:662-682`). True user-defined folders need new tables + contract fields + a `LaunchApiClient` method + `live-data.ts` wiring + the render swap. What the codebase makes harder than the spec assumes: the `/api/launch/library` handler reads via **service-role (RLS-bypassing)**, so every folder query **must** stamp `owner_user_id = session user` server-side — a dropped tenant filter turns a per-user read into a full-table scan returning *other users'* folders (a leak **and** the only way this feature becomes O(users)). Also: uninstall is a hard DELETE with no cascade to a folder-membership table, so membership orphans must be render-time filtered against the live installed/owned set.

---

## 2) RECOMMENDED DESIGN

### 2.1 Id-keyed registry (replaces the code constant)
```sql
CREATE TABLE public.platform_default_apps (
  app_id     uuid PRIMARY KEY REFERENCES public.apps(id) ON DELETE CASCADE,
  badge      text,                                 -- neutral provenance label, not a trust signal
  position   int  NOT NULL DEFAULT 0,
  enabled    boolean NOT NULL DEFAULT true,
  removed_at timestamptz,                           -- soft-retire; row kept for audit
  added_by   uuid,                                  -- owner, audit only
  added_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_default_apps_seed
  ON public.platform_default_apps (enabled, position)
  WHERE enabled = true AND removed_at IS NULL;
-- RLS enabled; GRANT to service_role ONLY (platform policy, not user data).
```
Side table, **not** `apps.is_default_install`: a flag on `apps` would require per-app `owner_id` to toggle (so the agent couldn't curate apps the owner doesn't own), bloats the hot catalog row, and has no home for `position/badge/enabled`. App_id PK = DB-level idempotency + "key on app_id" enforced structurally. **Seed migration:** resolve the current 6 names → ids with a `name->id` subselect, asserting **exactly one live installable app per name** (fail loudly on 0 or >1) — owner is sole user, no user backfill needed.

### 2.2 New-account seeding by app_id (`provisionDefaultApps` rewrite, `request-auth.ts:360-393`)
Replace the `name=in.(...)` query with the registry read; **batch** the upserts (one array POST, not 2×N serial round-trips); wrap per-app writes so one failure doesn't abort the loop; **drop the paired `app_likes` write** (it fabricates social-proof like-counts — every signup inflates each default's count via `trg_app_likes`; launch-web/suggestion installs already write library-only, so `user_app_library` is the authoritative installed signal).
```
GET platform_default_apps?enabled=eq.true&removed_at=is.null&select=app_id,badge&order=position
  → validate each app_id is live + installable (apps.deleted_at IS NULL AND visibility public)
  → POST /rest/v1/user_app_library  (array body, Prefer: resolution=merge-duplicates)
       [{user_id, app_id, source:'default'}, ...]
```
Call site **unchanged** at `:346` (post-insert, fire-and-forget). Idempotency unchanged and load-bearing: `UNIQUE(user_id, app_id)` + merge-duplicates makes re-runs/concurrent first-contacts safe.

**Provenance caveat (document, don't fight):** `source` is a single mutable slot; a later `like` flips `'default'→'like'` (merge-duplicates, last-writer-wins). Under forward-only this never bites (provisioner runs once, before any user action). **Do not build any read-side feature on `source='default'`.** If "was this seeded" must survive interaction, that needs a separate immutable marker — out of scope for this pilot.

### 2.3 Remote-update (live-version) lever — **no new code; rides existing versioning**
Update-for-everyone = ordinary app versioning on the shared `app_id`. `gx.upload` autoLive (`platform-mcp.ts:7030`, mandatory `esm:{appId}:latest` rewrite at `:7070`) or `gx.set version` (`executeSetVersion`, `:9870`, KV-before-DB ordering so no half-state). Rollback = same lever to a prior version in `app.versions`. **Hardening required because these are platform defaults:**
- Add registry apps as `connect_gate_exempt` so the lever isn't billing-locked; ensure **rollback is never publish-gated**.
- Reject `runtime='gpu'` at registry-add (keep the instant-reversible KV-swap invariant).
- Gate default version-pushes through the migration validator (blocks `DROP COLUMN`); prefer forward-fix over rollback once a migration has run (code-only rollback against newer data = skew).
- Surface `description_hash` change on the trust card in launch-web (detector exists at `trust.ts:274-300`, currently unrendered).
- This lever stays on the **per-app `owner_id` gate** (owner owns the app) — it does **not** touch the new admin surface. Note the privilege concentration: a single owner-API-key compromise = platform-wide code push to every default holder.

### 2.4 Private management agent + server-side owner-only check + reusable substrate
**Agent functions** (private owner app, `visibility='private'`):
```
defaults_list()                  → { defaults: [{app_id, name, slug, badge?, position, added_at}] }
defaults_add(app_id, badge?)     → { app_id, badge?, added_at }
defaults_remove(app_id)          → { app_id, removed: true }
```
Handlers call a **host-side `ADMIN` RPC binding** (parent isolate) — `ADMIN.defaultsList/Add/Remove(...)`. The binding mints an **owner-scoped actor token** (new prefix `gxo_v1_`, signed with a **new `OWNER_ACTOR_TOKEN_SECRET`**, *not* `WORKER_SECRET`) from the **authenticated execution-context user**, then fetches the internal admin endpoint. App code never holds a credential.

**New endpoints** (sibling of `admin.ts`, behind a new `authenticateInternalAdmin`, fail-closed):
```
GET    /api/admin/internal/defaults
POST   /api/admin/internal/defaults   {app_id, badge?}   -- validate live+public+installable; upsert ON CONFLICT(app_id) DO UPDATE SET enabled=true, removed_at=null, badge=excluded.badge
DELETE /api/admin/internal/defaults/:app_id              -- soft-retire: SET enabled=false, removed_at=now()
```
**SERVER-SIDE OWNER-ONLY (two independent gates, caller never trusted):**
1. **Host-side mint** only when `authResult.user.id === PLATFORM_OWNER_USER_ID` (identity from the verified auth result, never from app args).
2. **`authenticateInternalAdmin`**: verify token signature → read `user_id` **from signed claims** → assert `=== PLATFORM_OWNER_USER_ID`. Trusts only the verified claim; never a body/header/caller-supplied id.
3. **Door-guard extension** (`platform-mcp.ts:3210-3231`): reject the `gxo_v1_` source at `/mcp/platform` and account-session routes so a leaked owner-token can't pivot.
4. The private-app owner gate (`mcp.ts:944-1015`) is **defense-in-depth only**, never the authority.

Use a **dedicated scoped token, not `SUPABASE_SERVICE_ROLE_KEY`**, so a leak can't reach balance/billing/payouts.

**Reusable substrate (the actual deliverable):** `{private owner agent fn} → {host-side ADMIN binding mints gxo_v1_ from authed user} → {/api/admin/internal/<domain>} → {authenticateInternalAdmin asserts PLATFORM_OWNER_USER_ID claim}`. Add a domain by: (1) new `/api/admin/internal/<domain>` handler, (2) expose on the ADMIN binding, (3) publish a private agent. Defaults is instance #1.

### 2.5 Free-form folders (per-user Installed / per-owner Owned) + count removal
**Count removal:** delete `foundation-pages.tsx:3877` + `:3845-3847` + `styles.css:2860-2863`. Zero backend.

**Folders** — one shared table pair, discriminated by `scope`:
```sql
CREATE TABLE library_folders (
  id uuid PK DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('installed','owned')),  -- per-user / per-owner
  name text NOT NULL, position int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX library_folders_uniq ON library_folders(owner_user_id, scope, lower(name));

CREATE TABLE library_folder_members (
  folder_id uuid NOT NULL REFERENCES library_folders(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- denormalized for RLS + cheap query
  scope text NOT NULL CHECK (scope IN ('installed','owned')),
  position int NOT NULL DEFAULT 0, created_at timestamptz DEFAULT now(),
  PRIMARY KEY (owner_user_id, scope, app_id));   -- at-most-one folder per app per tab; uncategorized = no row
-- both: RLS USING (owner_user_id = auth.uid())
```
- **Read:** extend `LaunchLibraryResponse` with `folders:{installed:LaunchFolder[]; owned:LaunchFolder[]}`, `LaunchFolder={id,name,position,appIds[]}` (`shared/contracts/launch.ts:772-776`). In `handleLaunchLibrary` (`launch.ts:3790-3823`) issue the folders+members read **inside the existing `Promise.all`** (don't serialize behind `fetchInstalledIds→fetchAppsByIds→fetchOwnerMap`), **always** filtered to `owner_user_id = session user`, then **intersect members against the live installed/owned id set** (drop orphans; uninstall leaves harmless orphans that self-heal on reinstall).
- **CRUD** (separate surface, `requireLaunchUser`, `owner_user_id` stamped server-side): `POST/PATCH/DELETE /api/launch/folders[/:id]`, `PUT /api/launch/folders/:id/members {appId}`, `DELETE /api/launch/folders/members {scope,appId}`. Add matching `LaunchApiClient` methods (`api.ts:~202`).
- **UI:** replace the two flat `.map` branches (`foundation-pages.tsx:3880-3933`) with a shared `renderFolderedGrid(tab, folders, apps, cardComponent)` — "Uncategorized" section + one labeled section per folder, reusing `StoreAgentCard`/`OwnedAgentCard`. MVP = create/rename/delete + a "Move to folder…" dropdown (same endpoints); drag-and-drop layers on later.

---

## 3) PHASED PLAN (pilot first)

**Phase 0 — count removal (independent, ship anytime).** Delete the count span + calc + dead CSS. No prereqs. ~2 LOC.

**Phase 1 — PILOT: smallest end-to-end slice proving *owner's private agent edits the registry → new signups get seeded*.**
- 1a. Migration: `platform_default_apps` + seed the 6 current ids via `name->id` subselect (assert 1:1).
- 1b. Rewrite `provisionDefaultApps` to read the registry by app_id (batched upsert, per-app try/catch, drop `app_likes`, validate live+public). *Now seeding is id-keyed — already a correctness win even before the agent.*
- 1c. `PLATFORM_OWNER_USER_ID` config + new `OWNER_ACTOR_TOKEN_SECRET`.
- 1d. Host-side `ADMIN` RPC binding (mint-from-authed-user) + `authenticateInternalAdmin` + `/api/admin/internal/defaults` (GET/POST/DELETE) + door-guard rejection of `gxo_v1_`.
- 1e. Private "Defaults Manager" agent exposing `defaults_list/add/remove` over the binding.
- **Prerequisites:** owner identity decision (single env value vs allowlist — read from one source either way); `connect_gate_exempt` decision for registry apps; pilot constrained to `deno` runtime.
- **CI gates (ship with the phase, not after):** (i) `defaults_add`/`defaults_remove` touch **only** `platform_default_apps` and produce **zero** `user_app_library` writes for any existing user; (ii) the defaults routes reject every user JWT / api_token / sandbox token / wrong-bearer with 401/403; (iii) the admin route rejects any bearer originating from a sandbox-settable header.
- **Proof of slice:** owner calls `defaults_add(X)` via the agent → register a brand-new user → assert X appears in their `user_app_library` with `source='default'`; assert an *existing* user's library is byte-unchanged.

**Phase 2 — folders + no-counts (UI).**
- Migration: `library_folders` + `library_folder_members` (RLS by `owner_user_id`).
- Contract: `LaunchFolder` + extend `LaunchLibraryResponse`/handler (Promise.all read, server-side tenant filter, orphan intersection).
- `LaunchApiClient` + `live-data.ts` wiring; render swap + Move-to-folder MVP.
- **Prerequisites:** locate the `/api/launch/library` handler source (flagged as not yet located); confirm install caps (`fetchInstalledIds` limit 500 / `fetchAppsByIds` slice 100) are raised/paginated before grouping a possibly-truncated set.
- **Gate:** test that the service-role folder read is unreachable without an `owner_user_id` filter.

**Phase 3 — generalize to a 2nd internal op (proves the substrate is reusable, not bespoke).**
- Wrap one existing `/api/admin/*` handler (recommend **featured curation**, `admin.ts:2118` — read-mostly, low blast radius) under `/api/admin/internal/featured` with the **same** `authenticateInternalAdmin` gate; expose on the ADMIN binding; publish a 2nd private agent.
- **Prerequisite:** decide whether internal routes **wrap** the existing service-key handlers (one privileged implementation, two front doors) or run parallel — recommend wrapping.
- **No usage tracking needed in any phase** (forward-only).

---

## 4) TOP RISKS & OPEN DECISIONS

**Risks (ranked):**
1. **Owner-identity gate is a net-new single-value god-mode anchor that does not exist today.** If `PLATFORM_OWNER_USER_ID` is mis-set, checked against an unverified value, or the `gxo_v1_` token is accepted outside the internal-admin routes, **any caller can seed a malicious app into every future account** (platform-wide tool-poisoning, bounded to future signups by forward-only). Mitigate with the two server-side gates + door-guard + the CI assertions above.
2. **Credential carrier.** Egress injection is unimplementable (`outbound-binding.ts:23-36` attaches no auth) and `env.secrets` tokens are sandbox-readable — both are **blockers, not shortcuts**. The host-side binding is the only safe path; forbid the alternatives in the design doc.
3. **Service-key blast radius.** Reusing `SUPABASE_SERVICE_ROLE_KEY` as the agent bearer = whole-platform compromise on leak. Use the dedicated scoped token.
4. **Remote-update lever is billing-gated and not always reversible.** A Connect/balance lapse can lock the owner out of fixing or rolling back a broken default that every seeded user runs. Exempt registry apps; never publish-gate rollback; keep defaults non-GPU.
5. **app_id is only stable while the `apps` row persists.** Soft-delete + re-create gives a new id; the registry keeps pointing at the dead one and silently seeds fewer apps (the same "silent shrink" we're fixing, relocated from rename to re-create). Add a `defaults_list` liveness flag and a periodic alarm; re-creation requires explicit `remove(old)+add(new)`.
6. **Folder tenant-filter is the only guard on the RLS-bypassing service-role read.** A dropped `owner_user_id` filter is both a cross-tenant leak and the sole way folders become O(users). Make the filter non-optional + asserted.

**Open decisions the owner must make:**
- **A.** `PLATFORM_OWNER_USER_ID`: single env value or a small allowlist table (multi-operator future)? Read from one source regardless.
- **B.** Internal-admin routes: **wrap** the existing service-key handlers under the owner-actor gate (one implementation, two doors) or run parallel? (Recommend wrap.)
- **C.** Registry apps `connect_gate_exempt` for the update lever, and rollback explicitly ungated — confirm.
- **D.** Constrain defaults to `deno` runtime (reject GPU at add) — confirm.
- **E.** Drop the paired `app_likes` seed write (recommended; stops fabricated like-counts) — confirm.
- **F.** `defaults_add` visibility validation: reject private/non-installable/display-name inputs server-side — confirm (prevents seeding unreachable rows / quietly pushing the owner's private agent under platform authority).
- **G.** First-contact **disclosure**: seeding-without-disclosure is the soft consent gap (no onboarding copy exists today). Add a truthful "these are platform-provided starters you can remove" message + a neutral provenance chip (styled **distinct** from trust/verified chips per `trust.ts:35-90` honesty norm)? In scope now or deferred?
- **H.** Surface `description_hash` change on the trust card for defaults (consent-honest signal for silent behavior pushes) — now or deferred?
- **I.** `badge` UI: render a platform-default chip now, or store-only for later? (No platform-blessing badge component exists today.)

**File anchors:** `request-auth.ts:318-321,346-348,351-358,360-393` · `admin.ts:238-243,245-259,269-272,2118` · `platform-mcp.ts:3210-3231,6557-6564,7030,7070,9870` · `dynamic-sandbox.ts:129,451-561,531-535` · `executed-bundle.ts:30-32,108-142` · `sandbox.ts:2227` · `outbound-binding.ts:23-36` · `sandbox-actor.ts:21` · `mcp.ts:944-1015` · `apps.ts:902` · `trust.ts:35-90,274-300` · `foundation-pages.tsx:3845-3847,3877,3880-3933` · `launch.ts:3790-3823` · `shared/contracts/launch.ts:662-682,772-776` · `styles.css:2860-2863`.