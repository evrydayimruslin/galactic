import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import ts from "typescript";

const EXPECTED_RPC_METHODS: Record<string, readonly string[]> = {
  "ai-binding.ts:AIBinding": ["call"],
  "appdata-binding.ts:AppDataBinding": ["list", "load", "remove", "store"],
  "compute-binding.ts:ComputeBinding": ["call", "cancel", "get"],
  "credential-binding.ts:CredentialBinding": ["authenticatedFetch"],
  "database-binding.ts:DatabaseBinding": [
    "batch",
    "count",
    "delete",
    "first",
    "insert",
    "select",
    "update",
    "upsert",
  ],
  "embed-binding.ts:EmbedBinding": ["embed"],
  "events-binding.ts:EventsBinding": ["emit"],
  "fixture-database-binding.ts:FixtureDatabaseBinding": [
    "batch",
    "count",
    "delete",
    "first",
    "insert",
    "select",
    "update",
    "upsert",
  ],
  "memory-binding.ts:MemoryBinding": ["recall", "remember"],
  "network-binding.ts:NetworkBinding": ["imapFetchUnseen", "smtpSend"],
  "notify-binding.ts:NotifyBinding": ["notifyOwner"],
  "outbound-binding.ts:OutboundBinding": ["fetch"],
  "runs-binding.ts:RunsBinding": ["recent"],
  "../gx-test-session.ts:GxTestSession": [
    "alarm",
    "beginHttpFixtureAttempt",
    "close",
    "listAppData",
    "loadAppData",
    "recallMemory",
    "recordBlockedEffect",
    "recordObservedEffect",
    "rememberMemory",
    "removeAppData",
    "reserveHttpFixtureExchangeBytes",
    "sealAndSnapshot",
    "storeAppData",
  ],
};

function memberName(member: ts.ClassElement): string | null {
  if (
    !ts.isMethodDeclaration(member) &&
    !ts.isGetAccessorDeclaration(member) &&
    !ts.isSetAccessorDeclaration(member) &&
    !ts.isPropertyDeclaration(member)
  ) {
    return null;
  }
  const name = member.name;
  if (!name || ts.isPrivateIdentifier(name)) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return name.getText();
}

Deno.test("tenant RPC bindings expose only reviewed methods and use real private fields", async () => {
  for (const [subject, expected] of Object.entries(EXPECTED_RPC_METHODS)) {
    const [fileName, className] = subject.split(":");
    const source = await Deno.readTextFile(
      new URL(`./${fileName}`, import.meta.url),
    );
    const sourceFile = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declaration = sourceFile.statements.find((statement) =>
      ts.isClassDeclaration(statement) && statement.name?.text === className
    );
    assert(
      declaration && ts.isClassDeclaration(declaration),
      `${subject} class not found`,
    );

    const exposed: string[] = [];
    for (const member of declaration.members) {
      const hasErasedPrivateModifier = ts.canHaveModifiers(member) &&
        (ts.getModifiers(member)?.some((modifier) =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword
        ) ?? false);
      assert(
        !hasErasedPrivateModifier,
        `${subject} uses TypeScript private, which is erased and RPC-callable; use #private or a module function`,
      );
      const name = memberName(member);
      if (name) {
        exposed.push(name);
      }
    }
    assertEquals(
      exposed.sort(),
      [...expected].sort(),
      `${subject} RPC surface changed; review it explicitly`,
    );
  }
});

