import { serviceWorker } from './service-worker.mjs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = new URL('../dist/client/', import.meta.url);
const files = await readdir(root, { recursive: true, withFileTypes: true });
const assets = files
  .filter(
    (f) => f.isFile() && !f.name.startsWith('_') && !f.name.startsWith('.') && f.name !== 'sw.js',
  )
  .map((f) => relative(fileURLToPath(root), join(f.parentPath, f.name)).split(sep).join('/'));
const index = await readFile(new URL('index.html', root));
const cache = `linebreak-${createHash('sha256').update(index).digest('hex').slice(0, 12)}`;
await writeFile(new URL('sw.js', root), serviceWorker(cache, ['/', ...assets.map((f) => '/' + f)]));
console.log(`Offline cache: ${assets.length} static assets (${cache})`);
