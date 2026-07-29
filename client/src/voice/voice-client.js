import { Device } from 'mediasoup-client';
import { socket, request } from '../socket.js';

/**
 * Cliente WebRTC/SFU. Cada participante:
 *   - envia 1 producer de áudio (seu microfone) ao servidor;
 *   - consome N consumers (o áudio dos demais), roteados pelo mediasoup.
 * Nunca há conexão direta peer-a-peer (sem mesh).
 */
export class VoiceClient {
  constructor() {
    this.reset();

    // Preferências de dispositivo (persistem entre calls e sessões).
    this.inputDeviceId = localStorage.getItem('voice.inputDeviceId') || null;
    this.outputDeviceId = localStorage.getItem('voice.outputDeviceId') || null;

    // Sons do soundboard tocando agora (podem ser vários ao mesmo tempo).
    // Cada item é { audioEl, peerId }. Independentes da call, por isso ficam
    // fora do reset().
    this.soundboardAudios = new Set();
    // Volume dos efeitos sonoros por pessoa (peerId=socketId) -> 0..1.
    this.effectsVolumes = new Map();

    // Callbacks preenchidos pela UI.
    this.onSpeaking = () => {};
    this.onStateChange = () => {};
    this.onAudioBlocked = () => {}; // navegador bloqueou o autoplay do áudio remoto
    this.onAudioResumed = () => {};
    this.onSoundboardChange = () => {}; // recebe a quantidade de sons tocando

    socket.on('voice:newProducer', ({ producerId, peerId }) => {
      if (!this.channelId) return;
      this.producerPeer.set(producerId, peerId);
      this._consume(producerId).catch((e) => console.warn(e));
    });
    socket.on('voice:consumerClosed', ({ consumerId }) => this._removeConsumer(consumerId));
  }

  reset() {
    this.channelId = null;
    this.device = null;
    this.sendTransport = null;
    this.recvTransport = null;
    this.producer = null;
    this.micStream = null;
    this.consumers = new Map(); // consumerId -> { consumer, audioEl, peerId }
    this.producerPeer = new Map(); // producerId -> peerId (socketId)
    this.volumes = new Map(); // peerId -> 0..1
    this.muted = false;
    this.deaf = false;
    this._vad = null;
  }

  get connected() {
    return !!this.channelId;
  }

  async join(channelId) {
    if (this.channelId) await this.leave();

    const { rtpCapabilities } = await request('voice:join', { channelId });
    this.channelId = channelId;

    this.device = new Device();
    await this.device.load({ routerRtpCapabilities: rtpCapabilities });

    await this._createSendTransport();
    await this._createRecvTransport();
    await this._startMicrophone();

    // Consome quem já estava no canal.
    const producers = await request('voice:getProducers');
    for (const { producerId, peerId } of producers) {
      this.producerPeer.set(producerId, peerId);
      await this._consume(producerId).catch((e) => console.warn(e));
    }

    this._emitState();
  }

