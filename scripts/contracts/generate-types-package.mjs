import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from '../../api/node_modules/typescript/lib/typescript.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractsDir = path.join(repoRoot, 'shared', 'contracts');
const packageDir = path.join(repoRoot, 'packages', 'types');
const generatedDir = path.join(packageDir, 'generated');
const templatePath = path.join(packageDir, 'index.template.d.ts');
const outputPath = path.join(packageDir, 'index.d.ts');

const contractFiles = [
  'agentic-interface.ts',
  'ai.ts',
  'compute.ts',
  'env.ts',
  'jsonrpc.ts',
  'manifest.ts',
  'mcp.ts',
  'runtime.ts',
  'sdk.ts',
  'widget.ts',
].map((file) => path.join(contractsDir, file));

async function rmSafe(target) {
  await fs.rm(target, { recursive: true, force: true });
}

function emitSharedContractDeclarations() {
  const options = {
    declaration: true,
    emitDeclarationOnly: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    rootDir: repoRoot,
    outDir: generatedDir,
    skipLibCheck: true,
    strict: true,
    allowImportingTsExtensions: true,
  };

  const host = ts.createCompilerHost(options);
  const program = ts.createProgram(contractFiles, options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  if (diagnostics.length > 0) {
    const message = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    });
    throw new Error(message);
  }

  const result = program.emit();
  if (result.emitSkipped) {
    throw new Error('Type declaration emit was skipped for shared contracts.');
  }
}

async function main() {
  await rmSafe(generatedDir);
  emitSharedContractDeclarations();
  const template = await fs.readFile(templatePath, 'utf8');
  await fs.writeFile(outputPath, template, 'utf8');
  console.log('Generated @ultralightpro/types declarations.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
