# Tiered Storage, Auth Limits & Usage Tracking Architecture

## Executive Summary

This document designs the Free/Pro tier enforcement infrastructure for Ultralight. The current codebase has **scaffolding already in place** (`users.tier`, `storage_used_bytes`, `storage_limit_bytes`, `TIER_LIMITS`) but **none of it is enforced**. This architecture builds on those foundations.

---

## Current State Assessment

### What Exists
| Component | Status | Details |
|-----------|--------|---------|
| `users.tier` | Column exists, default `'free'` | CHECK constraint `('free', 'pro')` |
| `users.storage_used_bytes` | Column exists, default `0` | **Never updated** |
| `users.storage_limit_bytes` | Column exists, default `500MB` | **Never checked** |
| `apps.storage_bytes` | Column exists, default `0` | **Never updated** |
| `TIER_LIMITS` constant | Defined in `shared/types/index.ts` | `max_apps`, AI credits, timeouts |
| `user_api_tokens` table | Full CRUD implemented | No per-user token count limits |
| Rate limiting | `rate_limits` table + `check_rate_limit()` RPC | Per-user/endpoint, minute window |
| App visibility | `private`/`unlisted`/`public` | No tier gating on publish |

### What's Missing
- Storage tracking on upload/publish/delete
- Token count enforcement per tier
- Visibility/publish gating by tier
- MCP connection limiting for free tier
- Storage usage API/UI
- Version-level size tracking

---

## 1. Storage Tracking Architecture

### 1.1 Data Model Changes

```sql
-- New: per-version size tracking on apps table
-- apps.versions currently stores: ["1.0.0", "1.0.1"]
-- Change to store objects with size metadata:

ALTER TABLE apps ADD COLUMN version_metadata JSONB DEFAULT '[]';
-- Format: [
--   { "version": "1.0.0", "size_bytes": 45230, "created_at": "2025-01-15T..." },
--   { "version": "1.0.1", "size_bytes": 52100, "created_at": "2025-02-01T..." }
-- ]

-- Update users table default to match new tier limits
ALTER TABLE users
  ALTER COLUMN storage_limit_bytes SET DEFAULT 104857600;  -- 100MB for free
```

**Decision: Keep `versions` string array for backward compat, add `version_metadata` alongside.**

Why not a separate `app_versions` table? The version count per app is small (typically <50), JSONB avoids joins on every app list query, and the current codebase already uses JSONB patterns (e.g., `skills_parsed`, `env_vars`). A normalized table adds complexity without meaningful benefit at this scale.

### 1.2 Size Calculation Strategy

**When to calculate:** At upload time, by summing `file.size` for all files in the upload payload.

```
Upload Flow (existing: handleUpload / handleDraftUpload)
  ├── files[] already iterated for validation (totalSize calculated at line ~94)
  ├── totalSize is the EXACT pre-bundle source size
  │
  ├── OPTION A: Track source file sizes (what user uploads)
  │   ✓ Already calculated in upload handler
  │   ✓ Predictable (user controls it)
  │   ✗ Doesn't account for bundled output size
  │
  └── OPTION B: Track R2 stored sizes (post-bundle)
      ✓ Reflects actual storage consumed
      ✗ Requires measuring after bundle (adds complexity)
      ✗ Bundle size varies with bundler version
```

**Recommendation: Option A (source size).** Users can reason about it, it's already computed, and the delta from bundling is small for these file sizes. The `storage_bytes` field on the app tracks this per-version.

### 1.3 Enforcement Flow

```
handleUpload(request) or handleDraftUpload(request, appId)
  │
  ├── authenticate(request) → { id, email, tier }
  ├── validate files (existing)
  ├── calculate totalSize (existing, ~line 94)
  │
  ├── NEW: Fetch user storage soft-cap status
  │   │  SELECT storage_used_bytes, storage_limit_bytes FROM users WHERE id = $userId
  │   │
  │   └── IF storage_used_bytes + totalSize > storage_limit_bytes
  │       └── Allow upload; hourly Light billing handles storage soft-cap overage.
  │
  ├── ... bundle, upload to R2 (existing) ...
  │
  ├── NEW: Update storage tracking (atomic)
  │   │  UPDATE users SET storage_used_bytes = storage_used_bytes + $totalSize
  │   │  UPDATE apps SET storage_bytes = $totalSize (for this version)
  │   │  Append to version_metadata JSONB
  │   │
  │   └── Use a Supabase RPC for atomicity:
  │       CREATE FUNCTION record_upload_storage(
  │         p_user_id UUID, p_app_id UUID, p_version TEXT, p_size_bytes BIGINT
  │       ) RETURNS void
  │
  └── Return success (existing)
```

