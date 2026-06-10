# Ultralight Spec

Ultralight is a serverless MCP app platform. Developers write functions in TypeScript, deploy them, and Ultralight handles execution, data storage (Cloudflare D1/SQLite), user authentication, billing, and metering.

## What this directory is

This `ultralight-spec/` directory contains the canonical conventions for building Ultralight apps. It is the single source of truth for both human developers and coding agents.

## How to use this spec

**Agents**: Read everything in `conventions/` before generating any code. Follow every rule — the platform enforces most of them at runtime and deploy time.

**Humans**: Reference `conventions/` when designing schemas, writing migrations, or building new app functions.

### Conventions

| File | Covers |
|------|--------|
| `conventions/app-structure.md` | Entry point, function signatures, sandbox rules |
| `conventions/d1-schema.md` | Required columns, naming, data types |
| `conventions/migrations.md` | Migration file format, ordering, forbidden operations |
| `conventions/user-isolation.md` | user_id requirement, query rules |
| `conventions/api-surface.md` | Available SDK methods and usage rules |
| `conventions/metering.md` | Free tier limits, pricing, rate limits |
| `conventions/security.md` | Parameterization, blocked operations, permissions |
| `conventions/skills-as-functions.md` | Shipping long-form context via skills_index / skill_reader functions |
