import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertExists } from "https://deno.land/std@0.210.0/assert/assert_exists.ts";

import {
  generateManifestFromParseResult,
  hydrateManifestForSource,
  resolveStoredManifestCoverage,
  upsertManifestUploadFile,
} from "./app-manifest-generation.ts";
import { buildJsonSchemaDescriptors } from "./codemode-tools.ts";
import { parseTypeScript } from "./parser.ts";
import { validateManifest } from "../../shared/contracts/manifest.ts";

Deno.test("manifest generation: uses entry filename when building contracts from source", async () => {
  const parseResult = await parseTypeScript(
    "export async function greet(name: string) { return `hi ${name}`; }",
    "functions.ts",
  );

  const manifest = generateManifestFromParseResult(
    { name: "Greeting App", slug: "greeting-app" },
    parseResult,
    "1.2.3",
    { entryFileName: "functions.ts" },
  );

  assertEquals(manifest.entry.functions, "functions.ts");
  assertExists(manifest.functions?.greet);
  assertExists(manifest.skills?.context);
  assertEquals(manifest.skills?.context.resource, "skills.md");
  assertEquals(manifest.version, "1.2.3");
});

Deno.test("manifest generation: preserves rich uploaded manifests and merges missing source functions", async () => {
  const hydrated = await hydrateManifestForSource({
    app: { name: "Planner", slug: "planner" },
    existingManifest: {
      name: "Planner",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "planner.ts" },
      access_policy: {
        mode: "module",
        module: "policy.ts",
        export: "planAccess",
      },
      functions: {
        listTasks: {
          description: "List all tasks",
        },
      },
    },
    sourceCode: [
      "export async function listTasks() { return []; }",
      "export async function addTask(title: string) { return { ok: true, title }; }",
    ].join("\n"),
    filename: "planner.ts",
    version: "2.0.0",
  });

  assertEquals(hydrated.source, "merged");
  assertEquals(hydrated.manifest.version, "2.0.0");
  assertEquals(
    hydrated.manifest.functions?.listTasks?.description,
    "List all tasks",
  );
  assertEquals(hydrated.manifest.access_policy?.module, "policy.ts");
  assertExists(hydrated.manifest.functions?.addTask);
});

Deno.test("manifest generation: external_functions survive regeneration when descriptions are weak", async () => {
  const externalFunctions = [
    { app: "email-ops", functions: ["listDrafts"], access: "read" as const },
  ];
  // Placeholder-style descriptions force the regenerate branch, which must
  // still carry forward the publisher's declared cross-Agent dependencies.
  const hydrated = await hydrateManifestForSource({
    app: { name: "Caller", slug: "caller" },
    existingManifest: {
      name: "Caller",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      external_functions: externalFunctions,
      functions: {
        run: { description: "Function run" },
      },
    },
    sourceCode: "export async function run() { return { ok: true }; }",
    filename: "index.ts",
    version: "2.0.0",
  });

  assertEquals(hydrated.source, "generated");
  assertEquals(hydrated.manifest.external_functions, externalFunctions);
});

Deno.test("manifest generation: external_functions survive full regeneration of non-mcp manifests", async () => {
  const externalFunctions = [
    { app: "crm", functions: ["logLead"] },
  ];
  const hydrated = await hydrateManifestForSource({
    app: { name: "Caller", slug: "caller" },
    existingManifest: {
      name: "Caller",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      external_functions: externalFunctions,
      // No functions map -> hydration falls through to full regeneration.
    },
    sourceCode: "export async function run() { return { ok: true }; }",
    filename: "index.ts",
    version: "2.0.0",
  });

  assertEquals(hydrated.manifest.external_functions, externalFunctions);
});

Deno.test("manifest generation: rebuilds stored manifest coverage from source when manifest.json is missing", async () => {
  const stored = await resolveStoredManifestCoverage({
    app: { name: "Search", slug: "search" },
    fetchTextFile: async (path) => {
      if (path.endsWith("_source_index.ts")) {
        return "export async function search(query: string) { return [{ query }]; }";
      }
      throw new Error(`missing: ${path}`);
    },
    storageKey: "apps/app-123/1.0.0/",
    version: "1.0.0",
  });

  assertEquals(stored.source, "generated");
  assertExists(stored.manifest?.functions?.search);
  assertExists(stored.manifestJson);
});

Deno.test("manifest generation: upsertManifestUploadFile replaces stale manifest payloads", () => {
  const files = upsertManifestUploadFile(
    [
      { name: "manifest.json", content: "old" },
      { name: "index.ts", content: "code" },
    ],
    {
      name: "Search",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: {
        search: { description: "Search things" },
      },
    },
    (manifestJson) => ({ name: "manifest.json", content: manifestJson }),
  );

  assertEquals(files.length, 2);
  assertEquals(files[1].name, "manifest.json");
  assertExists(files[1].content.includes('"search"'));
});

