import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { buildAppNetworkDisclosure } from "./trust.ts";
import type { AppManifest } from "../../shared/contracts/manifest.ts";

const MANIFEST = {
  network: {
    allowed_destinations: [
      { host: "api.openai.com", label: "OpenAI", description: "generates taglines" },
      { host: "data.example.com", description: "public quotes" },
    ],
  },
  env_vars: {
    OPENAI_API_KEY: {
      scope: "per_user",
      input: "password",
      required: true,
      label: "API key",
      credential: { destination: "api.openai.com", inject: { as: "bearer" } },
    },
    BUSINESS_NAME: { scope: "per_user", input: "text", label: "Business name" },
    WEBHOOK_SECRET: { scope: "per_user", input: "password", group: "Webhooks" },
    IMAP_HOST: { scope: "per_user", input: "text", group: "Email server" },
    APP_WIDE: { scope: "universal", input: "text" },
  },
} as unknown as AppManifest;

Deno.test("network disclosure: credential secrets nest under their destination", () => {
  const d = buildAppNetworkDisclosure(MANIFEST);

  assertEquals(d.destinations.length, 2);

  const openai = d.destinations[0];
  assertEquals(openai.host, "api.openai.com");
  assertEquals(openai.label, "OpenAI");
  assertEquals(openai.description, "generates taglines");
  assertEquals(openai.credentials, [
    { key: "OPENAI_API_KEY", label: "API key", required: true, connected: undefined },
  ]);

  // Allowlisted destination with no bound credential = transparency-only.
  const market = d.destinations[1];
  assertEquals(market.host, "data.example.com");
  assertEquals(market.credentials, []);
});

Deno.test("network disclosure: unbound per-user vars fall into general_settings; universal excluded", () => {
  const d = buildAppNetworkDisclosure(MANIFEST);
  const keys = d.general_settings.map((s) => s.key);
  assertEquals(keys, ["BUSINESS_NAME", "WEBHOOK_SECRET", "IMAP_HOST"]);

  const byKey = Object.fromEntries(d.general_settings.map((s) => [s.key, s]));
  // A text config is not a secret; a password var is.
  assertEquals(byKey.BUSINESS_NAME.secret, false);
  assertEquals(byKey.WEBHOOK_SECRET.secret, true);
  // Display-only group label is carried through.
  assertEquals(byKey.IMAP_HOST.group, "Email server");
  assertEquals(byKey.BUSINESS_NAME.group, null);
  // Universal (developer-set) var never appears on the user's surface.
  assertEquals(keys.includes("APP_WIDE"), false);
});

Deno.test("network disclosure: connected flag reflects the viewing user's own secrets", () => {
  const d = buildAppNetworkDisclosure(
    MANIFEST,
    new Set(["OPENAI_API_KEY", "BUSINESS_NAME"]),
  );
  assertEquals(d.destinations[0].credentials[0].connected, true);
  const byKey = Object.fromEntries(d.general_settings.map((s) => [s.key, s]));
  assertEquals(byKey.BUSINESS_NAME.connected, true);
  assertEquals(byKey.WEBHOOK_SECRET.connected, false);
});

Deno.test("network disclosure: never contains a secret value", () => {
  const d = buildAppNetworkDisclosure(
    MANIFEST,
    new Set(["OPENAI_API_KEY"]),
  );
  // Structural guarantee: only key names / metadata are present.
  const serialized = JSON.stringify(d);
  assertEquals(serialized.includes("value"), false);
});
