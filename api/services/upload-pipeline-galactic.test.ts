import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { processUploadPipeline } from "./upload-pipeline.ts";

const GALACTIC_YAML = `apiVersion: agents.connectgalactic.com/v1alpha1
kind: Agent
metadata:
  name: Counter
  version: 1.0.0
  description: Count one value
spec:
  functions:
    run:
      description: Return the supplied value
      parameters:
        value:
          type: number
          required: true
      authority:
        level: read
        effects: {}
  conformance:
    profile: basic
    cases:
      - id: returns-value
        function: run
        input:
          value: 1
`;

Deno.test({
  name:
    "upload pipeline compiles galactic.yaml into one derived runtime manifest",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const pipeline = await processUploadPipeline([
      {
        name: "index.ts",
        content:
          "export async function run(args: { value: number }) { return { value: args.value }; }",
      },
      { name: "galactic.yaml", content: GALACTIC_YAML },
    ], { strictBuild: true });

    assertEquals(pipeline.agentDocument?.sourceKind, "galactic_yaml");
    assertEquals(pipeline.exports, ["run"]);
    assert(pipeline.esmBundledCode);
    assertEquals(
      pipeline.filesToUpload.filter((file) => file.name === "manifest.json")
        .length,
      1,
    );
    assertEquals(
      pipeline.filesToUpload.filter((file) => file.name === "galactic.yaml")
        .length,
      1,
    );
    const derived = JSON.parse(
      new TextDecoder().decode(
        pipeline.filesToUpload.find((file) => file.name === "manifest.json")!
          .content,
      ),
    );
    assertEquals(derived.functions.run.authority, {
      level: "read",
      effects: {},
    });
  },
});

Deno.test({
  name:
    "upload pipeline resolves named re-exports and checks the prepared module graph",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const valid = await processUploadPipeline([
      {
        name: "index.ts",
        content: 'export { run } from "./run.ts";',
      },
      {
        name: "run.ts",
        content: "export async function run() { return 1; }",
      },
      { name: "galactic.yaml", content: GALACTIC_YAML },
    ], { strictBuild: true });
    assertEquals(valid.exports, ["run"]);

    await assertRejects(
      () =>
        processUploadPipeline([
          {
            name: "index.ts",
            content: 'export { run } from "./run.ts";',
          },
          {
            name: "run.ts",
            content:
              'export async function run() { return await fetch("https://example.com"); }',
          },
          { name: "galactic.yaml", content: GALACTIC_YAML },
        ], { strictBuild: true }),
      Error,
      "Prepared release uses runtime permissions not declared by galactic.yaml: net:fetch",
    );
  },
});

Deno.test({
  name:
    "upload pipeline rejects every dependency whose runtime bytes are outside the release",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const attempts: Array<Array<{ name: string; content: string }>> = [
      [{
        name: "index.ts",
        content:
          'import { value } from "https://example.com/live.js";\nexport async function run() { return value; }',
      }],
      [
        {
          name: "index.ts",
          content: 'export { run } from "./run.ts";',
        },
        {
          name: "run.ts",
          content:
            'import leftPad from "left-pad";\nexport async function run() { return leftPad("x", 2); }',
        },
      ],
      [{
        name: "index.ts",
        content:
          "export async function run(args: { module: string }) { return await import(args.module); }",
      }],
      [
        {
          name: "index.ts",
          content: 'export { run } from "./run.ts";',
        },
        {
          name: "run.ts",
          content:
            "export function run(args: { module: string }) { return require(args.module); }",
        },
      ],
      [{
        name: "index.ts",
        content:
          "const load = require;\nexport function run(args: { module: string }) { return load(args.module); }",
      }],
      [{
        name: "index.ts",
        content:
          "export function run(args: { module: string }) { return (globalThis as any).require(args.module); }",
      }],
    ];

    for (const files of attempts) {
      await assertRejects(
        () =>
          processUploadPipeline([
            ...files,
            { name: "galactic.yaml", content: GALACTIC_YAML },
          ], { strictBuild: true }),
        Error,
        "galactic.yaml releases must vendor every dependency",
      );
    }
  },
});

Deno.test({
  name:
    "upload pipeline rejects dual contracts and undeclared executable functions",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await assertRejects(
      () =>
        processUploadPipeline([
          {
            name: "index.ts",
            content: "export function run() { return 1; }",
          },
          { name: "galactic.yaml", content: GALACTIC_YAML },
          { name: "manifest.json", content: "{}" },
        ], { strictBuild: true }),
      Error,
      "do not author manifest.json alongside galactic.yaml",
    );

    await assertRejects(
      () =>
        processUploadPipeline([
          {
            name: "index.ts",
            content:
              "export function run() { return 1; }\nexport function hidden() { return 2; }",
          },
          { name: "galactic.yaml", content: GALACTIC_YAML },
        ], { strictBuild: true }),
      Error,
      "undeclared exports: hidden",
    );
  },
});

Deno.test({
  name:
    "upload pipeline never widens galactic.yaml authority from source inference",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await assertRejects(
      () =>
        processUploadPipeline([
          {
            name: "index.ts",
            content:
              'export async function run() { return await fetch("https://example.com"); }',
          },
          { name: "galactic.yaml", content: GALACTIC_YAML },
        ], { strictBuild: true }),
      Error,
      "Source uses runtime permissions not declared by galactic.yaml: net:fetch",
    );
  },
});
