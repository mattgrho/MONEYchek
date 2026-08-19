import { build } from 'esbuild';

// Bundle the server TypeScript into a single ESM file. All node_modules stay
// external (the deployment keeps node_modules); this is transpilation plus
// path-alias resolution, not vendoring.
await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
});
