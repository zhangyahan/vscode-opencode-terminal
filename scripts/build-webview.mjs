import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('media', { recursive: true });

await build({
  entryPoints: ['media/src/webview.ts'],
  outfile: 'media/webview.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});