### 1.4 Deletion & Space Reclaim Flow

```
handleDeleteApp(request, appId)  -- currently soft-deletes
  │
  ├── Soft delete (existing): SET deleted_at = NOW()
  │
  ├── NEW: Reclaim storage immediately (don't wait for hard delete)
  │   │  UPDATE users SET storage_used_bytes = storage_used_bytes - apps.total_stored_bytes
  │   │  WHERE users.id = apps.owner_id
  │   │
  │   └── total_stored_bytes = SUM of all version_metadata[].size_bytes
  │       (or simpler: a computed column / stored aggregate)
  │
  └── R2 cleanup: Separate async/cron job (existing pattern)
      Delete apps/{appId}/ prefix from R2

handleDeleteVersion(request, appId, version)  -- NEW endpoint needed
  │
  ├── Validate: Cannot delete current_version
  ├── Remove version from versions[] array
  ├── Remove from version_metadata[]
  ├── UPDATE users SET storage_used_bytes -= version_size
  ├── UPDATE apps SET version_metadata = (filtered)
  └── Queue R2 cleanup: delete apps/{appId}/{version}/ prefix
```

**Gotcha: Eventual consistency.** If upload succeeds but storage update fails (crash between R2 write and DB update), `storage_used_bytes` will be understated. Mitigation: periodic reconciliation cron that sums actual app sizes vs. `storage_used_bytes`. Keep it simple — run weekly, log discrepancies, auto-correct.

### 1.5 Storage Usage API

```
GET /api/user/storage
Authorization: Bearer <token>

Response:
{
  "used_bytes": 52428800,
  "limit_bytes": 104857600,
  "used_percent": 50.0,
  "tier": "free",
  "breakdown": [
    {
      "app_id": "uuid-1",
      "app_name": "My App",
      "slug": "my-app",
      "total_bytes": 45000,
      "versions": [
        { "version": "1.0.0", "size_bytes": 20000, "created_at": "..." },
        { "version": "1.0.1", "size_bytes": 25000, "created_at": "...", "is_current": true }
      ]
    }
  ]
}
```

This is a read from `users` + `apps` tables. No new tables needed.

---

## 2. Auth Token Enforcement Strategy

### 2.1 The Problem

Free tier: max 1 active API token. Currently, `user_api_tokens` has no per-user count limit.

**Two strategies:**

| Strategy | Behavior | UX | Implementation |
|----------|----------|----|----------------|
| **Reject new** | Error on 2nd token creation | Clear error, user must delete old | Simple check in createToken |
| **Invalidate old** | Creating new auto-revokes old | Seamless but surprising | Delete + insert in transaction |

**Recommendation: Reject new.** Invalidating silently is dangerous — the user's CLI or automation using the old token would break without warning. Explicit is better.

### 2.2 Enforcement Location

```
createToken(userId, name, options?)          -- api/services/tokens.ts
  │
  ├── NEW: Check tier
  │   │  SELECT tier FROM users WHERE id = $userId
  │   │
  │   └── IF tier === 'free':
  │       │  SELECT COUNT(*) FROM user_api_tokens
  │       │  WHERE user_id = $userId AND (expires_at IS NULL OR expires_at > NOW())
  │       │
  │       └── IF count >= 1:
  │           └── THROW "Free tier allows 1 active API token. Delete existing token first."
  │
  ├── ... existing token generation logic ...
  └── Return token
```

**Why enforce in the service layer (not middleware)?** The middleware (`authenticate()`) validates tokens — it shouldn't also count them. Token creation is the correct enforcement point. JWT (OAuth) tokens are managed by Supabase and don't hit this path, so they're unaffected.

### 2.3 Token Lifecycle Handling

| Event | Free Tier | Pro Tier |
|-------|-----------|----------|
| Create token | Check count ≤ 1 | No limit |
| Validate token | No change (existing) | No change |
| Token expiry | Reclaims slot automatically | No effect |
| Revoke token | Frees slot for new creation | No effect |
| Revoke all | Frees all slots | No effect |
| Upgrade free→pro | Limit removed instantly | N/A |
| Downgrade pro→free | **Existing tokens stay valid** | N/A |

**Gotcha on downgrade:** If a Pro user with 5 tokens downgrades, we should NOT auto-revoke their tokens. Instead, block creation of new ones until they're at/below the limit. Tokens are auth credentials — revoking them silently is destructive.

