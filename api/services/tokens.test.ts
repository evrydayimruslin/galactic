import { assert, assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  classifyApiTokenCompatibility,
  isTokenVerdictCacheFresh,
  resolveTokenExpiry,
  verifyApiTokenRecord,
} from "./tokens.ts";

Deno.test("tokens: classifies canonical salted rows", () => {
  assertEquals(
    classifyApiTokenCompatibility({
      token_salt: "salt-123",
      plaintext_token: "ul_abcdef0123456789abcdef0123456789",
    }),
    "canonical",
  );
});

Deno.test("tokens: classifies canonical rows that no longer retain plaintext", () => {
  assertEquals(
    classifyApiTokenCompatibility({
      token_salt: "salt-123",
      plaintext_token: null,
    }),
    "canonical_missing_plaintext",
  );
});

Deno.test("tokens: classifies legacy rows that can be backfilled from plaintext", () => {
  assertEquals(
    classifyApiTokenCompatibility({
      token_salt: null,
      plaintext_token: "ul_abcdef0123456789abcdef0123456789",
    }),
    "legacy_backfillable_from_plaintext",
  );
});

Deno.test("tokens: classifies unrecoverable legacy rows", () => {
  assertEquals(
    classifyApiTokenCompatibility({
      token_salt: null,
      plaintext_token: null,
    }),
    "legacy_unrecoverable",
  );
});

Deno.test("tokens: verifies canonical salted rows without migration", async () => {
  const token = "ul_abcdef0123456789abcdef0123456789";
  const canonical = await verifyApiTokenRecord(token, {
    token_hash: "ignored",
    token_salt: "salt-123",
    plaintext_token: token,
  });

  assertEquals(canonical.state, "canonical");
  assertEquals(canonical.valid, false);
  assertEquals(canonical.reason, "hash_mismatch");
});

Deno.test("tokens: verifies canonical salted rows when the stored hash matches", async () => {
  const token = "ul_abcdef0123456789abcdef0123456789";
  const salted = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("salt-123"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", salted, new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(sig)).map((byte) => byte.toString(16).padStart(2, "0")).join("");

  const canonical = await verifyApiTokenRecord(token, {
    token_hash: tokenHash,
    token_salt: "salt-123",
    plaintext_token: null,
  });

  assertEquals(canonical.state, "canonical_missing_plaintext");
  assertEquals(canonical.valid, true);
  assertEquals(canonical.canonical_update, undefined);
});

Deno.test("tokens: verifies legacy plaintext rows and returns a canonical backfill payload", async () => {
  const token = "ul_abcdef0123456789abcdef0123456789";
  const verification = await verifyApiTokenRecord(token, {
    token_hash: "legacy-hash-no-longer-used",
    token_salt: null,
    plaintext_token: token,
  });

  assertEquals(verification.state, "legacy_backfillable_from_plaintext");
  assertEquals(verification.valid, true);
  assert(!!verification.canonical_update);
  assertEquals(typeof verification.canonical_update?.token_salt, "string");
  assertEquals(typeof verification.canonical_update?.token_hash, "string");
  assertEquals(verification.canonical_update?.token_salt.length, 32);
  assertEquals(verification.canonical_update?.token_hash.length, 64);
});

Deno.test("tokens: rejects legacy rows when plaintext does not match", async () => {
  const verification = await verifyApiTokenRecord("ul_abcdef0123456789abcdef0123456789", {
    token_hash: "legacy-hash-no-longer-used",
    token_salt: null,
    plaintext_token: "ul_deadbeefdeadbeefdeadbeefdeadbeef",
  });

  assertEquals(verification.state, "legacy_backfillable_from_plaintext");
  assertEquals(verification.valid, false);
  assertEquals(verification.reason, "plaintext_mismatch");
});

Deno.test("tokens: rejects unrecoverable legacy rows without token material", async () => {
  const verification = await verifyApiTokenRecord("ul_abcdef0123456789abcdef0123456789", {
    token_hash: "legacy-hash-no-longer-used",
    token_salt: null,
    plaintext_token: null,
  });

  assertEquals(verification.state, "legacy_unrecoverable");
  assertEquals(verification.valid, false);
  assertEquals(verification.reason, "missing_token_material");
});

Deno.test("tokens: exact short-lived expiry is preserved without day rounding", () => {
  const now = new Date("2026-07-27T12:00:00.000Z");
  const expiresAt = new Date("2026-07-27T12:30:00.000Z");
  assertEquals(
    resolveTokenExpiry({ expiresAt }, now),
    "2026-07-27T12:30:00.000Z",
  );
});

Deno.test("tokens: exact expiry fails closed when stale or ambiguous", () => {
  const now = new Date("2026-07-27T12:00:00.000Z");
  for (
    const options of [
      { expiresAt: new Date("2026-07-27T11:59:59.000Z") },
      {
        expiresAt: new Date("2026-07-27T12:30:00.000Z"),
        expiresInDays: 1,
      },
    ]
  ) {
    let message = "";
    try {
      resolveTokenExpiry(options, now);
    } catch (reason) {
      message = reason instanceof Error ? reason.message : String(reason);
    }
    assert(message.length > 0);
  }
});

Deno.test("tokens: cached verdict cannot outlive the token's exact expiry", () => {
  const cachedAt = Date.parse("2026-07-27T12:00:00.000Z");
  const expiresAt = "2026-07-27T12:00:30.000Z";
  assertEquals(
    isTokenVerdictCacheFresh(
      cachedAt,
      expiresAt,
      Date.parse("2026-07-27T12:00:29.999Z"),
    ),
    true,
  );
  assertEquals(
    isTokenVerdictCacheFresh(
      cachedAt,
      expiresAt,
      Date.parse("2026-07-27T12:00:30.000Z"),
    ),
    false,
  );
  assertEquals(
    isTokenVerdictCacheFresh(
      cachedAt,
      "not-a-date",
      Date.parse("2026-07-27T12:00:01.000Z"),
    ),
    false,
  );
});
