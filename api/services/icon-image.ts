const MAX_ICON_DIMENSION = 1024;
const MAX_GIF_FRAMES = 120;
// A small compressed GIF can expand into hundreds of megabytes once every
// frame is decoded. Bound the aggregate canvas work in addition to bytes,
// dimensions, and frame count so one Fleet icon cannot exhaust a browser tab.
const MAX_GIF_PIXEL_FRAMES = 16 * 1024 * 1024;

export type SupportedIconMime =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export const ICON_EXTENSIONS = ["png", "jpg", "webp", "gif"] as const;
export type IconExtension = (typeof ICON_EXTENSIONS)[number];

// New objects use the full digest. The 16-character form remains readable so
// URLs emitted by the short-lived pre-content-addressed implementation can be
// promoted safely after their legacy bytes are hash-verified.
const ICON_VERSION_RE = /^(?:[0-9a-f]{16}|[0-9a-f]{64})$/;

export interface IconReference {
  extension: IconExtension | null;
  version: string | null;
}

export interface ValidatedIcon {
  extension: IconExtension;
  width: number;
  height: number;
  frameCount: number;
}

export function isIconExtension(value: string | null): value is IconExtension {
  return value !== null && (ICON_EXTENSIONS as readonly string[]).includes(value);
}

export function isIconContentVersion(value: string | null): value is string {
  return value !== null && ICON_VERSION_RE.test(value);
}

export function iconContentType(extension: IconExtension): SupportedIconMime {
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
  }
}

/**
 * Parse the persisted icon URL without trusting it as an object key. A URL with
 * a version is valid only when it also pins a supported format. URLs without a
 * version are legacy references and may use the old mutable object keys.
 */
export function parseIconReference(iconUrl: string | null | undefined): IconReference | null {
  if (!iconUrl) return null;
  try {
    const parsed = new URL(iconUrl, "https://galactic.invalid");
    const rawExtension = parsed.searchParams.get("format");
    const rawVersion = parsed.searchParams.get("v");
    if (rawVersion !== null) {
      if (!isIconExtension(rawExtension) || !isIconContentVersion(rawVersion)) return null;
      return { extension: rawExtension, version: rawVersion };
    }
    if (rawExtension !== null && !isIconExtension(rawExtension)) return null;
    return { extension: rawExtension, version: null };
  } catch {
    return null;
  }
}

export function versionedIconObjectKey(
  appId: string,
  extension: IconExtension,
  version: string,
): string {
  if (!isIconContentVersion(version)) throw new Error("Invalid icon content version");
  return `apps/${appId}/icons/${version}.${extension}`;
}

export function legacyIconObjectKey(appId: string, extension: IconExtension): string {
  return `apps/${appId}/icon.${extension}`;
}

/**
 * Keep the current and immediately previous immutable objects, then retain a
 * small deterministic tail. R2 list results do not expose creation order here,
 * so correctness comes from the protected keys; the remainder is only a
 * bounded rollback/debug cushion.
 */
export function selectVersionedIconKeysForDeletion(
  keys: string[],
  protectedKeys: ReadonlySet<string>,
  maximumRetained = 8,
): string[] {
  const unique = [...new Set(keys)].sort();
  const protectedPresent = unique.filter((key) => protectedKeys.has(key));
  const available = Math.max(0, maximumRetained - protectedPresent.length);
  const retainedExtras = new Set(
    available === 0
      ? []
      : unique.filter((key) => !protectedKeys.has(key)).slice(-available),
  );
  return unique.filter((key) => !protectedKeys.has(key) && !retainedExtras.has(key));
}

