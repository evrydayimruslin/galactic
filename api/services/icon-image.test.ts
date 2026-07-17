import { assertEquals, assertThrows } from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  iconContentVersion,
  parseIconReference,
  selectVersionedIconKeysForDeletion,
  validateIconImage,
  versionedIconObjectKey,
} from "./icon-image.ts";

function gif(width = 32, height = 24, frames = 1): Uint8Array {
  const image = [
    0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0,
    2, 1, 0, 0,
  ];
  return new Uint8Array([
    ...new TextEncoder().encode("GIF89a"),
    width & 0xff, width >> 8, height & 0xff, height >> 8,
    0, 0, 0,
    ...Array.from({ length: frames }, () => image).flat(),
    0x3b,
  ]);
}

Deno.test("GIF icons retain dimensions and animation-safe metadata", () => {
  assertEquals(validateIconImage("image/gif", gif()), {
    extension: "gif",
    width: 32,
    height: 24,
    frameCount: 1,
  });
});

Deno.test("icon validation rejects MIME spoofing and oversized dimensions", () => {
  assertThrows(() => validateIconImage("image/png", gif()));
  assertThrows(() => validateIconImage("image/gif", gif(2048, 10)));
  assertThrows(
    () => validateIconImage("image/gif", gif(1024, 1024, 17)),
    Error,
    "decoded pixels",
  );
});

Deno.test("GIF validation bounds each frame inside the logical canvas", () => {
  const oversizedFrame = gif(32, 24);
  // Image descriptor width occupies bytes 18..19 in this compact fixture.
  oversizedFrame[18] = 0xff;
  oversizedFrame[19] = 0x03;
  assertThrows(() => validateIconImage("image/gif", oversizedFrame));
});

Deno.test("animated WebP must use the frame-bounded GIF path", () => {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  bytes[20] = 0x02;
  assertThrows(() => validateIconImage("image/webp", bytes));
});

Deno.test("icon content versions are deterministic and content-addressed", async () => {
  const first = await iconContentVersion(gif());
  assertEquals(first, await iconContentVersion(gif()));
  const changed = gif(33, 24);
  assertEquals(first === await iconContentVersion(changed), false);
});

Deno.test("icon references accept exact versions and distinguish legacy URLs", () => {
  assertEquals(
    parseIconReference("/api/apps/a/icon?format=gif&v=0123456789abcdef"),
    { extension: "gif", version: "0123456789abcdef" },
  );
  assertEquals(parseIconReference("/api/apps/a/icon?format=png"), {
    extension: "png",
    version: null,
  });
  assertEquals(parseIconReference("/api/apps/a/icon?v=0123456789abcdef"), null);
  assertEquals(parseIconReference("/api/apps/a/icon?format=svg&v=0123456789abcdef"), null);
});

Deno.test("versioned icon cleanup always protects current and previous objects", () => {
  const prefix = "apps/a/icons/";
  const keys = Array.from(
    { length: 12 },
    (_, index) => `${prefix}${index.toString(16).padStart(16, "0")}.gif`,
  );
  const current = keys[0];
  const previous = keys[1];
  const deleted = selectVersionedIconKeysForDeletion(
    keys,
    new Set([current, previous]),
    8,
  );
  assertEquals(deleted.includes(current), false);
  assertEquals(deleted.includes(previous), false);
  assertEquals(keys.length - deleted.length, 8);
  assertEquals(
    versionedIconObjectKey("a", "gif", "0123456789abcdef"),
    "apps/a/icons/0123456789abcdef.gif",
  );
});
