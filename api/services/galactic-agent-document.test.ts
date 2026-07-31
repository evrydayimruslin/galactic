// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertMatch,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  compileGalacticAgentYaml,
  GALACTIC_AGENT_API_VERSION,
  GALACTIC_STABLE_EFFECT_IDS,
  GalacticAgentDocumentError,
  type GalacticAgentDocumentErrorCode,
  resolveGalacticAgentDocument,
} from "./galactic-agent-document.ts";

function baseYaml(options: {
  requiredLine?: string;
  rootExtension?: string;
  effectLines?: string;
  spendLines?: string;
  destination?: string;
  credentialDestination?: string;
} = {}): string {
  const requiredLine = options.requiredLine === undefined
    ? ""
    : `        required: ${options.requiredLine}\n`;
  const rootExtension = options.rootExtension
    ? `${options.rootExtension}\n`
    : "";
  const effectLines = options.effectLines ??
    [
      "          storage.read: free",
      "          routine.read: free",
      "          inference.generate: ask",
      "          email.smtp.send: ask",
    ].join("\n");
  const spendLines = options.spendLines === undefined
    ? "      spend:\n        inference: ask\n"
    : options.spendLines;
  const destination = options.destination ?? "smtp.example.com:465";
  const credentialDestination = options.credentialDestination ?? destination;

  return `apiVersion: ${GALACTIC_AGENT_API_VERSION}
kind: Agent
metadata:
  name: Mail Helper
  version: 1.2.3
  description: Safely triage a mailbox
  parentReleaseDigest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
spec:
  entry:
    functions: index.ts
  functions:
    triage:
      description: Triage one mailbox
      parameters:
        mailbox:
          type: string
          required: true
      authority:
        level: external_write
        effects:
${effectLines}
${spendLines}  network:
    allowed_destinations:
      - ${destination}
  env_vars:
    SMTP_TOKEN:
      required: true
      scope: per_user
      credential:
        destination: ${credentialDestination}
        inject:
          as: bearer
  conformance:
    profile: basic
    cases:
      - id: triage-basic
        function: triage
        input:
          mailbox: inbox
${requiredLine}${rootExtension}`;
}

async function expectDocumentError(
  operation: () => Promise<unknown>,
  code: GalacticAgentDocumentErrorCode,
  path?: string,
): Promise<GalacticAgentDocumentError> {
  try {
    await operation();
  } catch (error) {
    assertInstanceOf(error, GalacticAgentDocumentError);
    assertEquals(error.code, code);
    if (path) assertEquals(error.path, path);
    return error;
  }
  throw new Error(`Expected ${code}`);
}

Deno.test("galactic document: stable effect catalog is exact", () => {
  assertEquals(GALACTIC_STABLE_EFFECT_IDS, [
    "storage.read",
    "storage.write",
    "storage.delete",
    "database.read",
    "database.write",
    "memory.read",
    "memory.write",
    "routine.read",
    "notification.owner.write",
    "inference.generate",
    "inference.embed",
    "compute.execute",
    "network.http",
    "network.tcp",
    "credential.http",
    "email.imap.read",
    "email.smtp.send",
    "event.publish",
    "agent.call",
  ]);
});

Deno.test("galactic document: compiles identity, authority, permissions, and cases", async () => {
  const result = await compileGalacticAgentYaml(baseYaml());

  assertEquals(result.sourceKind, "galactic_yaml");
  assertEquals(result.document?.metadata.name, "Mail Helper");
  assertEquals(result.document?.metadata.version, "1.2.3");
  assertEquals(result.functions, ["triage"]);
  assertEquals(result.effects, [
    "email.smtp.send",
    "inference.generate",
    "routine.read",
    "storage.read",
  ]);
  assertEquals(result.effectsByFunction, {
    triage: [
      "email.smtp.send",
      "inference.generate",
      "routine.read",
      "storage.read",
    ],
  });
  assertEquals(result.cases[0].required, true);
  assertEquals(result.compiledManifest.permissions, [
    "ai:call",
    "net:connect",
    "storage:read",
  ]);
  assertEquals(result.compiledManifest.flight_recorder, true);
  assertEquals(
    result.compiledManifest.functions?.triage.uses_inference,
    true,
  );
  assertEquals(
    result.compiledManifest.functions?.triage.uses_compute,
    undefined,
  );
  assertEquals(
    (result.compiledManifest.functions?.triage as unknown as Record<
      string,
      unknown
    >)
      .authority,
    {
      level: "external_write",
      effects: {
        "email.smtp.send": "ask",
        "inference.generate": "ask",
        "routine.read": "free",
        "storage.read": "free",
      },
    },
  );
  assertMatch(result.documentDigest, /^[a-f0-9]{64}$/);
});

