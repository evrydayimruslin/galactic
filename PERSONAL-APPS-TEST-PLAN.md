# Ultralight Personal Apps Test Plan

**Goal:** Get all 3 personal apps running in Ultralight with Corin (agent) able to operate them via Telegram through MCP/CLI.

---

## App-to-Feature Mapping

| App | Storage | Key Features Tested |
|-----|---------|---------------------|
| **Morning Dashboard** | Supabase BYOS | BYOS connection, env vars, cron, AI insights |
| **Ultravision** | R2 + Embeddings | R2 CRUD, vector search, AI summaries |
| **X Scrape** | Supabase BYOS | Full-text search, embeddings, AI analysis |

### Test Coverage Matrix

| Feature | Morning Dashboard | Ultravision | X Scrape |
|---------|------------------|-------------|----------|
| **R2 Storage** (`store/load/list/query`) | - | ✅ Primary | - |
| **Supabase BYOS** | ✅ Personal DB | - | ✅ Research DB |
| **BYOK AI** (`ultralight.ai`) | ✅ Daily briefs | ✅ Summaries | ✅ Analysis |
| **Cron Jobs** | ✅ Price alerts | ✅ Weekly reviews | - |
| **Embeddings/Vector Search** | - | ✅ Semantic search | ✅ Similar tweets |
| **Environment Variables** | ✅ Crypto API | - | - |
| **Cross-app Memory** | ✅ Hub for context | ✅ Links to insights | ✅ Source tracking |
| **Complex Queries** | ✅ Trends over time | ✅ Milestone filtering | ✅ Collection analysis |
| **HTTP Response Helpers** | - | - | - |

---

## App 1: Morning Dashboard

**Purpose:** Personal life hub - health, crypto, reminders, goals

### Storage: Supabase BYOS (`russell-personal-metrics`)

### Functions to Test

| Function | Tests | Expected Result |
|----------|-------|-----------------|
| `logWeight(75.5, 'kg')` | BYOS insert, daily snapshot | Returns entry with ID |
| `logSleep(7.5, 4)` | BYOS insert | Returns sleep entry |
| `logEnergy(4, 'morning')` | BYOS insert | Returns energy entry |
| `getHealthTrends(7)` | BYOS select, aggregation | Returns weight/sleep/energy arrays |
| `getCryptoPrices(['BTC'])` | External API (CoinGecko) | Returns prices object |
| `setPriceAlert('BTC', 100000, 'above')` | BYOS insert | Returns alert with ID |
| `addReminder('Test', null, 'high')` | BYOS insert | Returns reminder |
| `completeReminder(id)` | BYOS update | Returns success |
| `createGoal('Test Goal')` | BYOS insert | Returns goal |
| `generateDailyBrief()` | AI call, cross-app memory | Returns brief with AI insight |
| `healthCheck()` | All systems | Returns status: healthy |
| `setupCronJobs()` | Cron registration | Returns job names |

### Cron Jobs

- `price-check`: Every 15 min - checks crypto price alerts
- `morning-brief`: Daily at 7am - generates daily brief

### MCP Test Flow (for Corin)

```
1. platform.run("morning-dashboard", "logWeight", { weight: 74.5, unit: "kg" })
2. platform.run("morning-dashboard", "getCryptoPrices", { symbols: ["BTC", "ETH"] })
3. platform.run("morning-dashboard", "addReminder", { text: "Review Ultravision goals", priority: "high" })
4. platform.run("morning-dashboard", "generateDailyBrief")
5. Verify: Data persists in Supabase, cross-app memory contains daily_brief
```

### Setup Steps

1. Create Supabase project: `russell-personal-metrics`
2. Run `apps/morning-dashboard/supabase-migration.sql`
3. Configure BYOS in Ultralight (URL + anon key + service key)
4. Upload app: `ultralight upload ./apps/morning-dashboard`
5. Run: `ultralight run <app-id> healthCheck`

---

## App 2: Ultravision

**Purpose:** Ultralight business hub - roadmap, goals, decisions, risks

### Storage: R2 + OpenRouter Embeddings

### Functions to Test

| Function | Tests | Expected Result |
|----------|-------|-----------------|
| `createItem('goal', 'Launch v2', '...')` | R2 store, embedding gen | Returns item with ID |
| `getItem(id)` | R2 load | Returns item |
| `updateItem(id, { status: 'completed' })` | R2 update | Returns updated item |
| `updateMilestone(id, 'completed')` | R2 update, status tracking | Returns milestone |
| `getRoadmap('2024-Q1')` | R2 list + filter | Returns vision/goals/milestones |
| `getBlockers()` | R2 query with filter | Returns blocked items |
| `logDecision('Choose stack', ...)` | R2 store | Returns decision |
| `identifyRisk('Market shift', ...)` | R2 store, risk scoring | Returns risk |
| `identifyRisks()` | AI analysis of roadmap | Returns AI-identified risks |
| `searchVision('API pricing')` | Embedding similarity | Returns ranked results |
| `summarizeQuarter('2024-Q1')` | AI summary generation | Returns quarterly summary |
| `healthCheck()` | All systems | Returns status: healthy |

