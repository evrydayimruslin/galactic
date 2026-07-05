// Capability registry — the single source of truth the three surfaces project from.
//
// Strangler-fig migration: a capability listed here has LEFT the legacy
// platform-mcp PLATFORM_TOOLS array + dispatch switch (and, where applicable, the
// hand-written CLI command / REST route) and is now owned here. Everything not
// yet migrated still flows through the legacy paths, which act as the fallback.
//
// PR 0 migrates exactly one capability — `verify` — to prove the projection
// pattern end to end. Subsequent PRs move the rest branch by branch.

import type {
  Capability,
  CapabilitySurface,
} from "../../../shared/contracts/capabilities.ts";
import type { MCPTool } from "../../../shared/contracts/mcp.ts";
import { verifyAppIntegrity } from "./verify.ts";

const CAPABILITIES: Capability[] = [
  {
    id: "verify",
    branch: "agent_user",
    tier: 1,
    advertisedName: "gx.verify",
    aliases: ["ul.verify"],
    title: "Verify agent integrity",
    description:
      "Verify an Agent's integrity BEFORE you call it. Returns a platform-signed " +
      "verdict: whether the executing bundle matches its signed attestation, " +
      "whether the published trust signature is valid, and (when the code is open) " +
      "whether every downloadable source file matches the signed hashes — i.e. " +
      "'the code you can read is the code that runs'. Pair with gx.download to read " +
      "the source yourself.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        app_id: {
          type: "string",
          description: "App ID or slug of the Agent to verify.",
        },
      },
      required: ["app_id"],
    },
    auth: {},
    surfaces: ["mcp", "cli", "web"],
    coreTool: true,
    cli: { command: "verify" },
    web: { method: "GET", path: "/api/launch/agents/:id/verify" },
    handler: (args, ctx) =>
      verifyAppIntegrity(ctx.userId, String(args.app_id ?? "")),
  },
];

/** All registered capabilities (optionally filtered to one surface). */
export function listCapabilities(surface?: CapabilitySurface): Capability[] {
  if (!surface) return CAPABILITIES;
  return CAPABILITIES.filter((c) => c.surfaces.includes(surface));
}

// Tool-name → capability, keyed by every name a caller might use: the gx.*
// advertised name, its ul.* twin, and any explicit legacy aliases. Built once.
const byToolName = new Map<string, Capability>();
for (const cap of CAPABILITIES) {
  byToolName.set(cap.advertisedName, cap);
  if (cap.advertisedName.startsWith("gx.")) {
    byToolName.set("ul." + cap.advertisedName.slice(3), cap);
  }
  for (const alias of cap.aliases) byToolName.set(alias, cap);
}

/**
 * Resolve a capability from a requested MCP tool name (gx.*, ul.*, or a legacy
 * alias). Returns undefined for names still owned by the legacy switch.
 */
export function getCapabilityByToolName(name: string): Capability | undefined {
  return byToolName.get(name);
}

/** Resolve a capability by its canonical id (used by the CLI/REST projections). */
export function getCapabilityById(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/** Project a capability into an MCP tools/list entry. */
export function toMcpTool(cap: Capability): MCPTool {
  return {
    name: cap.advertisedName,
    title: cap.title,
    description: cap.description,
    inputSchema: cap.inputSchema,
    ...(cap.outputSchema ? { outputSchema: cap.outputSchema } : {}),
    ...(cap.annotations ? { annotations: cap.annotations } : {}),
  };
}

/**
 * MCP tools contributed by the registry, honoring the LITE manifest (core-only)
 * and Free Mode (codemode dropped) exactly as the legacy getPlatformTools does.
 */
export function registryMcpTools(
  opts: { lite: boolean; freeMode?: boolean },
): MCPTool[] {
  return listCapabilities("mcp")
    .filter((c) => !opts.lite || c.coreTool)
    .filter((c) => !(opts.freeMode && c.id === "codemode"))
    .map(toMcpTool);
}