Deno.test("manifest validation: command cards are native, fixed-size, and read-only", () => {
  const valid = validateManifest({
    name: "Command Widgets",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: {
      widget_overview_ui: { description: "Render the full widget" },
      widget_overview_data: { description: "Fetch widget and card data" },
    },
    widgets: [
      {
        id: "overview",
        label: "Overview",
        cards: [
          {
            id: "queue",
            label: "Queue",
            size: "2x1",
            render: "native",
            data_view: "queue",
            dependencies: [{
              app: "email-ops",
              functions: ["list_drafts"],
              access: "read",
            }],
          },
        ],
      },
    ],
  });

  assertEquals(valid.valid, true);
  assertEquals(valid.errors, []);

  const invalid = validateManifest({
    name: "Command Widgets",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    widgets: [
      {
        id: "overview",
        label: "Overview",
        cards: [
          {
            id: "queue",
            label: "Queue",
            size: "wide",
            render: "iframe",
            dependencies: [{
              app: "email-ops",
              functions: ["send_email"],
              access: "write",
            }],
          },
        ],
      },
    ],
  });

  assertEquals(invalid.valid, false);
  assertEquals(
    invalid.errors.some((error) => error.path.endsWith(".size")),
    true,
  );
  assertEquals(
    invalid.errors.some((error) => error.path.endsWith(".render")),
    true,
  );
  assertEquals(
    invalid.errors.some((error) => error.path.endsWith(".access")),
    true,
  );
});

Deno.test("manifest validation: skills are first-class semantic context entries", () => {
  const valid = validateManifest({
    name: "Skillful App",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: {
      search: { description: "Search documents" },
    },
    skills: {
      context: {
        description: "Full operating context.",
        semantic_description: "How to use search for research workflows.",
        resource: "skills.md",
        format: "markdown",
      },
    },
  });

  assertEquals(valid.valid, true);

  const invalid = validateManifest({
    name: "Broken Skill App",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    skills: {
      context: {
        resource: 42,
        format: "pdf",
      },
    },
  });

  assertEquals(invalid.valid, false);
  assertEquals(
    invalid.errors.some((error) => error.path === "skills.context.description"),
    true,
  );
  assertEquals(
    invalid.errors.some((error) => error.path === "skills.context.resource"),
    true,
  );
  assertEquals(
    invalid.errors.some((error) => error.path === "skills.context.format"),
    true,
  );
});

Deno.test("manifest validation: access policy declares a safe versioned policy hook", () => {
  const valid = validateManifest({
    name: "Policy App",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: {
      search: { description: "Search documents" },
    },
    access_policy: {
      mode: "module",
      module: "policies/access-policy.ts",
      export: "planAccess",
    },
  });

  assertEquals(valid.valid, true);

  const invalid = validateManifest({
    name: "Broken Policy App",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    access_policy: {
      mode: "module",
      module: "../policy.ts",
      export: "plan-access",
    },
  });

  assertEquals(invalid.valid, false);
  assertEquals(
    invalid.errors.some((error) => error.path === "access_policy.module"),
    true,
  );
  assertEquals(
    invalid.errors.some((error) => error.path === "access_policy.export"),
    true,
  );
});

Deno.test("manifest validation: routine templates declare schedules, config, and capabilities", () => {
  const valid = validateManifest({
    name: "Routine Composer",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: {
      poll_email_followups: { description: "Poll inbox and draft follow-ups" },
    },
    routines: [{
      id: "sales_followup_loop",
      label: "Sales follow-up loop",
      description: "Polls email and composes reviewable follow-up drafts.",
      handler: "poll_email_followups",
      default_schedule: { every_minutes: 5 },
      config_schema: {
        mailbox: { type: "string", required: true },
        max_emails: { type: "number", default: 20 },
      },
      default_config: { max_emails: 20 },
      capabilities: [{
        app: "email-drafter",
        functions: ["draft_reply"],
        access: "write",
        purpose: "Create response drafts for review",
      }],
      budget_defaults: {
        max_light_per_run: 25,
        max_light_per_day: 500,
        max_calls_per_run: 10,
      },
      approval_policy: {
        require_user_approval: true,
        require_paid_capability_approval: true,
        require_external_side_effect_approval: true,
      },
      surfaces: {
        widgets: ["email_ops"],
        command_cards: [{ widget_id: "email_ops", card_id: "pending_drafts" }],
      },
    }],
  });

  assertEquals(valid.valid, true);
  assertEquals(valid.errors, []);

  const invalid = validateManifest({
    name: "Bad Routine",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    routines: [{
      id: "bad routine",
      label: "",
      handler: "not-a-function",
      default_schedule: { every_minutes: 0 },
      capabilities: [{
        app: "",
        functions: [],
        access: "admin",
      }],
      budget_defaults: { max_light_per_day: -1 },
      approval_policy: { require_user_approval: "yes" },
    }],
  });

  assertEquals(invalid.valid, false);
  assertEquals(
    invalid.errors.some((error) => error.path.endsWith(".id")),
    true,
  );
  assertEquals(
    invalid.errors.some((error) => error.path.endsWith(".handler")),
    true,
  );
  assertEquals(
    invalid.errors.some((error) =>
      error.path.endsWith(".default_schedule.every_minutes")
    ),
    true,
  );
  assertEquals(
    invalid.errors.some((error) => error.path.endsWith(".access")),
    true,
  );
  assertEquals(
    invalid.errors.some((error) =>
      error.path.endsWith(".budget_defaults.max_light_per_day")
    ),
    true,
  );
});

