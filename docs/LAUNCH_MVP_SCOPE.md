# Launch MVP Scope

Last rewritten: 2026-06-10 (launch pivot — see
[LAUNCH_PIVOT_DECISIONS.md](LAUNCH_PIVOT_DECISIONS.md) for the decision record
and phase plan).

This document defines the public launch surface for the Ultralight MVP. The
repository remains the capability basin; launch exposes a curated,
production-facing layer over it. The desktop app is scrapped and is not part
of any launch stage.

## Launch Thesis

Deploy Agents any existing agent can install, call, compose, and pay for.

Ultralight launches as the agent-native layer for MCP-capable clients. Users
bring their own **connected agent** (Claude Code, Cursor, Codex, OpenClaw, any
MCP client) and connect it to Ultralight once. Developers deploy TypeScript
functions that become **Agents** — live MCP servers with functions, pricing,
trust cards, and user-controlled permissions. Everything an Agent exposes is a
Function; Agents are interoperable and composable out of the box, with the
user holding the permission keys.

## Included In MVP (target scope)

- Website built around install, library, discovery, public Agent pages,
  wallet, settings, and owner admin — on Cloudflare Pages.
- The platform MCP (`POST /mcp/platform`) and per-Agent MCP endpoints
  (`POST /mcp/{agentId}`), plus CLI/API install paths — on Cloudflare Workers.
- Agent library for owned and installed Agents.
- Agent discovery (semantic + lexical) across public Agents, functions,
  install docs, and platform primitives.
- Public Agent pages: install, Functions (the only capability surface),
  pricing, trust, owner, and admin affordances.
- Credits wallet: top-up, balances, transactions, receipts, earnings, payout
  status. (The credit was formerly named "Light"; user-facing surfaces say
  **Credits**. Internal DB names keep `*_light` — see decision record.)
- BYOK provider keys and credit-denominated inference: users may bring their
  own model keys (BYOK) or run platform inference debited from their Credits
  balance. Billing mode is explicit on the surfaces that trigger inference.
- Per-function caller permissions: the user's connected agent is governed by
  per-function always/ask/never policies; cross-Agent function grants (the P5
  model) extend this in a later phase.
- Builder and fee-credit leaderboards in discovery.
- Launch API facade (`/api/launch/*`) exposing only MVP-safe contracts.

## Removed From Launch Scope (kept dormant in the basin)

- **Widgets** — no public widget surfaces, widget endpoints, widget contract
  types, or widget discovery entries. Agent pages are Functions-first.
- **First-class Skills** — no skill entities, skill-pull billing, or skill
  endpoints. The convention replaces them: an Agent may export a skills-index
  function (returns skill descriptors) and a skill-reader function (returns
  full text), priced via ordinary per-function pricing. Generated `skills.md`
  function documentation remains and is served free.

## Deferred From MVP

- Desktop app (scrapped, not deferred — remnants are being removed).
- Web search toggle and provider-native browsing features.
- Cerebras or custom fast inference.
- Standalone Jarvis/general agent.
- Command cards, command dashboards, generated/agentic UI composer.
- Routines and perpetual agent responsibilities.
- Full tool-builder agent experience.

Deferred capabilities remain implemented internally but must not appear in
launch navigation, public copy, or default onboarding.

## Public Website Routes (target)

- `/` — launch home and primary install CTA.
- `/install` — copyable MCP, CLI, and API install instructions.
- `/library` — signed-in owned and installed Agents.
- `/store` — public Agent discovery (`/discover` remains a compat alias).
- `/agents/:slug` — public Agent page (`/tools/:slug` remains a compat alias
  through the P4 rename window).
- `/wallet` — Credits balance, top-up, transactions, receipts, earnings,
  payout status.
- `/settings` — account, API keys, BYOK provider keys, default caller
  permissions.
- `/admin/agents/:id` — owner-only Agent management (compat alias from
  `/admin/tools/:id`).

## Authentication

Launch web sign-in is the bridge flow: API-side Google OAuth (PKCE) issues a
short-lived encrypted bridge token in the redirect fragment; the SPA exchanges
it at `POST /auth/launch/exchange` for a bearer access token plus an HttpOnly
`SameSite=None` refresh cookie. The SPA silently rotates sessions via
`POST /auth/launch/refresh` (single-flight, one 401 retry), so account-session
surfaces (wallet, API keys, permissions, BYOK) survive past the access-token
lifetime. Sign-out revokes the Supabase session and clears the refresh cookie.

## Transition Status (honesty table)

The contract constants in `shared/contracts/launch.ts` are the mechanical
source of truth and are updated phase by phase; until a phase lands, code may
still reflect the pre-pivot scope.

| Change | Status |
|---|---|
| Session refresh + auth hardening | Landed (Phase 0) |
| Desktop CORS/bridge decoupling | Landed (Phase 0); endpoint teardown later |
| Skills → Functions convention (P3) | Landed (Phase 1) |
| Widget removal (P2) | Landed (Phase 1) |
| P5 manifest `external_functions` declaration | Landed (Phase 1 foundation) |
| BYOK + Credits surfaces (P1) | Landed (Phase 2) |
| Tools → Agents rename (P4, incl. caller-permissions rename) | Landed (Phase 3) |
| Cross-Agent permissions (P5) | Pending (Phase 4) |

## External Agent Experience

The install experience teaches a connected agent a small loop:

1. Discover relevant Agents and platform primitives.
2. Inspect an Agent's Functions before calling.
3. Call Functions through Ultralight (billing settles in Credits).
4. Link users to public Agent pages when a human decision is useful
   (permissions, top-up, install).
5. Preserve receipts and errors in the final response.

## Implementation Boundary

Do not fork or duplicate the backend for launch. Launch implementation is a
curated web/app/API layer over existing services:

```text
apps/launch-web          # Launch website (Cloudflare Pages)
api/handlers/launch.ts   # Thin launch API facade (Cloudflare Workers)
shared/contracts/launch.ts
docs/LAUNCH_PIVOT_DECISIONS.md
docs/LAUNCH_MVP_SCOPE.md
```
