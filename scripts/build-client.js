import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, copyFile } from 'node:fs/promises';
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

async function copyWnsAssets() {
  const wnsOut = path.join(ROOT, 'public', 'wns');
  const wnsSrc = path.join(ROOT, 'node_modules', '@sapphi-red', 'web-noise-suppressor', 'dist');
  await mkdir(wnsOut, { recursive: true });
  await copyFile(path.join(wnsSrc, 'rnnoise', 'workletProcessor.js'), path.join(wnsOut, 'rnnoiseWorklet.js'));
  await copyFile(path.join(wnsSrc, 'rnnoise.wasm'), path.join(wnsOut, 'rnnoise.wasm'));
  await copyFile(path.join(wnsSrc, 'rnnoise_simd.wasm'), path.join(wnsOut, 'rnnoise_simd.wasm'));
  console.log('[build:client] assets RNNoise copiados para public/wns/');
}

if (watch) {
  await copyWnsAssets();
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build:client] watching for changes...');
} else {
  await Promise.all([esbuild.build(options), copyWnsAssets()]);
  console.log('[build:client] bundle gerado em public/js/app.bundle.js');
}