Deno.test("galactic document: normalizes exact raw and credential HTTP fixtures", async () => {
  const source = baseYaml({
    effectLines: [
      "          network.http: free",
      "          credential.http: ask",
    ].join("\n"),
    spendLines: "",
  }).replace(
    `        input:
          mailbox: inbox
`,
    `        input:
          mailbox: inbox
        fixtures:
          http:
            - id: raw-status
              kind: raw
              request:
                method: get
                url: HTTPS://SMTP.EXAMPLE.COM:443/v1/status
              response:
                status: 200
                headers:
                  Content-Type: application/json
                  X-Fixture: " ready "
                body_text: '{"ok":true}'
            - id: credential-status
              kind: credential
              credential_key: SMTP_TOKEN
              request:
                method: post
                url: https://smtp.example.com/v1/status
                body_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
              response:
                status: 201
                headers: {}
                body_base64: AAEC/w==
`,
  );

  const result = await compileGalacticAgentYaml(source);
  assertEquals(result.cases[0].fixtures?.http, [
    {
      id: "raw-status",
      kind: "raw",
      request: {
        method: "GET",
        url: "https://smtp.example.com/v1/status",
      },
      response: {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-fixture": "ready",
        },
        body_text: '{"ok":true}',
      },
    },
    {
      id: "credential-status",
      kind: "credential",
      credential_key: "SMTP_TOKEN",
      request: {
        method: "POST",
        url: "https://smtp.example.com/v1/status",
        body_sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      response: {
        status: 201,
        headers: {},
        body_base64: "AAEC/w==",
      },
    },
  ]);
});

Deno.test("galactic document: HTTP fixture normalization is digest-bound", async () => {
  const withFixture = (body: string, canonical = false) =>
    baseYaml({
      effectLines: "          network.http: free",
      spendLines: "",
    }).replace(
      `        input:
          mailbox: inbox
`,
      `        input:
          mailbox: inbox
        fixtures:
          http:
            - id: raw-status
              kind: raw
              request:
                method: ${canonical ? "GET" : "get"}
                url: ${
        canonical
          ? "https://smtp.example.com/v1/status"
          : "HTTPS://SMTP.EXAMPLE.COM:443/v1/status"
      }
              response:
                status: 200
                headers:
                  ${
        canonical ? "content-type" : "Content-Type"
      }: application/json
                body_text: '${body}'
`,
    );

  const authored = await compileGalacticAgentYaml(
    withFixture('{"ok":true}'),
  );
  const equivalent = await compileGalacticAgentYaml(
    withFixture('{"ok":true}', true),
  );
  const changedResponse = await compileGalacticAgentYaml(
    withFixture('{"ok":false}', true),
  );

  assertEquals(equivalent.normalizedJson, authored.normalizedJson);
  assertEquals(equivalent.documentDigest, authored.documentDigest);
  assert(authored.documentDigest !== changedResponse.documentDigest);
});

Deno.test("galactic document: rejects malformed HTTP fixtures at the case path", async () => {
  const source = baseYaml({
    effectLines: "          network.http: free",
    spendLines: "",
  }).replace(
    `        input:
          mailbox: inbox
`,
    `        input:
          mailbox: inbox
        fixtures:
          http:
            - id: raw-status
              kind: raw
              request:
                method: GET
                url: https://smtp.example.com/v1/status
                wildcard: true
              response:
                status: 200
                headers: {}
                body_text: ok
`,
  );

  const error = await expectDocumentError(
    () => compileGalacticAgentYaml(source),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.conformance.cases[0].fixtures.http",
  );
  assert(error.message.includes("request.wildcard is not supported"));
});

