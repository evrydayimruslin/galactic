# Platform-Level MCP Server & CLI Design

## Implementation Status: ✅ COMPLETE

All major components have been implemented:

| Component | Status | Files |
|-----------|--------|-------|
| Platform MCP Server | ✅ Complete | `api/handlers/platform-mcp.ts` |
| CLI Tool | ✅ Complete | `cli/mod.ts`, `cli/config.ts`, `cli/api.ts`, `cli/colors.ts` |
| TypeScript SDK | ✅ Complete | `sdk/mod.ts` |
| Well-known Discovery | ✅ Complete | `GET /.well-known/mcp.json` |

> **Current-contract note (2026-07-27):** The detailed `platform.*` catalog
> later in this document records the original design and is not the live tool
> contract. The runtime registry in
> `api/services/capabilities/registry.ts`, the generated `tools/list` response,
> and `skills.md` are authoritative. Canonical public names use `gx.*`; legacy
> `ul.*` names remain aliases.

### Builder Milestone 1

The platform and CLI now expose three token-efficient builder primitives:

| Primitive | Contract | Purpose |
|-----------|----------|---------|
| Coding capsule | `gx.project({ app_id, view: "coding_capsule", since_revision? })` | Owner-only, source-free Agent snapshot with a 30-day revision lease; subsequent calls can return only a revision delta |
| Staged bundle | `gx.stage({ files?, base_bundle_id?, delete_paths? })` | Upload source once; incremental stages reuse unchanged content behind fail-closed rate and active-object quotas |
| Structured AI output | `galactic.ai({ messages, output_schema })` | Provider-native strict JSON Schema with parsed, locally verified `response.output` |

The preferred build pipeline is:

```typescript
const context = await gx.project({ app_id, view: "coding_capsule" });
const staged = await gx.stage({ files });
const tested = await gx.test({ bundle_id: staged.bundle_id });
await gx.upload({
  bundle_id: staged.bundle_id,
  test_attestation: tested.test_attestation,
});
```

The `bundle_id` is immutable and content-addressed. Test and upload resolve and
verify the same owner-scoped source identity. Direct `files` calls remain
supported. For the complete API, security invariants, structured-output error
codes, and R2 retention requirement, see
[Builder Milestone 1](BUILDER_MILESTONE_1.md).

### Quick Start

**Platform MCP Endpoint:**
```
POST /mcp/platform
```

**CLI Installation:**
```bash
deno task cli:install  # Install globally as 'ultralight'
```

**SDK Usage:**
```typescript
import { Galactic } from 'https://ultralight.dev/sdk/mod.ts';
const ul = new Galactic({ token: 'your-token' });
const apps = await ul.apps.list();
```

---

## Executive Summary

This document outlines the architectural decisions and implementation plan for adding platform-level MCP server capabilities and a CLI tool to Galactic. These additions will make Galactic significantly more robust for agentic use by enabling:

1. **Platform MCP Server** - Centralized MCP endpoint for managing all apps, not just individual app tools
2. **CLI Tool** - Command-line interface for programmatic app management
3. **TypeScript SDK** - Programmatic access for build tools and CI/CD pipelines

---

## Current State Analysis

### What Exists Today

#### Per-App MCP Server (`/mcp/:appId`)
- JSON-RPC 2.0 protocol implementation
- Tools: app-specific functions + SDK tools (storage, memory, AI, cron)
- Well-known discovery: `/a/:appId/.well-known/mcp.json`
- Rate limiting per endpoint
- User authentication via JWT

#### REST API Endpoints
```
POST /api/upload                    # Create new app
GET  /api/apps                      # List public apps
GET  /api/apps/me                   # List user's apps
GET  /api/apps/:appId               # Get app details
GET  /api/apps/:appId/code          # Get app code
PATCH /api/apps/:appId              # Update app settings
DELETE /api/apps/:appId             # Soft delete
POST /api/apps/:appId/icon          # Upload icon
POST /api/apps/:appId/draft         # Upload draft
POST /api/apps/:appId/publish       # Publish draft
DELETE /api/apps/:appId/draft       # Discard draft
POST /api/apps/:appId/generate-docs # Generate Skills.md
PATCH /api/apps/:appId/skills       # Update skills
GET  /api/apps/:appId/download      # Download as ZIP
POST /api/discover                  # Semantic search
POST /api/run/:appId                # Execute function
```

### What's Missing