### 2.4 JWT Token Note

The spec says "single user auth token max" for free tier. JWTs (from Google OAuth) are **stateless** and managed by Supabase — we cannot limit concurrent JWTs without building a server-side session store, which contradicts the current stateless architecture.

**Recommendation:** The "1 token" limit applies to **API tokens** only (`ul_*` tokens). JWT sessions naturally expire in ~1 hour and are tied to browser localStorage, making concurrent abuse impractical. If true single-session enforcement is needed later, add a `sessions` table — but this is a significant arch change.

---

## 3. MCP Single-User Enforcement

### 3.1 Current Architecture

MCP uses **stateless HTTP POST JSON-RPC** — no WebSocket, no SSE, no persistent connections. Every request is independent and authenticated individually.

This means "concurrent MCP connections" doesn't quite apply. What we're actually limiting is: **concurrent MCP users of a free-tier app**.

### 3.2 What "Single User MCP" Means

For a **free tier app owner**, only the owner themselves should be able to use their app's MCP endpoint. No sharing.

This is already partially enforced:
- Free tier apps default to `visibility: 'private'`
- Private apps: `if (app.visibility === 'private' && app.owner_id !== userId)` → rejected
- The missing piece: **prevent free-tier users from setting visibility to `unlisted` or `public`**

### 3.3 Enforcement Strategy

```
handleUpdateApp(request, appId)             -- api/handlers/apps.ts
  │
  ├── ... existing validation ...
  │
  ├── NEW: Tier-gate visibility changes
  │   │  IF updates.visibility IN ('unlisted', 'public'):
  │   │    SELECT tier FROM users WHERE id = $userId
  │   │    IF tier === 'free':
  │   │      RETURN 403: "Publishing apps requires Pro tier. Upgrade to make apps public."
  │   │
  │   └── This also gates MCP sharing (public/unlisted MCP = multi-user MCP)
  │
  └── ... existing update logic ...
```

Also enforce in the platform MCP tool (`platform.app.update`, `platform.app.create`):
```
platform.app.create / platform.app.update
  │
  └── IF visibility !== 'private' AND tier === 'free':
      └── Return error: "Pro tier required for public/unlisted apps"
```

**This is the cleanest approach because:**
1. No new connection tracking infrastructure needed
2. Private visibility + owner-only check = single-user MCP (already works)
3. Tier-gating visibility = tier-gating MCP sharing
4. Zero overhead on the MCP request hot path

### 3.4 Edge Case: Shared API Tokens

Could a free-tier user create an API token and share it? Yes, but:
- Free tier is limited to 1 API token (Section 2)
- That token authenticates as the owner
- Private apps only allow owner access
- So shared token + private app = owner-level access only

If we want to prevent token sharing entirely (multiple IPs using same token), we could track `last_used_ip` changes — but this creates false positives (VPNs, mobile networks). **Not recommended for v1.**

---

## 4. Complete Data Model Design

### 4.1 Schema Changes (Migration)

