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
  registryDemotedMcpTools,
  registryMcpTools,
  toMcpTool,
} from "./registry.ts";
import type { CapabilitySurface } from "../../../shared/contracts/capabilities.ts";

const ALL_SURFACES: CapabilitySurface[] = ["mcp", "cli", "web"];

// Capabilities we intend to reach full MCP + CLI + website parity. Agent-native
// signals (flag, codemode) are intentionally MCP-only and excluded. As each read
// migrates it is added here so the parity invariant grows with the registry.
const PARITY_TARGETS = ["verify", "job", "discover", "call"];

Deno.test("registry: full-parity capabilities declare all three surfaces", () => {
  for (const id of PARITY_TARGETS) {
    const cap = getCapabilityById(id);
    assert(cap, `${id} should be registered`);
    for (const surface of ALL_SURFACES) {
      assert(
        cap!.surfaces.includes(surface),
        `full-parity capability "${id}" is missing the "${surface}" surface`,
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
  // gx.* advertised name, its ul.* twin, and explicit legacy aliases all resolve.
  assertEquals(getCapabilityByToolName("gx.verify")?.id, "verify");
  assertEquals(getCapabilityByToolName("ul.verify")?.id, "verify");
  assertEquals(getCapabilityByToolName("gx.discover")?.id, "discover");
  assertEquals(getCapabilityByToolName("ul.discover")?.id, "discover");
  assertEquals(getCapabilityByToolName("gx.job")?.id, "job");
  assertEquals(getCapabilityByToolName("ul.job")?.id, "job");
  assertEquals(getCapabilityByToolName("ultralight.job")?.id, "job");
  assertEquals(getCapabilityByToolName("gx.flag")?.id, "flag");
  assertEquals(getCapabilityByToolName("ul.flag")?.id, "flag");
  assertEquals(getCapabilityByToolName("gx.download")?.id, "download");
  assertEquals(getCapabilityByToolName("ul.download")?.id, "download");
  assertEquals(getCapabilityByToolName("gx.upload")?.id, "upload");
  assertEquals(getCapabilityByToolName("ul.upload")?.id, "upload");
  assertEquals(getCapabilityByToolName("gx.test")?.id, "test");
  assertEquals(getCapabilityByToolName("ul.test")?.id, "test");
  assertEquals(getCapabilityByToolName("gx.set")?.id, "set");
  assertEquals(getCapabilityByToolName("ul.set")?.id, "set");
  assertEquals(getCapabilityByToolName("gx.permit")?.id, "consent");
  assertEquals(getCapabilityByToolName("ul.permit")?.id, "consent");
  assertEquals(getCapabilityByToolName("gx.secrets")?.id, "secrets");
  assertEquals(getCapabilityByToolName("ul.secrets")?.id, "secrets");
  // ul.connect + ul.connections folded into the secrets capability.
  assertEquals(getCapabilityByToolName("ul.connect")?.id, "secrets");
  assertEquals(getCapabilityByToolName("ul.connections")?.id, "secrets");
  assertEquals(getCapabilityByToolName("gx.call")?.id, "call");
  assertEquals(getCapabilityByToolName("ul.call")?.id, "call");
  assertEquals(getCapabilityByToolName("gx.codemode")?.id, "codemode");
  assertEquals(getCapabilityByToolName("ul.codemode")?.id, "codemode");
  assertEquals(getCapabilityByToolName("ul.execute")?.id, "codemode");
  // An unmigrated / unknown name does not resolve (falls to the legacy switch).
  assertEquals(getCapabilityByToolName("gx.wallet"), undefined);
  assertEquals(getCapabilityByToolName("nope"), undefined);
});

Deno.test("registry: MCP projection honors LITE (core-only) and Free Mode", () => {
  const lite = registryMcpTools({ lite: true }).map((t) => t.name);
  const full = registryMcpTools({ lite: false }).map((t) => t.name);
  // codemode is core (in LITE) but dropped in Free Mode (billing bypass).
  assert(lite.includes("gx.codemode"), "gx.codemode should be in LITE");
  assert(
    !registryMcpTools({ lite: false, freeMode: true }).map((t) => t.name)
      .includes("gx.codemode"),
    "gx.codemode must be dropped in Free Mode",
  );
  // Core tools appear in both the lean and full manifests.
  for (
    const name of [
      "gx.verify",
      "gx.job",
      "gx.discover",
      "gx.upload",
      "gx.test",
      "gx.set",
      "gx.permit",
      "gx.secrets",
    ]
  ) {
    assert(lite.includes(name), `${name} should be in the LITE manifest`);
    assert(full.includes(name), `${name} should be in the full manifest`);
  }
  // Demoted tools (flag) are hidden from LITE but callable + in the full manifest
  // and the progressive-disclosure list.
  assert(!lite.includes("gx.flag"), "gx.flag is demoted — not in LITE");
  assert(full.includes("gx.flag"), "gx.flag should be in the full manifest");
  // Demoted registry tools, in registration order (for the scope="tools" list).
  assertEquals(
    registryDemotedMcpTools().map((t) => t.name),
    ["gx.download", "gx.flag"],
  );
});

Deno.test("registry: toMcpTool produces a well-formed tools/list entry", () => {
  const verify = getCapabilityById("verify")!;
  const tool = toMcpTool(verify);
  assertEquals(tool.name, "gx.verify");
  assertEquals(tool.inputSchema.required, ["app_id"]);
  assertEquals(tool.annotations?.readOnlyHint, true);
  assert(tool.description.length > 0);
});
