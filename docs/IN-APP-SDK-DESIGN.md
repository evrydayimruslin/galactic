# In-App SDK Design: Calling Apps from Apps

## Overview

This document explores adding an **in-app SDK** that allows Ultralight apps to call other apps and platform features programmatically. This would enable composable app ecosystems where apps can build on each other.

## Current Architecture

### What Apps Can Access Today

```typescript
// Inside an Ultralight app (index.ts)
export default async function handler(request, ultralight) {
  // ✅ User context
  const user = ultralight.user;

  // ✅ App data storage (R2-based)
  await ultralight.store('key', value);
  const data = await ultralight.load('key');

  // ✅ Cross-app user memory
  await ultralight.remember('preference', value);
  const pref = await ultralight.recall('preference');

  // ✅ AI calls (with BYOK)
  const response = await ultralight.ai({ messages: [...] });

  // ✅ Cron jobs
  await ultralight.cron.register('daily', '0 9 * * *', 'myTask');

  // ✅ External HTTP (with net:fetch permission)
  const res = await fetch('https://api.example.com/data');

  // ❌ Cannot call other Ultralight apps
  // ❌ Cannot discover apps
  // ❌ Cannot access platform features
}
```

### Fan-out / best-of-N with `ultralight.ai()`

`ultralight.ai()` is a plain async call, so fan-out ("fusion" / best-of-N) is a
few lines of normal JS today — no special primitive is required. Spawn N calls
with `Promise.all`, then synthesize or pick the best:

```typescript
// Best-of-N: ask several models the same thing, then fuse.
export default async function handler(request, ultralight) {
  const prompt = [{ role: "user", content: request.question }];

  const candidates = await Promise.all([
    ultralight.ai({ model: "openai/gpt-4o-mini", messages: prompt }),
    ultralight.ai({ model: "anthropic/claude-haiku-4-5", messages: prompt }),
    ultralight.ai({ model: "deepseek/deepseek-chat", messages: prompt }),
  ]);

  // Synthesize: hand the drafts to one more call to merge the best of each.
  const fused = await ultralight.ai({
    messages: [{
      role: "user",
      content: `Question: ${request.question}\n\nDrafts:\n` +
        candidates.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n") +
        `\n\nReturn a single best answer, combining the strongest points.`,
    }],
  });

  return { answer: fused.content, drafts: candidates.map((c) => c.content) };
}
```

**Real ceilings to design against** (apply to the whole execution, including a
`Promise.all` fan-out):

- **Concurrency:** `ai()` is NOT bound by the sandbox's 20-concurrent-`fetch`
  cap (that cap is on `ultralight.fetch`, not `ai()`). The bound is the
  per-execution **subrequest budget** (apps **512**, codemode **128**) — each
  `ai()` call is one subrequest. *(These ceilings are conservative and pending
  verification by the staging smoke; treat them as soft.)*
- **Wall-clock:** the whole execution must finish in **30s** (default) / **120s**
  (max). A slow branch can blow the budget; size N accordingly.
- **Per-call timeout:** each `ai()` call is independently bounded at **90s**.
- **Spend:** every branch is billed. The balance gate is **pre-call only and
  fail-open**, and there is **no mid-flight abort** — a large fan-out commits to
  N calls' cost once it starts. Keep N modest and check `usage.cost_light`.
- **Tools:** `tools` is forwarded to the provider but the response returns text
  (`content`) only — `tool_calls` are not surfaced yet. Treat `tools` as a hint,
  not a round-trip.

No built-in `ul.ai.fanout` helper exists by design (deferred); the pattern above
is the supported way. See `examples/ai-fanout/` for a runnable agent.

### Missing Capabilities

1. **App-to-App Calls** - Invoke functions from other apps
2. **App Discovery** - Find apps by capability
3. **Platform Features** - Access analytics, user profile, etc.
4. **Composable Workflows** - Chain multiple apps together

---

## Proposed In-App SDK Design