1. **Platform-level MCP server** - No way to manage apps via MCP tools
2. **CLI tool** - No command-line interface for automation
3. **TypeScript SDK** - No programmatic client library
4. **Batch operations** - No multi-app management
5. **Webhooks** - No event notifications
6. **API keys** - Only JWT auth (user sessions)

---

## Platform MCP Server Design

### Architecture Decision: Separate Endpoint vs. Extended App MCP

**Recommendation: Separate Platform MCP Endpoint**

```
/mcp/platform  → Platform management tools
/mcp/:appId    → App-specific tools (existing)
```

**Rationale:**
- Clear separation of concerns
- Different rate limits (platform ops are heavier)
- Different permission model (platform = owner-scoped, app = app-scoped)
- Easier to document and discover
- No collision between platform tools and app tools

### Platform MCP Tools Definition

```typescript
const PLATFORM_MCP_TOOLS: MCPTool[] = [
  // ============================================
  // APP LIFECYCLE
  // ============================================
  {
    name: 'platform.apps.list',
    title: 'List Apps',
    description: 'List all apps owned by the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        visibility: {
          type: 'string',
          enum: ['all', 'public', 'private', 'unlisted'],
          description: 'Filter by visibility',
        },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Skip results' },
        include_drafts: { type: 'boolean', description: 'Include draft info' },
      },
    },
  },
  {
    name: 'platform.apps.get',
    title: 'Get App Details',
    description: 'Get detailed information about an app',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string', description: 'App ID or slug' },
        include_code: { type: 'boolean', description: 'Include source code' },
        include_skills: { type: 'boolean', description: 'Include parsed skills' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'platform.apps.create',
    title: 'Create App',
    description: 'Create a new app by uploading code files',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App display name' },
        slug: { type: 'string', description: 'URL slug (auto-generated if omitted)' },
        description: { type: 'string' },
        visibility: { type: 'string', enum: ['private', 'unlisted', 'public'] },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path (e.g., "index.ts")' },
              content: { type: 'string', description: 'File content' },
            },
            required: ['path', 'content'],
          },
          description: 'Source files to upload',
        },
        auto_generate_docs: { type: 'boolean', description: 'Generate Skills.md' },
      },
      required: ['files'],
    },
  },
  {
    name: 'platform.apps.update',
    title: 'Update App',
    description: 'Update app metadata (not code)',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        visibility: { type: 'string', enum: ['private', 'unlisted', 'public'] },
        category: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'platform.apps.delete',
    title: 'Delete App',
    description: 'Soft-delete an app (can be restored)',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true to confirm' },
      },
      required: ['app_id', 'confirm'],
    },
  },

  // ============================================
  // DRAFT/PUBLISH WORKFLOW
  // ============================================
  {
    name: 'platform.draft.upload',
    title: 'Upload Draft',
    description: 'Upload new code as draft without affecting production',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['app_id', 'files'],
    },
  },
  {
    name: 'platform.draft.get',
    title: 'Get Draft Info',
    description: 'Get information about current draft',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        include_diff: { type: 'boolean', description: 'Include diff with production' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'platform.draft.publish',
    title: 'Publish Draft',
    description: 'Publish draft to production (increments version)',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        regenerate_docs: { type: 'boolean', description: 'Regenerate Skills.md' },
        version_bump: { type: 'string', enum: ['patch', 'minor', 'major'] },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'platform.draft.discard',
    title: 'Discard Draft',
    description: 'Discard draft without publishing',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
      },
      required: ['app_id'],
    },
  },

  // ============================================
  // DOCUMENTATION
  // ============================================
  {
    name: 'platform.docs.generate',
    title: 'Generate Documentation',
    description: 'Generate or regenerate Skills.md from code',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        ai_enhance: { type: 'boolean', description: 'Use AI to improve descriptions' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'platform.docs.get',
    title: 'Get Documentation',
    description: 'Get Skills.md content',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'json', 'mcp'] },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'platform.docs.update',
    title: 'Update Documentation',
    description: 'Update Skills.md content (with validation)',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        skills_md: { type: 'string', description: 'New Skills.md content' },
      },
      required: ['app_id', 'skills_md'],
    },
  },

  // ============================================
  // DISCOVERY
  // ============================================
  {
    name: 'platform.discover',
    title: 'Discover Apps',
    description: 'Semantic search for apps by capability',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query' },
        limit: { type: 'number' },
        include_private: { type: 'boolean', description: 'Include own private apps' },
        min_similarity: { type: 'number', description: 'Similarity threshold 0-1' },
      },
      required: ['query'],
    },
  },
  {
    name: 'platform.apps.search',
    title: 'Search Apps',
    description: 'Search apps by name, description, or tags',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        filters: {
          type: 'object',
          properties: {
            category: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            visibility: { type: 'string' },
          },
        },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
      required: ['query'],
    },
  },

  // ============================================
  // EXECUTION & TESTING
  // ============================================
  {
    name: 'platform.run',
    title: 'Run App Function',
    description: 'Execute a function in any owned app',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        function: { type: 'string', description: 'Function name to call' },
        args: { description: 'Arguments to pass' },
        use_draft: { type: 'boolean', description: 'Run against draft code' },
      },
      required: ['app_id', 'function'],
    },
  },
  {
    name: 'platform.test',
    title: 'Test App',
    description: 'Run validation tests on app',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        use_draft: { type: 'boolean' },
        tests: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              function: { type: 'string' },
              args: {},
              expected: { description: 'Expected result or matcher' },
            },
          },
        },
      },
      required: ['app_id'],
    },
  },

  // ============================================
  // ANALYTICS
  // ============================================
  {
    name: 'platform.analytics.app',
    title: 'Get App Analytics',
    description: 'Get usage analytics for an app',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        period: { type: 'string', enum: ['7d', '30d', '90d', 'all'] },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'platform.analytics.overview',
    title: 'Get Platform Analytics',
    description: 'Get overall usage analytics',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['7d', '30d', '90d'] },
      },
    },
  },

  // ============================================
  // USER MANAGEMENT
  // ============================================
  {
    name: 'platform.user.profile',
    title: 'Get User Profile',
    description: 'Get current user profile and settings',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'platform.user.memory',
    title: 'Access User Memory',
    description: 'Read/write cross-app user memory',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'list', 'delete'] },
        key: { type: 'string' },
        value: { description: 'Value for set action' },
      },
      required: ['action'],
    },
  },

  // ============================================
  // CRON MANAGEMENT
  // ============================================
  {
    name: 'platform.cron.list',
    title: 'List All Cron Jobs',
    description: 'List cron jobs across all owned apps',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string', description: 'Filter by app (optional)' },
        enabled: { type: 'boolean', description: 'Filter by enabled status' },
      },
    },
  },
];
```

