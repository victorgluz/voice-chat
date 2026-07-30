import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';

let wasmBinary = null;
let workletRegistered = false;

async function loadAssets(ctx) {
  if (!wasmBinary) {
    wasmBinary = await loadRnnoise({
      url: '/wns/rnnoise.wasm',
      simdUrl: '/wns/rnnoise_simd.wasm',
    });
  }
  if (!workletRegistered) {
    await ctx.audioWorklet.addModule('/wns/rnnoiseWorklet.js');
    workletRegistered = true;
  }
}

export class NoiseSuppressor {
  constructor() {
    this._ctx = null;
    this._rnnoise = null;
    this._dest = null;
  }

  async process(rawTrack) {
    try {
      const ctx = new AudioContext({ sampleRate: 48000 });
      await loadAssets(ctx);

      const source = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
      const rnnoise = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
      const dest = ctx.createMediaStreamDestination();

      source.connect(rnnoise);
      rnnoise.connect(dest);

      this._ctx = ctx;
      this._rnnoise = rnnoise;
      this._dest = dest;

      return dest.stream.getAudioTracks()[0];
    } catch (err) {
      console.warn('[NoiseSuppressor] falhou ao inicializar, usando track crua:', err);
      return rawTrack;
    }
  }

  dispose() {
    try {
      this._rnnoise?.disconnect();
      this._dest?.disconnect();
      this._ctx?.close();
    } catch {
      /* ignore */
    }
    this._ctx = null;
    this._rnnoise = null;
    this._dest = null;
  }
}
