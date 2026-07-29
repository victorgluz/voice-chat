import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(ROOT, 'client', 'src', 'main.js')],
  outfile: path.join(ROOT, 'public', 'js', 'app.bundle.js'),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build:client] watching for changes...');
} else {
  await esbuild.build(options);
  console.log('[build:client] bundle gerado em public/js/app.bundle.js');
}
