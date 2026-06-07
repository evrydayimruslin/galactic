# Launch Web — Backend Deficit Map

**Date:** June 6, 2026
**FE source of truth:** `mockups/Launch Web Mockups.html` (this package) — the full design canvas, every page × state, desktop + mobile.
**BE reviewed against:** `evrydayimruslin/ultralight` @ `main` (commit `a51eefc`). Read: `launch.ts` (+`launch.test.ts`), `apps.ts`, `user.ts`, `http.ts`, `developer.ts`, `discover.ts`, `mcp.ts`/`platform-mcp.ts` (surface), `fee-waivers.test.ts`, `ultralight-spec/`.

> **Correction note:** an earlier pass mistakenly reviewed `ultralight-mvp` (an older, unrelated *app‑builder* repo). This document supersedes it.

---

## TL;DR

**Almost the entire Launch surface is already backed.** `ultralight` ships the curated `/api/launch/*` read facade *and* the underlying write/runtime paths in `apps.ts` + `user.ts`. After reading the mutation handlers (not just the facade), the four items flagged “confirm” in the prior draft are now **confirmed to exist**. **Tools are the `apps` table.**

The job is overwhelmingly **wire the FE to existing endpoints**. Only **one** screen concept is genuinely net‑new (per‑function agent permissions), plus a few thin wiring/ξpagination tasks and one number to verify (top‑up fee math).

---

## Legend

| Mark | Meaning |
|------|---------|
| 🟢 **Exists** | Endpoint/RPC ships today (facade or `apps.ts`/`user.ts`). FE consumes it; at most it lives under `/api/apps/*` rather than `/api/launch/*`. |
| 🟡 **Thin extend** | Capability exists but needs pagination, a query param, or a launch‑namespaced passthrough. |
| 🔴 **Build** | No backing found. New schema + endpoint. |

---

## Per‑screen map

### 1. Home — 🟢
`GET /api/launch/status · /install · /platform-primitives · /leaderboard?kind=builder`. “Add to agent” blob from `/install` (claude_code, cursor, codex, openai_remote_mcp, generic_mcp, cli, api → `/mcp/platform`). CTA swap on Light>0 from `wallet.spendableBalance`. No gap.

### 2. Sign in — 🟢
Supabase Google OAuth; authed routes 401 → popup → resume. No gap.

### 3. Library — 🟢 (lives under `/api/apps/*`)
- List: `GET /api/launch/library` (owned+installed) **and** `GET /api/apps/me/library?tab=saved|shared`. 🟢
- **Install / uninstall:** `POST /api/apps/:appId/save` → writes `user_app_library`; `DELETE /api/apps/:appId/save` removes. 🟢 *(was flagged 🔴 — confirmed exists.)*
- **CTA state:** `GET /api/apps/:appId/library-status` → `{ inLibrary, isOwner, hasUserSettings }` (O(1), drives the Install vs Installed button + “setup required”). 🟢
- “Free” label / counts → `pricing_config` + `runs_30d`. 🟢

### 4. Owner admin — 🟢 (writes live in `apps.ts`)
- Read: `GET /api/launch/admin/tools/:id`. 🟢
- **Edits:** `PATCH /api/apps/:appId` — whitelisted fields: `name, description, visibility, icon_url, tags, category, download_access, pricing_config, gpu_pricing_config, long_description`. Visibility (`private|unlisted|public`) is tier‑gated + publish‑deposit‑gated. Widgets edit via the `manifest` field (re‑resolves `env_schema`). 🟢 *(was 🟡 — confirmed.)*
- **Pricing (per‑function):** `pricing_config` supports `default_price_light` **and** `functions{}` mapping function→price. **Per‑function pricing already exists.** 🟢 *(upgrades the tool‑page price too.)*
- **Secrets:** owner env via `PUT /api/apps/:appId/env` (replace) + `PATCH …/env` (partial); per‑user secrets encrypted in `user_app_secrets` via `PUT /api/apps/:appId/settings`. 🟢 *(was 🟡 — confirmed.)*
- Receipts (revenue), Logs (runs+errors) → `mcp_call_logs`. 🟢
- Hosting‑suspended → `apps.hosting_suspended`. 🟢
- *(Note: `developer.ts` is OAuth‑client management — not tool admin. Don’t conflate.)*

### 5. Store / Discover — 🟢 (one leaderboard re‑point)
- `GET /api/launch/discover` → semantic (`search_apps` over tool/primitive/install‑doc embeddings) + lexical fallback (`retrieval.mode/embeddedSources/fallbackSources`). 🟢
- Builder leaderboard → `get_leaderboard`. 🟢
- **Fee‑credit (“fees waived”) leaderboard** → exists at `GET /api/marketplace/fee-waiver-leaderboard?period=&limit=` (`get_fee_waiver_leaderboard` → `fee_waived_light`, rank). Add `kind=fee_credit` passthrough on the launch leaderboard *or* point the FE at the marketplace route. 🟡 **wire**

