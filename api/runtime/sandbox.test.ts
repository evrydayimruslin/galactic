/**
 * Tests for Sandbox Isolation & Runtime
 *
 * Tests executeInSandbox with mock services to verify:
 * - Stdlib utilities (uuid, base64, hash, _, dateFns, schema, str, jwt, markdown)
 * - Security constraints (HTTPS-only fetch, concurrent limits, timeouts, result size)
 * - Console capture
 * - Timer cleanup
 * - SDK permission gating (memory, ai)
 * - Error handling
 */

import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import {
  type AIService,
  type AppDataService,
  executeInSandbox,
  type MemoryService,
  type RuntimeConfig,
} from "./sandbox.ts";

// ── Mock services ──

function mockAppDataService(): AppDataService {
  const store = new Map<string, unknown>();
  return {
    store: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    load: async (key: string) => store.get(key) ?? null,
    remove: async (key: string) => {
      store.delete(key);
    },
    list: async (prefix?: string) => {
      const keys = [...store.keys()];
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    },
    query: async () => [],
    batchStore: async (items) => {
      for (const i of items) store.set(i.key, i.value);
    },
    batchLoad: async (keys) =>
      keys.map((k) => ({ key: k, value: store.get(k) ?? null })),
    batchRemove: async (keys) => {
      for (const k of keys) store.delete(k);
    },
  };
}

function mockMemoryService(): MemoryService {
  const store = new Map<string, unknown>();
  return {
    remember: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    recall: async (key: string) => store.get(key) ?? null,
  };
}

function mockAIService(): AIService {
  return {
    call: async () => ({
      content: "AI response",
      model: "test-model",
      usage: { input_tokens: 10, output_tokens: 20, cost_light: 0.8 },
    }),
  };
}

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    appId: "app-test",
    userId: "user-test",
    ownerId: "owner-test",
    executionId: "exec-test",
    code: "",
    permissions: [],
    userApiKey: null,
    user: null,
    appDataService: mockAppDataService(),
    d1DataService: null,
    memoryService: null,
    aiService: mockAIService(),
    envVars: {},
    ...overrides,
  };
}

// Helper: build IIFE-style bundled code that esbuild would produce
function iife(body: string): string {
  return `var __exports = (function() {
    ${body}
  })();`;
}

// ============================================
// Basic execution
// ============================================

Deno.test("sandbox: executes simple function and returns result", async () => {
  const config = makeConfig({
    code: iife(`
      function hello() { return 'world'; }
      return { hello: hello };
    `),
  });
  const result = await executeInSandbox(config, "hello", [{}]);
  assertEquals(result.success, true);
  assertEquals(result.result, "world");
});

Deno.test("sandbox: executes async function", async () => {
  const config = makeConfig({
    code: iife(`
      async function fetchName() { return 'async-result'; }
      return { fetchName: fetchName };
    `),
  });
  const result = await executeInSandbox(config, "fetchName", [{}]);
  assertEquals(result.success, true);
  assertEquals(result.result, "async-result");
});

Deno.test("sandbox: returns error for non-existent function", async () => {
  const config = makeConfig({
    code: iife(`
      function existing() { return 1; }
      return { existing: existing };
    `),
  });
  const result = await executeInSandbox(config, "nonExistent", [{}]);
  assertEquals(result.success, false);
  assert(result.error?.message.includes("nonExistent"));
  assert(result.error?.message.includes("not found"));
});

Deno.test("sandbox: passes args to function", async () => {
  const config = makeConfig({
    code: iife(`
      function greet(args) { return 'Hello ' + args.name; }
      return { greet: greet };
    `),
  });
  const result = await executeInSandbox(config, "greet", [{ name: "World" }]);
  assertEquals(result.success, true);
  assertEquals(result.result, "Hello World");
});

Deno.test("sandbox: records duration", async () => {
  const config = makeConfig({
    code: iife(`
      function noop() { return null; }
      return { noop: noop };
    `),
  });
  const result = await executeInSandbox(config, "noop", [{}]);
  assertEquals(result.success, true);
  assert(result.durationMs >= 0);
});

// ============================================
// Console capture
// ============================================

Deno.test("sandbox: captures console.log", async () => {
  const config = makeConfig({
    code: iife(`
      function logTest() {
        console.log('hello', 'world');
        return 'done';
      }
      return { logTest: logTest };
    `),
  });
  const result = await executeInSandbox(config, "logTest", [{}]);
  assertEquals(result.success, true);
  // Look for user's console.log (not SDK logs)
  const userLog = result.logs.find((l) => l.message === "hello world");
  assert(userLog !== undefined);
  assertEquals(userLog!.level, "log");
});

Deno.test("sandbox: captures console.error", async () => {
  const config = makeConfig({
    code: iife(`
      function errTest() {
        console.error('something broke');
        return 'done';
      }
      return { errTest: errTest };
    `),
  });
  const result = await executeInSandbox(config, "errTest", [{}]);
  const errLog = result.logs.find((l) => l.message === "something broke");
  assert(errLog !== undefined);
  assertEquals(errLog!.level, "error");
});

Deno.test("sandbox: captures console.warn and console.info", async () => {
  const config = makeConfig({
    code: iife(`
      function warnInfoTest() {
        console.warn('caution');
        console.info('info-msg');
        return 'done';
      }
      return { warnInfoTest: warnInfoTest };
    `),
  });
  const result = await executeInSandbox(config, "warnInfoTest", [{}]);
  assert(
    result.logs.some((l) => l.level === "warn" && l.message === "caution"),
  );
  assert(
    result.logs.some((l) => l.level === "info" && l.message === "info-msg"),
  );
});