### Cron Jobs

- `weekly-review`: Mondays at 9am - roadmap status update
- `quarterly-review`: 1st of quarter months - full review

### MCP Test Flow (for Corin)

```
1. platform.run("ultravision", "createItem", { type: "goal", title: "Ship MCP v2", description: "Complete platform MCP implementation", options: { quarter: "2024-Q4", priority: "high" }})
2. platform.run("ultravision", "createItem", { type: "milestone", title: "Finish testing", options: { parentId: "<goal-id>" }})
3. platform.run("ultravision", "getRoadmap", { quarter: "2024-Q4" })
4. platform.run("ultravision", "searchVision", { query: "MCP testing" })
5. platform.run("ultravision", "identifyRisks")
6. Verify: Items stored in R2, embeddings generated, cross-app memory updated
```

### Setup Steps

1. Configure BYOK AI (OpenRouter key in user settings)
2. Upload app: `ultralight upload ./apps/ultravision`
3. Run: `ultralight run <app-id> healthCheck`
4. Run: `ultralight run <app-id> setupCronJobs`

---

## App 3: X Scrape

**Purpose:** Research & analysis - tweet storage, collections, AI analysis

### Storage: Supabase BYOS (`russell-x-research`) + pgvector

### Functions to Test

| Function | Tests | Expected Result |
|----------|-------|-----------------|
| `addTweet(url, content, {...})` | BYOS insert, embedding | Returns tweet with ID |
| `getTweet(id)` | BYOS select | Returns tweet |
| `searchTweets('pricing')` | Full-text search | Returns matching tweets |
| `findSimilarTweets(query)` | Vector similarity (pgvector) | Returns ranked results |
| `createCollection('API Research')` | BYOS insert | Returns collection |
| `addToCollection(collId, tweetIds)` | BYOS update | Returns added count |
| `getCollection(id)` | BYOS join query | Returns collection + tweets |
| `analyzeCollection(id)` | AI analysis | Returns themes/insights |
| `extractThemes()` | AI theme extraction | Returns theme objects |
| `analyzeTweets(ids, prompt)` | Custom AI analysis | Returns analysis text |
| `addNote('Insight here')` | BYOS insert | Returns note |
| `createRoadmapInsight(...)` | Cross-app memory write | Returns insight_id |
| `healthCheck()` | All systems | Returns status: healthy |

### MCP Test Flow (for Corin)

```
1. platform.run("x-scrape", "addTweet", { url: "https://x.com/naval/status/123", content: "Seek wealth, not money...", options: { tags: ["wisdom"] }})
2. platform.run("x-scrape", "createCollection", { name: "Startup Wisdom" })
3. platform.run("x-scrape", "addToCollection", { collectionId: "<coll-id>", tweetIds: ["<tweet-id>"] })
4. platform.run("x-scrape", "analyzeCollection", { collectionId: "<coll-id>" })
5. platform.run("x-scrape", "createRoadmapInsight", { tweetId: "<tweet-id>", title: "Pricing Strategy", description: "..." })
6. Verify: Data in Supabase, embeddings generated, cross-app memory written
```

### Setup Steps

1. Create Supabase project: `russell-x-research`
2. Enable `vector` extension in Supabase
3. Run `apps/x-scrape/supabase-migration.sql`
4. Configure BYOS in Ultralight
5. Upload app: `ultralight upload ./apps/x-scrape`
6. Run: `ultralight run <app-id> healthCheck`

---

## Cross-App Integration Tests

### Scenario 1: Morning Routine (Corin workflow)

```
1. Corin: morning-dashboard.generateDailyBrief()
   → Generates health + crypto summary
   → Stores in cross-app memory: daily_brief

2. Corin: x-scrape.extractThemes()
   → Analyzes recent saved tweets
   → Returns key themes from research

3. Corin: ultravision.getRoadmap()
   → Gets current quarter status
   → Identifies blockers

4. Corin: Synthesizes all data, reports via Telegram
```

### Scenario 2: Tweet → Roadmap Item

```
1. User (via Telegram): "Add this tweet about pricing"
2. Corin: x-scrape.addTweet(url, content)
3. User: "Create roadmap item from that insight"
4. Corin: x-scrape.createRoadmapInsight(tweetId, title, desc)
   → Stores in cross-app memory for Ultravision
5. Corin: ultravision.createItem('note', title, desc, { metadata: { source: 'x-scrape' }})
6. User: "Remind me to review tomorrow"
7. Corin: morning-dashboard.addReminder(text, dueAt)
```