Deno.test("galactic document: canonical digest ignores YAML key order, comments, and explicit true default", async () => {
  const first = await compileGalacticAgentYaml(baseYaml());
  const second = await compileGalacticAgentYaml(`# equivalent authored form
kind: Agent
apiVersion: ${GALACTIC_AGENT_API_VERSION}
metadata:
  version: 1.2.3
  name: Mail Helper
  parentReleaseDigest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  description: Safely triage a mailbox
spec:
  conformance:
    cases:
      - required: true
        input: { mailbox: inbox }
        function: triage
        id: triage-basic
    profile: basic
  env_vars:
    SMTP_TOKEN:
      credential:
        inject: { as: bearer }
        destination: smtp.example.com:465
      scope: per_user
      required: true
  network:
    allowed_destinations: [smtp.example.com:465]
  functions:
    triage:
      spend: { inference: ask }
      authority:
        effects:
          email.smtp.send: ask
          inference.generate: ask
          routine.read: free
          storage.read: free
        level: external_write
      parameters:
        mailbox: { required: true, type: string }
      description: Triage one mailbox
  entry: { functions: index.ts }
`);

  assertEquals(second.normalizedJson, first.normalizedJson);
  assertEquals(second.documentDigest, first.documentDigest);
  assertEquals(
    first.documentDigest,
    "577edf60b5e8f95b10fb5472ffa76e561fd1ff2a97d7e518ce78119b3bd3140b",
  );
});

Deno.test("galactic document: resolves exact root, rejects nested and dual contracts, preserves legacy", async () => {
  const root = await resolveGalacticAgentDocument([
    { path: "galactic.yaml", content: baseYaml() },
    { path: "index.ts", content: "export function triage() {}" },
  ]);
  assertEquals(root?.sourceKind, "galactic_yaml");

  await expectDocumentError(
    () =>
      resolveGalacticAgentDocument([
        { path: "project/galactic.yaml", content: baseYaml() },
      ]),
    "GALACTIC_DOCUMENT_NOT_ROOT",
    "project/galactic.yaml",
  );
  await expectDocumentError(
    () =>
      resolveGalacticAgentDocument([
        { path: "galactic.yaml", content: baseYaml() },
        { path: "project/manifest.json", content: "{}" },
      ]),
    "GALACTIC_DOCUMENT_AMBIGUOUS",
    "project/manifest.json",
  );

  const legacy = await resolveGalacticAgentDocument([
    {
      path: "project/manifest.json",
      content: JSON.stringify({
        name: "Legacy",
        version: "1.0.0",
        type: "mcp",
        entry: { functions: "index.ts" },
        functions: { run: { description: "Run" } },
      }),
    },
  ]);
  assertEquals(legacy?.sourceKind, "legacy_manifest");
  assertEquals(legacy?.document, null);
  assertEquals(legacy?.functions, ["run"]);
  assertEquals(legacy?.cases, []);
});

Deno.test("galactic document: rejects oversized and multidocument YAML", async () => {
  await expectDocumentError(
    () => compileGalacticAgentYaml("a".repeat(128 * 1024 + 1)),
    "GALACTIC_DOCUMENT_TOO_LARGE",
  );
  await expectDocumentError(
    () => compileGalacticAgentYaml(`${baseYaml()}\n---\nkind: Agent\n`),
    "GALACTIC_DOCUMENT_PARSE_ERROR",
  );
});

Deno.test("galactic document: rejects duplicate keys, anchors, aliases, merges, and explicit tags", async () => {
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace(
          "kind: Agent",
          "kind: Agent\nkind: Agent",
        ),
      ),
    "GALACTIC_DOCUMENT_PARSE_ERROR",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace("name: Mail Helper", "name: &agent Mail Helper"),
      ),
    "GALACTIC_DOCUMENT_UNSAFE_YAML",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace(
          "description: Safely triage a mailbox",
          "description: &desc Safe\n  author: *desc",
        ),
      ),
    "GALACTIC_DOCUMENT_UNSAFE_YAML",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace(
          "  description: Safely triage a mailbox",
          "  <<: {}\n  description: Safely triage a mailbox",
        ),
      ),
    "GALACTIC_DOCUMENT_UNSAFE_YAML",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace("name: Mail Helper", "name: !!str Mail Helper"),
      ),
    "GALACTIC_DOCUMENT_UNSAFE_YAML",
  );
});