### Well-Known Discovery Endpoint

```
GET /.well-known/mcp.json
```

Returns:
```json
{
  "name": "Galactic Platform",
  "version": "1.0.0",
  "description": "Serverless app platform with AI integration",
  "capabilities": {
    "tools": { "listChanged": false }
  },
  "endpoints": {
    "platform": "/mcp/platform",
    "apps": "/mcp/{appId}"
  },
  "tools_count": 25,
  "documentation": "https://ultralight.dev/docs/mcp"
}
```

---

## CLI Tool Design

### Architecture Decision: Deno CLI

**Recommendation: Native Deno CLI**

**Rationale:**
- Consistent with API runtime (Deno)
- TypeScript native - no build step
- Single binary distribution via `deno compile`
- Cross-platform (macOS, Linux, Windows)
- Can share types with API (`shared/types/`)

### Command Structure

```
ultralight
├── init                    # Initialize new project
├── login                   # Authenticate with OAuth
├── logout                  # Clear credentials
├── whoami                  # Show current user
│
├── upload [dir]            # Upload new app or update existing
│   --name <name>           # App display name
│   --slug <slug>           # URL slug
│   --visibility <v>        # private|unlisted|public
│   --no-docs               # Skip doc generation
│
├── apps                    # App management
│   ├── list                # List your apps
│   ├── get <app>           # Get app details
│   ├── delete <app>        # Delete app
│   ├── update <app>        # Update metadata
│   └── download <app>      # Download as zip
│
├── draft                   # Draft management
│   ├── upload [dir]        # Upload draft
│   ├── status <app>        # Draft status
│   ├── diff <app>          # Diff with production
│   ├── publish <app>       # Publish draft
│   └── discard <app>       # Discard draft
│
├── docs                    # Documentation
│   ├── generate <app>      # Generate Skills.md
│   ├── get <app>           # Get Skills.md
│   └── update <app>        # Update Skills.md
│
├── run <app> <fn> [args]   # Execute function
│   --draft                 # Run against draft
│   --json                  # JSON output
│
├── discover <query>        # Semantic search
│
├── cron                    # Cron management
│   ├── list [app]          # List jobs
│   ├── create <app>        # Create job
│   ├── update <job>        # Update job
│   ├── delete <job>        # Delete job
│   └── trigger <job>       # Manually trigger
│
├── logs <app>              # View execution logs
│   --follow                # Stream logs
│   --since <time>          # Filter by time
│
└── config                  # CLI configuration
    ├── get <key>
    ├── set <key> <value>
    └── list
```