Deno.test("gx.test state crosses Worker boundaries only through a persistent Durable Object", async () => {
  const [
    testBindingsSource,
    fixtureDatabaseSource,
    sessionClientSource,
    sessionSource,
    workerEntrySource,
    sessionWorkerEntrySource,
    dynamicSandboxSource,
    wranglerSource,
    sessionWranglerSource,
    envSource,
    packageSource,
  ] = await Promise.all([
    Deno.readTextFile(
      new URL("./test-runtime-bindings.ts", import.meta.url),
    ),
    Deno.readTextFile(
      new URL("./fixture-database-binding.ts", import.meta.url),
    ),
    Deno.readTextFile(
      new URL("./test-runtime-session-client.ts", import.meta.url),
    ),
    Deno.readTextFile(new URL("../gx-test-session.ts", import.meta.url)),
    Deno.readTextFile(new URL("../worker-entry.ts", import.meta.url)),
    Deno.readTextFile(
      new URL("../gx-test-session-worker-entry.ts", import.meta.url),
    ),
    Deno.readTextFile(
      new URL("../../runtime/dynamic-sandbox.ts", import.meta.url),
    ),
    Deno.readTextFile(new URL("../../wrangler.toml", import.meta.url)),
    Deno.readTextFile(
      new URL("../../wrangler.gx-test-session.toml", import.meta.url),
    ),
    Deno.readTextFile(new URL("../../lib/env.ts", import.meta.url)),
    Deno.readTextFile(new URL("../../package.json", import.meta.url)),
  ]);

  assert(
    !testBindingsSource.includes("RpcTarget"),
    "gx.test binding props must not carry a non-persistent RpcTarget",
  );
  assert(
    !testBindingsSource.includes("TestRuntimeSessionFactory"),
    "gx.test must not recreate the transient session factory",
  );
  assert(
    testBindingsSource.includes("resolveTestRuntimeSession") &&
      fixtureDatabaseSource.includes("resolveTestRuntimeSession"),
    "every gx.test binding must resolve durable state in its own trusted context",
  );
  assert(
    sessionClientSource.includes("sessionName: string") &&
      sessionClientSource.includes("env.GX_TEST_SESSION") &&
      sessionClientSource.includes("return namespace.getByName(sessionName)"),
    "gx.test binding props must carry only a durable session name and resolve the external namespace",
  );
  assert(
    testBindingsSource.includes(
      "resolveTestRuntimeSession(this.env, this.ctx)",
    ) &&
      fixtureDatabaseSource.includes(
        "resolveTestRuntimeSession(this.env, this.ctx)",
      ) &&
      !testBindingsSource.includes("resolveTestRuntimeSession(this.ctx)") &&
      !fixtureDatabaseSource.includes(
        "resolveTestRuntimeSession(this.ctx)",
      ),
    "every trusted gx.test WorkerEntrypoint must use its environment binding",
  );
  assert(
    !testBindingsSource.includes("session: TestRuntimeSessionRpc") &&
      !fixtureDatabaseSource.includes("session: TestRuntimeSessionRpc"),
    "gx.test binding props must never embed the Durable Object stub",
  );
  assert(
    sessionSource.includes("extends DurableObject"),
    "gx.test state must remain a Durable Object",
  );
  assert(
    sessionSource.includes("this.ctx.storage.deleteAll()"),
    "gx.test Durable Object storage must be fully deallocated after snapshot",
  );
  assert(
    sessionSource.includes("this.ctx.storage.getAlarm()") &&
      sessionSource.includes("this.ctx.storage.setAlarm(") &&
      sessionSource.includes("override async alarm(): Promise<void>"),
    "gx.test Durable Object must self-delete if host cleanup never runs",
  );
  assert(
    workerEntrySource.includes(
      'export { GxTestSession } from "./gx-test-session.ts";',
    ),
    "the API must retain its dormant rollback-compatible staging export",
  );
  assert(
    sessionWorkerEntrySource.includes(
      'export { GxTestSession } from "./gx-test-session.ts";',
    ),
    "the dedicated session Worker must export the gx.test Durable Object class",
  );
  assert(
    dynamicSandboxSource.includes(
      "globalThis.__env?.GX_TEST_SESSION",
    ) &&
      dynamicSandboxSource.includes("sessionNamespace.getByName(") &&
      !dynamicSandboxSource.includes("availableExports.GxTestSession"),
    "the sandbox host must create gx.test sessions through the external durable namespace",
  );
  assert(
    envSource.includes("GX_TEST_SESSION: DurableObjectNamespace"),
    "the API environment must type the external gx.test Durable Object namespace",
  );
  assert(
    wranglerSource.includes("[[durable_objects.bindings]]") &&
      wranglerSource.includes('name = "GX_TEST_SESSION"') &&
      wranglerSource.includes('script_name = "galactic-gx-test-session"') &&
      wranglerSource.includes(
        'script_name = "galactic-gx-test-session-staging"',
      ),
    "API production and staging must bind their matching dedicated session Workers",
  );
  assert(
    !wranglerSource.includes("\n[exports.GxTestSession]\n") &&
      wranglerSource.includes(
        "[env.staging.exports.GxTestSession]",
      ),
    "only staging may retain the dormant API-owned gx.test namespace",
  );
  assert(
    sessionWranglerSource.includes('name = "galactic-gx-test-session"') &&
      sessionWranglerSource.includes(
        'name = "galactic-gx-test-session-staging"',
      ) &&
      sessionWranglerSource.includes("[exports.GxTestSession]") &&
      sessionWranglerSource.includes('type = "durable-object"') &&
      sessionWranglerSource.includes('storage = "sqlite"') &&
      sessionWranglerSource.includes("workers_dev = false") &&
      sessionWranglerSource.includes("preview_urls = false"),
    "the dedicated gx.test Worker must privately own both SQLite namespaces",
  );
  assert(
    packageSource.includes('"deploy:gx-test-session"') &&
      packageSource.includes('"deploy:gx-test-session:dry-run"') &&
      packageSource.includes('"deploy:gx-test-session:staging"') &&
      packageSource.includes('"deploy:gx-test-session:staging:dry-run"'),
    "dedicated gx.test Worker deploy and dry-run scripts must remain available",
  );
  assert(
    !dynamicSandboxSource.includes(".dup()"),
    "the sandbox host must not duplicate a transient RPC session",
  );
  assert(
    dynamicSandboxSource.includes("sessionName") &&
      !dynamicSandboxSource.includes("session: persistentTestSession()"),
    "the sandbox host must pass a plain session name to every test binding",
  );
});