// ============================================
// Stdlib: uuid
// ============================================

Deno.test("sandbox: uuid.v4() returns valid UUID format", async () => {
  const config = makeConfig({
    code: iife(`
      function genUuid() { return uuid.v4(); }
      return { genUuid: genUuid };
    `),
  });
  const result = await executeInSandbox(config, "genUuid", [{}]);
  assertEquals(result.success, true);
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert(uuidRegex.test(result.result as string));
});

Deno.test("sandbox: uuid.v4() produces unique values", async () => {
  const config = makeConfig({
    code: iife(`
      function twoUuids() { return [uuid.v4(), uuid.v4()]; }
      return { twoUuids: twoUuids };
    `),
  });
  const result = await executeInSandbox(config, "twoUuids", [{}]);
  assertEquals(result.success, true);
  const [a, b] = result.result as string[];
  assert(a !== b);
});

// ============================================
// Stdlib: base64
// ============================================

Deno.test("sandbox: base64 encode/decode roundtrip", async () => {
  const config = makeConfig({
    code: iife(`
      function b64Test() {
        var encoded = base64.encode('Hello World');
        var decoded = base64.decode(encoded);
        return { encoded: encoded, decoded: decoded };
      }
      return { b64Test: b64Test };
    `),
  });
  const result = await executeInSandbox(config, "b64Test", [{}]);
  assertEquals(result.success, true);
  const data = result.result as { encoded: string; decoded: string };
  assertEquals(data.encoded, "SGVsbG8gV29ybGQ=");
  assertEquals(data.decoded, "Hello World");
});

Deno.test("sandbox: base64 encodeBytes/decodeBytes roundtrip", async () => {
  const config = makeConfig({
    code: iife(`
      function bytesTest() {
        var bytes = new Uint8Array([72, 101, 108, 108, 111]);
        var encoded = base64.encodeBytes(bytes);
        var decoded = base64.decodeBytes(encoded);
        return { encoded: encoded, decoded: Array.from(decoded) };
      }
      return { bytesTest: bytesTest };
    `),
  });
  const result = await executeInSandbox(config, "bytesTest", [{}]);
  assertEquals(result.success, true);
  const data = result.result as { encoded: string; decoded: number[] };
  assertEquals(data.decoded, [72, 101, 108, 108, 111]);
});

// ============================================
// Stdlib: hash
// ============================================

