import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import type { AgenticInterfaceSpec } from "../../shared/contracts/agentic-interface.ts";
import { flattenCommandSurfaceInventory } from "./command-surfaces.ts";
import {
  deleteAgenticInterface,
  getAgenticInterface,
  listAgenticInterfaces,
  normalizeInterfaceKey,
  saveAgenticInterface,
  updateAgenticInterface,
} from "./agentic-interface-storage.ts";
import type { FunctionIndex } from "./function-index.ts";

const fnIndex: FunctionIndex = {
  functions: {
    email_ops_list_approvals: {
      appId: "app-email",
      appSlug: "email-ops",
      fnName: "list_approvals",
      description: "List pending email approvals",
      params: {},
      returns: "Approval[]",
      conventions: [],
      dependsOn: [],
    },
    email_ops_send_approval: {
      appId: "app-email",
      appSlug: "email-ops",
      fnName: "send_approval",
      description: "Send approval",
      params: { approval_id: { type: "string", required: true } },
      returns: "Approval",
      conventions: [],
      dependsOn: [],
    },
  },
  widgets: [],
  contextSources: [],
  routines: [],
  types: "",
  updatedAt: "2026-05-27T00:00:00.000Z",
};

const inventory = flattenCommandSurfaceInventory(fnIndex);

function approvalSpec(overrides: Partial<AgenticInterfaceSpec> = {}): AgenticInterfaceSpec {
  return {
    id: "email_interface",
    title: "Email Approvals",
    description: "Review approvals",
    mode: "temporary",
    data_bindings: [{
      id: "approvals",
      source: "mcp_read_function",
      app_id: "app-email",
      app_slug: "email-ops",
      function_name: "list_approvals",
    }],
    actions: [{
      id: "send",
      kind: "mcp_function",
      label: "Send",
      mode: "write",
      confirmation: "user",
      app_id: "app-email",
      app_slug: "email-ops",
      function_name: "send_approval",
    }],
    components: [{
      id: "approval_table",
      kind: "table",
      title: "Approvals",
      data_binding_id: "approvals",
      action_ids: ["send"],
    }],
    provenance: { prompt: "approval workspace" },
    ...overrides,
  };
}

Deno.test("agentic interface storage: normalizes interface keys", () => {
  assertEquals(normalizeInterfaceKey("approval_workspace"), "approval_workspace");
  assertThrows(
    () => normalizeInterfaceKey("Approval Workspace!"),
    Error,
    "interface_key",
  );
});

Deno.test("agentic interface storage: saves verified specs as saved interfaces", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  const calls: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = [];
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: input.toString(), init, body });
    return new Response(
      JSON.stringify([{
        id: "interface-row-1",
        interface_key: body?.interface_key,
        title: body?.title,
        description: body?.description,
        icon: body?.icon,
        spec: body?.spec,
        source_prompt: body?.source_prompt,
        mode: body?.mode,
        status: body?.status,
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      }]),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await saveAgenticInterface("user-1", {
      spec: approvalSpec(),
      title: "Approvals",
      icon: "mail-check",
    }, {
      getFunctionIndex: () => Promise.resolve(fnIndex),
      getCommandSurfaceInventory: () => Promise.resolve(inventory),
      now: () => new Date("2026-05-27T01:00:00.000Z"),
    });

    assertEquals(result.interface_key, "approvals");
    assertEquals(result.normalized_spec.mode, "saved");
    assertEquals(result.component_count, 1);
    assertEquals(result.action_count, 1);
    assertEquals(result.source_prompt, "approval workspace");
    assertEquals(calls.length, 1);
    assertEquals((calls[0].body?.spec as AgenticInterfaceSpec).mode, "saved");
    assertEquals(
      (calls[0].body?.spec as AgenticInterfaceSpec).components.length,
      result.component_count,
    );
    assertEquals(calls[0].body?.deleted_at, null);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("agentic interface storage: list summarizes saved specs without loading full verification", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([{
        id: "interface-row-1",
        interface_key: "approvals",
        title: "Approvals",
        description: null,
        icon: "mail-check",
        spec: approvalSpec({ mode: "saved" }),
        source_prompt: "approval workspace",
        mode: "saved",
        status: "active",
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      }]),
      { headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    const result = await listAgenticInterfaces("user-1");
    assertEquals(result.interfaces[0].interface_key, "approvals");
    assertEquals(result.interfaces[0].component_count, 1);
    assertEquals(result.interfaces[0].action_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("agentic interface storage: get re-verifies saved specs against current capabilities", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([{
        id: "interface-row-1",
        interface_key: "approvals",
        title: "Approvals",
        description: null,
        icon: "mail-check",
        spec: approvalSpec({
          actions: [{
            id: "send",
            kind: "mcp_function",
            label: "Send",
            mode: "write",
            confirmation: "user",
            app_id: "app-email",
            app_slug: "email-ops",
            function_name: "missing_function",
          }],
        }),
        source_prompt: "approval workspace",
        mode: "saved",
        status: "active",
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      }]),
      { headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    const result = await getAgenticInterface("user-1", "approvals", {
      getFunctionIndex: () => Promise.resolve(fnIndex),
      getCommandSurfaceInventory: () => Promise.resolve(inventory),
    });
    assertEquals(result.normalized_spec.actions ?? [], []);
    assertEquals(result.dropped[0].reason, "unknown MCP function");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("agentic interface storage: updates metadata while preserving verified specs", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  const calls: Array<{ method: string; body?: Record<string, unknown> }> = [];
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, body });
    const hasBodyField = (field: string) =>
      Object.prototype.hasOwnProperty.call(body ?? {}, field);
    const spec = approvalSpec({ mode: "saved" });
    return new Response(
      JSON.stringify([{
        id: "interface-row-1",
        interface_key: "approvals",
        title: hasBodyField("title") ? body?.title : "Approvals",
        description: hasBodyField("description")
          ? body?.description
          : "Existing description",
        icon: hasBodyField("icon") ? body?.icon : "mail-check",
        spec: body?.spec ?? spec,
        source_prompt: hasBodyField("source_prompt")
          ? body?.source_prompt
          : "approval workspace",
        mode: "saved",
        status: hasBodyField("status") ? body?.status : "active",
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      }]),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await updateAgenticInterface("user-1", "approvals", {
      title: "Renamed Approvals",
      description: null,
    }, {
      getFunctionIndex: () => Promise.resolve(fnIndex),
      getCommandSurfaceInventory: () => Promise.resolve(inventory),
      now: () => new Date("2026-05-27T01:00:00.000Z"),
    });

    assertEquals(result.title, "Renamed Approvals");
    assertEquals(result.description, null);
    assertEquals(calls.map((call) => call.method), ["GET", "PATCH"]);
    assertEquals(calls[1].body?.description, null);
    assertEquals(calls[1].body?.mode, "saved");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("agentic interface storage: delete archives saved interfaces", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  const calls: Array<{ body?: Record<string, unknown> }> = [];
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const result = await deleteAgenticInterface("user-1", "approvals", {
      now: () => new Date("2026-05-27T01:00:00.000Z"),
    });
    assertEquals(result, { ok: true, interface_key: "approvals" });
    assertEquals(calls[0].body, {
      status: "archived",
      deleted_at: "2026-05-27T01:00:00.000Z",
      updated_at: "2026-05-27T01:00:00.000Z",
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});