### Architecture Options

#### Option A: Direct MCP Client (Recommended)

Apps get an MCP client that can call other apps:

```typescript
export default async function handler(request, ultralight) {
  // Call another app's function via MCP
  const weather = await ultralight.apps.call('weather-app', 'getWeather', { city: 'NYC' });

  // Discover apps by capability
  const emailApps = await ultralight.apps.discover('send email');

  // Call platform features
  const myApps = await ultralight.platform.apps.list();
}
```

**Pros:**
- Unified interface (MCP everywhere)
- Permission-based access control
- Async by nature
- Well-defined schemas

**Cons:**
- Network overhead for each call
- Latency for chained calls

#### Option B: Direct Function Import

Allow importing other apps' exports:

```typescript
import { getWeather } from 'ultralight:weather-app';

export async function handler(request, ultralight) {
  const weather = await getWeather({ city: 'NYC' });
}
```

**Pros:**
- Feels native
- Type inference possible
- Lower latency (bundled)

**Cons:**
- Complex dependency resolution
- Security implications
- Versioning challenges
- Build-time vs runtime?

#### Option C: Hybrid Approach

Provide both - MCP for dynamic calls, imports for explicit dependencies:

```typescript
// Dynamic (runtime)
const result = await ultralight.apps.call('some-app', 'fn', args);

// Static (build-time, declared in package.json)
import { helper } from 'ultralight:utility-app';
```

### Recommended: Option A (MCP Client)

For MVP, the MCP approach is cleanest because:
1. Already have MCP infrastructure
2. Clear permission boundaries
3. No build complexity
4. Works with private apps (permission-based)

---

## Detailed SDK Design

### New SDK Methods

```typescript
interface UltralightSDK {
  // ... existing methods (store, load, ai, cron, etc.)

  // ============================================
  // NEW: APP-TO-APP COMMUNICATION
  // ============================================

  apps: {
    /**
     * Call a function in another app
     * Requires 'apps:call' permission
     */
    call<T = unknown>(
      appId: string,
      functionName: string,
      args?: Record<string, unknown>
    ): Promise<T>;

    /**
     * List available functions in an app
     * Requires 'apps:discover' permission
     */
    tools(appId: string): Promise<Array<{
      name: string;
      description: string;
      inputSchema: unknown;
    }>>;

    /**
     * Discover apps by capability
     * Requires 'apps:discover' permission
     */
    discover(query: string, options?: {
      limit?: number;
      publicOnly?: boolean;
    }): Promise<Array<{
      id: string;
      name: string;
      description: string;
      similarity: number;
    }>>;
  };

  // ============================================
  // NEW: PLATFORM FEATURES (Optional)
  // ============================================

  platform: {
    /**
     * Get current user's apps
     * Requires 'platform:apps' permission
     */
    myApps(): Promise<Array<{
      id: string;
      name: string;
      slug: string;
    }>>;

    /**
     * Get app analytics
     * Requires 'platform:analytics' permission
     */
    analytics(appId: string): Promise<{
      runs_30d: number;
      unique_users: number;
    }>;
  };
}
```

### Permission Model

New permissions for app-to-app communication:

```typescript
const APP_PERMISSIONS = [
  // Existing
  'memory:read',
  'memory:write',
  'ai:call',
  'net:fetch',
  'cron:read',
  'cron:write',

  // NEW: App-to-App
  'apps:call',        // Call functions in other apps
  'apps:discover',    // Discover and list app tools

  // NEW: Platform (optional)
  'platform:apps',     // Access own apps list
  'platform:analytics', // Access analytics
];
```

### Access Control

When App A calls App B:

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   App A     │         │   Platform  │         │   App B     │
│  (caller)   │────────▶│   Gateway   │────────▶│  (target)   │
└─────────────┘         └─────────────┘         └─────────────┘
      │                       │                       │
      │ Has 'apps:call'       │                       │
      │ permission?           │                       │
      │                       │                       │
      │                       │ Is App B public       │
      │                       │ OR same owner         │
      │                       │ OR explicitly shared? │
      │                       │                       │
      │                       │                       │
      └───────────────────────┴───────────────────────┘