  async leave() {
    if (!this.channelId) return;
    try {
      await request('voice:leave');
    } catch {
      /* servidor pode já ter limpado */
    }
    this._stopVad();
    // Ao sair da call, os efeitos/sons param imediatamente para este usuário.
    this.stopSound();
    if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop());
    for (const { audioEl } of this.consumers.values()) audioEl.remove();
    [this.sendTransport, this.recvTransport].forEach((t) => t && t.close());
    this.reset();
    this._emitState();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.producer) {
      muted ? this.producer.pause() : this.producer.resume();
    }
    if (this.micStream) this.micStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (muted) this.onSpeaking(false);
    this._reportState();
    this._emitState();
  }

  setDeaf(deaf) {
    this.deaf = deaf;
    for (const { audioEl } of this.consumers.values()) audioEl.muted = deaf;
    // Ensurdecer também silencia o próprio microfone (como no Discord) e,
    // ao desfazer, restaura o estado de mudo anterior.
    if (deaf) {
      this._mutedBeforeDeaf = this.muted;
      this.setMuted(true);
    } else {
      this.setMuted(this._mutedBeforeDeaf ?? false);
    }
    this._reportState();
    this._emitState();
  }

  setPeerVolume(peerId, volume) {
    const v = Math.max(0, Math.min(1, volume));
    this.volumes.set(peerId, v);
    for (const entry of this.consumers.values()) {
      if (entry.peerId === peerId) entry.audioEl.volume = v;
    }
  }

  getPeerVolume(peerId) {
    return this.volumes.get(peerId) ?? 1;
  }

  /** Volume dos efeitos sonoros (soundboard) de uma pessoa. Aplica ao vivo. */
  setPeerEffectsVolume(peerId, volume) {
    const v = Math.max(0, Math.min(1, volume));
    this.effectsVolumes.set(peerId, v);
    for (const { audioEl, peerId: id } of this.soundboardAudios) {
      if (id === peerId) audioEl.volume = v;
    }
  }

  getPeerEffectsVolume(peerId) {
    return this.effectsVolumes.get(peerId) ?? 1;
  }

  /**
   * Troca o microfone. Se houver call ativa, substitui a track do producer ao
   * vivo (sem reconectar). Fora de call, só guarda para o próximo join.
   */
  async setInputDevice(deviceId) {
    this.inputDeviceId = deviceId || null;
    localStorage.setItem('voice.inputDeviceId', this.inputDeviceId || '');
    if (!this.producer || !this.sendTransport) return;

    const newStream = await this._getMicStream();
    const newTrack = newStream.getAudioTracks()[0];
    await this.producer.replaceTrack({ track: newTrack });
    newTrack.enabled = !this.muted;

    if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop());
    this.micStream = newStream;

    this._stopVad();
    this._startVad(newTrack);
  }

  /** Troca a saída de áudio (fone/alto-falante) de todos os participantes. */
  async setOutputDevice(deviceId) {
    this.outputDeviceId = deviceId || null;
    localStorage.setItem('voice.outputDeviceId', this.outputDeviceId || '');
    await Promise.all(
      [...this.consumers.values()].map(({ audioEl }) => this._applySink(audioEl))
    );
  }

  /** Retoma o áudio remoto após um gesto do usuário (contorna o autoplay). */
  resumeAudio() {
    for (const { audioEl } of this.consumers.values()) {
      audioEl.play().catch(() => {});
    }
    for (const { audioEl } of this.soundboardAudios) audioEl.play().catch(() => {});
    this.onAudioResumed();
  }

  /**
   * Toca um som do soundboard localmente (num <audio> no #audio-sink), usando a
   * mesma saída de áudio (setSinkId) e o mesmo desbloqueio de autoplay dos
   * streams de voz. Chamado em todos os clientes via evento 'soundboard:play';
   * o servidor decide a audiência (canal de voz ou preview solo). Vários sons
   * podem tocar ao mesmo tempo (não corta o anterior). `playerId` (socketId de
   * quem tocou) permite aplicar o volume de efeitos por pessoa.
   */
  playSound(url, { preview = false, playerId = null } = {}) {
    // Ensurdecido não ouve broadcast do canal; o preview solo sempre toca.
    if (this.deaf && !preview) return;

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.src = url;
    audioEl.volume = this.getPeerEffectsVolume(playerId);
    document.getElementById('audio-sink').append(audioEl);

    const entry = { audioEl, peerId: playerId };
    this.soundboardAudios.add(entry);
    this._soundboardChanged();

    const cleanup = () => {
      if (this.soundboardAudios.delete(entry)) this._soundboardChanged();
      audioEl.remove();
    };
    audioEl.addEventListener('ended', cleanup);
    audioEl.addEventListener('error', cleanup);

    this._applySink(audioEl);
    this._tryPlay(audioEl);
  }

  /** Para TODOS os sons do soundboard que estiverem tocando. */
  stopSound() {
    if (!this.soundboardAudios.size) return;
    for (const { audioEl } of this.soundboardAudios) {
      try {
        audioEl.pause();
      } catch {
        /* ignore */
      }
      audioEl.remove();
    }
    this.soundboardAudios.clear();
    this._soundboardChanged();
  }

  _soundboardChanged() {
    this.onSoundboardChange(this.soundboardAudios.size);
  }

  // ---- interno ----

  async _createSendTransport() {
    const params = await request('voice:createTransport', { direction: 'send' });
    this.sendTransport = this.device.createSendTransport(params);
    this._wireTransport(this.sendTransport);
    this.sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
      try {
        const { id } = await request('voice:produce', {
          transportId: this.sendTransport.id,
          kind,
          rtpParameters,
        });
        callback({ id });
      } catch (err) {
        errback(err);
      }
    });
  }

  async _createRecvTransport() {
    const params = await request('voice:createTransport', { direction: 'recv' });
    this.recvTransport = this.device.createRecvTransport(params);
    this._wireTransport(this.recvTransport);
  }

  _wireTransport(transport) {
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      request('voice:connectTransport', { transportId: transport.id, dtlsParameters })
        .then(callback)
        .catch(errback);
    });
  }

  _micConstraints() {
    const audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (this.inputDeviceId) audio.deviceId = { exact: this.inputDeviceId };
    return { audio, video: false };
  }

  async _getMicStream() {
    try {
      return await navigator.mediaDevices.getUserMedia(this._micConstraints());
    } catch (err) {
      // Dispositivo escolhido sumiu/indisponível: cai para o microfone padrão.
      if (this.inputDeviceId) {
        console.warn('Microfone selecionado indisponível, usando o padrão:', err);
        this.inputDeviceId = null;
        return navigator.mediaDevices.getUserMedia(this._micConstraints());
      }
      throw err;
    }
  }

  async _startMicrophone() {
    this.micStream = await this._getMicStream();
    const track = this.micStream.getAudioTracks()[0];
    this.producer = await this.sendTransport.produce({
      track,
      codecOptions: { opusStereo: false, opusDtx: true, opusFec: true },
    });
    if (this.muted) this.producer.pause();
    this._startVad(track);
  }

  async _consume(producerId) {
    const { id, kind, rtpParameters } = await request('voice:consume', {
      transportId: this.recvTransport.id,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });

    const consumer = await this.recvTransport.consume({ id, producerId, kind, rtpParameters });
    const peerId = this.producerPeer.get(producerId) || producerId;

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.srcObject = new MediaStream([consumer.track]);
    audioEl.muted = this.deaf;
    audioEl.volume = this.volumes.get(peerId) ?? 1;
    document.getElementById('audio-sink').append(audioEl);
    await this._applySink(audioEl);

    this.consumers.set(id, { consumer, audioEl, peerId });
    consumer.on('trackended', () => this._removeConsumer(id));

    await request('voice:resumeConsumer', { consumerId: id });
    this._tryPlay(audioEl);
  }

  _applySink(audioEl) {
    if (!this.outputDeviceId || typeof audioEl.setSinkId !== 'function') {
      return Promise.resolve();
    }
    return audioEl
      .setSinkId(this.outputDeviceId)
      .catch((err) => console.warn('Não foi possível selecionar a saída de áudio:', err));
  }

  _tryPlay(audioEl) {
    const p = audioEl.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        // Autoplay bloqueado pelo navegador: avisa a UI e retoma no 1º gesto.
        this.onAudioBlocked();
        this._ensureGestureResume();
      });
    }
  }

  _ensureGestureResume() {
    if (this._gestureBound) return;
    this._gestureBound = true;
    const resume = () => {
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      this._gestureBound = false;
      this.resumeAudio();
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }

  _removeConsumer(consumerId) {
    const entry = this.consumers.get(consumerId);
    if (!entry) return;
    try {
      entry.consumer.close();
    } catch {
      /* já fechado */
    }
    entry.audioEl.remove();
    this.consumers.delete(consumerId);
  }

  // Detecção de atividade de voz (VAD) local: mede RMS do microfone e reporta
  // "falando/parado" ao servidor. Feito no cliente para poupar CPU do servidor.
  _startVad(track) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.fftSize);
    let speaking = false;
    let lastChange = 0;
    let raf = 0;
    const THRESHOLD = 0.02;
    const HANG_MS = 250;

    const tick = () => {
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) {
        const norm = (v - 128) / 128;
        sum += norm * norm;
      }
      const rms = Math.sqrt(sum / buffer.length);
      const now = performance.now();
      const active = rms > THRESHOLD && !this.muted;

      if (active && !speaking) {
        speaking = true;
        lastChange = now;
        this._setSpeaking(true);
      } else if (!active && speaking && now - lastChange > HANG_MS) {
        speaking = false;
        this._setSpeaking(false);
      } else if (active) {
        lastChange = now;
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    this._vad = { ctx, cancel: () => cancelAnimationFrame(raf) };
  }

  _stopVad() {
    if (!this._vad) return;
    this._vad.cancel();
    this._vad.ctx.close().catch(() => {});
    this._vad = null;
  }

  _setSpeaking(speaking) {
    this.onSpeaking(speaking);
    socket.emit('voice:state', { speaking });
  }

  _reportState() {
    socket.emit('voice:state', { muted: this.muted, deaf: this.deaf });
  }

  _emitState() {
    this.onStateChange({
      connected: this.connected,
      channelId: this.channelId,
      muted: this.muted,
      deaf: this.deaf,
    });
  }
}

export const voiceClient = new VoiceClient();
