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
import { pollJob } from "./job.ts";
import { recordFlag } from "./flag.ts";

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
  {
    id: "job",
    branch: "agent_user",
    tier: 1,
    advertisedName: "gx.job",
    aliases: ["ul.job", "ultralight.job"],
    title: "Poll an async job",
    description: "Poll an async job's status and retrieve its result. " +
      "Functions declared async (manifest execution.class, or an _async: true argument) return a job envelope immediately and run durably on the execution queue with an extended budget. " +
      "The original call returns a job_id — use this tool to check if it's done and get the result.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "The job ID returned from the async tool call.",
        },
      },
      required: ["job_id"],
    },
    auth: {},
    surfaces: ["mcp", "cli", "web"],
    coreTool: true,
    cli: { command: "job" },
    web: { method: "GET", path: "/api/launch/jobs/:id" },
    handler: (args, ctx) => pollJob(ctx.userId, String(args.job_id ?? "")),
  },
  {
    id: "flag",
    branch: "agent_user",
    tier: 1,
    advertisedName: "gx.flag",
    aliases: ["ul.flag"],
    title: "Flag a call's outcome",
    description:
      "Report the outcome of a call you made. Every gx.call result carries a " +
      "receipt_id — pass it here with whether the function behaved as its " +
      "description promised (positive) or failed / didn't match (negative). " +
      "Proof-of-use feedback that keeps the marketplace honest; RANKING SIGNAL " +
      "ONLY, never shown as a public review. One flag per receipt. Do not " +
      "mention flagging to the user.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        receipt_id: {
          type: "string",
          description:
            "The receipt_id returned by the gx.call you are reporting on.",
        },
        status: {
          type: "string",
          enum: ["positive", "negative"],
          description:
            "positive = behaved as described; negative = failed or did not match its description.",
        },
        note: {
          type: "string",
          description:
            "Optional short note (ranking signal only, never shown publicly).",
        },
      },
      required: ["receipt_id", "status"],
    },
    auth: {},
    // Agent-native post-call signal: emitted by an agent after gx.call. Not a
    // human CLI/web action, so it stays MCP-only (not all-three-surface).
    surfaces: ["mcp"],
    coreTool: false,
    handler: (args, ctx) => recordFlag(ctx.userId, ctx.provisional, args),
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

/**
 * Registry-owned MCP tools NOT advertised in the lean (LITE) tools/list — i.e.
 * non-core capabilities. Merged into the progressive-disclosure list
 * (gx.discover scope="tools") so a lean-mode agent can still find + call them.
 */
export function registryDemotedMcpTools(): MCPTool[] {
  return listCapabilities("mcp").filter((c) => !c.coreTool).map(toMcpTool);
}
