# Design follow-ups — accumulated across the premium-UI port

Running list of things the design / BE teams need to decide or produce
before they can be cleanly tokenized / implemented. Maintained across
batches; appended to as new gaps surface. Ship as a single follow-up
mockup set + a small BE addendum at the end of the port.

Updated through Batch 3 audit (pre-3a).

---

## A. Missing UI patterns (need new mockups)

These exist in production but the design mockups don't cover them. We
kept the production treatment as-is and flagged here; please spec a
target visual.

### A1. Composer stop button (when `isLoading=true`) — Batch 2a, 2b-i
The mockup's `PremiumComposer` never depicts the `isLoading=true` steady
state, so it has no abort affordance. Production renders a small gray
filled rounded-rect to the right of the textarea with a square stop
glyph (`ChatInput.tsx`).

### A2. Queue-mode send button (when `isRunnerManaged=true`) — Batch 2a, 2b-i
Production renders an amber filled circle (`bg-amber-500`) for the
"queue a follow-up" send while an `isRunnerManaged` agent is running.
No mockup equivalent. The base hex is `ul-warning` but there's no
`-hover` token for the `bg-amber-600` hover.

### A3. Errored ToolCallCard treatment — Batch 2b-iii (PR #10)
The mockup's `PUI_ToolCallCeremony` documents three states
(`running` / `executing` / `completed`) and is silent on errors. We
invented a treatment matching the rest of the design language:
- Status icon: red X (in place of spinner/check)
- Card border: `border-ul-error`
- Background: `bg-ul-error-soft`
- Action label: `text-ul-error`
- Expanded body: prominent error banner with the message in
  `font-mono`, framed by `border-ul-error/30` and `bg-ul-error-soft`
- `animate-ring-resolve` is suppressed (only fires on clean completion)

Confirm or override.

### A4. Optional composer `+` popover — Batch 2b-i
The mockup has a `+` button bottom-left that opens a popover with
"Add files / Slash commands / Edit custom instructions". With slash
commands scrapped (decision: keep on BE only) and no "Edit custom
instructions" surface in production, only "Add files" would be in the
popover. We kept the paperclip as a top-level button instead. Confirm
the simplification, or spec what else should live inside `+`.

### A5. Library variant rationalization — Batch 3 audit
`library-screens.jsx` defines four layout variants: `LibraryGrid`,
`LibrarySectioned`, `LibraryHybrid`, `LibraryReceipts`. The
component-port-spec.md originally named three different sub-views
(`LibraryGrid.tsx`, `LibraryTable.tsx`, `LibraryShared.tsx`) that
**don't exist as separate components in the mockup**. Per the design
lead (2026-05-14): **Hybrid is the final design**; the other three
are exploration variants. Batch 3a will port only the Hybrid layout
and skip the others. If alternate views are wanted later (e.g., a
denser grid for very large libraries), spec as separate routes.

### A11. Visibility settings panel — Batch 4d (PR #18)
Mockup `AOwnerPanel` includes a per-listing visibility preset
selector (Public / Verified bidders / Hand-picked / Private)
controlling revenue + call-volume disclosure to bidders. Today the
side rail honors `marketplace_summary.show_metrics` but there's no
seller-facing toggle to flip that flag, gate by bid threshold, or
allowlist specific bidders.

Action: BE has `PATCH /api/marketplace/metrics-visibility` per the
audit; needs a small settings UI (likely tucked behind the
seller's Edit-ask flow, or a "Listing settings" expansion in the
side rail).

### A10. Transfer ceremony animation — Batch 4d (PR #18)
The full `AHandoffCeremony` from `acquisition-handoff.jsx` (~794
LOC of multi-stage choreography: lockup, numbers strip, keys
panel, backdrop transitions) is not implemented. Today, accepting
a bid atomically transfers ownership + refreshes the listing —
the page reflects the new state without ceremony.

Decide:
- Ship the ceremony as a follow-up batch (significant LOC, but
  high-leverage marketing moment)
- Or keep the minimal refresh + just add a confirmation toast

