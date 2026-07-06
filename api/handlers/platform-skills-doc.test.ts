// The /api/skills doc is curated prose, which means it can silently drift from
// the real tool surface — it did: gx.verify was migrated to the registry in
// PR 0 and the doc never documented it (nor gx.consent/gx.db/gx.flag), while
// the header claimed a hardcoded "20 tools". This test pins the invariant:
// every tool the registry advertises must appear in the served doc.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";

import { handleSkills } from "./platform-mcp.ts";
import {
  registryDemotedMcpTools,
  registryMcpTools,
} from "../services/capabilities/registry.ts";

Deno.test("skills doc documents every registry-owned tool", async () => {
  const response = handleSkills(new Request("https://api.test/api/skills"));
  const body = await response.text();

  const advertised = [
    ...registryMcpTools({ lite: false }),
    ...registryDemotedMcpTools(),
  ];
  assert(advertised.length > 0, "registry should advertise tools");
  for (const tool of advertised) {
    assert(
      body.includes(tool.name),
      `skills doc is missing registry tool ${tool.name}`,
    );
  }
});

Deno.test("skills doc header count is computed, not hardcoded", async () => {
  const response = handleSkills(new Request("https://api.test/api/skills"));
  const body = await response.text();
  const match = body.match(/^(\d+) tools \+ MCP Resources/m);
  assert(match, "skills doc should lead with a computed tool count");
  // The count must at least cover the registry surface; a hardcoded relic
  // (e.g. the old "20") smaller than the registry itself fails here.
  assert(
    Number(match![1]) >= registryMcpTools({ lite: false }).length,
    `header count ${match![1]} is smaller than the registry surface`,
  );
});