function fail(message: string): never {
  throw new Error(message);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function dimensions(width: number, height: number): { width: number; height: number } {
  if (
    !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    width > MAX_ICON_DIMENSION || height > MAX_ICON_DIMENSION
  ) {
    fail(`Icon dimensions must be between 1 and ${MAX_ICON_DIMENSION}px.`);
  }
  return { width, height };
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 33 ||
    !signature.every((value, index) => bytes[index] === value) ||
    ascii(bytes, 12, 4) !== "IHDR"
  ) {
    fail("The uploaded file is not a valid PNG.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) fail("The uploaded PNG has an invalid IHDR.");
  return dimensions(view.getUint32(16), view.getUint32(20));
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    fail("The uploaded file is not a valid JPEG.");
  }
  let offset = 2;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (sof.has(marker)) {
      if (length < 7) break;
      return dimensions(
        (bytes[offset + 5] << 8) | bytes[offset + 6],
        (bytes[offset + 3] << 8) | bytes[offset + 4],
      );
    }
    offset += length;
  }
  return fail("The JPEG dimensions could not be read.");
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP"
  ) {
    fail("The uploaded file is not a valid WebP image.");
  }
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    if ((bytes[20] & 0x02) !== 0) {
      fail("Animated WebP icons are not supported. Use GIF for animation.");
    }
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return dimensions(width, height);
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return dimensions(
      (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    );
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const width = 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8));
    const height = 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10));
    return dimensions(width, height);
  }
  return fail("The WebP dimensions could not be read.");
}

function skipGifSubBlocks(bytes: Uint8Array, offset: number): number {
  while (offset < bytes.length) {
    const length = bytes[offset++];
    if (length === 0) return offset;
    if (offset + length > bytes.length) fail("The GIF data is truncated.");
    offset += length;
  }
  return fail("The GIF data is truncated.");
}

function gifInfo(bytes: Uint8Array): { width: number; height: number; frameCount: number } {
  const header = ascii(bytes, 0, 6);
  if (bytes.length < 13 || (header !== "GIF87a" && header !== "GIF89a")) {
    fail("The uploaded file is not a valid GIF.");
  }
  const size = dimensions(bytes[6] | (bytes[7] << 8), bytes[8] | (bytes[9] << 8));
  let offset = 13;
  const globalPacked = bytes[10];
  if (globalPacked & 0x80) offset += 3 * (2 ** ((globalPacked & 0x07) + 1));
  let frameCount = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      if (offset >= bytes.length) fail("The GIF extension is truncated.");
      offset += 1; // extension label
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) {
      fail("The GIF block structure is invalid.");
    }
    const left = bytes[offset] | (bytes[offset + 1] << 8);
    const top = bytes[offset + 2] | (bytes[offset + 3] << 8);
    const frameWidth = bytes[offset + 4] | (bytes[offset + 5] << 8);
    const frameHeight = bytes[offset + 6] | (bytes[offset + 7] << 8);
    dimensions(frameWidth, frameHeight);
    if (left + frameWidth > size.width || top + frameHeight > size.height) {
      fail("A GIF frame extends beyond the bounded icon canvas.");
    }
    frameCount += 1;
    if (frameCount > MAX_GIF_FRAMES) {
      fail(`Animated icons may contain at most ${MAX_GIF_FRAMES} frames.`);
    }
    const localPacked = bytes[offset + 8];
    offset += 9;
    if (localPacked & 0x80) offset += 3 * (2 ** ((localPacked & 0x07) + 1));
    if (offset >= bytes.length) fail("The GIF image data is truncated.");
    offset += 1; // LZW minimum code size
    offset = skipGifSubBlocks(bytes, offset);
  }
  if (frameCount < 1) fail("The GIF contains no image frames.");
  if (size.width * size.height * frameCount > MAX_GIF_PIXEL_FRAMES) {
    fail("Animated icons contain too many decoded pixels.");
  }
  return { ...size, frameCount };
}

export function validateIconImage(
  mime: string,
  bytes: Uint8Array,
): ValidatedIcon {
  switch (mime as SupportedIconMime) {
    case "image/png": {
      const size = pngDimensions(bytes);
      return { extension: "png", ...size, frameCount: 1 };
    }
    case "image/jpeg": {
      const size = jpegDimensions(bytes);
      return { extension: "jpg", ...size, frameCount: 1 };
    }
    case "image/webp": {
      const size = webpDimensions(bytes);
      return { extension: "webp", ...size, frameCount: 1 };
    }
    case "image/gif": {
      const info = gifInfo(bytes);
      return { extension: "gif", ...info };
    }
    default:
      return fail("Invalid file type. Use PNG, JPG, WebP, or GIF.");
  }
}

export async function iconContentVersion(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