Deno.test("sandbox: hash.sha256 produces hex string", async () => {
  const config = makeConfig({
    code: iife(`
      async function hashTest() { return await hash.sha256('hello'); }
      return { hashTest: hashTest };
    `),
  });
  const result = await executeInSandbox(config, "hashTest", [{}]);
  assertEquals(result.success, true);
  const h = result.result as string;
  // SHA-256 of "hello" is well-known
  assertEquals(
    h,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

Deno.test("sandbox: hash.sha512 produces hex string", async () => {
  const config = makeConfig({
    code: iife(`
      async function sha512Test() { return await hash.sha512('hello'); }
      return { sha512Test: sha512Test };
    `),
  });
  const result = await executeInSandbox(config, "sha512Test", [{}]);
  assertEquals(result.success, true);
  const h = result.result as string;
  assertEquals(h.length, 128); // SHA-512 = 64 bytes = 128 hex chars
});

Deno.test("sandbox: hash.md5 produces deterministic hash", async () => {
  const config = makeConfig({
    code: iife(`
      function md5Test() { return hash.md5('hello'); }
      return { md5Test: md5Test };
    `),
  });
  const result = await executeInSandbox(config, "md5Test", [{}]);
  assertEquals(result.success, true);
  const h1 = result.result as string;

  // Run again to verify deterministic
  const result2 = await executeInSandbox(config, "md5Test", [{}]);
  assertEquals(result2.result, h1);
});

// ============================================
// Stdlib: lodash (_)
// ============================================

Deno.test("sandbox: _.chunk splits arrays", async () => {
  const config = makeConfig({
    code: iife(`
      function chunkTest() { return _.chunk([1,2,3,4,5], 2); }
      return { chunkTest: chunkTest };
    `),
  });
  const result = await executeInSandbox(config, "chunkTest", [{}]);
  assertEquals(result.success, true);
  assertEquals(result.result, [[1, 2], [3, 4], [5]]);
});

Deno.test("sandbox: _.uniq deduplicates", async () => {
  const config = makeConfig({
    code: iife(`
      function uniqTest() { return _.uniq([1, 2, 2, 3, 1]); }
      return { uniqTest: uniqTest };
    `),
  });
  const result = await executeInSandbox(config, "uniqTest", [{}]);
  assertEquals(result.result, [1, 2, 3]);
});

Deno.test("sandbox: _.groupBy groups items", async () => {
  const config = makeConfig({
    code: iife(`
      function groupTest() {
        return _.groupBy(
          [{ n: 'a', t: 1 }, { n: 'b', t: 1 }, { n: 'c', t: 2 }],
          function(x) { return String(x.t); }
        );
      }
      return { groupTest: groupTest };
    `),
  });
  const result = await executeInSandbox(config, "groupTest", [{}]);
  assertEquals(result.success, true);
  const data = result.result as Record<string, unknown[]>;
  assertEquals(data["1"].length, 2);
  assertEquals(data["2"].length, 1);
});

Deno.test("sandbox: _.get with dot path", async () => {
  const config = makeConfig({
    code: iife(`
      function getTest() {
        var obj = { a: { b: { c: 42 } } };
        return _.get(obj, 'a.b.c');
      }
      return { getTest: getTest };
    `),
  });
  const result = await executeInSandbox(config, "getTest", [{}]);
  assertEquals(result.result, 42);
});

Deno.test("sandbox: _.get with default value", async () => {
  const config = makeConfig({
    code: iife(`
      function getDefaultTest() {
        return _.get({}, 'a.b.c', 'fallback');
      }
      return { getDefaultTest: getDefaultTest };
    `),
  });
  const result = await executeInSandbox(config, "getDefaultTest", [{}]);
  assertEquals(result.result, "fallback");
});

Deno.test("sandbox: _.pick and _.omit", async () => {
  const config = makeConfig({
    code: iife(`
      function pickOmitTest() {
        var obj = { a: 1, b: 2, c: 3 };
        return {
          picked: _.pick(obj, ['a', 'c']),
          omitted: _.omit(obj, ['b']),
        };
      }
      return { pickOmitTest: pickOmitTest };
    `),
  });
  const result = await executeInSandbox(config, "pickOmitTest", [{}]);
  const data = result.result as {
    picked: Record<string, number>;
    omitted: Record<string, number>;
  };
  assertEquals(data.picked, { a: 1, c: 3 });
  assertEquals(data.omitted, { a: 1, c: 3 });
});

Deno.test("sandbox: _.camelCase / _.snakeCase / _.kebabCase", async () => {
  const config = makeConfig({
    code: iife(`
      function caseTest() {
        return {
          camel: _.camelCase('hello-world'),
          snake: _.snakeCase('helloWorld'),
          kebab: _.kebabCase('helloWorld'),
        };
      }
      return { caseTest: caseTest };
    `),
  });
  const result = await executeInSandbox(config, "caseTest", [{}]);
  const data = result.result as Record<string, string>;
  assertEquals(data.camel, "helloWorld");
  assertEquals(data.snake, "hello_world");
  assertEquals(data.kebab, "hello-world");
});

Deno.test("sandbox: _.sum / _.mean / _.clamp", async () => {
  const config = makeConfig({
    code: iife(`
      function mathTest() {
        return {
          sum: _.sum([1, 2, 3, 4]),
          mean: _.mean([2, 4, 6]),
          clamped: _.clamp(15, 0, 10),
        };
      }
      return { mathTest: mathTest };
    `),
  });
  const result = await executeInSandbox(config, "mathTest", [{}]);
  const data = result.result as { sum: number; mean: number; clamped: number };
  assertEquals(data.sum, 10);
  assertEquals(data.mean, 4);
  assertEquals(data.clamped, 10);
});

Deno.test("sandbox: _.isEmpty", async () => {
  const config = makeConfig({
    code: iife(`
      function emptyTest() {
        return {
          emptyArr: _.isEmpty([]),
          emptyObj: _.isEmpty({}),
          emptyStr: _.isEmpty(''),
          nul: _.isEmpty(null),
          nonEmpty: _.isEmpty([1]),
        };
      }
      return { emptyTest: emptyTest };
    `),
  });
  const result = await executeInSandbox(config, "emptyTest", [{}]);
  const data = result.result as Record<string, boolean>;
  assertEquals(data.emptyArr, true);
  assertEquals(data.emptyObj, true);
  assertEquals(data.emptyStr, true);
  assertEquals(data.nul, true);
  assertEquals(data.nonEmpty, false);
});

// ============================================
// Stdlib: dateFns
// ============================================

Deno.test("sandbox: dateFns.format produces formatted date", async () => {
  const config = makeConfig({
    code: iife(`
      function formatTest() {
        return dateFns.format(new Date('2025-06-15T12:30:00Z'), 'yyyy-MM-dd');
      }
      return { formatTest: formatTest };
    `),
  });
  const result = await executeInSandbox(config, "formatTest", [{}]);
  assertEquals(result.success, true);
  assertEquals(result.result, "2025-06-15");
});

Deno.test("sandbox: dateFns.addDays", async () => {
  const config = makeConfig({
    code: iife(`
      function addDaysTest() {
        var d = dateFns.addDays('2025-01-01T00:00:00Z', 5);
        return d.toISOString().slice(0, 10);
      }
      return { addDaysTest: addDaysTest };
    `),
  });
  const result = await executeInSandbox(config, "addDaysTest", [{}]);
  assertEquals(result.result, "2025-01-06");
});

Deno.test("sandbox: dateFns.isAfter / isBefore", async () => {
  const config = makeConfig({
    code: iife(`
      function compareTest() {
        return {
          after: dateFns.isAfter('2025-06-15', '2025-01-01'),
          before: dateFns.isBefore('2025-01-01', '2025-06-15'),
        };
      }
      return { compareTest: compareTest };
    `),
  });
  const result = await executeInSandbox(config, "compareTest", [{}]);
  const data = result.result as { after: boolean; before: boolean };
  assertEquals(data.after, true);
  assertEquals(data.before, true);
});

// ============================================
// Stdlib: schema (Zod-like validation)
// ============================================

Deno.test("sandbox: schema.string validation", async () => {
  const config = makeConfig({
    code: iife(`
      function schemaStringTest() {
        var s = schema.string().min(3);
        var ok = s.safeParse('hello');
        var fail = s.safeParse('hi');
        return { ok: ok.success, fail: fail.success, failErr: fail.error };
      }
      return { schemaStringTest: schemaStringTest };
    `),
  });
  const result = await executeInSandbox(config, "schemaStringTest", [{}]);
  const data = result.result as { ok: boolean; fail: boolean; failErr: string };
  assertEquals(data.ok, true);
  assertEquals(data.fail, false);
  assert(data.failErr.includes("at least 3"));
});

Deno.test("sandbox: schema.number validation", async () => {
  const config = makeConfig({
    code: iife(`
      function schemaNumberTest() {
        var n = schema.number().int().min(0).max(100);
        return {
          ok: n.safeParse(50).success,
          notInt: n.safeParse(5.5).success,
          tooHigh: n.safeParse(101).success,
          notNum: n.safeParse('abc').success,
        };
      }
      return { schemaNumberTest: schemaNumberTest };
    `),
  });
  const result = await executeInSandbox(config, "schemaNumberTest", [{}]);
  const data = result.result as Record<string, boolean>;
  assertEquals(data.ok, true);
  assertEquals(data.notInt, false);
  assertEquals(data.tooHigh, false);
  assertEquals(data.notNum, false);
});

Deno.test("sandbox: schema.object validation", async () => {
  const config = makeConfig({
    code: iife(`
      function schemaObjTest() {
        var s = schema.object({
          name: schema.string(),
          age: schema.number(),
        });
        var ok = s.safeParse({ name: 'Alice', age: 30 });
        var fail = s.safeParse({ name: 'Bob', age: 'thirty' });
        return { ok: ok.success, fail: fail.success };
      }
      return { schemaObjTest: schemaObjTest };
    `),
  });
  const result = await executeInSandbox(config, "schemaObjTest", [{}]);
  const data = result.result as { ok: boolean; fail: boolean };
  assertEquals(data.ok, true);
  assertEquals(data.fail, false);
});

Deno.test("sandbox: schema.array validation", async () => {
  const config = makeConfig({
    code: iife(`
      function schemaArrTest() {
        var s = schema.array(schema.string()).min(1);
        return {
          ok: s.safeParse(['a', 'b']).success,
          empty: s.safeParse([]).success,
          notArr: s.safeParse('hello').success,
        };
      }
      return { schemaArrTest: schemaArrTest };
    `),
  });
  const result = await executeInSandbox(config, "schemaArrTest", [{}]);
  const data = result.result as Record<string, boolean>;
  assertEquals(data.ok, true);
  assertEquals(data.empty, false);
  assertEquals(data.notArr, false);
});

Deno.test("sandbox: schema.enum validation", async () => {
  const config = makeConfig({
    code: iife(`
      function schemaEnumTest() {
        var s = schema.enum('red', 'green', 'blue');
        return {
          ok: s.safeParse('red').success,
          fail: s.safeParse('yellow').success,
        };
      }
      return { schemaEnumTest: schemaEnumTest };
    `),
  });
  const result = await executeInSandbox(config, "schemaEnumTest", [{}]);
  const data = result.result as Record<string, boolean>;
  assertEquals(data.ok, true);
  assertEquals(data.fail, false);
});

// ============================================
// Stdlib: str (string utilities)
// ============================================

Deno.test("sandbox: str.slugify", async () => {
  const config = makeConfig({
    code: iife(`
      function slugTest() { return str.slugify('Hello World! 123'); }
      return { slugTest: slugTest };
    `),
  });
  const result = await executeInSandbox(config, "slugTest", [{}]);
  assertEquals(result.result, "hello-world-123");
});

Deno.test("sandbox: str.escapeHtml / str.unescapeHtml roundtrip", async () => {
  const config = makeConfig({
    code: iife(`
      function escapeTest() {
        var raw = '<script>alert("xss")</script>';
        var escaped = str.escapeHtml(raw);
        var unescaped = str.unescapeHtml(escaped);
        return { escaped: escaped, roundtrip: unescaped === raw };
      }
      return { escapeTest: escapeTest };
    `),
  });
  const result = await executeInSandbox(config, "escapeTest", [{}]);
  const data = result.result as { escaped: string; roundtrip: boolean };
  assert(!data.escaped.includes("<script>"));
  assertEquals(data.roundtrip, true);
});

Deno.test("sandbox: str.wordCount", async () => {
  const config = makeConfig({
    code: iife(`
      function wcTest() { return str.wordCount('hello beautiful world'); }
      return { wcTest: wcTest };
    `),
  });
  const result = await executeInSandbox(config, "wcTest", [{}]);
  assertEquals(result.result, 3);
});

Deno.test("sandbox: str.pluralize", async () => {
  const config = makeConfig({
    code: iife(`
      function pluralTest() {
        return {
          one: str.pluralize('item', 1),
          many: str.pluralize('item', 5),
          custom: str.pluralize('child', 3, 'children'),
        };
      }
      return { pluralTest: pluralTest };
    `),
  });
  const result = await executeInSandbox(config, "pluralTest", [{}]);
  const data = result.result as Record<string, string>;
  assertEquals(data.one, "item");
  assertEquals(data.many, "items");
  assertEquals(data.custom, "children");
});

// ============================================
// Stdlib: jwt (decode only)
// ============================================

Deno.test("sandbox: jwt.decode reads claims", async () => {
  // Build a simple JWT (header.payload.signature)
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({ sub: "123", name: "Test", exp: 9999999999 }),
  );
  const token = `${header}.${payload}.fakesignature`;

  const config = makeConfig({
    code: iife(`
      function decodeTest(args) { return jwt.decode(args.token); }
      return { decodeTest: decodeTest };
    `),
  });
  const result = await executeInSandbox(config, "decodeTest", [{ token }]);
  assertEquals(result.success, true);
  const decoded = result.result as {
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
  };
  assertEquals(decoded.payload.sub, "123");
  assertEquals(decoded.payload.name, "Test");
});

Deno.test("sandbox: jwt.isExpired returns correct status", async () => {
  const header = btoa(JSON.stringify({ alg: "HS256" }));
  const expiredPayload = btoa(JSON.stringify({ exp: 1000000000 })); // year 2001
  const validPayload = btoa(JSON.stringify({ exp: 9999999999 })); // far future
  const expiredToken = `${header}.${expiredPayload}.sig`;
  const validToken = `${header}.${validPayload}.sig`;

  const config = makeConfig({
    code: iife(`
      function expiryTest(args) {
        return {
          expired: jwt.isExpired(args.expiredToken),
          valid: jwt.isExpired(args.validToken),
        };
      }
      return { expiryTest: expiryTest };
    `),
  });
  const result = await executeInSandbox(config, "expiryTest", [{
    expiredToken,
    validToken,
  }]);
  const data = result.result as { expired: boolean; valid: boolean };
  assertEquals(data.expired, true);
  assertEquals(data.valid, false);
});

Deno.test("sandbox: jwt.decode returns null for invalid token", async () => {
  const config = makeConfig({
    code: iife(`
      function invalidJwt() { return jwt.decode('not-a-jwt'); }
      return { invalidJwt: invalidJwt };
    `),
  });
  const result = await executeInSandbox(config, "invalidJwt", [{}]);
  assertEquals(result.result, null);
});

// ============================================
// Stdlib: markdown
// ============================================

Deno.test("sandbox: markdown.toHtml converts headers", async () => {
  const config = makeConfig({
    code: iife(`
      function mdTest() { return markdown.toHtml('# Hello'); }
      return { mdTest: mdTest };
    `),
  });
  const result = await executeInSandbox(config, "mdTest", [{}]);
  assertEquals(result.success, true);
  assert((result.result as string).includes("<h1>"));
  assert((result.result as string).includes("Hello"));
});

Deno.test("sandbox: markdown.toText strips formatting", async () => {
  const config = makeConfig({
    code: iife(`
      function mdTextTest() { return markdown.toText('# Hello **world**'); }
      return { mdTextTest: mdTextTest };
    `),
  });
  const result = await executeInSandbox(config, "mdTextTest", [{}]);
  assertEquals(result.success, true);
  assertEquals(result.result, "Hello world");
});

// ============================================
// SDK: App data storage
// ============================================

Deno.test("sandbox: ultralight.store / ultralight.load roundtrip", async () => {
  const appData = mockAppDataService();
  const config = makeConfig({
    appDataService: appData,
    code: iife(`
      async function storeLoadTest() {
        await ultralight.store('key1', { data: 42 });
        var loaded = await ultralight.load('key1');
        return loaded;
      }
      return { storeLoadTest: storeLoadTest };
    `),
  });
  const result = await executeInSandbox(config, "storeLoadTest", [{}]);
  assertEquals(result.success, true);
  assertEquals((result.result as { data: number }).data, 42);
});

Deno.test("sandbox: ultralight.list returns keys", async () => {
  const appData = mockAppDataService();
  // Pre-populate
  await appData.store("users_1", "a");
  await appData.store("users_2", "b");
  await appData.store("posts_1", "c");

  const config = makeConfig({
    appDataService: appData,
    code: iife(`
      async function listTest() {
        return await ultralight.list('users');
      }
      return { listTest: listTest };
    `),
  });
  const result = await executeInSandbox(config, "listTest", [{}]);
  assertEquals(result.success, true);
  assertEquals((result.result as string[]).length, 2);
});

Deno.test("sandbox: ultralight.remove deletes key", async () => {
  const appData = mockAppDataService();
  await appData.store("temp", "value");

  const config = makeConfig({
    appDataService: appData,
    code: iife(`
      async function removeTest() {
        await ultralight.remove('temp');
        var result = await ultralight.load('temp');
        return result;
      }
      return { removeTest: removeTest };
    `),
  });
  const result = await executeInSandbox(config, "removeTest", [{}]);
  assertEquals(result.success, true);
  assertEquals(result.result, null);
});

// ============================================
// SDK: Permission gating
// ============================================

Deno.test("sandbox: memory:write permission required for remember", async () => {
  const config = makeConfig({
    permissions: [], // No permissions
    memoryService: mockMemoryService(),
    code: iife(`
      async function memTest() {
        await ultralight.remember('key', 'val');
        return 'ok';
      }
      return { memTest: memTest };
    `),
  });
  const result = await executeInSandbox(config, "memTest", [{}]);
  assertEquals(result.success, false);
  assert(result.error?.message.includes("memory:write"));
});

Deno.test("sandbox: memory:read permission required for recall", async () => {
  const config = makeConfig({
    permissions: [], // No permissions
    memoryService: mockMemoryService(),
    code: iife(`
      async function recallTest() {
        return await ultralight.recall('key');
      }
      return { recallTest: recallTest };
    `),
  });
  const result = await executeInSandbox(config, "recallTest", [{}]);
  assertEquals(result.success, false);
  assert(result.error?.message.includes("memory:read"));
});

Deno.test("sandbox: memory works when permission granted", async () => {
  const mem = mockMemoryService();
  const config = makeConfig({
    permissions: ["memory:write", "memory:read"],
    memoryService: mem,
    code: iife(`
      async function memOkTest() {
        await ultralight.remember('pref', 'dark-mode');
        var result = await ultralight.recall('pref');
        return result;
      }
      return { memOkTest: memOkTest };
    `),
  });
  const result = await executeInSandbox(config, "memOkTest", [{}]);
  assertEquals(result.success, true);
  assertEquals(result.result, "dark-mode");
});

Deno.test("sandbox: memory throws when service is null", async () => {
  const config = makeConfig({
    permissions: ["memory:write"],
    memoryService: null, // No memory service
    code: iife(`
      async function noMemTest() {
        await ultralight.remember('key', 'val');
        return 'ok';
      }
      return { noMemTest: noMemTest };
    `),
  });
  const result = await executeInSandbox(config, "noMemTest", [{}]);
  assertEquals(result.success, false);
  assert(result.error?.message.includes("not available"));
});

Deno.test("sandbox: ai:call permission required", async () => {
  const config = makeConfig({
    permissions: [], // No ai:call
    code: iife(`
      async function aiTest() {
        return await ultralight.ai({ messages: [{ role: 'user', content: 'hi' }] });
      }
      return { aiTest: aiTest };
    `),
  });
  const result = await executeInSandbox(config, "aiTest", [{}]);
  assertEquals(result.success, false);
  assert(result.error?.message.includes("ai:call"));
});

Deno.test("sandbox: ai works when permission granted", async () => {
  const config = makeConfig({
    permissions: ["ai:call"],
    code: iife(`
      async function aiOkTest() {
        var res = await ultralight.ai({ messages: [{ role: 'user', content: 'hi' }] });
        return res.content;
      }
      return { aiOkTest: aiOkTest };
    `),
  });
  const result = await executeInSandbox(config, "aiOkTest", [{}]);
  assertEquals(result.success, true);
  assertEquals(result.result, "AI response");
});

Deno.test("sandbox: app call can use a declared read dependency", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = input.toString();
    capturedAuth = new Headers(init?.headers).get("Authorization") || "";
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "call-1",
        result: {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const prevEnv = globalThis.__env;
  globalThis.__env = {
    ...(prevEnv || {}),
    AGENT_CALLER_SECRET: "sandbox-test-secret",
  } as typeof globalThis.__env;
  try {
    const config = makeConfig({
      permissions: [],
      baseUrl: "https://api.example.test",
      // The raw caller bearer; it must NEVER reach the inter-app call.
      authToken: "token-123",
      user: {
        id: "user-1",
        email: "dev@example.com",
        displayName: null,
        avatarUrl: null,
        tier: "free",
      },
      appCallDependencies: [
        { app: "target-app", functions: ["readSummary"], access: "read" },
      ],
      code: iife(`
        async function callDependency() {
          return await ultralight.call('target-app', 'readSummary', { limit: 1 });
        }
        return { callDependency: callDependency };
      `),
    });

    const result = await executeInSandbox(config, "callDependency", [{}]);
    assertEquals(result.success, true);
    assertEquals(result.result, { ok: true });
    assertEquals(capturedUrl, "https://api.example.test/mcp/target-app");
    // The leak fix: a short-lived scoped token is sent, never the raw bearer.
    assert(capturedAuth.startsWith("Bearer gxe_v1_"));
    assert(!capturedAuth.includes("token-123"));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = prevEnv;
  }
});

Deno.test("sandbox: app call rejects undeclared dependency without app:call", async () => {
  const config = makeConfig({
    permissions: [],
    baseUrl: "https://api.example.test",
    authToken: "token-123",
    appCallDependencies: [
      { app: "target-app", functions: ["readSummary"], access: "read" },
    ],
    code: iife(`
      async function blockedDependency() {
        return await ultralight.call('target-app', 'writeSummary', {});
      }
      return { blockedDependency: blockedDependency };
    `),
  });

  const result = await executeInSandbox(config, "blockedDependency", [{}]);
  assertEquals(result.success, false);
  assert(result.error?.message.includes("matching dependency"));
});

Deno.test("sandbox: app call can use a declared write dependency", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "call-1",
        result: {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const prevEnv = globalThis.__env;
  globalThis.__env = {
    ...(prevEnv || {}),
    AGENT_CALLER_SECRET: "sandbox-test-secret",
  } as typeof globalThis.__env;
  try {
    const config = makeConfig({
      permissions: [],
      baseUrl: "https://api.example.test",
      authToken: "token-123",
      user: {
        id: "user-1",
        email: "dev@example.com",
        displayName: null,
        avatarUrl: null,
        tier: "free",
      },
      appCallDependencies: [
        { app: "target-app", functions: ["writeSummary"], access: "write" },
      ],
      code: iife(`
        async function writeDependency() {
          return await ultralight.call('target-app', 'writeSummary', { value: 1 });
        }
        return { writeDependency: writeDependency };
      `),
    });

    const result = await executeInSandbox(config, "writeDependency", [{}]);
    assertEquals(result.success, true);
    assertEquals(result.result, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = prevEnv;
  }
});

// ============================================
// SDK: User context
// ============================================

Deno.test("sandbox: ultralight.user is null when anonymous", async () => {
  const config = makeConfig({
    user: null,
    code: iife(`
      function userTest() { return ultralight.user; }
      return { userTest: userTest };
    `),
  });
  const result = await executeInSandbox(config, "userTest", [{}]);
  assertEquals(result.result, null);
});

Deno.test("sandbox: ultralight.user has correct properties", async () => {
  const config = makeConfig({
    user: {
      id: "u1",
      email: "test@test.com",
      displayName: "Test",
      avatarUrl: null,
      tier: "free",
    },
    code: iife(`
      function userTest() { return ultralight.user; }
      return { userTest: userTest };
    `),
  });
  const result = await executeInSandbox(config, "userTest", [{}]);
  const user = result.result as { id: string; email: string };
  assertEquals(user.id, "u1");
  assertEquals(user.email, "test@test.com");
});

Deno.test("sandbox: ultralight.isAuthenticated returns false for anon", async () => {
  const config = makeConfig({
    user: null,
    code: iife(`
      function authTest() { return ultralight.isAuthenticated(); }
      return { authTest: authTest };
    `),
  });
  const result = await executeInSandbox(config, "authTest", [{}]);
  assertEquals(result.result, false);
});

Deno.test("sandbox: ultralight.requireAuth throws for anon", async () => {
  const config = makeConfig({
    user: null,
    code: iife(`
      function authRequired() { return ultralight.requireAuth(); }
      return { authRequired: authRequired };
    `),
  });
  const result = await executeInSandbox(config, "authRequired", [{}]);
  assertEquals(result.success, false);
  assert(result.error?.message.includes("Authentication required"));
});

// ============================================
// SDK: Environment variables
// ============================================

Deno.test("sandbox: ultralight.env provides env vars", async () => {
  const config = makeConfig({
    envVars: { API_KEY: "secret-123", DB_URL: "postgres://localhost" },
    code: iife(`
      function envTest() {
        return { key: ultralight.env.API_KEY, db: ultralight.env.DB_URL };
      }
      return { envTest: envTest };
    `),
  });
  const result = await executeInSandbox(config, "envTest", [{}]);
  const data = result.result as Record<string, string>;
  assertEquals(data.key, "secret-123");
  assertEquals(data.db, "postgres://localhost");
});

Deno.test("sandbox: ultralight.env is frozen (read-only)", async () => {
  const config = makeConfig({
    envVars: { KEY: "value" },
    code: iife(`
      function freezeTest() {
        try {
          ultralight.env.KEY = 'hacked';
          return 'mutated';
        } catch(e) {
          return 'frozen';
        }
      }
      return { freezeTest: freezeTest };
    `),
  });
  const result = await executeInSandbox(config, "freezeTest", [{}]);
  assertEquals(result.success, true);
  // In strict mode, assignment to frozen object throws
  assertEquals(result.result, "frozen");
});

// ============================================
// Security: Fetch constraints
// ============================================

Deno.test("sandbox: fetch rejects HTTP URLs", async () => {
  const config = makeConfig({
    code: iife(`
      async function httpTest() {
        await fetch('http://example.com');
        return 'should-not-reach';
      }
      return { httpTest: httpTest };
    `),
  });
  const result = await executeInSandbox(config, "httpTest", [{}]);
  assertEquals(result.success, false);
  assert(result.error?.message.includes("HTTPS"));
});

Deno.test({
  name: "sandbox: fetch allows localhost",
  // The fetch timeout timer may linger since connection to localhost fails
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // We can't actually fetch localhost in tests, but we can verify
    // the URL validation doesn't block it. The actual fetch will fail
    // because nothing is running, but the error won't be about HTTPS.
    const config = makeConfig({
      code: iife(`
        async function localhostTest() {
          try {
            await fetch('http://localhost:3000/test');
            return 'ok';
          } catch(e) {
            // Connection refused is expected — not HTTPS error
            return e.message.includes('HTTPS') ? 'blocked' : 'allowed-but-failed';
          }
        }
        return { localhostTest: localhostTest };
      `),
    });
    const result = await executeInSandbox(config, "localhostTest", [{}]);
    assertEquals(result.success, true);
    // Should NOT be blocked by HTTPS check
    assert(result.result !== "blocked");
  },
});

// ============================================
// Security: Require module mock
// ============================================

Deno.test('sandbox: require("react") returns mock', async () => {
  const config = makeConfig({
    code: iife(`
      function requireTest() {
        var React = require('react');
        return React.createElement === null || typeof React.createElement === 'function' ? 'mock-ok' : 'unexpected';
      }
      return { requireTest: requireTest };
    `),
  });
  const result = await executeInSandbox(config, "requireTest", [{}]);
  assertEquals(result.success, true);
  assertEquals(result.result, "mock-ok");
});

Deno.test("sandbox: require unknown module throws", async () => {
  const config = makeConfig({
    code: iife(`
      function unknownReqTest() {
        return require('some-unknown-module');
      }
      return { unknownReqTest: unknownReqTest };
    `),
  });
  const result = await executeInSandbox(config, "unknownReqTest", [{}]);
  assertEquals(result.success, false);
  assert(result.error?.message.includes("not available"));
  assert(result.error?.message.includes("some-unknown-module"));
});

// ============================================
// Error handling
// ============================================

Deno.test("sandbox: catches runtime errors gracefully", async () => {
  const config = makeConfig({
    code: iife(`
      function crashTest() {
        throw new Error('intentional crash');
      }
      return { crashTest: crashTest };
    `),
  });
  const result = await executeInSandbox(config, "crashTest", [{}]);
  assertEquals(result.success, false);
  assertEquals(result.error?.message, "intentional crash");
});

Deno.test("sandbox: catches type errors", async () => {
  const config = makeConfig({
    code: iife(`
      function typeErrTest() {
        var x = null;
        return x.property;
      }
      return { typeErrTest: typeErrTest };
    `),
  });
  const result = await executeInSandbox(config, "typeErrTest", [{}]);
  assertEquals(result.success, false);
  assert(result.error?.type === "TypeError");
});

Deno.test("sandbox: returns logs even on error", async () => {
  const config = makeConfig({
    code: iife(`
      function logThenCrash() {
        console.log('before crash');
        throw new Error('boom');
      }
      return { logThenCrash: logThenCrash };
    `),
  });
  const result = await executeInSandbox(config, "logThenCrash", [{}]);
  assertEquals(result.success, false);
  const beforeLog = result.logs.find((l) => l.message === "before crash");
  assert(beforeLog !== undefined);
});

Deno.test("sandbox: handles code compilation errors", async () => {
  const config = makeConfig({
    code: "this is not valid javascript at all {{{",
  });
  const result = await executeInSandbox(config, "anything", [{}]);
  assertEquals(result.success, false);
  // Should be caught as compilation or runtime error
  assert(result.error !== undefined);
});

// ============================================
// Globals availability
// ============================================

Deno.test("sandbox: crypto.randomUUID available", async () => {
  const config = makeConfig({
    code: iife(`
      function cryptoTest() { return crypto.randomUUID(); }
      return { cryptoTest: cryptoTest };
    `),
  });
  const result = await executeInSandbox(config, "cryptoTest", [{}]);
  assertEquals(result.success, true);
  assert(typeof result.result === "string");
  assert((result.result as string).length > 30);
});

Deno.test("sandbox: TextEncoder/TextDecoder available", async () => {
  const config = makeConfig({
    code: iife(`
      function encoderTest() {
        var enc = new TextEncoder();
        var dec = new TextDecoder();
        var bytes = enc.encode('hello');
        return dec.decode(bytes);
      }
      return { encoderTest: encoderTest };
    `),
  });
  const result = await executeInSandbox(config, "encoderTest", [{}]);
  assertEquals(result.result, "hello");
});

Deno.test("sandbox: URL and URLSearchParams available", async () => {
  const config = makeConfig({
    code: iife(`
      function urlTest() {
        var u = new URL('https://example.com/path?foo=bar');
        var params = new URLSearchParams('a=1&b=2');
        return { host: u.hostname, param: params.get('a') };
      }
      return { urlTest: urlTest };
    `),
  });
  const result = await executeInSandbox(config, "urlTest", [{}]);
  const data = result.result as { host: string; param: string };
  assertEquals(data.host, "example.com");
  assertEquals(data.param, "1");
});

Deno.test("sandbox: Map and Set available", async () => {
  const config = makeConfig({
    code: iife(`
      function collectionsTest() {
        var m = new Map();
        m.set('key', 'value');
        var s = new Set([1, 2, 2, 3]);
        return { mapVal: m.get('key'), setSize: s.size };
      }
      return { collectionsTest: collectionsTest };
    `),
  });
  const result = await executeInSandbox(config, "collectionsTest", [{}]);
  const data = result.result as { mapVal: string; setSize: number };
  assertEquals(data.mapVal, "value");
  assertEquals(data.setSize, 3);
});

// ============================================
// globalThis access pattern
// ============================================

Deno.test("sandbox: globalThis.ultralight accessible (IIFE pattern)", async () => {
  const config = makeConfig({
    code: iife(`
      // This mimics how esbuild IIFE bundles capture globalThis at module init
      var ul = globalThis.ultralight;
      async function storeViaGlobal(args) {
        await ul.store('gkey', args.val);
        return await ul.load('gkey');
      }
      return { storeViaGlobal: storeViaGlobal };
    `),
  });
  const result = await executeInSandbox(config, "storeViaGlobal", [{
    val: "from-global",
  }]);
  assertEquals(result.success, true);
  assertEquals(result.result, "from-global");
});

// ============================================
// Result size limit
// ============================================

Deno.test("sandbox: rejects result larger than 5MB", async () => {
  const config = makeConfig({
    code: iife(`
      function bigResult() {
        // Generate a string > 5MB
        return 'x'.repeat(6 * 1024 * 1024);
      }
      return { bigResult: bigResult };
    `),
  });
  const result = await executeInSandbox(config, "bigResult", [{}]);
  assertEquals(result.success, false);
  assert(result.error?.type === "ResultTooLarge");
  assert(result.error?.message.includes("exceeds limit"));
});
