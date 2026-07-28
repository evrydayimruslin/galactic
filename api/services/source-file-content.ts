const textEncoder = new TextEncoder();

/**
 * Source files are text-first, but Galactic also accepts byte-exact binary
 * artifacts. `content` remains available for text-oriented pipeline stages;
 * when `bytes` is present it is the authoritative payload for hashing, quota,
 * bundling, and storage.
 */
export interface BytePreservingSourceContent {
  content: string;
  bytes?: Uint8Array;
}

export function isBinarySourcePath(path: string): boolean {
  return path.toLowerCase().endsWith('.wasm');
}

export function sourceFileBytes(
  file: BytePreservingSourceContent,
): Uint8Array {
  return file.bytes ?? textEncoder.encode(file.content);
}

export function sourceFileByteLength(
  file: BytePreservingSourceContent,
): number {
  return sourceFileBytes(file).byteLength;
}

export function bytesToBinaryString(bytes: Uint8Array): string {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return value;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinaryString(bytes));
}

export function decodeBase64Bytes(value: string): Uint8Array {
  // atob is deliberately used only as a base64 parser. Converting its binary
  // string with TextEncoder would UTF-8-expand bytes >= 0x80.
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
