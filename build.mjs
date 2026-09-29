// Bundles the userscript sources into a single installable .user.js file.
//
// hls.js is NOT bundled: it is loaded by the userscript manager through the
// `@require` line in metadata.txt. The build asserts that, plus that nothing
// hls.js-sized slipped into the output (a value import of `hls.js` would
// silently inline ~1 MB of duplicate player code).

import { readFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const outFile = join(root, 'dist', 'stremio-local-proxy-hls.user.js');

// Anything larger than this means a dependency got inlined by accident.
const MAX_OUTPUT_BYTES = 200_000;

const minify = process.argv.includes('--minify');

const banner = await readFile(join(root, 'metadata.txt'), 'utf8');

if (!banner.includes('@require') || !banner.includes('hls.js')) {
  throw new Error('metadata.txt must keep the hls.js @require line');
}

await mkdir(dirname(outFile), { recursive: true });

const result = await esbuild.build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: outFile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome80', 'firefox115'],
  charset: 'utf8',
  legalComments: 'none',
  minify,
  sourcemap: false,
  banner: { js: banner.trimEnd() },
  logLevel: 'warning',
  metafile: true,
});

const { size } = await stat(outFile);

if (size > MAX_OUTPUT_BYTES) {
  throw new Error(
    `bundle is ${size} bytes (> ${MAX_OUTPUT_BYTES}); hls.js must stay external via @require`,
  );
}

const inputs = Object.keys(result.metafile.inputs).filter((name) => !name.startsWith('node_modules'));

console.log(`built ${outFile}`);
console.log(`  ${(size / 1024).toFixed(1)} KiB, ${inputs.length} module(s)${minify ? ', minified' : ''}`);
for (const name of inputs.sort()) console.log(`    ${name}`);
