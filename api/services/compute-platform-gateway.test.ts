import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  authorizeComputePlatformFunction,
  createBearerFreeComputePlatformRequest,
  createComputePlatformFunctionAllowlist,
  filterComputePlatformTools,
} from "./compute-platform-gateway.ts";

Deno.test("compute platform authority accepts canonical names only", () => {
  const allowed = createComputePlatformFunctionAllowlist([
    "ul.call",
    "ul.upload",
  ]);
  assertEquals([...allowed], ["ul.call", "ul.upload"]);

  assertThrows(
    () => createComputePlatformFunctionAllowlist(["gx.call"]),
    Error,
    "canonical ul.*",
  );
});

Deno.test("compute platform authorization is exact and retains non-human restrictions", () => {
  const allowed = createComputePlatformFunctionAllowlist([
    "ul.call",
    "ul.upload",
    "ul.secrets",
    "ul.codemode",
  ]);

  assert(
    authorizeComputePlatformFunction({
      requestedName: "gx.call",
      allowed,
    }).allowed,
  );

  const unlisted = authorizeComputePlatformFunction({
    requestedName: "gx.test",
    allowed,
  });
  assertEquals(unlisted.allowed, false);
  assertEquals(unlisted.exactScopeDenied, true);

  const secretWrite = authorizeComputePlatformFunction({
    requestedName: "gx.secrets",
    args: { app_id: "agent-1", secrets: { API_KEY: "secret" } },
    allowed,
  });
  assertEquals(secretWrite.allowed, false);
  assertEquals(secretWrite.accountSessionRequired, true);

  const codemode = authorizeComputePlatformFunction({
    requestedName: "gx.codemode",
    allowed,
  });
  assertEquals(codemode.allowed, false);
  assertEquals(codemode.bearerDependentToolDenied, true);
});

Deno.test("compute tools/list projection applies the exact authority", () => {
  const allowed = createComputePlatformFunctionAllowlist([
    "ul.call",
    "ul.upload",
  ]);
  const tools = filterComputePlatformTools(
    [
      { name: "gx.call" },
      { name: "gx.upload" },
      { name: "gx.test" },
      { name: "gx.codemode" },
    ],
    allowed,
  );
  assertEquals(tools.map((tool) => tool.name), ["gx.call", "gx.upload"]);
});

Deno.test("compute dispatch request drops bearer and credential headers", () => {
  const request = new Request("https://api.test/private/compute/mcp", {
    method: "POST",
    headers: {
      "Authorization": "Bearer compute-job-secret",
      "Cookie": "session=human-secret",
      "X-Provider-Key": "provider-secret",
      "Mcp-Session-Id": "session-1",
    },
  });

  const sanitized = createBearerFreeComputePlatformRequest(request);
  assertEquals(sanitized.headers.get("Authorization"), null);
  assertEquals(sanitized.headers.get("Cookie"), null);
  assertEquals(sanitized.headers.get("X-Provider-Key"), null);
  assertEquals(sanitized.headers.get("Mcp-Session-Id"), "session-1");
});
