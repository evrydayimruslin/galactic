import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { handleApps } from "./apps.ts";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const APP_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_TOKEN = "owner-session-token";

function gif(width: number): Uint8Array {
  const height = 24;
  return new Uint8Array([
    ...new TextEncoder().encode("GIF89a"),
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
    0,
    0,
    0,
    0x2c,
    0,
    0,
    0,
    0,
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
    0,
    2,
    1,
    0,
    0,
    0x3b,
  ]);
}

class FakeR2Object {
  constructor(private readonly bytes: Uint8Array) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer;
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }
}

class FakeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array): Promise<void> {
    this.objects.set(key, value.slice());
  }

  async get(key: string): Promise<FakeR2Object | null> {
    const value = this.objects.get(key);
    return value ? new FakeR2Object(value) : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(options: { prefix?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: false;
  }> {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(options.prefix || ""))
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}

function authenticated(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${SESSION_TOKEN}`);
  return new Request(url, { ...init, headers });
}

async function upload(bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.set("icon", new File([bytes], "icon.gif", { type: "image/gif" }));
  const response = await handleApps(authenticated(
    `https://api.test/api/apps/${APP_ID}/icon`,
    { method: "POST", body: form },
  ));
  assertEquals(response.status, 200);
  return (await response.json() as { icon_url: string }).icon_url;
}

Deno.test("icon uploads preserve old URL bytes and private responses cannot be cached", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const bucket = new FakeR2Bucket();
  const app: Record<string, unknown> = {
    id: APP_ID,
    owner_id: OWNER_ID,
    name: "Private Agent",
    slug: "private-agent",
    visibility: "private",
    icon_url: null,
    deleted_at: null,
  };

  globalThis.__env = {
    ...(previousEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    R2_BUCKET: bucket,
  } as typeof globalThis.__env;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/auth/v1/user") {
      return request.headers.get("Authorization") === `Bearer ${SESSION_TOKEN}`
        ? Response.json({ id: OWNER_ID, email: "owner@example.com" })
        : new Response("invalid", { status: 401 });
    }
    if (url.pathname === "/rest/v1/users" && request.method === "GET") {
      return Response.json([{ id: OWNER_ID, tier: "pro" }]);
    }
    if (url.pathname === "/rest/v1/apps" && request.method === "GET") {
      if (url.searchParams.has("visibility")) {
        return Response.json(app.visibility === "private" ? [] : [app]);
      }
      return Response.json([app]);
    }
    if (url.pathname === "/rest/v1/apps" && request.method === "PATCH") {
      Object.assign(app, await request.json());
      return Response.json([app]);
    }
    throw new Error(`Unexpected fetch in icon test: ${request.method} ${url}`);
  };

  try {
    const firstBytes = gif(32);
    const secondBytes = gif(33);
    const firstUrl = await upload(firstBytes);
    const secondUrl = await upload(secondBytes);
    assertEquals(firstUrl === secondUrl, false);

    const anonymous = await handleApps(
      new Request(`https://api.test${firstUrl}`),
    );
    assertEquals(anonymous.status, 404);

    const oldResponse = await handleApps(authenticated(`https://api.test${firstUrl}`));
    assertEquals(oldResponse.status, 200);
    assertEquals(new Uint8Array(await oldResponse.arrayBuffer()), firstBytes);
    assertEquals(oldResponse.headers.get("Cache-Control"), "private, no-store");
    assertStringIncludes(oldResponse.headers.get("Vary") || "", "Authorization");
    assertStringIncludes(oldResponse.headers.get("Vary") || "", "Cookie");

    const newResponse = await handleApps(authenticated(`https://api.test${secondUrl}`));
    assertEquals(new Uint8Array(await newResponse.arrayBuffer()), secondBytes);
    assertEquals(bucket.objects.size, 2);

    app.visibility = "public";
    const publicResponse = await handleApps(new Request(`https://api.test${secondUrl}`));
    assertEquals(publicResponse.status, 200);
    assertEquals(
      publicResponse.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});
