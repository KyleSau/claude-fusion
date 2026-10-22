// Bundles the VS Code extension and the CLI into self-contained CommonJS files in dist/.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  legalComments: 'none',
  logLevel: 'info',
  external: ['vscode'],
};

const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js' }),
  esbuild.context({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', banner: { js: '#!/usr/bin/env node' } }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
