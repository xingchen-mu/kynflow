// Static demo build: the real interface, a preloaded board, no server.
// `PUBLIC_BASE` sets the path it is served from (GitHub Pages project sites use /<repo>/).
import { cp, copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'vite';

const OUT = 'dist-demo';
const base = process.env.PUBLIC_BASE ?? '/kynflow/';

process.env.VITE_DEMO = '1';
process.env.VITE_BASE = base;

await build({ base, build: { outDir: OUT, emptyOutDir: true } });

// The fixture and its media are plain files next to the bundle, not part of it.
await cp('demo', join(OUT, 'demo'), { recursive: true });
// GitHub Pages serves 404.html for unknown paths; the app has no router, so every path is the app.
await copyFile(join(OUT, 'index.html'), join(OUT, '404.html'));
// Keep Pages from running Jekyll over the output.
await writeFile(join(OUT, '.nojekyll'), '');

async function size(dir) {
  let total = 0;
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await stat(path);
    total += info.isDirectory() ? await size(path) : info.size;
  }
  return total;
}

const index = await readFile(join(OUT, 'index.html'), 'utf8');
const referenced = [...index.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((p) => !p.startsWith('data:'));
console.log(`demo build → ${OUT}/ (base ${base}, ${(await size(OUT) / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  index references: ${referenced.join(', ')}`);
if (!referenced.every((p) => p.startsWith(base))) console.log('  warning: a reference is outside the base path');