### Configuration File

`~/.ultralight/config.json`:
```json
{
  "api_url": "https://ultralight.dev",
  "auth": {
    "token": "...",
    "expires_at": "2025-02-02T00:00:00Z",
    "refresh_token": "..."
  },
  "defaults": {
    "visibility": "private",
    "auto_docs": true
  }
}
```

Project-level `.ultralightrc.json`:
```json
{
  "app_id": "uuid-here",
  "slug": "my-app",
  "name": "My App",
  "entry": "src/index.ts",
  "include": ["src/**/*.ts", "package.json"],
  "exclude": ["**/*.test.ts", "node_modules"]
}
```

### TypeScript SDK

`npm install @ultralight/sdk` or import from `https://ultralight.dev/sdk/mod.ts`

```typescript
import { Galactic } from '@ultralight/sdk';

const ul = new Galactic({
  token: process.env.ULTRALIGHT_TOKEN,
  // or: apiKey: process.env.ULTRALIGHT_API_KEY
});

// App management
const apps = await ul.apps.list();
const app = await ul.apps.get('my-app');
const newApp = await ul.apps.create({
  name: 'My App',
  files: [
    { path: 'index.ts', content: '...' }
  ]
});

// Draft workflow
await ul.drafts.upload('app-id', files);
await ul.drafts.publish('app-id');

// Execute functions
const result = await ul.run('app-id', 'myFunction', { arg: 'value' });

// MCP client
const mcp = ul.mcp('app-id');
const tools = await mcp.listTools();
const response = await mcp.callTool('functionName', { args });
```

---

## Architectural Decisions

### 1. Authentication: API Keys vs. JWT

**Decision: Support Both**

| Method | Use Case | Implementation |
|--------|----------|----------------|
| JWT (OAuth) | Interactive use, web UI, CLI login | Existing Supabase Auth |
| API Key | CI/CD, scripts, SDK | New: long-lived tokens with scopes |

**API Key Implementation:**
```typescript
interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  prefix: string;     // First 8 chars for identification
  hash: string;       // SHA-256 hash of full key
  scopes: string[];   // ['apps:read', 'apps:write', 'run']
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}
```

Header: `Authorization: Bearer ul_sk_xxx` (API key) or `Authorization: Bearer eyJ...` (JWT)

### 2. Rate Limiting Strategy

| Endpoint | Free Tier | Pro Tier |
|----------|-----------|----------|
| `platform:apps/list` | 60/min | 300/min |
| `platform:apps/create` | 10/hour | 100/hour |
| `platform:draft/upload` | 30/hour | 200/hour |
| `platform:run` | 100/min | 1000/min |
| `platform:discover` | 60/min | 300/min |

### 3. Error Handling

Standard JSON-RPC error codes plus custom:

```typescript
const PLATFORM_ERRORS = {
  // Standard JSON-RPC
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Custom
  RATE_LIMITED: -32000,
  AUTH_REQUIRED: -32001,
  NOT_FOUND: -32002,
  FORBIDDEN: -32003,
  QUOTA_EXCEEDED: -32004,
  BUILD_FAILED: -32005,
  VALIDATION_ERROR: -32006,
};
```

### 4. File Upload Strategy

**Decision: Base64-encoded in JSON**

For MCP protocol compatibility, files are base64-encoded in tool arguments:

```json
{
  "name": "platform.apps.create",
  "arguments": {
    "files": [
      {
        "path": "index.ts",
        "content": "ZXhwb3J0IGZ1bmN0aW9uIGhlbGxvKCkgeyByZXR1cm4gIkhlbGxvISI7IH0=",
        "encoding": "base64"
      }
    ]
  }
}
```

For CLI and SDK, support both:
- Plain text for small files
- Base64 for binary or large files
- Streaming for very large files (>1MB)

### 5. Versioning Strategy

