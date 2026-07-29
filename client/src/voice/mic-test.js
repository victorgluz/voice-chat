/**
 * Teste de microfone independente da call. Captura o mic selecionado para:
 *   - medir o nível de entrada (medidor visual — confirma que o mic capta);
 *   - opcionalmente reproduzir a própria voz (monitor/loopback) na saída
 *     selecionada, para conferir microfone e saída ao mesmo tempo.
 *
 * Reage à troca de entrada/saída ao vivo. Use fones para o monitor, senão o
 * som volta pelo mic e gera microfonia.
 */
export class MicTest {
  constructor() {
    this.stream = null;
    this.ctx = null;
    this.raf = 0;
    this.audioEl = null;
    this.monitor = true;
    this.running = false;
    this.onLevel = () => {}; // recebe 0..1
  }

  get active() {
    return this.running;
  }

  async start({ inputDeviceId, outputDeviceId, monitor = true } = {}) {
    await this.stop();
    this.monitor = monitor;

    const audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (inputDeviceId) audio.deviceId = { exact: inputDeviceId };

    this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    this.running = true;

    // Medidor de nível (RMS do sinal de entrada).
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const source = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buffer = new Uint8Array(analyser.fftSize);

    const tick = () => {
      if (!this.running) return;
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) {
        const n = (v - 128) / 128;
        sum += n * n;
      }
      const rms = Math.sqrt(sum / buffer.length);
      // Ganho no medidor: fala normal (~0.05–0.2) já preenche bem a barra.
      this.onLevel(Math.min(1, rms * 4));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);

    // Monitor / loopback: toca o próprio mic num <audio> oculto.
    this.audioEl = document.createElement('audio');
    this.audioEl.autoplay = true;
    this.audioEl.srcObject = this.stream;
    this.audioEl.muted = !this.monitor;
    document.getElementById('audio-sink').append(this.audioEl);
    await this.setOutput(outputDeviceId);
    try {
      await this.audioEl.play();
    } catch {
      /* clicar em "Testar" já é o gesto do usuário; ignora bloqueio residual */
    }
  }

  /** Recomeça o teste com um novo microfone (mantém saída e monitor atuais). */
  async setInput(inputDeviceId, outputDeviceId) {
    if (!this.running) return;
    await this.start({ inputDeviceId, outputDeviceId, monitor: this.monitor });
  }

  /** Aplica a saída (fone/alto-falante) ao monitor. */
  async setOutput(outputDeviceId) {
    if (this.audioEl && outputDeviceId && typeof this.audioEl.setSinkId === 'function') {
      await this.audioEl.setSinkId(outputDeviceId).catch(() => {});
    }
  }

  /** Liga/desliga ouvir a própria voz sem parar o medidor. */
  setMonitor(on) {
    this.monitor = on;
    if (this.audioEl) this.audioEl.muted = !on;
  }

  async stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.onLevel(0);
  }
}