### 6. Public tool page — 🟢 except per‑function permissions
`GET /api/launch/tools/:id · /widgets · /widgets/:widgetId`.
- Header, publisher, install count, visibility, 404‑private → 🟢.
- **Widgets tab:** `POST /api/launch/tools/:id/widgets/:widgetId/render` runs the dev UI fn through the billing/secret/receipt path; client sandboxes the returned HTML in an iframe. Loading / error / setup‑required map to the render response + `required_secrets`. 🟢
- **Details tab:** `TrustCard` (signer, version, runtime, capabilities, required setup, receipts). 🟢
- **Per‑function ✦ price:** `pricing_config.functions`. 🟢
- **Install button:** `POST /api/apps/:appId/save` (§3). 🟢
- **Functions‑tab “Run” sandbox:** the execution path exists (MCP `tools/call` via `platform-mcp.ts`; `run.ts`). What’s not yet a clean web entry point is “run **this** function with caller args from the page, billed, return the receipt.” Likely a thin wrapper over the MCP call path. 🟡 **confirm/expose**
- **Agent permission per function (always / always‑ask / never)** + the Profile defaults that seed it — **no backing found.** This is the one genuinely new model (persisted per user × function). 🔴 **build**

### 7. Wallet — 🟢 (much richer than the facade summary)
`GET /api/launch/wallet` → `WalletSummary`. Underlying model in `user.ts` confirms:
- **Balance vs Earnings split is real:** `deposit_balance_light` (top‑ups) vs `earned_balance_light` (creator income), plus `escrow_*`. Maps 1:1 to the mockup’s Balance / Earnings tabs. 🟢
- **Combined ledger** with `kind` = call/topup/transfer/payout already. 🟢 for *recent*; the mockup’s **infinite‑scroll** wants `?cursor=` pagination and **earnings‑by‑tool** `?tool=` — not yet discrete params. 🟡 **extend**
- **Top up:** **Apple/Google Pay** via `createWalletExpressPaymentIntent` (`wallet_funding`) **and ACH/wire** via `createWireTransferPaymentIntent` (`wire_funding`); Stripe webhook finalizes (`recordPendingLightDeposit` → `finalizeLightDeposit`). Auto‑topup fields exist (`auto_topup_enabled/threshold/amount`). 🟢 — **only open item:** confirm the **exact fee math** (mockup shows 2.9 %+$0.30 card / ACH 0.8 % capped $5) lives in `services/stripe-wallet-funding.ts` / `stripe-wire-funding.ts` / `billing-config.ts`. 🟡 **verify numbers**
- **Withdraw (Earnings):** Stripe Connect withdrawal (`validateWithdrawalRequest`, `stripe_connect_*`, `StripeConnectWithdrawRow`). 🟢
- **Transfer Earnings → Balance:** exists as an earned→deposit **conversion** (`converted_light` + `deposit_balance_light`/`earned_balance_light` rows) plus the `auto_add_earnings_to_balance` toggle. 🟢 *(was 🔴 — confirmed.)*

### 8. Profile — 🟢 except permission defaults
- Account + sign out → Supabase. 🟢
- **API key** (copy / rotate / revoke) → `GET/POST /api/launch/api-keys`, `DELETE /:id` (scope `apps:call`). 🟢
- “Connecting an agent?” → `/install`. 🟢
- **Default new‑tool / installed‑tool permission** → same missing model as §6. 🔴 **build**

---

## The genuine deficit list (what to actually build)

1. 🔴 **Per‑function agent permissions** (always / always‑ask / never), persisted per user × function, with Profile‑level defaults. The only net‑new data model. *(§6, §8)*
2. 🟡 **Functions‑tab Run endpoint** — auth’d, billed, sandboxed web execution of one function with caller args, returning the MCP receipt shape. Thin wrapper over the existing call path; confirm it isn’t already exposed. *(§6)*
3. 🟡 **Wallet inline detail** — add `?cursor=` pagination to the ledger and `?tool=` filter to earnings for the infinite‑scroll tabs. *(§7)*
4. 🟡 **Verify top‑up fee math** matches the mockup (2.9 %+$0.30 / ACH 0.8 % cap $5) in the Stripe funding service + `billing-config.ts`; adjust copy or config to match. *(§7)*
5. 🟡 **Fee‑credit leaderboard wiring** — expose `kind=fee_credit` on the launch leaderboard or point the FE at `/api/marketplace/fee-waiver-leaderboard`. *(§5)*

Everything else is already wired — consume the endpoints. Items that were 🔴/🟡 in the prior draft (install write, owner‑admin writes, secrets write, Transfer‑Earnings‑to‑Balance, per‑function pricing) are **confirmed to exist**.

---

## Don’t rebuild (confirmed in `ultralight`)

`launch.ts` read facade · `mcp.ts`/`platform-mcp.ts` runtime + `mcp_call_logs` (receipts/logs) · widget render (`…/render`, iframe sandbox) · `TrustCard` · semantic `discover.ts` · builder + fee‑waiver leaderboards · **Light wallet w/ deposit‑vs‑earned split, ledger, Stripe wallet/wire funding, Connect withdrawal, earned→balance conversion, auto‑topup** · per‑function pricing (`pricing_config.functions`) · install/uninstall (`/api/apps/:appId/save` → `user_app_library`) · owner edits (`PATCH /api/apps/:appId`) · env/secret writes (`/env`, `user_app_secrets`) · API keys (`apps:call`) · Supabase Google OAuth · `apps.hosting_suspended`, `runs_30d`, `manifest.widgets`, `env_schema`.

---

## Caveats on this review

Reviewed by reading the facade, the mutation handlers (`apps.ts`, `user.ts`), tests, the generated OpenAPI, and `ultralight-spec/` — not by running the stack. **One** item is still unread at the source level: the **exact top‑up fee percentages** (in `services/stripe-wallet-funding.ts` / `stripe-wire-funding.ts` / `billing-config.ts`) — the funding *flows* are confirmed; only the numeric fee policy needs an eyeball. The Functions‑tab “Run” web entry point should also be confirmed against `run.ts`/`platform-mcp.ts` before estimating.