```sql
-- migration-tiers.sql

-- 1. Update default storage limit for new free users (100MB, per spec)
ALTER TABLE users
  ALTER COLUMN storage_limit_bytes SET DEFAULT 104857600;

-- 2. Add version metadata tracking to apps
ALTER TABLE apps ADD COLUMN IF NOT EXISTS version_metadata JSONB DEFAULT '[]';

-- 3. RPC: Atomic storage recording on upload
CREATE OR REPLACE FUNCTION record_upload_storage(
  p_user_id UUID,
  p_app_id UUID,
  p_version TEXT,
  p_size_bytes BIGINT
) RETURNS void AS $$
BEGIN
  -- Update user's total storage
  UPDATE users
  SET storage_used_bytes = storage_used_bytes + p_size_bytes,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Update app's current version size
  UPDATE apps
  SET storage_bytes = p_size_bytes,
      updated_at = NOW()
  WHERE id = p_app_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. RPC: Reclaim storage on delete
CREATE OR REPLACE FUNCTION reclaim_app_storage(
  p_user_id UUID,
  p_app_id UUID
) RETURNS BIGINT AS $$
DECLARE
  v_total_bytes BIGINT;
BEGIN
  -- Calculate total storage across all versions
  SELECT COALESCE(
    (SELECT SUM((elem->>'size_bytes')::BIGINT)
     FROM jsonb_array_elements(version_metadata) AS elem),
    storage_bytes
  ) INTO v_total_bytes
  FROM apps WHERE id = p_app_id;

  -- Subtract from user's total
  UPDATE users
  SET storage_used_bytes = GREATEST(0, storage_used_bytes - COALESCE(v_total_bytes, 0)),
      updated_at = NOW()
  WHERE id = p_user_id;

  RETURN COALESCE(v_total_bytes, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. RPC: Check storage quota before upload
CREATE OR REPLACE FUNCTION check_storage_quota(
  p_user_id UUID,
  p_upload_size BIGINT
) RETURNS TABLE (
  allowed BOOLEAN,
  used_bytes BIGINT,
  limit_bytes BIGINT,
  remaining_bytes BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (u.storage_used_bytes + p_upload_size <= u.storage_limit_bytes) AS allowed,
    u.storage_used_bytes AS used_bytes,
    u.storage_limit_bytes AS limit_bytes,
    GREATEST(0, u.storage_limit_bytes - u.storage_used_bytes) AS remaining_bytes
  FROM users u
  WHERE u.id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. RPC: Count active API tokens for tier enforcement
CREATE OR REPLACE FUNCTION count_active_tokens(
  p_user_id UUID
) RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::INTEGER
    FROM user_api_tokens
    WHERE user_id = p_user_id
    AND (expires_at IS NULL OR expires_at > NOW())
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.2 Updated TIER_LIMITS Constant

```typescript
// shared/types/index.ts — updated
export const TIER_LIMITS = {
  free: {
    max_apps: 5,
    max_api_tokens: 1,                    // NEW
    storage_limit_bytes: 100 * 1024 * 1024, // 100MB (changed from 500MB)
    daily_ai_credit_cents: 5,
    monthly_ai_credit_cents: 150,
    max_file_size_mb: 10,
    max_files_per_app: 50,
    execution_timeout_ms: 30000,
    log_retention_days: 7,
    allowed_visibility: ['private'] as const,     // NEW
    max_mcp_users: 1,                     // NEW (informational)
  },
  pro: {
    max_apps: Infinity,
    max_api_tokens: Infinity,             // NEW
    storage_limit_bytes: 10 * 1024 * 1024 * 1024, // 10GB
    daily_ai_credit_cents: 50,
    monthly_ai_credit_cents: 1500,
    max_file_size_mb: 10,
    max_files_per_app: 50,
    execution_timeout_ms: 60000,
    log_retention_days: 30,
    allowed_visibility: ['private', 'unlisted', 'public'] as const, // NEW
    max_mcp_users: Infinity,              // NEW (informational)
  },
} as const;
```

### 4.3 Entity Relationship Summary

```
users (1) ──── (N) apps
  │                  │
  │ tier             │ version_metadata[]
  │ storage_used     │ storage_bytes
  │ storage_limit    │ visibility (tier-gated)
  │                  │
  └── (N) user_api_tokens
       │
       │ count limited by tier
       │ (free: 1, pro: unlimited)
       │
       └── validates MCP + API access
```

---

## 5. Migration Strategy

### 5.1 Existing Users → Free Tier

All existing users already have `tier = 'free'` (column default). No migration needed for tier assignment.

### 5.2 Storage Limit Update

```sql
-- Existing users have storage_limit_bytes = 536870912 (500MB)
-- New spec says 100MB for free, 10GB for pro

-- Update all free users to 100MB
UPDATE users SET storage_limit_bytes = 104857600
WHERE tier = 'free';

-- Update all pro users to 10GB
UPDATE users SET storage_limit_bytes = 10737418240
WHERE tier = 'pro';

-- Change default for new users
ALTER TABLE users
  ALTER COLUMN storage_limit_bytes SET DEFAULT 104857600;
```

### 5.3 Backfill Storage Calculations

Storage backfill requires querying R2 for actual file sizes. Two approaches:

**Approach A: Query R2 ListObjects (accurate, slow)**
```
For each app:
  For each version in versions[]:
    R2 ListObjects(prefix="apps/{appId}/{version}/")
    Sum ContentLength from response
    Update version_metadata, storage_bytes
  Sum all versions → update user storage_used_bytes