**Semantic Versioning for Apps:**
- `patch` (1.0.0 → 1.0.1): Bug fixes, minor changes
- `minor` (1.0.0 → 1.1.0): New features, backward compatible
- `major` (1.0.0 → 2.0.0): Breaking changes

**API Versioning:**
- Path prefix: `/v1/mcp/platform`
- Header: `X-API-Version: 2025-02-01`
- Default to latest stable

---

## Implementation Plan

### Phase 1: Platform MCP Foundation (Week 1-2)

1. **Create `/api/handlers/platform-mcp.ts`**
   - Implement JSON-RPC handler
   - Add tool routing
   - Integrate auth (JWT + API key)

2. **Implement Core Tools**
   - `platform.apps.list`
   - `platform.apps.get`
   - `platform.apps.create`
   - `platform.apps.update`
   - `platform.apps.delete`

3. **Add Well-Known Discovery**
   - `GET /.well-known/mcp.json`

### Phase 2: Draft/Publish Tools (Week 2-3)

1. **Draft Management Tools**
   - `platform.draft.upload`
   - `platform.draft.get`
   - `platform.draft.publish`
   - `platform.draft.discard`

2. **Documentation Tools**
   - `platform.docs.generate`
   - `platform.docs.get`
   - `platform.docs.update`

### Phase 3: CLI Tool (Week 3-4)

1. **Core CLI Structure**
   - Command parser
   - Config management
   - OAuth login flow

2. **Essential Commands**
   - `ultralight login`
   - `ultralight upload`
   - `ultralight apps list`
   - `ultralight draft publish`

3. **Distribution**
   - `deno compile` for binaries
   - npm package (wrapper)
   - Homebrew formula

### Phase 4: SDK & Advanced Features (Week 4-5)

1. **TypeScript SDK**
   - API client
   - MCP client wrapper
   - Type definitions

2. **API Keys**
   - Database schema
   - Generation endpoint
   - Auth middleware update

3. **Advanced Tools**
   - `platform.discover`
   - `platform.run`
   - `platform.analytics.*`

### Phase 5: Polish & Documentation (Week 5-6)

1. **Documentation**
   - MCP tool reference
   - CLI user guide
   - SDK examples

2. **Testing**
   - Integration tests
   - E2E CLI tests
   - Load testing

---

## Agentic Use Benefits

### Before: Manual Workflow
```
User → Web UI → Upload code → Generate docs → Test → Publish
```

### After: Agentic Workflow
```
Agent → MCP platform.apps.create → platform.docs.generate
      → platform.run (test) → platform.draft.publish
```

### Key Improvements for Agents

1. **Programmatic Upload**: Agents can create/update apps without UI
2. **Atomic Operations**: Draft/publish ensures safe deployments
3. **Self-Documenting**: Auto-generate Skills.md from code
4. **Discoverable**: Semantic search finds relevant apps
5. **Testable**: Run functions to validate before publishing
6. **Observable**: Analytics and logs for monitoring
7. **Composable**: MCP tools can be chained together

### Example Agent Workflow

```
Agent: "I need to create a weather app"

1. platform.discover("weather API integration")
   → Finds existing weather app templates

2. platform.apps.create({
     name: "My Weather App",
     files: [{ path: "index.ts", content: "..." }]
   })
   → Creates app in draft state

3. platform.docs.generate({ app_id: "..." })
   → Generates Skills.md

4. platform.run({ app_id: "...", function: "getWeather", args: { city: "SF" } })
   → Tests the function

5. platform.draft.publish({ app_id: "..." })
   → Publishes to production
```

---

## Open Questions

1. **Webhook Events**: Should we add webhooks for app events (deploy, run, error)?
2. **Team/Org Support**: Multi-user access to apps?
3. **Environment Variables**: Secure secrets management?
4. **Custom Domains**: Allow `myapp.ultralight.dev` → `custom.com`?
5. **Billing Integration**: Metered API usage?

---

## Conclusion

Adding platform-level MCP and CLI will transform Galactic from a primarily UI-driven platform to a fully programmable one. This enables:

- **CI/CD Integration**: Automated deployments
- **Agent Workflows**: AI agents can manage the full app lifecycle
- **Developer Experience**: CLI for local development
- **Ecosystem Growth**: SDK enables third-party integrations

The modular approach (separate platform MCP, typed SDK, familiar CLI) ensures we can iterate on each component independently while maintaining a cohesive developer experience.