### Scenario 3: Weekly Status Review

```
1. Cron triggers: ultravision.weeklyReviewCron()
   → Stores status in cross-app memory

2. Next morning, cron triggers: morning-dashboard.generateMorningBriefCron()
   → Pulls Ultravision status from cross-app memory
   → Includes in daily brief

3. Corin fetches brief via morning-dashboard.generateDailyBrief()
   → Has full context across all apps
```

---

## Pre-Deployment Checklist

### Platform (DigitalOcean)

- [ ] All 10 env vars set (SUPABASE_URL, R2_*, OPENROUTER_API_KEY, etc.)
- [ ] SQL migrations applied (5 total)
- [ ] PostgREST schema reloaded
- [ ] API responding at `/health`

### Supabase Projects

- [ ] `russell-personal-metrics` created
  - [ ] Migration applied
  - [ ] RLS policies active
  - [ ] Connection tested

- [ ] `russell-x-research` created
  - [ ] pgvector extension enabled
  - [ ] Migration applied
  - [ ] RLS policies active
  - [ ] Connection tested

### Per-App Setup

#### Morning Dashboard

```bash
# 1. Upload
ultralight upload ./apps/morning-dashboard --name "morning-dashboard"

# 2. Configure BYOS (via Ultralight dashboard or API)
# Set: supabase_url, supabase_anon_key, supabase_service_key

# 3. Test
ultralight run <app-id> healthCheck

# 4. Setup cron
ultralight run <app-id> setupCronJobs
```

#### Ultravision

```bash
# 1. Configure BYOK (OpenRouter) in user settings

# 2. Upload
ultralight upload ./apps/ultravision --name "ultravision"

# 3. Test
ultralight run <app-id> healthCheck

# 4. Setup cron
ultralight run <app-id> setupCronJobs
```

#### X Scrape

```bash
# 1. Upload
ultralight upload ./apps/x-scrape --name "x-scrape"

# 2. Configure BYOS
# Set: supabase_url, supabase_anon_key, supabase_service_key

# 3. Test
ultralight run <app-id> healthCheck
```

### MCP Integration (for Corin)

- [ ] Corin has valid auth token
- [ ] `platform.discover "morning dashboard"` finds the app
- [ ] `platform.apps.list` shows all 3 apps
- [ ] Each app's MCP endpoint accessible
- [ ] Cross-app memory working (`remember`/`recall`)

---

## Quick Smoke Test Script

```bash
#!/bin/bash
# Run: ULTRALIGHT_TOKEN=your-token ./scripts/smoke-test.sh

API_URL="${ULTRALIGHT_API_URL:-https://ultralight-api.rgn4jz429m.workers.dev}"
TOKEN="${ULTRALIGHT_TOKEN}"

mcp_call() {
  curl -sf -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "$API_URL/mcp/platform" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}

echo "=== Ultralight Personal Apps Smoke Test ==="

# Test each app's health check
for app in "morning-dashboard" "ultravision" "x-scrape"; do
  echo -n "Testing $app... "
  result=$(mcp_call "platform.run" "{\"app_id\":\"$app\",\"function\":\"healthCheck\"}")
  if echo "$result" | grep -q '"status":"healthy"'; then
    echo "✓ HEALTHY"
  elif echo "$result" | grep -q '"status":"degraded"'; then
    echo "⚠ DEGRADED"
  else
    echo "✗ UNHEALTHY or ERROR"
  fi
done

echo "=== Done ==="
```

---

## Success Criteria

By end of day:

1. **All 3 apps deployed and running**
   - `ultralight apps list` shows morning-dashboard, ultravision, x-scrape
   - All health checks return `healthy` or `degraded`

2. **Storage working**
   - Morning Dashboard: Supabase queries succeed
   - Ultravision: R2 store/load works
   - X Scrape: Supabase + embeddings work

3. **AI integration working**
   - All apps can make BYOK AI calls
   - Embeddings generated for Ultravision and X Scrape

4. **Corin can operate all apps**
   - Via Telegram → MCP → Ultralight
   - Can discover, list, and run functions
   - Cross-app memory working (`daily_brief`, `ultravision_weekly_status`, etc.)

5. **Cron jobs registered**
   - Morning Dashboard: price-check, morning-brief
   - Ultravision: weekly-review, quarterly-review

---

## Next Steps (After Initial Testing)

1. **End-to-end Telegram test** - Full Corin workflow
2. **Error injection** - Test failure handling (API down, invalid data)
3. **Performance baseline** - Measure latencies
4. **Monitoring** - Set up alerts for failures
5. **Documentation** - Skills.md verification