Deno.test("codemode descriptors: indexes routine templates alongside widgets", () => {
  const descriptors = buildJsonSchemaDescriptors([{
    id: "app-compose",
    name: "Routine Composer",
    slug: "routine-composer",
    manifest: {
      functions: {
        poll_email_followups: {
          description: "Poll inbox and draft follow-ups",
        },
      },
      routines: [{
        id: "sales_followup_loop",
        label: "Sales follow-up loop",
        handler: "poll_email_followups",
        default_schedule: "*/5 * * * *",
        capabilities: [{
          app: "email-drafter",
          functions: ["draft_reply"],
          access: "write",
        }],
      }],
    },
  }]);

  assertEquals(descriptors.routines.length, 1);
  assertEquals(descriptors.routines[0].id, "sales_followup_loop");
  assertEquals(descriptors.routines[0].appId, "app-compose");
  assertEquals(descriptors.routines[0].capabilities?.[0]?.access, "write");
});

Deno.test("codemode descriptors: indexes agentic widgets and context sources", () => {
  const descriptors = buildJsonSchemaDescriptors([{
    id: "app-email",
    name: "Email Ops",
    slug: "email-ops",
    manifest: {
      functions: {
        widget_email_inbox_ui: { description: "Render inbox widget" },
        widget_email_inbox_data: { description: "Load inbox widget" },
        conversations_list: {
          description: "List email conversations",
          generation_hints: {
            tags: ["email", "threads"],
            preferred_component: "table",
            entity_types: ["conversation"],
            safe_default_filters: { status: "active", limit: 10 },
            prompt_examples: ["show active guest conversations"],
          },
        },
      },
      context_sources: [{
        id: "recent_threads",
        label: "Recent threads",
        description: "Threads available to the inbox widget",
        type: "d1_table",
        access: "read",
        searchable: true,
        tables: ["conversations"],
        default_for_widgets: ["email_inbox"],
        generation_hints: {
          tags: ["email", "guest"],
          preferred_component: "table",
          entity_types: ["conversation"],
        },
      }],
      widgets: [{
        id: "email_inbox",
        label: "Email Inbox",
        agentic: true,
        context_sources: ["recent_threads"],
        generation_hints: {
          tags: ["email approvals"],
          preferred_component: "widget_embed",
          entity_types: ["conversation", "draft"],
        },
        cards: [{
          id: "drafts_queue",
          label: "Drafts Queue",
          size: "2x1",
          render: "native",
          kind: "list",
          generation_hints: {
            tags: ["approvals"],
            preferred_component: "table",
            suggested_components: [{
              kind: "detail",
              title: "Selected draft",
              description:
                "Show the selected draft and available review actions.",
            }],
          },
        }],
        agent_actions: [{
          id: "open_thread",
          label: "Open thread",
          mode: "ui",
          confirmation: "none",
          generation_hints: {
            action_group: "thread_navigation",
            tags: ["open", "thread"],
          },
        }],
      }],
    },
  }]);

  assertEquals(descriptors.widgets[0].agentic, true);
  assertEquals(descriptors.widgets[0].contextSources, ["recent_threads"]);
  assertEquals(
    descriptors.widgets[0].generationHints?.preferred_component,
    "widget_embed",
  );
  assertEquals(
    descriptors.widgets[0].cards[0].generationHints?.preferred_component,
    "table",
  );
  assertEquals(descriptors.widgets[0].agentActions?.[0]?.id, "open_thread");
  assertEquals(
    descriptors.widgets[0].agentActions?.[0]?.generation_hints?.action_group,
    "thread_navigation",
  );
  assertEquals(descriptors.contextSources.length, 1);
  assertEquals(descriptors.contextSources[0].appSlug, "email-ops");
  assertEquals(descriptors.contextSources[0].tables, ["conversations"]);
  assertEquals(descriptors.contextSources[0].defaultForWidgets, [
    "email_inbox",
  ]);
  assertEquals(descriptors.contextSources[0].generationHints?.entity_types, [
    "conversation",
  ]);
  assertEquals(
    descriptors.toolMap.email_ops_conversations_list?.generationHints
      ?.safe_default_filters,
    { status: "active", limit: 10 },
  );
});
