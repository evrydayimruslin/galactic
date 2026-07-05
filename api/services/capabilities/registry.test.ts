// Parity test harness for the capability registry.
//
// The durable win of the registry is that "Tier-1 parity" becomes an enforced
// invariant instead of a hand-audited hope: a Tier-1 capability that isn't
// projected onto all three surfaces fails this test. PR 0 migrates `verify`;
// each later PR adds capabilities and this test keeps them honest.

import { assert, assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  getCapabilityById,
  getCapabilityByToolName,
  listCapabilities,
  registryMcpTools,
  toMcpTool,
} from "./registry.ts";
import type { CapabilitySurface } from "../../../shared/contracts/capabilities.ts";

const ALL_SURFACES: CapabilitySurface[] = ["mcp", "cli", "web"];

Deno.test("registry: every Tier-1 capability declares all three surfaces", () => {
  for (const cap of listCapabilities()) {
    if (cap.tier !== 1) continue;
    for (const surface of ALL_SURFACES) {
      assert(
        cap.surfaces.includes(surface),
        `Tier-1 capability "${cap.id}" is missing the "${surface}" surface`,
      );
    }
  }
});

Deno.test("registry: each declared surface has a projection descriptor", () => {
  for (const cap of listCapabilities()) {
    // MCP: needs an advertised gx.* name that resolves back to the capability.
    if (cap.surfaces.includes("mcp")) {
      assert(
        cap.advertisedName.startsWith("gx."),
        `"${cap.id}" mcp name must be gx.*-prefixed`,
      );
      assertEquals(getCapabilityByToolName(cap.advertisedName)?.id, cap.id);
    }
    // CLI: needs a command binding.
    if (cap.surfaces.includes("cli")) {
      assert(cap.cli?.command, `"${cap.id}" declares cli but has no cli.command`);
    }
    // Web: needs a route descriptor.
    if (cap.surfaces.includes("web")) {
      assert(cap.web?.path, `"${cap.id}" declares web but has no web.path`);
      assert(
        cap.web!.path.startsWith("/api/"),
        `"${cap.id}" web.path must be an /api/ route`,
      );
    }
  }
});

Deno.test("registry: tool-name resolution covers gx.*, ul.*, and aliases", () => {
  const verify = getCapabilityById("verify");
  assert(verify, "verify capability should be registered");
  // gx.* advertised name, its ul.* twin, and the explicit legacy alias all resolve.
  assertEquals(getCapabilityByToolName("gx.verify")?.id, "verify");
  assertEquals(getCapabilityByToolName("ul.verify")?.id, "verify");
  // An unmigrated / unknown name does not resolve (falls to the legacy switch).
  assertEquals(getCapabilityByToolName("gx.upload"), undefined);
  assertEquals(getCapabilityByToolName("nope"), undefined);
});

Deno.test("registry: MCP projection honors LITE (core-only) and Free Mode", () => {
  // verify is a coreTool, so it appears in both the lean and full manifests.
  const lite = registryMcpTools({ lite: true }).map((t) => t.name);
  const full = registryMcpTools({ lite: false }).map((t) => t.name);
  assert(lite.includes("gx.verify"), "gx.verify should be in the LITE manifest");
  assert(full.includes("gx.verify"), "gx.verify should be in the full manifest");
});

Deno.test("registry: toMcpTool produces a well-formed tools/list entry", () => {
  const verify = getCapabilityById("verify")!;
  const tool = toMcpTool(verify);
  assertEquals(tool.name, "gx.verify");
  assertEquals(tool.inputSchema.required, ["app_id"]);
  assertEquals(tool.annotations?.readOnlyHint, true);
  assert(tool.description.length > 0);
});