### A9. Dashboard drag/resize reorder — Batch 3c-ii (PR #14)
The cozy homescreen ships with add (picker modal) + remove (× in
edit mode) but NOT drag-to-reorder or pointer-resize. Mockup
implies both (edit mode is called "Drag or remove" in the header).

Implementation paths:
- (a) Hand-rolled pointer handlers driving CSS grid-row/grid-column
      reflow + sortable cards
- (b) A DnD library (react-dnd, dnd-kit) — but we've avoided adding
      dependencies so far
- (c) HTML5 drag-and-drop API — works but is awkward for grid layouts

Today: append-only positioning, instances ordered by their order in
`layout.cards[]`. Add to followups; (a) is probably the right path
to stay dependency-clean.

### A8. Kanban / Agents / Activity rehoming — Batch 3c-i (PR #13)
HomeView's three tabs are sunset by the cozy homescreen replacement.
Their content surfaces (project Kanban, Agents fleet management,
Activity event feed) are now unreachable from the desktop UI.

Decide:
- (a) Re-spec each as a widget tile that ships on the cozy homescreen
      (Kanban widget, Activity widget — would also need a BE manifest
      since they're Ultralight-native, not app-supplied)
- (b) Relocate to dedicated screens (e.g., new sidebar items)
- (c) Sunset entirely — accept that those surfaces are gone

Code for these surfaces (KanbanBoard, KanbanCard, CardDetailModal,
WidgetAppView, WidgetHomescreen, lib/suggestions, lib/templates) is
kept on disk for now. After this decision, a cleanup PR will either
delete or migrate the dead tree.

### A7. Sandbox runner permission UX — Batch 3b (PR #12)
The Tool detail page's per-function expand-to-sandbox needs a UX for
running a function on a tool the viewer doesn't have installed /
hasn't granted permissions for. Two paths:
- (a) Install + grant inline (modal flow), then run the sandbox call
- (b) Require install first, gate the Run button until installed

Sandbox currently renders disabled placeholder. Pick a path, spec the
flow + any consent surfaces.

### A6. RESOLVED — Cozy homescreen replaces tabbed HomeView (Batch 3 audit)
The cozy widget homescreen (`command-screens.jsx`) is a **hard
replacement** of the existing tabbed [HomeView.tsx](desktop/src/components/HomeView.tsx)
(Project / Agents / Activity tabs). Per the design lead
(2026-05-14): no tabs on the new command screen; full replacement.
Implementation will sunset Kanban / Agents / Activity tabbed surfaces
when Batch 3c lands. If those surfaces are still needed, they'll be
specced as widget tiles in a follow-up batch.

---

## B. Missing data layer (need BE additions)

The FE could ship richer behaviors but the BE doesn't surface the data
yet. None of these are blockers for the current batches.

### B1. Per-model flash/heavy tier curation — Batch 2b-ii (PR #9)
`BYOKModel` is `{ id, name, contextWindow, inputPrice?, outputPrice? }` —
no tier metadata. The mockup's `MODELS_BY_PROVIDER` editorially groups
each provider's models into `flash` and `heavy`. As a result, both Flash
and Heavy popovers currently show the **same** provider catalog; the
`tier` prop on `ModelPickerPopover` only routes the pick to the right
storage key.

If the design intent is genuine flash/heavy curation per provider, the
BE needs to add a tier annotation to each model (or a separate
`flashModels` / `heavyModels` split on `ChatInferenceProviderOption`).

### B2. Slash command registry — Batch 2b-i (scrapped on FE per user)
The mockup's `SLASH_CMDS` array is hardcoded; there's no BE service
to register / list / dispatch slash commands. User chose to scrap on
FE for now. If slash commands become a real feature, BE needs a
registry endpoint.

### B3. In-stream tool error state via SSE — Batch 2b-iii (PR #10)
`AccumulatedToolCall` in `desktop/src/lib/sse.ts` has no `status` field.
`ToolInvocationTelemetryRequest` (`shared/contracts/ai.ts:113`) defines
a proper `status: 'success' | 'error' | 'aborted' | 'timeout'` + `errorType` +
`errorMessage`, but it's only emitted as post-hoc telemetry, not streamed.

To get rid of the heuristic error detection in `MessageBubble`
(currently: `/^(error[:\s]|\[error\b|exception[:\s])/i`), `useChat`
needs to surface telemetry-style status into the `Message` type
(`hooks/useChat.ts:13`).

### B7. Author / seller profile pages — Batch 4 audit (2026-05-14)
The marketplace mockups reference per-author/seller pages (avatar +
"by @sara" linking to that user's catalog + acquisitions). No
endpoint today: `GET /api/discover/seller/{userId}` or `/api/users/
{userId}/apps` for listing all apps owned by a user. Marketplace
view in Batch 4a will render author names but not link out until
this lands.

### B8. Category / capability filter facets — Batch 4 audit (2026-05-14)
`GET /api/discover/marketplace` supports `?type=apps|skills` and
`?runtime=gpu|deno` but not `?category=` (despite apps having a
`category` column) or capability filters (e.g., `?caps=ai,storage`).
Mockup market sidebar suggests category-faceted browsing. Batch 4a
will surface categories from the `sections` response but the
category-as-filter path requires either a new query param or a new
`/api/discover/by-category/{cat}` endpoint.

### B16. BYOK provider key editor — Batch 5c (PR #21)
SettingsTab surfaces BYOK status (read-only) from `profile.byok_enabled`
+ `byok_provider`. There's no UI to actually paste/rotate the API key
for a provider — currently you'd have to do it via the web settings
surface.

Needs:
- Per-provider key entry form (Anthropic / OpenAI / OpenRouter /
  DeepSeek), with masked input + Save + Remove
- Status display ("connected" / "no key") synced with the composer's
  ModelPickerPopover provider status badges (already wired)
- Either a new endpoint or surface the existing one if it exists
  (search `api/handlers/user.ts` for `byok` writes)

Today the composer can show provider status, but users can't
configure keys from desktop. Marketplace works fine since the
composer falls back to the Light tier.

### B15. RESOLVED — Stripe.js Payment Element in AddLightModal (PR #34)
Shipped: `@stripe/stripe-js` was added as a desktop dep with CSP
additions for the necessary `stripe.com` hostnames; the new
`StripePaymentPanel.tsx` mounts Stripe's Payment Element inside
AddLightModal. The Element auto-detects which payment methods the
device supports (Apple Pay if the WKWebView is entitled, Google Pay
on supported platforms, Link, card fallback) — one mount surfaces
every method available on the machine. The BE webhook already
credits Light on `payment_intent.succeeded`; the FE just flips to
the success state once `confirmPayment` resolves.

### B14. RESOLVED — `/api/user` GET surfaces `stats` + `created_at` (PR 41)
The handler now best-effort-fetches `created_at` from `users` and
the `get_user_profile_stats` RPC in parallel after `userService.getUser`
returns, then merges them into the response as `created_at` and
`stats: { published_app_count, acquired_app_count }`. The RPC is the
same one the public author profile (`GET /api/user/profile/:slug`)
already uses, mapped from `{ published_count, acquired_count }` to
the FE's snake_case names. Both are optional in the payload so the
FE's pre-B14 proxies stay in play during the BE deploy gap.

### B13. W-9 / VAT collection — Batch 5 audit
Beyond simple billing address (`/api/user/billing-address`), full
tax compliance forms (W-9 for US sellers, VAT number for EU
sellers, etc.) aren't wired. Payout flow can onboard via Stripe
Connect but tax-doc collection is a separate concern; Stripe Connect
handles some of this via Express onboarding but the platform may
need its own surface for thresholds (e.g., 1099-K reporting).

### B12. Usage time-series aggregation — Batch B (PR #40) — BE pending
PR #40 ported `BB_B12_Chart` into ProfileView's BALANCE tab: 4
windows (7d/30d/90d/1y), per-app stacked bars, toggleable legend,
per-app table with sparkline. The FE calls
`GET /api/usage?range=7d|30d|90d|1y&groupBy=app` and falls back
gracefully to an empty state if BE returns non-200 (see
`fetchUsageSeries` in `desktop/src/lib/api.ts`).

BE-side: implement the endpoint and the bucket shape documented in
`UsageSeriesResponse` (api.ts:1344) — server should aggregate the
heavier ranges (90d → weekly, 1y → monthly) so the payload stays
small regardless of account age. The legacy "Last 7 days" strip in
ProfileView (`bucketDailySums` / `SevenDayBars`) was deleted in
PR #40.

### B11. "Install" (save-to-library) endpoint — Batch 4c (PR #17)
The mockup's tool detail page has both an **Install** button (free,
free, adds to library) and an **Acquire** button (paid, transfers
ownership). Acquire is now wired through AcquisitionFlow → `/api/
marketplace/{bid,acquire,cancel}`. Install has no obvious BE
endpoint:
- The user_app_library join exists (used by `ul.discover` library
  scope) — so a "saved apps" concept is in the DB — but no
  POST endpoint to add an app to it was found.
- Possibilities: there's a `POST /api/user/library` or similar
  that I didn't find, OR the FE used to call something via the
  web side, OR "install" isn't a real BE action and it just means
  "I've seen / used this app".

Action: confirm whether an install endpoint exists, expose if
needed, then we'll wire Install. Today the button stays disabled.

### B10. Marketplace result enrichment — Batch 4a (PR #15)
The `/api/discover/marketplace` response surfaces apps with `runs_30d`,
`likes`, `marketplace` listing snapshot, `trust_card`, etc. — but
the mockup's per-tool fields don't all map. Missing:
- `sparkline` (last 7d trend, ~8 data points) — useful for the
  billboard row visual
- `growth7d` (percent change) — paired with sparkline
- `latencyP50` (request latency, per-tool) — overlaps with B5
- per-call price (cost per function call, not the transaction-level
  ask_price_light) — needs a pricing config endpoint or a field on
  the discover result
- author display name — currently only `owner_id` UUID is returned;
  FE shows a slug-prefix fallback (`@<slug-prefix>`) until B7
  (author profile pages) lands

Today: billboard column repurposed for `active_bid_count`; trending
cards show `ask_price_light` in place of per-call price. Neither
is wrong but neither is exactly what the mockup specifies.

### B9. Bid expiration cleanup + payout withdrawal — Batch 4 audit
Two adjacent gaps surfaced in the marketplace audit:
- `app_bids.expires_at` is stored on placement but no worker auto-
  expires + refunds stale bids. Manual cancellation only today.
  Buyer-side risk: if buyer abandons, escrow remains held until
  manual cancel.
- Seller payout WITHDRAWAL (from Light balance to fiat via Stripe
  Connect) — `users.balance_light` accrues on accepted sales but
  there's no clear FE surface or BE flow for the seller to "cash
  out". Trust.ts hints at Stripe integration; handler-side ties
  weren't fully traced.

Both are post-MVP polish — won't block Batch 4 unless we want a
seller payout surface on the marketplace.

### B6. Per-card burn rate / cost-per-min — Batch 3c-i (PR #13)
The mockup's cozy tile header has a `✦{n}/min` burn rate in the
top-right of each tile. `CardDefn` has no per-call cost or pull-rate
field today. Optional addition: surface per-card cost-per-minute on
the card defn or derive from the widget's pull settings (the
existing `widgetRuntime.ts` already tracks pull cost; would need to
map dashboard cards to those settings).

