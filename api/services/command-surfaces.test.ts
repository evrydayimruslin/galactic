import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import type { FunctionIndex } from "./function-index.ts";
import {
  buildCommandDashboardBlueprintFromInventory,
  buildCommandSurfacesFromApps,
  flattenCommandSurfaceInventory,
  normalizeCommandSurfaceKinds,
} from "./command-surfaces.ts";

const fnIndex: FunctionIndex = {
  functions: {},
  widgets: [{
    name: "email_ops",
    label: "Email Ops",
    description: "Review and triage inbox work",
    appId: "app-email",
    appSlug: "email-ops",
    appName: "Email Ops",
    uiFunction: "widget_email_ops_ui",
    dataFunction: "widget_email_ops_data",
    dependencies: [{
      app: "calendar",
      functions: ["list_events"],
      access: "read",
    }],
    generationHints: {
      tags: ["backoffice"],
      preferred_component: "widget_embed",
      entity_types: ["conversation"],
    },
    cards: [{
      id: "drafts_queue",
      label: "Drafts Queue",
      description: "Drafts awaiting review",
      size: "2x1",
      render: "native",
      kind: "metric",
      dataView: "drafts",
      refreshIntervalS: 60,
    }, {
      id: "urgent_threads",
      label: "Urgent Threads",
      size: "2x2",
      render: "native",
      kind: "list",
      dataFunction: "widget_email_urgent_data",
      dependencies: [{
        app: "crm",
        functions: ["list_accounts"],
        access: "read",
      }],
      generationHints: {
        tags: ["vip escalation"],
        preferred_component: "table",
        entity_types: ["conversation"],
        prompt_examples: ["review priority guest approvals"],
      },
    }],
  }, {
    name: "fitness",
    label: "Fitness",
    appId: "app-fit",
    appSlug: "fitness",
    appName: "Fitness",
    uiFunction: "widget_fitness_ui",
    dataFunction: "widget_fitness_data",
    cards: [{
      id: "steps_today",
      label: "Steps Today",
      size: "1x1",
      render: "native",
      kind: "progress",
    }],
  }],
  contextSources: [],
  routines: [],
  types: "",
  updatedAt: "2026-05-11T00:00:00Z",
};

Deno.test("command surfaces: flattens widget and card inventory", () => {
  const inventory = flattenCommandSurfaceInventory(fnIndex);

  assertEquals(inventory.totals, {
    widgets: 2,
    command_cards: 3,
    apps: 2,
  });
  assertEquals(inventory.surfaces.map((surface) => surface.surface), [
    "command_card",
    "command_card",
    "command_card",
    "widget",
    "widget",
  ]);

  const urgent = inventory.surfaces.find((surface) =>
    surface.surface === "command_card" && surface.card_id === "urgent_threads"
  );
  assertEquals(urgent?.surface, "command_card");
  if (urgent?.surface === "command_card") {
    assertEquals(urgent.data_function, "widget_email_urgent_data");
    assertEquals(urgent.dependencies?.length, 2);
    assertEquals(urgent.generation_hints?.preferred_component, "table");
  }
});

Deno.test("command surfaces: filters command cards by natural language query", () => {
  const inventory = flattenCommandSurfaceInventory(fnIndex, {
    query: "fitness steps",
    surfaces: ["command_card"],
  });

  assertEquals(inventory.surfaces.length, 1);
  const [surface] = inventory.surfaces;
  assertEquals(surface.surface, "command_card");
  if (surface.surface === "command_card") {
    assertEquals(surface.card_id, "steps_today");
  }
});

Deno.test("command surfaces: searches and returns generation hints", () => {
  const inventory = flattenCommandSurfaceInventory(fnIndex, {
    query: "vip escalation",
    surfaces: ["command_card"],
  });

  assertEquals(inventory.surfaces.length, 1);
  const [surface] = inventory.surfaces;
  assertEquals(surface.surface, "command_card");
  if (surface.surface === "command_card") {
    assertEquals(surface.card_id, "urgent_threads");
    assertEquals(surface.generation_hints?.entity_types, ["conversation"]);
  }
});

Deno.test("command surfaces: scopes inventory to a specific app", () => {
  const inventory = flattenCommandSurfaceInventory(fnIndex, {
    app_scope: { app_slugs: ["fitness"] },
  });

  assertEquals(inventory.totals, {
    widgets: 2,
    command_cards: 3,
    apps: 2,
  });
  assertEquals(inventory.surfaces.map((surface) => surface.app_slug), [
    "fitness",
    "fitness",
  ]);
});

Deno.test("command surfaces: builds a packed dashboard blueprint", () => {
  const inventory = flattenCommandSurfaceInventory(fnIndex, {
    query: "email review",
    surfaces: ["command_card"],
  });
  const blueprint = buildCommandDashboardBlueprintFromInventory(inventory, {
    title: "Work",
    limit: 2,
  });

  assertEquals(blueprint.dashboard_key, "work");
  assertEquals(blueprint.layout.cards.length, 2);
  assertEquals(blueprint.layout.cards[0].position, { x: 0, y: 0 });
  assertEquals(blueprint.layout.cards[1].position, { x: 2, y: 0 });
  assertEquals(blueprint.cards[0].app_name, "Email Ops");
  assertEquals(blueprint.unmatched, []);
});

Deno.test("command surfaces: reads cards from app manifests", () => {
  const inventory = buildCommandSurfacesFromApps([{
    id: "app-calendar",
    name: "Calendar",
    slug: "calendar",
    manifest: {
      widgets: [{
        id: "calendar_home",
        label: "Calendar Home",
        ui_function: "widget_calendar_ui",
        data_function: "widget_calendar_data",
        cards: [{
          id: "up_next",
          label: "Up Next",
          description: "Upcoming meetings",
          size: "2x1",
          render: "native",
          kind: "timeline",
        }],
      }],
    },
  }], { surfaces: ["command_card"] });

  assertEquals(inventory.totals.command_cards, 1);
  const [surface] = inventory.surfaces;
  assertEquals(surface.surface, "command_card");
  if (surface.surface === "command_card") {
    assertEquals(surface.source, "appstore");
    assertEquals(surface.data_function, "widget_calendar_data");
  }
});

Deno.test("command surfaces: ignores non-command surface names", () => {
  assertEquals(
    normalizeCommandSurfaceKinds(["function", "command_card", "nonsense"]),
    ["command_card"],
  );
});
