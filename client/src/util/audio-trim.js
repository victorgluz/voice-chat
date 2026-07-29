/**
 * Corte de áudio no navegador, sem dependências, com a Web Audio API.
 *
 * Fluxo: decodeAudio(file) -> AudioBuffer; desenha a waveform num <canvas>;
 * createTrimmer() coloca duas alças (início/fim) arrastáveis e permite ouvir só
 * o trecho; trimToWavBlob() recorta as amostras selecionadas e encoda em WAV
 * (PCM 16-bit) para o upload. Só o trecho recortado sobe ao servidor.
 */

let sharedCtx = null;

function audioCtx() {
  if (!sharedCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    sharedCtx = new AudioCtx();
  }
  return sharedCtx;
}

/** Libera o AudioContext (chamar ao fechar o modal). */
export function closeAudioContext() {
  if (sharedCtx) {
    sharedCtx.close().catch(() => {});
    sharedCtx = null;
  }
}

/** Decodifica um File de áudio em um AudioBuffer. */
export async function decodeAudio(file) {
  const arrayBuf = await file.arrayBuffer();
  return audioCtx().decodeAudioData(arrayBuf);
}

/** Desenha a waveform (picos min/max por coluna) ocupando o canvas inteiro. */
export function drawWaveform(canvas, audioBuffer) {
  const w = Math.max(1, Math.floor(canvas.clientWidth || canvas.width || 600));
  const h = Math.max(1, Math.floor(canvas.clientHeight || canvas.height || 96));
  canvas.width = w;
  canvas.height = h;

  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);

  const data = audioBuffer.getChannelData(0);
  const mid = h / 2;
  const step = Math.max(1, Math.floor(data.length / w));

  g.fillStyle = '#7a83ff';
  for (let x = 0; x < w; x++) {
    let min = 1;
    let max = -1;
    const base = x * step;
    for (let i = 0; i < step; i++) {
      const v = data[base + i] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid + min * mid;
    const y2 = mid + max * mid;
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

/**
 * Controla a seleção de trecho sobre o canvas. Retorna helpers para ler o
 * intervalo, ouvir a seleção e limpar. `onChange({start,end})` é chamado a cada
 * ajuste das alças (em segundos).
 */
export function createTrimmer({ canvas, audioBuffer, onChange = () => {} }) {
  const duration = audioBuffer.duration;
  let start = 0;
  let end = duration;
  let dragging = null; // 'start' | 'end' | null
  let source = null;

  const width = () => Math.max(1, canvas.clientWidth || canvas.width || 600);
  const xToTime = (x) => Math.max(0, Math.min(duration, (x / width()) * duration));
  const timeToX = (t) => (t / duration) * width();

  function render() {
    drawWaveform(canvas, audioBuffer);
    const g = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const xs = timeToX(start);
    const xe = timeToX(end);

    // Escurece o que está fora da seleção.
    g.fillStyle = 'rgba(0, 0, 0, 0.55)';
    g.fillRect(0, 0, xs, h);
    g.fillRect(xe, 0, w - xe, h);

    // Borda + alças da seleção.
    g.strokeStyle = '#5865f2';
    g.lineWidth = 2;
    g.strokeRect(xs, 1, Math.max(0, xe - xs), h - 2);
    g.fillStyle = '#5865f2';
    g.fillRect(xs - 3, 0, 6, h);
    g.fillRect(xe - 3, 0, 6, h);
  }

  function moveTo(x) {
    const t = xToTime(x);
    const minGap = Math.min(0.05, duration / 100);
    if (dragging === 'start') start = Math.max(0, Math.min(t, end - minGap));
    else end = Math.min(duration, Math.max(t, start + minGap));
    render();
    onChange(getRange());
  }

  function pickHandle(x) {
    return Math.abs(x - timeToX(start)) <= Math.abs(x - timeToX(end)) ? 'start' : 'end';
  }

  function localX(e) {
    return e.clientX - canvas.getBoundingClientRect().left;
  }

  function onDown(e) {
    dragging = pickHandle(localX(e));
    moveTo(localX(e));
    canvas.setPointerCapture?.(e.pointerId);
  }
  function onMove(e) {
    if (dragging) moveTo(localX(e));
  }
  function onUp(e) {
    dragging = null;
    canvas.releasePointerCapture?.(e.pointerId);
  }

  function getRange() {
    return { start, end };
  }

  function stopPreview() {
    if (!source) return;
    try {
      source.stop();
    } catch {
      /* já parado */
    }
    source.disconnect?.();
    source = null;
  }

  function previewSelection() {
    stopPreview();
    const c = audioCtx();
    if (c.state === 'suspended') c.resume().catch(() => {});
    source = c.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(c.destination);
    source.onended = () => {
      source?.disconnect?.();
      source = null;
    };
    source.start(0, start, Math.max(0.01, end - start));
  }

  function destroy() {
    stopPreview();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  render();

  return { getRange, previewSelection, stopPreview, render, destroy, duration };
}

/** Recorta [start,end] (segundos) do AudioBuffer e devolve um Blob WAV PCM 16-bit. */
export function trimToWavBlob(audioBuffer, start, end) {
  const sr = audioBuffer.sampleRate;
  const numCh = audioBuffer.numberOfChannels;
  const startF = Math.max(0, Math.floor(start * sr));
  const endF = Math.min(audioBuffer.length, Math.floor(end * sr));
  const frames = Math.max(0, endF - startF);

  const channels = [];
  for (let c = 0; c < numCh; c++) {
    channels.push(audioBuffer.getChannelData(c).subarray(startF, endF));
  }

  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // tamanho do chunk fmt
  view.setUint16(20, 1, true); // formato PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true); // bits por amostra
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i] || 0;
      s = Math.max(-1, Math.min(1, s));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([view], { type: 'audio/wav' });
}
