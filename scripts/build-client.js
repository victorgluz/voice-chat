import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const watch = process.argv.includes('--watch');

// Stockfish (bot de xadrez) roda como Worker clássico, então não pode ser
// bundlado pelo esbuild — copiamos o binário single-threaded "lite" (não
// precisa de headers COOP/COEP) direto de node_modules para public/vendor.
function copyStockfish() {
  const src = path.join(ROOT, 'node_modules', 'stockfish', 'bin');
  const dest = path.join(ROOT, 'public', 'vendor', 'stockfish');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(src, 'stockfish-18-lite-single.js'), path.join(dest, 'stockfish.js'));
  fs.copyFileSync(path.join(src, 'stockfish-18-lite-single.wasm'), path.join(dest, 'stockfish.wasm'));
}
copyStockfish();

const options = {
  entryPoints: [path.join(ROOT, 'client', 'src', 'main.js')],
  outfile: path.join(ROOT, 'public', 'js', 'app.bundle.js'),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
  // Assets (ex.: sons .mp3) são copiados para public/js e importados como URL.
  loader: { '.mp3': 'file' },
  publicPath: '/js',
  assetNames: '[name]-[hash]',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build:client] watching for changes...');
} else {
  await esbuild.build(options);
  console.log('[build:client] bundle gerado em public/js/app.bundle.js');
}
