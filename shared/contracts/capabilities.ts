// Capability contract — the single source of truth for a platform capability.
//
// A capability is defined ONCE here and projected onto every surface it declares
// (MCP tool, CLI command, website route). Parity across surfaces is then a
// property we can test, not one we hand-maintain, and the outward `gx.*` names
// become an editable label (`advertisedName`) rather than something baked into
// three separate dispatch tables.
//
// See docs/brief: strangler-fig migration — capabilities leave the legacy
// PLATFORM_TOOLS array + switch as they join this registry.

import type { MCPJsonSchema, MCPToolAnnotations } from "./mcp.ts";

/** Where a capability is exposed. Tier-1 capabilities declare all three. */
export type CapabilitySurface = "mcp" | "cli" | "web";

/** Which gx.* family a capability groups under (presentation/grouping only). */
export type CapabilityBranch = "ownership" | "agent_user" | "platform_user";

/**
 * 1 = pure-API, parity on all three surfaces.
 * 2 = sensitive mutation (money / keys / authorizing others) — website only.
 * 3 = interaction-bound (Stripe, OAuth) — website only.
 */
export type CapabilityTier = 1 | 2 | 3;

/**
 * Surface-neutral error a handler throws. Each surface adapter maps it to its
 * own shape (MCP JSON-RPC code, HTTP status, CLI exit) so a capability handler
 * never needs to know which surface called it.
 */
export type CapabilityErrorCode =
  | "invalid_input"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "internal";

export class CapabilityError extends Error {
  readonly code: CapabilityErrorCode;
  constructor(code: CapabilityErrorCode, message: string) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
  }
}

/** Caller context every handler receives, independent of the calling surface. */
export interface CapabilityContext {
  userId: string;
  provisional: boolean;
  /** The surface the call arrived on — for telemetry, never for authorization. */
  surface: CapabilitySurface;
}

export interface CapabilityAuth {
  /** Handler restricts to the app owner. Declared here for docs + projection. */
  ownerOnly?: boolean;
  /** Tier 2/3: requires a browser account session (rejects API/actor tokens). */
  needsSession?: boolean;
}

/** Web projection descriptor — the REST route this capability mounts at. */
export interface CapabilityWebRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** e.g. "/api/launch/agents/:id/verify" (":id" bound to the app_id arg). */
  path: string;
}

/** CLI projection descriptor — the command this capability is invoked as. */
export interface CapabilityCliCommand {
  /** e.g. "verify" → `galactic verify <app-id>`. */
  command: string;
}

export interface Capability<
  Args extends Record<string, unknown> = Record<string, unknown>,
  Result = unknown,
> {
  /** Stable canonical id (never renamed), e.g. "verify". */
  id: string;
  branch: CapabilityBranch;
  tier: CapabilityTier;
  /** Outward gx.* name shown on the MCP surface, e.g. "gx.verify". Late-bound. */
  advertisedName: string;
  /** Legacy tool names kept callable for one deprecation window, e.g. ["ul.verify"]. */
  aliases: string[];
  title: string;
  description: string;
  inputSchema: MCPJsonSchema;
  outputSchema?: MCPJsonSchema;
  annotations?: MCPToolAnnotations;
  auth: CapabilityAuth;
  surfaces: CapabilitySurface[];
  /** Advertised in the lean (LITE) MCP tools/list rather than progressive-disclosure. */
  coreTool?: boolean;
  cli?: CapabilityCliCommand;
  web?: CapabilityWebRoute;
  /** The single implementation every surface resolves to. */
  handler: (args: Args, ctx: CapabilityContext) => Promise<Result>;
}
