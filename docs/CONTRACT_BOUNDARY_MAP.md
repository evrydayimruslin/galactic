# Contract Boundary Map

This document defines the ownership model for Wave 3 contract convergence.
The goal is to prevent the repo from continuing to grow parallel, hand-edited
contract surfaces.

## Canonical Sources

Canonical shared source lives under `shared/contracts/*`.

Current Wave 3 families:

- `shared/contracts/agentic-interface.ts`
  Generated Command interface specs, native component/data/action bindings, and
  spec validation helpers.
- `shared/contracts/jsonrpc.ts`
  JSON-RPC request/response ids, envelopes, and error objects used by MCP and
  SDK clients.
- `shared/contracts/mcp.ts`
  MCP tools, schemas, tool-call envelopes, and resource descriptors.
- `shared/contracts/ai.ts`
  AI request/response payloads, multimodal content parts, chat payloads, and
  chat billing contracts.
- `shared/contracts/widget.ts`
  Widget declarations, widget items, and widget app responses.
- `shared/contracts/env.ts`
  env schema entries and env-key validation helpers used by manifests and app
  settings.
- `shared/contracts/runtime.ts`
  runtime-facing user context, query contracts, and the app runtime SDK
  surface.
- `shared/contracts/manifest.ts`
  app manifest schema, manifest env helpers, validation, and manifest-to-MCP
  conversion.
- `shared/contracts/sdk.ts`
  public SDK DTOs used by both npm and Deno entrypoints.

## Compatibility Surfaces

- `shared/types/index.ts`
  compatibility barrel for existing API, web, desktop, and runtime imports.
  It may continue to host older contract families during migration, but new
  shared transport/runtime/public SDK contracts should land in
  `shared/contracts/*`.
- `packages/types/index.d.ts`
  generated publication artifact for the ambient app-runtime type package.
  This file is not a source of truth.
- `sdk/mod.ts`
  compatibility entrypoint for Deno and direct URL imports. It should remain a
  thin wrapper over the canonical SDK implementation.

## Package-Local Canonical Sources

Some types are package-specific and should not be forced into shared contracts
unless another package genuinely consumes them.

- `packages/types/index.template.d.ts`
  canonical template for the ambient runtime package wrapper and global
  utility declarations.
- `sdk/src/client.ts`
  canonical SDK implementation. Runtime behavior should not be duplicated in
  `sdk/mod.ts`.

## Internal-Only Contracts

These should not be published through `@ultralightpro/types` or the public SDK
unless intentionally promoted:

- raw DB row helper types used only inside a handler/service
- internal persistence records for billing, auth, or operational tables
- implementation-only response wrappers used by one subsystem
- generated migration or workflow-only helper shapes

## Ownership Rules

1. Shared public or cross-package contracts belong in `shared/contracts/*`.
2. `shared/types/index.ts` may re-export compatibility symbols, but new shared
   contracts should not originate there if a domain module already exists.
3. Published artifacts under `packages/types` must be generated.
4. `sdk/src/index.ts` and `sdk/mod.ts` must not maintain parallel request,
   response, or transport declarations.
5. JSON-RPC/MCP envelopes must be imported from shared contracts rather than
   re-declared in handlers or SDK code.

## Planned Deletions

- Hand-maintained drift in `packages/types/index.d.ts`
- Local JSON-RPC envelope interfaces in `api/handlers/mcp.ts`
- Local JSON-RPC envelope interfaces in `api/handlers/platform-mcp.ts`
- Parallel SDK contract/interface maintenance between `sdk/src/index.ts` and
  `sdk/mod.ts`
