// Bundles the node:test suites into .test-build/ so they can run on plain node
// without a TypeScript loader. Each test file becomes one ESM bundle.

import { readdir, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const testDir = join(root, 'test');
const outDir = join(root, '.test-build');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const entryPoints = (await readdir(testDir))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join(testDir, name));

if (entryPoints.length === 0) {
  throw new Error('no test files found in test/');
}

await esbuild.build({
  entryPoints,
  outdir: outDir,
  outExtension: { '.js': '.js' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  sourcemap: 'inline',
  logLevel: 'warning',
});
