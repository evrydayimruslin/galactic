import { assertEquals, assertRejects } from '@std/assert/mod.ts';

import { ALLOWED_EXTENSIONS } from '../../shared/types/index.ts';
import {
  base64ToBytes,
  CLI_ALLOWED_EXTENSIONS,
  collectSourceFiles,
  toEncodedSourceFile,
} from '../source-files.ts';

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({
    prefix: 'galactic-source-files-',
  });
  try {
    await run(directory);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test('CLI collection includes every platform-supported extension and preserves wasm bytes', async () => {
  await withTempDirectory(async (directory) => {
    assertEquals(CLI_ALLOWED_EXTENSIONS, ALLOWED_EXTENSIONS);

    for (const extension of CLI_ALLOWED_EXTENSIONS) {
      const path = `${directory}/fixture${extension}`;
      if (extension === '.wasm') {
        await Deno.writeFile(path, new Uint8Array([0, 97, 255, 128]));
      } else {
        await Deno.writeTextFile(path, `fixture:${extension}`);
      }
    }
    await Deno.writeTextFile(`${directory}/ignored.exe`, 'ignored');

    const files = await collectSourceFiles(directory);

    assertEquals(files.length, CLI_ALLOWED_EXTENSIONS.length);
    assertEquals(
      files.map((file) => file.name),
      [...CLI_ALLOWED_EXTENSIONS]
        .map((extension) => `fixture${extension}`)
        .sort((a, b) => a.localeCompare(b)),
    );

    const wasm = files.find((file) => file.name === 'fixture.wasm');
    assertEquals(wasm, {
      name: 'fixture.wasm',
      content: 'AGH/gA==',
      encoding: 'base64',
      size: 4,
    });
    assertEquals(toEncodedSourceFile(wasm!), {
      path: 'fixture.wasm',
      content: 'AGH/gA==',
      encoding: 'base64',
    });
    assertEquals(
      base64ToBytes(wasm!.content),
      new Uint8Array([0, 97, 255, 128]),
    );
  });
});

Deno.test('CLI source collection excludes live env files but permits placeholder examples', async () => {
  await withTempDirectory(async (directory) => {
    await Deno.writeTextFile(`${directory}/.env`, 'SECRET=live\n');
    await Deno.writeTextFile(`${directory}/.env.local`, 'SECRET=local\n');
    await Deno.writeTextFile(
      `${directory}/.env.example`,
      'SECRET=replace-me\n',
    );

    const files = await collectSourceFiles(directory);
    assertEquals(files.map((file) => file.name), ['.env.example']);
  });
});

Deno.test('CLI collection is deterministic, byte-counted, and rejects invalid UTF-8 text', async () => {
  await withTempDirectory(async (directory) => {
    await Deno.mkdir(`${directory}/nested`);
    await Deno.writeTextFile(`${directory}/nested/main.py`, "print('🪐')\n");
    await Deno.writeTextFile(
      `${directory}/ultralight.gpu.yaml`,
      'runtime: python-cuda\n',
    );

    const files = await collectSourceFiles(directory);
    assertEquals(
      files.map((file) => file.name),
      ['nested/main.py', 'ultralight.gpu.yaml'],
    );
    assertEquals(
      files[0].size,
      new TextEncoder().encode("print('🪐')\n").byteLength,
    );
    assertEquals(toEncodedSourceFile(files[0]), {
      path: 'nested/main.py',
      content: "print('🪐')\n",
    });

    await Deno.writeFile(
      `${directory}/invalid.ts`,
      new Uint8Array([0xff, 0xfe]),
    );
    await assertRejects(
      () => collectSourceFiles(directory),
      Error,
      'Source file is not valid UTF-8: invalid.ts',
    );
  });
});
