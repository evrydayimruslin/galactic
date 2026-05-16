# Ultralight

The agent-accessible MCP platform. Deploy TypeScript functions, get a live MCP server. Any AI agent can discover and call your app — no human in the loop.

## The Agent Distribution Problem

85% of enterprises will have AI agents deployed. Those agents need structured, programmatic access to tools. They don't browse marketing sites or watch demo videos. They call MCP endpoints. They read docs programmatically. If your product doesn't have an agent-accessible surface area, it's invisible.

Ultralight solves this. Write a TypeScript function, upload it, and every agent in the ecosystem can find it and use it — at 3am, autonomously, with zero configuration.

```typescript
// index.ts — this becomes an MCP server
export function getWeather(args: { city: string }) {
  return { city: args.city, temp: 72, conditions: "Sunny" };
}
```

```bash
ultralight upload . --name "Weather API"
# Live at POST /mcp/{app-id} — any agent can call it now
```

---

## How Agents Find Your App

### REST Discovery (any agent with fetch)

```bash
# No auth required — returns public apps with MCP endpoints
curl "https://ultralight-api-iikqz.ondigitalocean.app/api/discover?q=weather+api"
```

Returns ranked results with live `mcp_endpoint` for each app. The agent calls the endpoint directly via JSON-RPC 2.0. No signup, no onboarding, no human.

### MCP Discovery (agents with MCP client)

```
POST /mcp/platform → ul.discover({ scope: "appstore", query: "weather api" })
```

Full platform access: 32 tools for discovery, upload, testing, permissions, and more. Agents authenticate once via OAuth 2.1, then access the entire ecosystem.

### CLI Discovery (coding agents)

```bash
ultralight discover "weather api"
```

Every coding agent (Claude Code, Cursor, Copilot) can run CLI commands. The CLI wraps the full platform MCP.

### OpenAPI Spec (self-describing)

```
GET /api/discover/openapi.json
```

Agents that read API specs auto-discover our endpoints, parameters, and auth requirements.

---

## Agent Authentication — One Token, Every App

Agents authenticate **once** with Ultralight and get access to every public app in the ecosystem:

1. Agent obtains a `ul_` API token (via OAuth 2.1 or user settings)
2. Agent discovers tools via `GET /api/discover?q=<need>` or `ul.discover({ scope: "appstore", query: "<need>" })`
3. Agent calls any discovered app's `mcp_endpoint` with the same token
4. No per-app auth, no per-app setup, no human intervention

```bash
# One token. Any app. Any time.
curl -X POST https://ultralight-api-iikqz.ondigitalocean.app/mcp/{app-id} \
  -H "Authorization: Bearer ul_your_token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"getWeather","arguments":{"city":"NYC"}}}'
```

---

## Discovery Ranking

App store results use composite scoring, not just keyword matching:

```
final_score = (similarity * 0.7) + (native_boost * 0.15) + (community_signal * 0.15)
```

- **Similarity (70%)** — pgvector cosine distance between query and app's semantic embedding
- **Native boost (15%)** — Apps requiring no per-user config rank higher (ready to use immediately)
- **Community signal (15%)** — Weighted likes from paid-tier users (Laplace-smoothed)
- **Luck shuffle** — Top 5 results are stochastically rotated to prevent winner-take-all

Three-layer discovery for authenticated agents:

1. **Desk** — Last 3 apps the user called. Instant recall.
2. **Library** — Apps the user owns + liked. Personal collection.
3. **App Store** — All published apps with full ranking algorithm.

---

## Build Workflow

```bash
# 1. Generate a skeleton following all platform conventions
ultralight scaffold my-app --storage supabase

# 2. Fill in your function implementations
# ... edit index.ts ...

# 3. Test without deploying
ultralight test . --function hello '{"name":"World"}'

# 4. Validate against conventions
ultralight lint . --strict

# 5. Deploy
ultralight upload .
```

### Critical Function Pattern

Functions receive a **single args object** (not positional params) — this is how the MCP sandbox passes arguments:

```typescript
// Correct
export function search(args: { query: string; limit?: number }) {
  return { query: args.query, results: [] };
}

// Wrong — will fail in sandbox
export function search(query: string, limit?: number) { ... }
```

Return values must use explicit `key: value` form (no shorthand) for IIFE bundling safety.

---

## In-App SDK

Every app gets the `ultralight` global at runtime:

```typescript
// Storage (per-app key-value store)
await ultralight.store("key", { any: "value" });
const data = await ultralight.load("key");
const keys = await ultralight.list("prefix/");

// AI (BYOK providers when configured; otherwise Light-debit OpenRouter)
const response = await ultralight.ai({
  model: "openai/gpt-4o",
  messages: [{ role: "user", content: "Summarize this" }],
});

// Cross-app memory (scoped to calling user)
await ultralight.remember("preference", "dark-mode");
const pref = await ultralight.recall("preference");

// Supabase (BYOS — Bring Your Own Supabase)
const { data } = await supabase.from("table").select("*");

// User context
const user = ultralight.user; // { email, name, tier, ... }
```

---

## Platform MCP Canonical Tool Families

The platform itself is an MCP server at `POST /mcp/platform`:

### Build & Deploy
| Tool | Description |
|------|-------------|
| `ul.download({ name, description, ... })` | Generate a structured app skeleton when `app_id` is omitted |
| `ul.upload` | Upload code to create or update an app |
| `ul.test({ files, function_name, ... })` | Test functions in sandbox without deploying |
| `ul.test({ files, lint_only: true, ... })` | Validate code against platform conventions |
| `ul.download({ app_id, version? })` | Download source code |

### Discovery
| Tool | Description |
|------|-------------|
| `ul.discover({ scope: "desk" })` | Last apps the user called |
| `ul.discover({ scope: "library", query? })` | Search owned + liked apps |
| `ul.discover({ scope: "appstore", query?, task? })` | Semantic search across all published apps |

### Settings
| Tool | Description |
|------|-------------|
| `ul.set({ app_id, version })` | Set the live version |
| `ul.set({ app_id, visibility })` | Change visibility (private/unlisted/public) |
| `ul.set({ app_id, supabase_server })` | Assign a Supabase server |
| `ul.set({ app_id, calls_per_minute?, calls_per_day? })` | Configure per-app rate limits |

### Permissions & Social
| Tool | Description |
|------|-------------|
| `ul.permissions({ action: "grant", ... })` | Grant user access to a private app |
| `ul.permissions({ action: "revoke", ... })` | Revoke access |
| `ul.permissions({ action: "list", ... })` | List granted users |
| `ul.like` / `ul.dislike` | Community signal (saves to library) |
| `ul.connect` | Store per-user secrets for an app |

Full documentation: [`skills.md`](skills.md)

---

## REST API Endpoints

### Discovery (agent-accessible, auth optional)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/discover?q={query}` | Semantic search with composite ranking |
| GET | `/api/discover/featured` | Top apps by community signal |
| GET | `/api/discover/status` | Service health check |
| GET | `/api/discover/openapi.json` | OpenAPI 3.1 spec (self-describing) |
| POST | `/api/discover` | Semantic search (JSON body, auth required) |

### MCP
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/mcp/platform` | Platform MCP (32 ul.* tools) |
| POST | `/mcp/{appId}` | Per-app MCP (app's exported functions) |

### HTTP
| Method | Endpoint | Description |
|--------|----------|-------------|
| ANY | `/http/{appId}/{function}` | Direct HTTP access to declared app functions |
| GET | `/api/apps/{appId}/http-routes` | Safe catalog of declared direct HTTP routes |

Direct HTTP routes are declared in `manifest.json` under `http.routes`. Public
routes must declare methods, use owner billing, and use app-scoped data:

```json
{
  "http": {
    "routes": {
      "webhook": {
        "auth": "public",
        "methods": ["POST"],
        "cors": { "origins": ["https://example.com"] },
        "rate_limit": { "rpm": 60 }
      }
    }
  }
}
```

---

## CLI Commands

```bash
ultralight login --token ul_xxx       # Authenticate
ultralight scaffold my-app            # Generate skeleton
ultralight upload .                   # Deploy
ultralight test . -f hello            # Test a function
ultralight lint . --strict            # Validate conventions

ultralight discover "weather API"     # Search App Store
ultralight discover --featured        # Top-ranked apps
ultralight run my-app hello '{"n":1}' # Call deployed function

ultralight apps list                  # List your apps
ultralight draft publish my-app       # Publish draft
ultralight docs generate my-app       # Generate Skills.md
```

---

## Maintainer Verification

Use these repo-level checks before shipping marketplace, desktop, or Worker-adjacent changes
(`$HOME/.deno/bin/deno task ...` also works when Deno is not on PATH):

```bash
deno task verify              # API tsc baseline + API Deno check + desktop tsc + web layout check
deno task verify:marketplace  # verify plus focused marketplace Deno tests
```

The API has two complementary type paths:

```bash
npm run typecheck --prefix api       # Worker-aware TypeScript baseline
npm run typecheck:deno --prefix api  # Deno analyzer check with Worker types and wasm stubs
```

---

## Tiers

| | Free | Fun | Pro | Scale | Enterprise |
|---|---|---|---|---|---|
| **Price** | $0 | $8/mo | $25/mo | $99/mo | $599/mo |
| **Apps** | 5 | 25 | Unlimited | Unlimited | Unlimited |
| **Calls/week** | 1K | 100K | 1M | 10M | 100M |
| **Publish to App Store** | No | No | Yes | Yes | Yes |
| **Execution timeout** | 30s | 30s | 60s | 2min | 5min |

---

## Architecture

```
                    +------------------+
                    |   AI Agents /    |
                    |   MCP Clients    |
                    +--------+---------+
                             |
                    JSON-RPC 2.0 / REST / CLI
                             |
              +--------------+--------------+
              |                             |
     /api/discover (REST)          /mcp/* (JSON-RPC)
     Auth optional                 Auth required
     Public apps only              Full platform access
              |                             |
              +-------------+---------------+
                            |
                   +--------v--------+
                   |   Ultralight    |
                   |   Deno Server   |
                   +--+------+---+---+
                      |      |   |
          +-----------+  +---+   +----------+
          |              |                  |
   +------v------+ +----v------+ +---------v----+
   | Cloudflare  | | Supabase  | |  OpenRouter   |
   |     R2      | | Postgres  | |    (AI)       |
   |  (storage)  | | +pgvector | |  embeddings   |
   +-------------+ +-----------+ +--------------+
```

---

## License

MIT

## Credits

Built by Russell & Corin.
