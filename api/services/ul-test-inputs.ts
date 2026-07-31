import {
  type D1TestFixtureConfig,
  resolveD1TestFixtureConfig,
} from "./d1-test-fixtures.ts";
import {
  type HttpTestFixtureConfig,
  resolveHttpTestFixtureConfig,
} from "./http-test-fixtures.ts";

export interface UlTestFile {
  path: string;
  content: string;
}

export interface UlTestInvocationResolution {
  entryFile: UlTestFile;
  exports: string[];
  functionName: string;
  testArgs: Record<string, unknown>;
  fixtureEnvVars: Record<string, string>;
  d1Fixtures: D1TestFixtureConfig | null;
  httpFixtures: HttpTestFixtureConfig | null;
}

const ENTRY_FILE_NAMES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

export function findUlTestEntryFile(
  files: UlTestFile[],
): UlTestFile | undefined {
  return files.find((file) =>
    ENTRY_FILE_NAMES.includes(file.path.split("/").pop() || file.path)
  );
}

export function extractUlTestExports(content: string): string[] {
  const exportRegex = /export\s+(?:async\s+)?function\s+(\w+)/g;
  const constRegex = /export\s+(?:const|let|var)\s+(\w+)\s*=/g;
  const exports: string[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = exportRegex.exec(content)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      exports.push(match[1]);
    }
  }
  while ((match = constRegex.exec(content)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      exports.push(match[1]);
    }
  }

  return exports;
}

interface ParsedUlTestFixtureEntry {
  args: Record<string, unknown>;
  envVars: Record<string, string>;
  d1Fixtures: D1TestFixtureConfig | null;
  httpFixtures: HttpTestFixtureConfig | null;
}

function isExtendedFixtureEntry(value: Record<string, unknown>): boolean {
  return "args" in value || "env_vars" in value || "d1_fixtures" in value ||
    "http_fixtures" in value;
}

function parseFixture(
  files: UlTestFile[],
): Record<string, ParsedUlTestFixtureEntry> {
  const fixtureFile = files.find((file) =>
    (file.path.split("/").pop() || file.path) === "test_fixture.json"
  );
  if (!fixtureFile) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(fixtureFile.content);
  } catch (err) {
    throw new Error(
      `test_fixture.json could not be parsed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "test_fixture.json must be an object keyed by function name",
    );
  }

  const fixture: Record<string, ParsedUlTestFixtureEntry> = {};
  for (const [functionName, entryValue] of Object.entries(parsed)) {
    if (
      !entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)
    ) {
      throw new Error(
        `test_fixture.json entry for "${functionName}" must be an object`,
      );
    }

    const entry = entryValue as Record<string, unknown>;
    if (isExtendedFixtureEntry(entry)) {
      const args = entry.args === undefined ? {} : entry.args;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error(
          `test_fixture.json entry for "${functionName}".args must be an object`,
        );
      }

      fixture[functionName] = {
        args: args as Record<string, unknown>,
        envVars: resolveUlTestEnvVars(entry.env_vars),
        d1Fixtures: resolveD1TestFixtureConfig(entry.d1_fixtures),
        httpFixtures: resolveHttpTestFixtureConfig(entry.http_fixtures),
      };
      continue;
    }

    fixture[functionName] = {
      args: entry,
      envVars: {},
      d1Fixtures: null,
      httpFixtures: null,
    };
  }

  return fixture;
}

export function resolveUlTestInvocation(
  files: UlTestFile[],
  requestedFunctionName?: string,
  explicitTestArgs?: Record<string, unknown>,
): UlTestInvocationResolution {
  const entryFile = findUlTestEntryFile(files);
  if (!entryFile) {
    throw new Error("Must include an entry file (index.ts/tsx/js/jsx)");
  }

  const exports = extractUlTestExports(entryFile.content);
  const fixture = parseFixture(files);
  const fixtureFunctions = Object.keys(fixture);

  let functionName = requestedFunctionName?.trim() || "";
  if (!functionName) {
    if (fixtureFunctions.length === 1) {
      functionName = fixtureFunctions[0];
    } else if (exports.length === 1) {
      functionName = exports[0];
    } else {
      throw new Error(
        `function_name is required when multiple exports are present. Available: ${
          exports.join(", ")
        }`,
      );
    }
  }

  if (!exports.includes(functionName)) {
    throw new Error(
      `Function "${functionName}" not found in exports. Available: ${
        exports.join(", ")
      }`,
    );
  }

  const testArgs = explicitTestArgs === undefined
    ? (fixture[functionName]?.args || {})
    : explicitTestArgs;

  return {
    entryFile,
    exports,
    functionName,
    testArgs,
    fixtureEnvVars: fixture[functionName]?.envVars || {},
    d1Fixtures: fixture[functionName]?.d1Fixtures || null,
    httpFixtures: fixture[functionName]?.httpFixtures || null,
  };
}

export function resolveUlTestEnvVars(
  envVars: unknown,
): Record<string, string> {
  if (envVars === undefined) return {};
  if (!envVars || typeof envVars !== "object" || Array.isArray(envVars)) {
    throw new Error("env_vars must be an object of string values");
  }

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (typeof value !== "string") {
      throw new Error(`env_vars.${key} must be a string`);
    }
    resolved[key] = value;
  }

  return resolved;
}

export function resolveUlTestD1Fixtures(
  d1Fixtures: unknown,
): D1TestFixtureConfig | null {
  return resolveD1TestFixtureConfig(d1Fixtures);
}

export function resolveUlTestHttpFixtures(
  httpFixtures: unknown,
): HttpTestFixtureConfig | null {
  return resolveHttpTestFixtureConfig(httpFixtures);
}