```

**Rules:**
1. Caller must have `apps:call` permission
2. Target app must be:
   - Public (`visibility: 'public'`)
   - OR owned by same user
   - OR explicitly shared (future: app permissions)
3. Rate limits apply per caller

### Implementation in Sandbox

```typescript
// In api/runtime/sandbox.ts

const sdk = {
  // ... existing SDK methods

  // NEW: App-to-app calls
  apps: {
    call: async <T = unknown>(
      targetAppId: string,
      functionName: string,
      args?: Record<string, unknown>
    ): Promise<T> => {
      // Check permission
      if (!config.permissions.includes('apps:call')) {
        throw new Error('apps:call permission required');
      }

      // Make internal MCP call
      const response = await fetch(`${PLATFORM_URL}/mcp/${targetAppId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.internalToken}`,
          'X-Caller-App': config.appId,
          'X-Caller-User': config.userId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: crypto.randomUUID(),
          method: 'tools/call',
          params: {
            name: functionName,
            arguments: args || {},
          },
        }),
      });

      const rpc = await response.json();

      if (rpc.error) {
        throw new Error(rpc.error.message);
      }

      return rpc.result?.structuredContent as T;
    },

    tools: async (targetAppId: string) => {
      if (!config.permissions.includes('apps:discover')) {
        throw new Error('apps:discover permission required');
      }

      const response = await fetch(`${PLATFORM_URL}/mcp/${targetAppId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.internalToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: crypto.randomUUID(),
          method: 'tools/list',
        }),
      });

      const rpc = await response.json();
      return rpc.result?.tools || [];
    },

    discover: async (query: string, options?: { limit?: number }) => {
      if (!config.permissions.includes('apps:discover')) {
        throw new Error('apps:discover permission required');
      }

      const response = await fetch(`${PLATFORM_URL}/mcp/platform`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.internalToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: crypto.randomUUID(),
          method: 'tools/call',
          params: {
            name: 'platform.discover',
            arguments: {
              query,
              limit: options?.limit || 10,
            },
          },
        }),
      });

      const rpc = await response.json();
      return rpc.result?.structuredContent?.results || [];
    },
  },
};
```

---

## Use Cases

### 1. Composable Workflows

```typescript
// In: workflow-app/index.ts
export async function processOrder(order, ultralight) {
  // Validate with validation-app
  const validation = await ultralight.apps.call('validation-app', 'validateOrder', order);
  if (!validation.valid) {
    throw new Error(validation.errors.join(', '));
  }

  // Calculate shipping with shipping-app
  const shipping = await ultralight.apps.call('shipping-app', 'calculateRate', {
    from: order.warehouse,
    to: order.address,
    weight: order.totalWeight,
  });

  // Send confirmation with email-app
  await ultralight.apps.call('email-app', 'sendTemplate', {
    template: 'order-confirmation',
    to: order.customerEmail,
    data: { order, shipping },
  });

  return { order, shipping };
}
```

### 2. Dynamic Tool Selection

```typescript
// In: smart-assistant/index.ts
export async function handleRequest(request, ultralight) {
  const { task } = request;

  // Find the best app for this task
  const apps = await ultralight.apps.discover(task);

  if (apps.length === 0) {
    return { error: 'No app found for this task' };
  }

  // Get the best match
  const bestApp = apps[0];

  // List its capabilities
  const tools = await ultralight.apps.tools(bestApp.id);

  // Call the most relevant tool
  const result = await ultralight.apps.call(bestApp.id, tools[0].name, request.data);

  return result;
}
```

### 3. Utility Library Apps

```typescript
// In: data-utils/index.ts (utility app)
export function parseCSV(csv) {
  // ... CSV parsing logic
  return rows;
}

export function formatCurrency(amount, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

// In: report-generator/index.ts (consumer app)
export async function generateReport(data, ultralight) {
  // Use utility functions from another app
  const rows = await ultralight.apps.call('data-utils', 'parseCSV', { csv: data.csv });

  const formattedTotals = rows.map(row => ({
    ...row,
    total: await ultralight.apps.call('data-utils', 'formatCurrency', {
      amount: row.total,
      currency: 'USD',
    }),
  }));

  return formattedTotals;
}
```

---

## MVP vs Future

### MVP (Foundation)

| Feature | Priority | Complexity |
|---------|----------|------------|
| `apps.call()` | High | Medium |
| `apps.tools()` | High | Low |
| `apps.discover()` | Medium | Low (uses existing) |
| Permission model | High | Medium |
| Same-owner access | High | Low |
| Public app access | High | Low |

### Future Enhancements

| Feature | Priority | Complexity |
|---------|----------|------------|
| Cross-owner sharing | Medium | Medium |
| Billing/usage tracking | Low | High |
| Caching/optimization | Low | Medium |
| Static imports | Low | Very High |
| Dependency management | Low | Very High |
| App marketplace | Low | High |

---

## Security Considerations

### Concerns

1. **Infinite Loops** - App A calls B, B calls A
2. **Resource Exhaustion** - Chained calls multiplying load
3. **Data Leakage** - Passing sensitive data between apps
4. **Permission Escalation** - App B has more permissions than A

### Mitigations

1. **Call Depth Limit** - Max 5 levels of nested calls
2. **Rate Limiting** - Per-app, per-user limits
3. **Sandboxed Context** - Each call gets fresh context
4. **Permission Intersection** - Result limited to caller's permissions
5. **Audit Logging** - Track all cross-app calls

---

## Current Foundation Assessment

### What We Have ✅

1. **MCP Infrastructure** - Full JSON-RPC implementation
2. **Permission System** - Declared permissions per app
3. **User Context** - User ID available in sandbox
4. **Discovery** - Semantic search with embeddings
5. **Platform MCP** - All platform tools available

### What We Need 🔧

1. **Internal Auth Token** - For app-to-app calls
2. **Call Depth Tracking** - Prevent infinite loops
3. **Permission Expansion** - New `apps:call`, `apps:discover`
4. **Access Control Checks** - In MCP handler

### Estimated Implementation Effort

| Component | Effort | Files Affected |
|-----------|--------|----------------|
| SDK Extension | 2-3 hours | `sandbox.ts` |
| Permission System | 1-2 hours | `types/index.ts`, `mcp.ts` |
| Access Control | 2-3 hours | `mcp.ts` |
| Call Depth Tracking | 1 hour | `mcp.ts` |
| Internal Token | 1-2 hours | `auth.ts`, `sandbox.ts` |
| **Total** | **~8-12 hours** | |

---

## Recommendation

### For MVP: Not Required

The in-app SDK is valuable but **not essential for MVP**. Current capabilities:
- Apps can use `fetch()` to call external APIs
- Apps can call their own MCP endpoint if needed
- Platform MCP + CLI + external SDK cover most use cases

### For V2: Strongly Recommended

After core platform is stable, add in-app SDK because:
- Enables composable app ecosystems
- Differentiator from other serverless platforms
- Natural extension of MCP architecture
- Foundation is already 80% there

### Implementation Order

1. ✅ **Done**: Platform MCP, CLI, External SDK
2. **Next**: Stabilize core platform, get user feedback
3. **Then**: Add `apps.call()` and `apps.discover()`
4. **Later**: Cross-owner sharing, marketplace

---

## Conclusion

**Do we have the foundations for optimal architecture?** Yes!

The MCP-based architecture we implemented is ideal for app-to-app communication:
- Clean separation between apps
- Permission-based access control
- Async by design
- Type-safe with schemas

**Is it valuable for MVP?** Probably not essential, but the foundations are solid for V2.
