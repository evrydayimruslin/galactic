# Fee Waiver Referral PR Roadmap

## Product Rules

- End users pay the same gross Light amount whether a platform fee is waived or not.
- Developers receive more when a platform fee is waived.
- A referral landing creates at most one `user -> publisher` fee-waiver grant.
- Later clicks do not extend, renew, or recreate a referral grant.
- Users can have active grants for multiple publishers.
- Referral grants apply to all MCP creator revenue for that publisher, including marketplace app sales.
- Referral grants remain attached to the original publisher if an app changes owner.
- Referral grants do not consume developer fee-waiver credit.
- Developer fee-waiver credit is separate scrip that can pay some or all of the 15% internal platform fee.
- Fee-waiver credit has no expiry.
- Referral grants take precedence over developer fee-waiver credit.
- The leaderboard ranks only waived platform fees.
- End-user transaction UI should not change; terms/policy copy can explain the program.

## PR 1: Fee Waiver Schema Foundation

Add schema only, with no behavior change:

- `publisher_referral_links`
- `publisher_referral_landings`
- `publisher_fee_waiver_grants`
- `publisher_fee_credit_accounts`
- `publisher_fee_credit_ledger`
- `platform_fee_waiver_events`

This PR establishes constraints, indexes, RLS posture, and comments for the rest of the rollout.

## PR 2: Referral URL Creation And Owner Copy Surface

Create/refetch a referral link per listing owner.

- Add referral service helpers under `api/services`.
- Include owner-only referral link data in the existing marketplace listing response.
- Add a copyable referral URL to the owner admin surface in `ToolDetailView`.
- Disable old active links when app ownership changes in a later marketplace PR.

URL shape:

```text
/r/:referralSlug
```

## PR 3: Landing Capture And Anonymous Handoff

Add a public route for referral landings:

```text
GET /r/:slug
```

The route should:

- Validate the active referral link.
- Record a landing.
- Set a secure, HttpOnly, SameSite=Lax visitor cookie.
- Claim immediately if the requester is already signed in.
- Redirect to the canonical app page.

Anonymous landings are held by visitor cookie until auth.

## PR 4: Claim Referral Landings During Auth

Claim pending landings when identity becomes known:

- OAuth callback.
- Browser session bootstrap.
- Desktop OAuth callback.
- Provisional-to-real account merge.

Claim rule:

```text
first landing per user/publisher wins
starts_at = landed_at
expires_at = landed_at + 90 days
```

Expired historical landings may be claimed for audit, but they never waive future fees.

## PR 5: Desktop Deep-Link Claim Token

Handle users who click a referral URL in the browser but transact from an already-signed-in desktop app.

Deep link shape:

```text
ultralight://app/:id?ref_claim=:token
```

Desktop should post the token to an authenticated claim endpoint. This avoids requiring browser sign-in for attribution.

## PR 6: Apply Waivers To Tool Calls

Modify `transfer_light()` so creator-revenue transfers can waive platform fees.

Resolver order:

```text
1. active referral grant for payer -> publisher
2. publisher fee-waiver credit
3. normal platform fee
```

Return extra fields from the RPC:

```text
platform_fee
fee_would_have_been
fee_waived
waiver_source
waiver_event_id
```

For partial credit, charge the remaining fee and waive only the credit-covered amount.

## PR 7: Apply Waivers To Marketplace Sales

Modify `complete_marketplace_sale()`.

- Buyer still pays full sale price.
- Seller payout is `sale_price_light - platform_fee_charged_light`.
- Referral waiver can make seller payout equal full sale price.
- Record `transaction_kind = marketplace_sale` in `platform_fee_waiver_events`.
- Disable active referral links for the sold app without touching existing grants.

## PR 8: Fee Credit Admin And Reward Tooling

Add service/admin APIs for developer fee-waiver credit:

```text
POST /api/admin/fee-waiver-credits/grant
GET /api/admin/fee-waiver-credits/:publisherUserId
GET /api/user/fee-waiver-credit
```

All credit grants and spends write to `publisher_fee_credit_ledger`.

## PR 9: Waived-Fee Leaderboard

Add leaderboard query/API based only on `platform_fee_waiver_events.fee_waived_light`.

Suggested route:

```text
GET /api/marketplace/fee-waiver-leaderboard?period=30d|90d|all
```

Rank by:

```text
sum(fee_waived_light) desc
```

## PR 10: QA, Terms, And Reconciliation

Test cases:

- First referral click creates a fixed 90-day grant.
- Later clicks do not extend the grant.
- Expired grants do not renew.
- One user can have grants for multiple publishers.
- Self-referral is ignored.
- Referral waiver beats fee credit.
- Partial fee credit spends correctly.
- Marketplace sale waiver increases seller payout.
- GPU compute cost is not waived; only the developer fee can be.
- Leaderboard ranks only waived fees.

Rollout recommendation: ship PRs 1-5 behind a feature flag, then turn on monetary behavior in PRs 6-7 after attribution data is visible.
