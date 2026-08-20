import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository root, resolved by walking up to the nearest package.json. Works
 * both when running TypeScript sources (server/…) and the bundled build
 * (dist/server/index.mjs).
 */
function findRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('package.json not found above ' + startDir);
    dir = parent;
  }
}

export const repoRoot = findRoot(path.dirname(fileURLToPath(import.meta.url)));