Tile chrome currently renders without the burn-rate eyebrow.

### B5. Per-function price/call + latency metadata — Batch 3b (PR #12)
`SkillFunction` in `shared/types/index.ts:233` is
`{ name, description, parameters, returns, examples? }`. The mockup's
function table has `Price/call` (✦{n}) and `Latency` (ms) columns; we
currently render `—` placeholders for both.

BE additions needed (any subset is useful):
- Per-function cost cents (or use a uniform per-app cost from the
  pricing config that already exists on apps?)
- Per-function p50/p95 latency, either declared by app authors or
  derived from `total_runs` telemetry.

### B4. RESOLVED — Command card BE is in place (Batch 3 audit, 2026-05-14)
Earlier batches flagged "compact widget view" as a potential
follow-up. Audit found the BE work already landed on main:
- `api/services/command-dashboard.ts` (628 LOC) — `CommandDashboardCardInstance`
  contract
- `api/services/command-surfaces.ts` (534 LOC) — `ul.command` MCP tool
- `api/handlers/user.ts` — 3 REST endpoints:
  - `GET /api/user/command-widgets`
  - `GET /api/user/command-dashboard?dashboard_key=<key>`
  - `PUT /api/user/command-dashboard`
- `desktop/src/lib/api.ts:759-876` — already wraps all 3 endpoints
- `apps/mcps/email-ops/manifest.json` — proof-of-concept with `drafts_queue`
  (2x2 list) + `inbox_volume` (2x1 metric) cards.

