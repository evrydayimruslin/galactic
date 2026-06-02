# Launch MVP Scope

This document defines the public launch surface for the first Ultralight MVP.
The existing repository remains the capability basin. The launch work exposes a
small, production-facing layer for external agents, tool discovery, widgets, and
Light payments while keeping the broader agent architecture dormant.

## Launch Thesis

Deploy tools any existing agent can install, run, compose, and pay for.

Ultralight launches as the agent-native tool layer for MCP-capable agents. Users
bring their own agent and model environment first. Ultralight provides install,
auth, tool hosting, discovery, widget surfaces, Light payments, receipts, and
owner administration.

## Included In MVP

- Website built around install, library, discovery, public tool pages, widgets,
  wallet, and owner admin.
- CLI/API/MCP install paths for existing agents.
- Tool library for owned and installed tools.
- Owner admin links for tools the signed-in user owns.
- Tool discovery for public tools and public pages.
- Public tool pages connected to widget surfaces when widgets exist.
- Widgets as the only public launch UI surface.
- Light balance top-up, balances, transactions, receipts, earnings, and payout
  status where the existing backend path is stable.
- Builder and fee-credit leaderboard surfaces in discovery/market.
- Real vector embeddings for launch discovery across tools, widgets, public
  pages, install docs, and platform primitives.
- Launch API facade that exposes only MVP-safe contracts over existing backend
  services.

## Deferred From MVP

- Desktop launch.
- BYOK management as a primary launch surface.
- Web search toggle and provider-native browsing features.
- Cerebras or custom fast inference.
- Standalone Jarvis/general agent.
- Command cards in public UI.
- Generated/agentic UI composer.
- Command dashboards.
- Routines and perpetual agent responsibilities.
- Full tool-builder agent experience.

These capabilities can remain implemented internally. They should not appear in
launch navigation, public copy, or default onboarding unless explicitly promoted
by a later stage.

## Public Website Routes

- `/` - launch home and primary install CTA.
- `/install` - copyable MCP, CLI, and API install instructions.
- `/library` - signed-in owned and installed tools.
- `/discover` - public tool and page discovery.
- `/tools/:slug` - public tool page with install/run/widget affordances.
- `/wallet` - Light balance, top-up, transactions, receipts, earnings, payouts.
- `/settings` - account, API key, and launch-safe preferences.
- `/admin/tools/:id` - owner-only tool management.

## Launch API Facade

The launch website should prefer a thin API facade instead of binding directly
to broad internal handlers.

- `GET /api/launch/install`
- `GET /api/launch/status`
- `GET /api/launch/openapi.json`
- `GET /api/launch/library`
- `GET /api/launch/discover`
- `GET /api/launch/tools/:id`
- `GET /api/launch/tools/:id/widgets`
- `GET /api/launch/wallet`
- `GET /api/launch/leaderboard`
- `GET /api/launch/platform-primitives`

The facade should call existing backend services and filter out deferred
capabilities such as command cards, BYOK-first flows, desktop-only fields, and
general-agent surfaces.

## MVP Navigation

The default signed-out journey is:

1. Home.
2. Install.
3. Discover.
4. Public tool page.
5. Sign in or add Light when required.

The default signed-in journey is:

1. Library.
2. Discover.
3. Wallet.
4. Owner admin for owned tools.
5. Widget view for tools that expose widgets.

## Widgets Only

Widgets are the only public launch UI surface. If a tool has widgets, public and
library tool pages should show a widget preview or open-widget action. If a tool
does not have widgets, the page should show install, run, pricing, trust, owner,
and admin affordances.

Command cards, generated interfaces, native composers, and command dashboards
remain hidden for later stages.

## External Agent Experience

The install experience should teach external agents a small loop:

1. Discover relevant tools and platform primitives.
2. Inspect tool capabilities before calling.
3. Call tools through Ultralight.
4. Return widget/public-page links when UI is useful.
5. Preserve Light receipts and errors in the final response.

The launch discovery index should include:

- public tool names, descriptions, manifests, functions, pricing, trust cards,
  and owner metadata;
- widget labels, descriptions, data functions, and public page links;
- public pages attached to tools;
- install documentation;
- platform primitives such as deploy, publish, install, wallet, pricing,
  receipts, API keys, and owner admin.

## Stage 2 Direction

Stage 2 promotes native tool UI composition for agentic usage. The initial
version should compose widgets and tool actions inside the website, not launch a
general agent. BYOK, web search, Cerebras, command cards, command dashboards,
desktop, and a standalone Jarvis layer remain later-stage surfaces.

## Implementation Boundary

Do not fork or duplicate the backend for launch. The backend already contains
MCP, settlement, Light, wallet, marketplace, telemetry, widgets, command
surfaces, and broader agent primitives. Launch implementation should create a
curated web/app/API layer over those services.

The recommended production-facing shape is:

```text
apps/launch-web          # Clean launch website/admin/discovery UI
api/handlers/launch.ts   # Thin launch API facade
shared/contracts/launch.ts
docs/LAUNCH_MVP_SCOPE.md
```
