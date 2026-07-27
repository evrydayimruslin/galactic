import { assertEquals } from 'jsr:@std/assert';

import { bytesToBinaryString } from './source-file-content.ts';
import { processUploadPipeline } from './upload-pipeline.ts';
import { buildVersionTrustMetadata, sha256Hex } from './trust.ts';

Deno.test('upload pipeline stores and signs byte-exact wasm source', async () => {
  const wasmBytes = new Uint8Array([0, 97, 255, 128]);
  const pipeline = await processUploadPipeline([
    {
      name: 'index.js',
      content: 'export function run() { return true; }',
    },
    {
      name: 'module.wasm',
      content: bytesToBinaryString(wasmBytes),
      bytes: wasmBytes,
    },
  ], {
    name: 'Binary Agent',
    version: '1.0.0',
  });

  const storedWasm = pipeline.filesToUpload.find((file) => file.name === 'module.wasm');
  assertEquals(storedWasm?.content, wasmBytes);
  assertEquals(storedWasm?.contentType, 'application/wasm');

  const trust = await buildVersionTrustMetadata({
    appId: 'app-1',
    version: '1.0.0',
    runtime: pipeline.runtime,
    manifest: pipeline.manifest,
    files: pipeline.filesToUpload,
    storageKey: 'apps/app-1/1.0.0/',
  });
  assertEquals(
    trust.artifact_hashes['module.wasm'],
    await sha256Hex(wasmBytes),
  );
});
