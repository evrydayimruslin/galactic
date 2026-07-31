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
    dynamicSandboxSource,
    wranglerSource,
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
      new URL("../../runtime/dynamic-sandbox.ts", import.meta.url),
    ),
    Deno.readTextFile(new URL("../../wrangler.toml", import.meta.url)),
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
      sessionClientSource.includes("exports?.GxTestSession") &&
      sessionClientSource.includes("return namespace.getByName(sessionName)"),
    "gx.test binding props must carry only a durable session name",
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
    "the host worker must export the gx.test Durable Object class",
  );
  assert(
    dynamicSandboxSource.includes(
      "sessionNamespace.getByName(",
    ),
    "the sandbox host must create gx.test sessions through the durable namespace",
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
  assert(
    wranglerSource.includes("[exports.GxTestSession]") &&
      wranglerSource.includes('type = "durable-object"') &&
      wranglerSource.includes('storage = "sqlite"'),
    "Wrangler must provision the gx.test Durable Object namespace",
  );
});