No new BE work needed for Batch 3c. FE just needs the tile renderer
+ grid layout component + per-`kind` templates.

---

## C. Missing token entries (small additive PR after design confirms)

Several hover pairs were left raw because there's no `-hover` token in
the design vocabulary. Trivial to add once the design team picks the
target hex values.

### C1. `*-hover` tokens
Used across the chat surfaces; currently kept raw with `TODO(token):`
comments:

| Need | Used by |
|---|---|
| `info-hover` | `text-blue-500 hover:text-blue-700` ("Open Chat ↗" link, AgentHeader / NavSidebar) |
| `error-hover` | `text-ul-error hover:text-red-700` ("Stop" link on subagent) |
| `warning-hover` | `bg-amber-500 hover:bg-amber-600` (queue-mode send button — would unblock A2 tokenization too) |
| `accent-hover` (filled-button hover) | `bg-gray-800 hover:bg-gray-700` (default ChatInput send button — gray-800 `#1f2937` doesn't match `ul-accent` `#0a0a0a` either; see C3) |

### C2. Composer "mute" tone — Batch 2b-i (PR #8)
The mockup's `PremiumComposer` uses **two distinct mute greys**:
`#777` for the Tool selection pill, `#888` for the model pills. Both
are between `ul-text-muted` (`#999999`) and `ul-text-secondary`
(`#555555`). Currently kept raw as `text-[#777]` / `text-[#888]`.

Either (a) add `ul-text-mute-strong` and `ul-text-mute-medium` tokens
covering 777/888, or (b) commit to a single mute token and accept the
2-color gradient collapses.

### C3. Send-button filled tone — Batch 2b-i
The default ChatInput send button uses `bg-gray-800` (`#1f2937`).
`ul-accent` is `#0a0a0a` (true black). The mockup uses pure black for
the "armed" state border + text — but the production filled bg has
historically been `gray-800`, slightly softer. Decide which is the
target: tokenize to `ul-accent` and accept the slight darkening, or
add an `ul-accent-soft-strong` (`#1f2937`) token.

---

## D. Specific raw-color spot fixes

Smaller — values currently kept raw because no exact `ul-*` token
matches. Listed for completeness; some collapse to the items in C
above once `-hover` tokens land.

| Raw value | Hex | Where | Closest token (and why it's not exact) |
|---|---|---|---|
| `bg-gray-300` | `#d1d5db` | status dot (pending/default) in AgentHeader, NavSidebar | nothing close enough |
| `bg-gray-200` | `#e5e7eb` | avatar circle bg, stop button bg | nothing close enough |
| `bg-gray-100` / `hover:bg-gray-100` | `#f3f4f6` | menu hovers across NavSidebar; file chips bg in ChatInput | `bg-ul-bg-hover` is `rgba(0,0,0,0.04)` — much subtler |
| `text-gray-400`, `text-gray-500`, `text-gray-600` | `#9ca3af`, `#6b7280`, `#4b5563` | file chips, paperclip, default SystemAgentIcon | sit between `ul-text-muted` and `ul-text-secondary` |
| `text-emerald-500` | `#10b981` | ToolCallCard completed check | `ul-success` is `#22c55e` (green-500) — hex-different |
| `border-blue-200` / `border-blue-300` / `border-t-blue-600` | various blues | ToolCallCard executing ring, spinner border-tops | no token covers spinner ring tones |
| `from-blue-50/40` | `#eff6ff` w/ alpha | ToolCallCard executing gradient | nothing close |
| `border-gray-150` | not a real Tailwind class | ToolCallCard idle border | Vite renders nothing; pick a real class |
| `placeholder:text-gray-500` | `#6b7280` | textarea placeholder | as above |
| `border-dashed` | utility | custom-paste CTA in ModelPickerPopover | no token covers dashed borders |

---

## E. Onboarding & first-launch ceremony — Batch 6a

### E1. No BE-tracked onboarding completion
Onboarding completion is currently a local `localStorage["ul_onboarding_complete"]`
flag. Multi-device users see the tour again after re-installing. Suggested:
add `onboarding_completed_at` to the user profile (`PUT /api/user/profile`
already exists for adjacent fields) and read it on auth resume.

Not blocking the visual port. Filed for the wrap-up batch.

### E2. No "brand-new user" vs "returning user" signal
Beyond E1, the Platform Guide wizard could shorten itself for users who
sign in on a second machine but already explored the platform. Today it
runs the full 4-stop tour every time the local flag is missing.

### E3. Onboarding composer → chat seeding
Step 3 of the Platform Guide ends in a live composer ("Try it: deploy a
hello-world tool…"). The mockup implies the draft message becomes the
user's first chat. Production currently routes to a fresh chat but
**discards** the draft (the wizard ships `draftPrompt` through
`onComplete` but `App.tsx` drops it — search `_draftPrompt` in `App.tsx`).

Wire-up needs: a way to pre-seed `ChatInput`'s initial value on a brand
new chat. Could be done with a `useAppState` field
(`pendingComposerDraft`) read once by `ChatView` and cleared on first
keystroke.

---

## G. Acquisition handoff screens — Batch 8 PR 30b

Three screens from Section 3 of the acquisition handoff that need
recently-transacted state to do their job, deferred until that state
exists.

### G1. Seller library banner (3E1b ASellerLibrary)
One-time "sold · keeps running for you" banner shown in the seller's
LibraryView the next time they open it after an acceptance. Needs:
- A list of "apps I recently sold" with sale price + buyer handle +
  timestamp. The BE has the sale record (`sales` table referenced in
  the acquisition handlers); FE needs an endpoint to query the last
  N sales for the current user.
- A "banner dismissed" flag per sale so we only render once.

Today the seller sees the SoldConfirmation modal (PR 30b) at the
moment of acceptance and that's it. No follow-up on next launch.

### G2. Buyer library banner (3E2 ABuyerLibrary)
The inverse — "newly acquired · waiting on you" tile pinned to the
top of the buyer's LibraryView, with a pulsing "Open admin →" CTA
that fires the TransferCeremony. Needs:
- A list of "apps I recently acquired" for the current user
  (`acquisitions` join or similar — adjacent to the existing
  `marketplace_summary` shape).
- A dismissed flag per acquisition.

Today the buyer sees the TransferCeremony immediately on
instant-bought (PR 30b). The accepted-path buyer sees nothing
until they navigate to the tool — at which point they're already
in the owner view. This banner is the missing handoff for the
async accepted path.

### G3. Post-handoff admin steady state (3E4 AAdminPostHandoff)
Per the addendum this is just the regular ToolDetailView in owner
mode — already shipped (Batch 4d). No new work needed; flagged here
only so the section accounts for all of Section 3.

---

## F. Cmd+K palette & empty states — Batch 6b

### F1. Unwired palette actions (mockup-listed, no production target)
The palette mockup advertises five commands that have no real
implementation: **Deploy current tool** (⇧⌘D), **Share this run**
(⇧⌘S), **Run validation** (⌘T), **View 7-day spend**, **Switch
workspace**. Per the no-no-op principle, they're omitted from
[CmdKPalette.tsx](desktop/src/components/CmdKPalette.tsx) today.

Decide which of these we want wired vs. retired:
- "Deploy current tool" needs a notion of "currently-edited tool" —
  unclear what surface that maps to.
- "Share this run" presumes shareable chat URLs — not built.
- "Run validation" — could route to a Tool Builder agent prompt; FE
  decision.
- "View 7-day spend" — could open a Wallet sub-tab; no BE rollup yet
  (related to B14).
- "Switch workspace" — multi-workspace is a much larger BE feature.

### F2. Per-agent ⌘1 / ⌘2 / ⌘3 shortcuts unwired
Palette renders the shortcuts (`⌘1` Tool Maker, `⌘2` Tool Dealer,
`⌘3` Platform Guide) but the keystrokes themselves are not bound.
Wire-up needs to live alongside the existing `(e.metaKey || e.ctrlKey)
&& key === 'k'` handler in [App.tsx](desktop/src/App.tsx) and respect
input focus.

### F3. ConstellationHero replay
The mockup `ConstellationHero` accepts `replayKey` so the typing
animation can rerun after the user dismisses it (e.g., navigating
back to the empty chat). Today it remounts on each route change so
this is a non-issue, but if we ever cache the empty state we'll need
to pass an incrementing `replayKey`.

---

## H. Launch Web UI parity pass (2026-06-09)

Items surfaced while streamlining `apps/launch-web` against the
`handoff/launch-web/mockups` canvas (Launch Web Mockups.html). Everything
implementable from existing FE data shipped; the rest is listed here.

### H1. ✦ Light glyph vs USD credits — needs a design decision
The mockups render every money value with the `✦` Light glyph
(`launch-data.jsx` `fmtLight`, wallet/leaderboard/admin receipts). The
codebase has since migrated display to **USD-denominated credits** —
`formatCreditFromLight` in `shared/types/index.ts:1312` is documented as
formatting "USD credits from the *legacy* Light storage amount". We kept
`$` everywhere rather than regress the migration. The mockup set needs a
refresh to USD, or product needs to re-bless ✦ as a display unit.

### H2. Hosting-suspended banner has no contract field
`launch-admin.jsx:188–191` shows an amber "Hosting suspended" banner.
`LaunchToolAdminSummary` carries no hosting/suspension flag, so the
banner isn't rendered. Needs a BE contract addition.

### H3. Trust & Setup card — partial data only
The full mockup card (`launch-trust.jsx`) includes a Receipts row, a
"Required setup" section (OAuth/secret status), and a "View manifest"
footer action. The public tool contract exposes none of these (no
manifest URL, receipts flag, or setup state). Shipped: signed-manifest
header, owner badge, meta rows, capability permission pills.

### H4. Mobile Catalog tabs not ported
`launch-discover.jsx:140–166` gives mobile a three-tab layout (Tools /
Builders / Fee credit). The app currently stacks the desktop sections on
mobile. Port pending design confirmation that tabs are still wanted.

### H5. Retrieval diagnostics in empty state
Mockup empty state shows "semantic ✗ → lexical ✗" style retrieval
telemetry with per-mode counts. Confirm `/api/launch/discover` exposes
`embeddedSources`/counts; FE currently renders only the mode string.

### H6. Wallet "Receipts" tab is an app addition
Mockup wallet has Balance / Top up / Earnings only; the app adds a
Receipts tab. Kept — design should confirm or fold it into the Balance
ledger.

### H7. "Use another account" can't force account selection
The sign-in modal's "Use another account" state redirects through the
same `buildLaunchSignInUrl()`; the auth bridge has no
`prompt=select_account` passthrough. Small BE addendum if the forced
chooser matters.

### H8. Minor type deviations kept
- Leaderboard names render mono; mockup uses sans 12.5/500.
- Install-page "Sign in" CTAs now open the sign-in modal (they were
  inert placeholders); confirm intended post-auth behavior.

---

## How this file is maintained

- Append new items as each batch surfaces them; never overwrite an
  item that's already shipped (it'd lose the per-PR context).
- Sections are: A=mockup gaps, B=BE gaps, C=token additions,
  D=raw-color spot fixes, E=onboarding & first-launch,
  F=cmd+k & empty states, G=acquisition handoff screens.
- After the design team responds, this file becomes the punch list
  for a wrap-up batch (or a small BE addendum PR).
