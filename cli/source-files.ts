// The CLI is published as a self-contained npm package, so it cannot import the
// repository-level shared module at runtime. A parity test compares this list
// byte-for-byte with shared/types/index.ts to make drift a release failure.
export const CLI_ALLOWED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.svg',
  '.md',
  '.mdx',
  '.txt',
  '.csv',
  '.sql',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.conf',
  '.env.example',
  '.sh',
  '.bash',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.wasm',
  '.graphql',
  '.gql',
  '.prisma',
  '.lock',
  '.gitignore',
  '.dockerignore',
  '.dockerfile',
  '.editorconfig',
] as const;

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.galactic',
  '.ultralight',
]);

// The source protocol is text-first, but WebAssembly is an allowed deployment
// artifact. Keep binary classification explicit so adding another binary
// extension requires an intentional transport decision instead of silently
// decoding bytes as UTF-8.
const BINARY_EXTENSIONS = new Set(['.wasm']);

export interface CollectedSourceFile {
  name: string;
  content: string;
  size: number;
  encoding?: 'base64';
}

export interface EncodedSourceFile {
  path: string;
  content: string;
  encoding?: 'base64';
}

function hasAllowedExtension(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return CLI_ALLOWED_EXTENSIONS.some((extension) => lowerPath.endsWith(extension));
}

function isBinarySourceFile(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return [...BINARY_EXTENSIONS].some((extension) => lowerPath.endsWith(extension));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Collect every platform-supported source file in deterministic path order.
 * Text files must be valid UTF-8; binary artifacts use the protocol's base64
 * encoding instead of being silently corrupted by a text read.
 */
export async function collectSourceFiles(
  directory: string,
): Promise<CollectedSourceFile[]> {
  const files: CollectedSourceFile[] = [];

  async function walk(path: string, relativeDirectory: string): Promise<void> {
    for await (const entry of Deno.readDir(path)) {
      const fullPath = `${path}/${entry.name}`;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;

      if (entry.isDirectory) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await walk(fullPath, relativePath);
        }
        continue;
      }
      if (!entry.isFile || !hasAllowedExtension(relativePath)) continue;

      const bytes = await Deno.readFile(fullPath);
      if (isBinarySourceFile(relativePath)) {
        files.push({
          name: relativePath,
          content: bytesToBase64(bytes),
          encoding: 'base64',
          size: bytes.byteLength,
        });
        continue;
      }

      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error(
          `Source file is not valid UTF-8: ${relativePath}. ` +
            'Only .wasm files currently support binary uploads.',
        );
      }
      files.push({
        name: relativePath,
        content,
        size: bytes.byteLength,
      });
    }
  }

  await walk(directory, '');
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Convert a collected file without dropping its binary transport metadata. */
export function toEncodedSourceFile(
  file: CollectedSourceFile,
): EncodedSourceFile {
  return {
    path: file.name,
    content: file.content,
    ...(file.encoding ? { encoding: file.encoding } : {}),
  };
}
