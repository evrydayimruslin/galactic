import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(scriptDir, '..');
const baselinePath = resolve(apiDir, 'typecheck-baseline.txt');
const tsconfigPath = resolve(apiDir, 'tsconfig.check.json');
const tscPath = require.resolve('typescript/bin/tsc');
const shouldWriteBaseline = process.argv.includes('--write-baseline');

function normalizeOutput(output) {
  return output
    .replaceAll('\r\n', '\n')
    .replaceAll(`${apiDir}/`, '')
    .trim();
}

function countErrors(output) {
  return (output.match(/error TS\d+:/g) ?? []).length;
}

const result = spawnSync(process.execPath, [tscPath, '-p', tsconfigPath, '--pretty', 'false'], {
  cwd: apiDir,
  encoding: 'utf8',
});

const rawOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const normalizedOutput = normalizeOutput(rawOutput);
const baselineOutput = existsSync(baselinePath)
  ? normalizeOutput(readFileSync(baselinePath, 'utf8'))
  : '';

if (shouldWriteBaseline) {
  writeFileSync(baselinePath, normalizedOutput ? `${normalizedOutput}\n` : '', 'utf8');
  console.log(
    normalizedOutput
      ? `Updated typecheck baseline with ${countErrors(normalizedOutput)} known error(s).`
      : 'Updated typecheck baseline: no remaining errors.',
  );
  process.exit(0);
}

if (!normalizedOutput) {
  if (baselineOutput) {
    console.error('Typecheck is now clean but typecheck-baseline.txt still contains stale errors.');
    console.error('Run `npm run typecheck:update-baseline` (or the pnpm equivalent) to clear the baseline.');
    process.exit(1);
  }

  console.log('API typecheck passed with no errors.');
  process.exit(0);
}

if (normalizedOutput === baselineOutput) {
  console.log(`API typecheck matched baseline (${countErrors(normalizedOutput)} known error(s)).`);
  process.exit(0);
}

console.error('API typecheck output changed from the committed baseline.');
console.error(`Current error count: ${countErrors(normalizedOutput)}.`);
console.error('Run `npm run typecheck:full` to inspect the raw output.');
console.error('If the new output is intentional, refresh the baseline with `npm run typecheck:update-baseline`.');
process.exit(1);
