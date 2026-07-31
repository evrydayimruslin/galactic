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