```

**Approach B: Estimate from upload history (fast, approximate)**
Not possible — we don't have historical upload sizes.

**Recommendation: Approach A, run as one-time migration script.**
- Batch by user (not all at once)
- Rate limit R2 API calls (S3 ListObjects is cheap but has limits)
- Log results for verification
- Run during low-traffic period
- Estimated time: ~1-2 seconds per app × number of apps

### 5.4 Handling Existing Over-Limit Users

After backfill, some free users may exceed the new 100MB limit.

**Recommendation: Grandfather, don't break.**
- Set their `storage_used_bytes` accurately
- Allow them to keep existing apps
- Block NEW uploads until they're under limit (or upgrade)
- Show a clear banner: "You're using X of 100MB. Delete old versions or upgrade to continue uploading."

---

## 6. Implementation Phases

### Phase 1: Storage Tracking (Foundation)
**Dependencies:** None (can ship independently)

1. Run migration: add `version_metadata` column, create RPC functions
2. Update `handleUpload` to call `check_storage_quota` pre-upload
3. Update `handleUpload` to call `record_upload_storage` post-upload
4. Update `handlePublishDraft` to record version metadata
5. Add `GET /api/user/storage` endpoint
6. Run backfill script for existing apps
7. Update storage_limit defaults (500MB → 100MB free)

**Files to modify:**
- `migration-tiers.sql` (new)
- `api/handlers/upload.ts` (add quota check + storage recording)
- `api/handlers/apps.ts` (publish: record version metadata, delete: reclaim)
- `api/handlers/user.ts` (add storage endpoint)
- `shared/types/index.ts` (update TIER_LIMITS)

### Phase 2: Auth Token Limits
**Dependencies:** Phase 1 (needs tier infrastructure)

1. Add token count check in `createToken()`
2. Update `TIER_LIMITS` with `max_api_tokens`
3. Return clear error message with upgrade CTA

**Files to modify:**
- `api/services/tokens.ts` (add count check)
- `shared/types/index.ts` (TIER_LIMITS update)

### Phase 3: Visibility / Publish Gating
**Dependencies:** Phase 1 (needs tier infrastructure)

1. Add tier check in app update handler (visibility changes)
2. Add tier check in platform MCP tool (app create/update)
3. Add tier check in upload handler (if visibility specified)

**Files to modify:**
- `api/handlers/apps.ts` (visibility gate)
- `api/handlers/upload.ts` (visibility gate on create)
- `api/handlers/platform-mcp.ts` (tool-level gate)

### Phase 4: Billing Integration
**Dependencies:** Phases 1-3

1. Stripe integration for Pro tier ($25/mo)
2. Webhook to update `users.tier` and `storage_limit_bytes` on subscription change
3. Handle upgrade: instant limit increase
4. Handle downgrade: grandfather existing, block new over-limit actions
5. Handle `tier_expires_at` for failed payments

---

## 7. Gotchas & Tradeoffs

### Storage
- **Draft uploads consume space temporarily.** Should drafts count against quota? Recommendation: Yes, but a draft replaces the previous draft (not additive). Only one draft per app at a time (already enforced).
- **Old versions accumulate.** Free users with 5 versions of a 20MB app = 100MB. Consider: auto-purge old versions beyond N (e.g., keep last 3 for free, unlimited for pro). Or defer this — users can manually delete versions.
- **R2 doesn't charge for storage listing**, but ListObjects calls are rate-limited. Backfill should be throttled.
- **Bundled output isn't tracked separately.** IIFE + ESM bundles add ~2x source size. Since we track source size, actual R2 usage will be ~2-3x reported. This is fine — the limit is a soft contract, not a billing meter.

### Auth
- **JWTs can't be counted.** Supabase issues them, and they're stateless. True single-session requires a session table + invalidation, which is a breaking change. The "1 token" limit should apply to API tokens only.
- **Downgrade doesn't revoke tokens.** This is intentional — revoking active credentials is destructive. New token creation is blocked until under limit.
- **Expired tokens still in DB.** The `count_active_tokens` function excludes expired tokens, so slot is auto-freed on expiry.

### MCP
- **No persistent connections to track.** Stateless HTTP means no WebSocket connection counting. "Single MCP user" = "only owner can access" = "private visibility only."
- **Token sharing is hard to prevent.** A free user could give their API token to someone else. Since private visibility already restricts to owner_id, the shared token would authenticate as the owner, which is the same as the owner using it. This is acceptable for v1.

### General
- **TIER_LIMITS is client-side.** It lives in `shared/types/index.ts` which is shipped to the frontend. Don't put anything sensitive there. All enforcement must happen server-side.
- **Race conditions on storage update.** Two concurrent uploads could both pass the quota check before either records. Mitigation: use `SELECT ... FOR UPDATE` in the RPC, or accept minor over-provision (self-correcting on next check).
