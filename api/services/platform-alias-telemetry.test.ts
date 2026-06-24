import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  PLATFORM_MCP_ALIAS_MAP,
  buildPlatformMcpAliasRetiredMessage,
  buildPlatformMcpAliasLogEntry,
  parseDisabledPlatformMcpAliases,
} from "./platform-alias-telemetry.ts";

Deno.test("platform alias telemetry: maps ul.execute to ul.codemode", () => {
  assertEquals(PLATFORM_MCP_ALIAS_MAP["ul.execute"], {
    canonicalTool: "gx.codemode",
    replacement: 'gx.codemode({ code })',
  });
});

Deno.test("platform alias telemetry: includes blockers for aliases without a canonical replacement", () => {
  const entry = buildPlatformMcpAliasLogEntry({
    alias: "ul.markdown.list",
    userId: "user-123",
    sessionId: "session-123",
  });

  assertEquals(entry, {
    event: "platform_mcp_alias",
    alias: "ul.markdown.list",
    canonical_tool: null,
    replacement: "No canonical replacement published yet.",
    removal_blocker: "Page listing still depends on the legacy alias surface.",
    user_id: "user-123",
    session_id: "session-123",
    known_alias: true,
  });
});

Deno.test("platform alias telemetry: removable config token disables only aliases with canonical replacements", () => {
  const disabled = parseDisabledPlatformMcpAliases("removable,unknown");

  assertEquals(disabled.has("ul.execute"), true);
  assertEquals(disabled.has("ul.set.version"), true);
  assertEquals(disabled.has("ul.health"), false);
  assertEquals(disabled.has("ul.shortcomings"), false);
});

Deno.test("platform alias telemetry: explicit alias names can be disabled individually", () => {
  const disabled = parseDisabledPlatformMcpAliases("ul.health");

  assertEquals(disabled.has("ul.health"), true);
  assertEquals(disabled.has("ul.execute"), false);
});

Deno.test("platform alias telemetry: retired message points callers at canonical replacements when available", () => {
  assertEquals(
    buildPlatformMcpAliasRetiredMessage("ul.execute"),
    'The tool alias "ul.execute" has been retired. Use gx.codemode({ code }) instead.',
  );
});