Deno.test("galactic document: rejects non-string keys and non-finite numbers", async () => {
  await expectDocumentError(
    () => compileGalacticAgentYaml("? [a, b]\n: value\n"),
    "GALACTIC_DOCUMENT_PARSE_ERROR",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace("version: 1.2.3", "version: .inf"),
      ),
    "GALACTIC_DOCUMENT_UNSAFE_YAML",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace(
          "description: Safely triage a mailbox",
          'description: "\\uD800"',
        ),
      ),
    "GALACTIC_DOCUMENT_UNSAFE_YAML",
  );
});

Deno.test("galactic document: enforces YAML depth and node budgets", async () => {
  const nested = `value: ${"{ value: ".repeat(33)}ok${" }".repeat(33)}\n`;
  await expectDocumentError(
    () => compileGalacticAgentYaml(nested),
    "GALACTIC_DOCUMENT_UNSAFE_YAML",
  );

  const manyNodes = `values:\n${"  - 0\n".repeat(10_001)}`;
  await expectDocumentError(
    () => compileGalacticAgentYaml(manyNodes),
    "GALACTIC_DOCUMENT_UNSAFE_YAML",
  );
});

Deno.test("galactic document: rejects unknown standard keys and retains x-* extensions", async () => {
  await expectDocumentError(
    () => compileGalacticAgentYaml(`${baseYaml()}\nunknown: true\n`),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "$.unknown",
  );

  const result = await compileGalacticAgentYaml(
    `${baseYaml()}\nx-vendor:\n  mode: audited\n`,
  );
  assertEquals(
    (result.document as unknown as Record<string, unknown>)["x-vendor"],
    { mode: "audited" },
  );
});

Deno.test("galactic document: rejects unknown fields recursively", async () => {
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace(
          "      description: Triage one mailbox",
          `      description: Triage one mailbox
      execution:
        class: async
        timeout_milliseconds: 1000`,
        ),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.functions.triage.execution.timeout_milliseconds",
  );

  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace(
          "          required: true",
          "          required: true\n          descriptino: mailbox name",
        ),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.functions.triage.parameters.mailbox.descriptino",
  );

  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace(
          `      parameters:
        mailbox:
          type: string
          required: true`,
          `      parameters:
        - name: mailbox
          type: string
          requird: true`,
        ),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.functions.triage.parameters",
  );
});

Deno.test("galactic document: rejects D1 response and request typos", async () => {
  const withDatabaseFixture = (response: string) =>
    baseYaml({
      effectLines: "          database.read: free",
      spendLines: "",
    }).replace(
      `        input:
          mailbox: inbox
`,
      `        input:
          mailbox: inbox
        fixtures:
          database:
            responses:
${response}
`,
    );

  const responseTypo = await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        withDatabaseFixture(`              - method: select
                table: messages
                results: []`),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.conformance.cases[0].fixtures.database",
  );
  assert(
    responseTypo.message.includes(
      "d1_fixtures.responses[0].results is not supported",
    ),
  );

  const requestTypo = await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        withDatabaseFixture(`              - method: select
                table: messages
                when:
                  wheree:
                    status: unread
                result: []`),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.conformance.cases[0].fixtures.database",
  );
  assert(
    requestTypo.message.includes(
      "d1_fixtures.responses[0].when.wheree is not supported",
    ),
  );
});

