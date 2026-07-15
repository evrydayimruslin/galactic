// The interface scaffold's whole value is that it emits a DEPLOYABLE UI in one
// command. These pin that: the manifest it generates passes the real validator,
// the interfaces[] entry is well-formed, and the emitted main.html carries the
// call bridge — so "give my agent a UI" produces a running page, not boilerplate
// to transcribe.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { executeScaffold } from "./platform-mcp.ts";
import { validateManifest } from "../../shared/contracts/manifest.ts";

type ScaffoldResult = {
  files: Array<{ path: string; content: string }>;
  next_steps: string[];
};

function scaffold(withInterface: boolean): ScaffoldResult {
  return executeScaffold({
    name: "Weather Bot",
    description: "Answers weather questions.",
    functions: [
      { name: "forecast", description: "Get the forecast" },
      { name: "alerts", description: "Get active alerts" },
    ],
    storage: "none",
    interface: withInterface,
  }) as ScaffoldResult;
}

Deno.test("scaffold interface: opt-in — no interface files unless requested", () => {
  const files = scaffold(false).files.map((f) => f.path);
  assert(!files.includes("interfaces/main.html"), "no UI when interface:false");
  const manifest = JSON.parse(
    scaffold(false).files.find((f) => f.path === "manifest.json")!.content,
  );
  assertEquals(manifest.interfaces, undefined);
});

Deno.test("scaffold interface: emits a running main.html with the bridge", () => {
  const result = scaffold(true);
  const html = result.files.find((f) => f.path === "interfaces/main.html");
  assert(html, "interfaces/main.html is emitted");
  // The bridge + a live call to the first function must be present.
  assert(html!.content.includes("ul-interface-connect"), "has the bridge handshake");
  assert(html!.content.includes('window.ul.call("forecast"'), "calls the first function");
  assert(html!.content.includes("<!doctype html>"), "is a full HTML document");
});

Deno.test("scaffold interface: the generated manifest PASSES the real validator", () => {
  const manifest = JSON.parse(
    scaffold(true).files.find((f) => f.path === "manifest.json")!.content,
  );
  // interfaces[] entry is well-formed and allowlists the real functions.
  assertEquals(manifest.interfaces.length, 1);
  assertEquals(manifest.interfaces[0].id, "main");
  assertEquals(manifest.interfaces[0].entry, "interfaces/main.html");
  assertEquals(manifest.interfaces[0].functions, ["forecast", "alerts"]);

  const result = validateManifest(manifest);
  assertEquals(
    result.errors,
    [],
    "scaffolded manifest must be deployable (no validation errors)",
  );
});

Deno.test("scaffold interface: adds an edit-the-UI next step", () => {
  const steps = scaffold(true).next_steps.join("\n");
  assert(/interfaces\/main\.html/.test(steps), "next steps point at the UI file");
  assert(
    steps.includes("test_attestation: tested.test_attestation"),
    "generic scaffold carries successful gx.test proof into gx.upload",
  );
});