Deno.test("galactic document: fixture env must name declared ordinary variables", async () => {
  const withFixtureEnv = (envDeclaration: string, key = "MODE") =>
    baseYaml().replace(
      `  env_vars:
    SMTP_TOKEN:`,
      `  env_vars:
${envDeclaration}
    SMTP_TOKEN:`,
    ).replace(
      `        input:
          mailbox: inbox
`,
      `        input:
          mailbox: inbox
        fixtures:
          env:
            ${key}: test
`,
    );

  const accepted = await compileGalacticAgentYaml(
    withFixtureEnv(`    MODE:
      scope: universal
      input: text
`),
  );
  assertEquals(accepted.cases[0].fixtures?.env, { MODE: "test" });

  await expectDocumentError(
    () => compileGalacticAgentYaml(withFixtureEnv("", "UNDECLARED")),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.conformance.cases[0].fixtures.env.UNDECLARED",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        withFixtureEnv(`    MODE:
      scope: per_user
      input: password
`),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.conformance.cases[0].fixtures.env.MODE",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        withFixtureEnv(
          `    SERVICE_TOKEN:
      scope: per_user
`,
          "SERVICE_TOKEN",
        ),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.conformance.cases[0].fixtures.env.SERVICE_TOKEN",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        withFixtureEnv(`    MODE:
      scope: per_user
      credential:
        destination: smtp.example.com:465
        inject:
          as: bearer
`),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.conformance.cases[0].fixtures.env.MODE",
  );
});

Deno.test("galactic document: password and credential variables cannot author defaults", async () => {
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace(
          `    SMTP_TOKEN:
      required: true`,
          `    SMTP_TOKEN:
      required: true
      default: not-a-real-token`,
        ),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.env_vars.SMTP_TOKEN.default",
  );

  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace(
          `  env_vars:
    SMTP_TOKEN:`,
          `  env_vars:
    SERVICE_TOKEN:
      required: true
      default: not-a-real-token
    SMTP_TOKEN:`,
        ),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.env_vars.SERVICE_TOKEN.default",
  );
});

Deno.test("galactic document: validates conformance bounds, IDs, references, and required cases", async () => {
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml()
          .replace("    triage:", "    triage-agent:")
          .replace("function: triage", "function: triage-agent"),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.functions.triage-agent",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace("id: triage-basic", "id: 7-bad"),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace("function: triage", "function: absent"),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
  );
  await expectDocumentError(
    () => compileGalacticAgentYaml(baseYaml({ requiredLine: "false" })),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.conformance.cases",
  );

  const duplicate = baseYaml().replace(
    "      - id: triage-basic",
    `      - id: triage-basic
        function: triage
      - id: triage-basic`,
  );
  await expectDocumentError(
    () => compileGalacticAgentYaml(duplicate),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
  );

  const cases = Array.from(
    { length: 17 },
    (_, index) => `      - id: case-${index}\n        function: triage`,
  ).join("\n");
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace(
          /[ ]{6}- id: triage-basic[\s\S]*$/,
          `${cases}\n`,
        ),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.conformance.cases",
  );
});

Deno.test("galactic document: validates authority effects and spend dimensions", async () => {
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml({
          effectLines: "          email.teleport: ask",
          spendLines: "",
        }),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml({
          effectLines: "          storage.read: maybe",
          spendLines: "",
        }),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml({
          effectLines: "          storage.read: free",
          spendLines: "      spend:\n        inference: ask\n",
        }),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.functions.triage.spend.inference",
  );
  await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml().replace(
          "level: external_write",
          "level: read",
        ),
      ),
    "GALACTIC_DOCUMENT_SCHEMA_ERROR",
    "spec.functions.triage.authority.level",
  );

  const conservative = await compileGalacticAgentYaml(
    baseYaml({
      effectLines: "          storage.read: free",
      spendLines: "",
    }),
  );
  assertEquals(
    conservative.document?.spec.functions.triage.authority.level,
    "external_write",
  );
});

Deno.test("galactic document: delegates endpoint and credential consistency to manifest validation", async () => {
  const error = await expectDocumentError(
    () =>
      compileGalacticAgentYaml(
        baseYaml({
          destination: "api.example.com",
          credentialDestination: "evil.example.com",
        }),
      ),
    "GALACTIC_MANIFEST_INVALID",
  );
  assert(
    error.message.includes("env_vars.SMTP_TOKEN.credential.destination"),
  );
});
