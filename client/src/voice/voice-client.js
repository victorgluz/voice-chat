import { Device } from 'mediasoup-client';
import { socket, request } from '../socket.js';
import joinSoundUrl from '../sounds/join.mp3';
import leaveSoundUrl from '../sounds/leave.mp3';
import notificationSoundUrl from '../sounds/notification.mp3';

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
    this.videoDeviceId = localStorage.getItem('voice.videoDeviceId') || null;

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
    this.onShareStateChange = () => {}; // recebe true/false: estou compartilhando?
    this.onScreensChange = () => {}; // lista de telas disponíveis mudou
    this.onWatchStart = () => {}; // (stream, user) — comecei a assistir uma tela
    this.onWatchStop = () => {}; // parei de assistir
    this.onCamStateChange = () => {}; // recebe true/false: minha câmera está ligada?
    this.onWebcamsChange = () => {}; // grade de webcams (minha + dos outros) mudou

    socket.on('voice:newProducer', ({ producerId, peerId, mediaType = 'mic' }) => {
      if (!this.channelId) return;
      this.producerPeer.set(producerId, peerId);
      this._onProducer(producerId, peerId, mediaType);
    });
    socket.on('voice:consumerClosed', ({ consumerId }) => this._removeConsumer(consumerId));
    socket.on('voice:producerClosed', ({ producerId, peerId }) =>
      this._onProducerClosed(producerId, peerId)
    );
    socket.on('voice:peerLeft', ({ peerId }) => this._onPeerLeft(peerId));
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

    // Compartilhamento de tela.
    this.screenStream = null; // MediaStream local capturado (getDisplayMedia)
    this.screenProducers = { video: null, audio: null }; // meus producers de tela
    // Telas de OUTROS disponíveis para assistir. peerId -> { peerId, videoProducerId, audioProducerId }.
    this.availableScreens = new Map();
    // Tela que estou assistindo agora (só uma por vez). null ou:
    // { peerId, consumers: [consumerId], stream }.
    this.watching = null;

    // Webcam: minha câmera + as dos outros (auto-consumidas, grade central).
    this.webcamStream = null; // MediaStream local da minha câmera
    this.webcamProducer = null; // meu producer de webcam
    this.webcams = new Map(); // peerId -> { consumer, stream } (câmeras dos outros)
  }

  get sharing() {
    return !!this.screenProducers.video;
  }

  get connected() {
    return !!this.channelId;
  }

  async join(channelId) {
    if (this.channelId) await this.leave();

    const { rtpCapabilities, videoBitrate } = await request('voice:join', { channelId });
    this.channelId = channelId;
    // Bitrate de vídeo definido no servidor (.env); usado por tela e webcam.
    this.videoBitrate = videoBitrate || { min: 2e6, max: 20e6, start: 5e6 };

    this.device = new Device();
    await this.device.load({ routerRtpCapabilities: rtpCapabilities });

    await this._createSendTransport();
    await this._createRecvTransport();
    await this._startMicrophone();

    // Consome o áudio de quem já estava no canal e registra as telas ativas.
    const producers = await request('voice:getProducers');
    for (const { producerId, peerId, mediaType = 'mic' } of producers) {
      this.producerPeer.set(producerId, peerId);
      await this._onProducer(producerId, peerId, mediaType);
    }

    this._emitState();
  }

  async leave() {
    if (!this.channelId) return;
    // Encerra compartilhamento, visualização e câmera antes de derrubar a call.
    this.stopScreenShare();
    this.stopWatching();
    this.stopWebcam();
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
    // Ensurdecer também silencia o áudio da tela que estiver assistindo.
    if (this.watching) {
      for (const t of this.watching.stream.getAudioTracks()) t.enabled = !deaf;
    }
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

  /**
   * Som de notificação de entrada/saída da call ('join' | 'leave'). Toca na
   * saída de áudio selecionada; não passa pelo SFU (é local, disparado por
   * evento do servidor). Ignora falha de autoplay silenciosamente.
   */
  playNotification(type) {
    const url =
      type === 'leave' ? leaveSoundUrl : type === 'mention' ? notificationSoundUrl : joinSoundUrl;
    const audio = new Audio(url);
    audio.volume = 0.6;
    this._applySink(audio);
    audio.play().catch(() => {});
  }

  // ---- interno ----

  async _createSendTransport() {
    const params = await request('voice:createTransport', { direction: 'send' });
    this.sendTransport = this.device.createSendTransport(params);
    this._wireTransport(this.sendTransport);
    this.sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
      try {
        const { id } = await request('voice:produce', {
          transportId: this.sendTransport.id,
          kind,
          rtpParameters,
          appData,
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

  /**
   * Roteia um producer recém-anunciado conforme o tipo de mídia: microfone é
   * consumido automaticamente (áudio da call); tela apenas fica disponível
   * para o usuário escolher assistir (não consome sozinha).
   */
  async _onProducer(producerId, peerId, mediaType) {
    if (mediaType === 'mic') {
      await this._consume(producerId).catch((e) => console.warn(e));
      return;
    }
    if (mediaType === 'webcam') {
      // Webcam é auto-consumida: todos veem na grade central.
      try {
        const consumer = await this._consumeProducer(producerId);
        const stream = new MediaStream([consumer.track]);
        this.webcams.set(peerId, { consumer, stream });
        consumer.on('trackended', () => this._removeWebcam(peerId));
        this.onWebcamsChange();
      } catch (e) {
        console.warn(e);
      }
      return;
    }
    // screen-video / screen-audio
    const entry = this.availableScreens.get(peerId) || {
      peerId,
      videoProducerId: null,
      audioProducerId: null,
    };
    if (mediaType === 'screen-video') entry.videoProducerId = producerId;
    if (mediaType === 'screen-audio') entry.audioProducerId = producerId;
    this.availableScreens.set(peerId, entry);
    this.onScreensChange();
  }

  _onProducerClosed(producerId, peerId) {
    // Webcam de outro peer encerrada.
    const cam = this.webcams.get(peerId);
    if (cam && cam.consumer.producerId === producerId) {
      this._removeWebcam(peerId);
      return;
    }
    // Atualiza a lista de telas disponíveis.
    const entry = this.availableScreens.get(peerId);
    if (entry) {
      if (entry.videoProducerId === producerId) entry.videoProducerId = null;
      if (entry.audioProducerId === producerId) entry.audioProducerId = null;
      if (!entry.videoProducerId && !entry.audioProducerId) {
        this.availableScreens.delete(peerId);
      }
      this.onScreensChange();
    }
    // Se eu estava assistindo essa tela, encerra a visualização.
    if (this.watching && this.watching.peerId === peerId) this.stopWatching();
  }

  _onPeerLeft(peerId) {
    if (this.availableScreens.delete(peerId)) this.onScreensChange();
    if (this.watching && this.watching.peerId === peerId) this.stopWatching();
    this._removeWebcam(peerId);
  }

  _removeWebcam(peerId) {
    const cam = this.webcams.get(peerId);
    if (!cam) return;
    try {
      cam.consumer.close();
    } catch {
      /* já fechado */
    }
    this.webcams.delete(peerId);
    this.onWebcamsChange();
  }

  /** Consome um producer e devolve o consumer já retomado (fluxo pause→resume). */
  async _consumeProducer(producerId) {
    const { id, kind, rtpParameters } = await request('voice:consume', {
      transportId: this.recvTransport.id,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });
    const consumer = await this.recvTransport.consume({ id, producerId, kind, rtpParameters });
    await request('voice:resumeConsumer', { consumerId: id });
    return consumer;
  }

  async _consume(producerId) {
    const consumer = await this._consumeProducer(producerId);
    const peerId = this.producerPeer.get(producerId) || producerId;

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.srcObject = new MediaStream([consumer.track]);
    audioEl.muted = this.deaf;
    audioEl.volume = this.volumes.get(peerId) ?? 1;
    document.getElementById('audio-sink').append(audioEl);
    await this._applySink(audioEl);

    this.consumers.set(consumer.id, { consumer, audioEl, peerId });
    consumer.on('trackended', () => this._removeConsumer(consumer.id));

    this._tryPlay(audioEl);
  }

  // ---- compartilhamento de tela ----

  /**
   * Captura a tela (o navegador oferece o seletor nativo de janela/tela/aba) e
   * publica como producer(s) de vídeo — e de áudio, se o usuário compartilhar o
   * som. Exige estar num canal de voz (reutiliza o sendTransport da call).
   */
  async startScreenShare() {
    if (!this.connected) throw new Error('Entre em um canal de voz para compartilhar a tela.');
    if (this.sharing) return;

    this.screenStream = await navigator.mediaDevices.getDisplayMedia({
      // Pede framerate alto; em LAN não há gargalo de banda.
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
    });

    const videoTrack = this.screenStream.getVideoTracks()[0];
    // "motion" prioriza fluidez (fps) em vez de detalhe.
    videoTrack.contentHint = 'motion';
    this.screenProducers.video = await this.sendTransport.produce({
      track: videoTrack,
      appData: { mediaType: 'screen-video' },
      ...this._videoProduceParams(),
    });
    // Quando o usuário clica em "Parar de compartilhar" na barra nativa do navegador.
    videoTrack.addEventListener('ended', () => this.stopScreenShare());

    const audioTrack = this.screenStream.getAudioTracks()[0];
    if (audioTrack) {
      this.screenProducers.audio = await this.sendTransport.produce({
        track: audioTrack,
        appData: { mediaType: 'screen-audio' },
        codecOptions: { opusStereo: true, opusDtx: false, opusFec: true },
      });
    }

    socket.emit('voice:state', { sharing: true });
    this.onShareStateChange(true);
  }

  stopScreenShare() {
    if (!this.sharing && !this.screenStream) return;
    for (const key of ['video', 'audio']) {
      const producer = this.screenProducers[key];
      if (!producer) continue;
      request('voice:closeProducer', { producerId: producer.id }).catch(() => {});
      try {
        producer.close();
      } catch {
        /* já fechado */
      }
      this.screenProducers[key] = null;
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }
    socket.emit('voice:state', { sharing: false });
    this.onShareStateChange(false);
  }

  /**
   * Parâmetros de produção de vídeo compartilhados por tela e webcam:
   * prefere H264 (encoder de hardware; fallback VP8) e aplica o bitrate vindo
   * do servidor (.env). `videoGoogle*Bitrate` é em kbps.
   */
  _videoProduceParams() {
    const h264 = this.device.rtpCapabilities.codecs.find(
      (c) => c.mimeType.toLowerCase() === 'video/h264'
    );
    const b = this.videoBitrate;
    return {
      ...(h264 ? { codec: h264 } : {}),
      encodings: [{ maxBitrate: b.max }],
      codecOptions: {
        videoGoogleStartBitrate: Math.round(b.start / 1000),
        videoGoogleMinBitrate: Math.round(b.min / 1000),
      },
      degradationPreference: 'maintain-framerate',
    };
  }

  // ---- webcam ----

  get camOn() {
    return !!this.webcamProducer;
  }

  _camConstraints() {
    // ideal 60 (não trava em 30); câmeras que só fazem 30 caem para 30.
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } };
    if (this.videoDeviceId) video.deviceId = { exact: this.videoDeviceId };
    return { video, audio: false };
  }

  async _getCamStream() {
    try {
      return await navigator.mediaDevices.getUserMedia(this._camConstraints());
    } catch (err) {
      // Câmera escolhida sumiu/indisponível: cai para a padrão.
      if (this.videoDeviceId) {
        console.warn('Câmera selecionada indisponível, usando a padrão:', err);
        this.videoDeviceId = null;
        return navigator.mediaDevices.getUserMedia(this._camConstraints());
      }
      throw err;
    }
  }

  /**
   * Troca a câmera. Se estiver ligada, substitui a track do producer ao vivo
   * (sem reconectar). Desligada, só guarda para o próximo start.
   */
  async setVideoDevice(deviceId) {
    this.videoDeviceId = deviceId || null;
    localStorage.setItem('voice.videoDeviceId', this.videoDeviceId || '');
    if (!this.webcamProducer) return;

    const newStream = await this._getCamStream();
    const newTrack = newStream.getVideoTracks()[0];
    newTrack.contentHint = 'motion';
    await this.webcamProducer.replaceTrack({ track: newTrack });
    newTrack.addEventListener('ended', () => this.stopWebcam());

    if (this.webcamStream) this.webcamStream.getTracks().forEach((t) => t.stop());
    this.webcamStream = newStream;
    this.onWebcamsChange(); // atualiza o preview local na grade
  }

  /** Liga a câmera e publica como producer de vídeo (todos veem, auto-consume). */
  async startWebcam() {
    if (!this.connected) throw new Error('Entre em um canal de voz para ligar a câmera.');
    if (this.camOn) return;

    this.webcamStream = await this._getCamStream();
    const videoTrack = this.webcamStream.getVideoTracks()[0];
    videoTrack.contentHint = 'motion';
    this.webcamProducer = await this.sendTransport.produce({
      track: videoTrack,
      appData: { mediaType: 'webcam' },
      ...this._videoProduceParams(),
    });
    videoTrack.addEventListener('ended', () => this.stopWebcam());

    socket.emit('voice:state', { cam: true });
    this.onCamStateChange(true);
    this.onWebcamsChange();
  }

  stopWebcam() {
    if (!this.camOn && !this.webcamStream) return;
    if (this.webcamProducer) {
      request('voice:closeProducer', { producerId: this.webcamProducer.id }).catch(() => {});
      try {
        this.webcamProducer.close();
      } catch {
        /* já fechado */
      }
      this.webcamProducer = null;
    }
    if (this.webcamStream) {
      this.webcamStream.getTracks().forEach((t) => t.stop());
      this.webcamStream = null;
    }
    socket.emit('voice:state', { cam: false });
    this.onCamStateChange(false);
    this.onWebcamsChange();
  }

  /** Assiste à tela de um peer. Só uma tela por vez: fecha a anterior. */
  async watchScreen(peerId) {
    const entry = this.availableScreens.get(peerId);
    if (!entry || !entry.videoProducerId) return;
    if (this.watching && this.watching.peerId === peerId) return;
    this.stopWatching();

    const consumers = [];
    const tracks = [];
    const videoConsumer = await this._consumeProducer(entry.videoProducerId);
    consumers.push(videoConsumer);
    tracks.push(videoConsumer.track);
    if (entry.audioProducerId) {
      const audioConsumer = await this._consumeProducer(entry.audioProducerId);
      consumers.push(audioConsumer);
      const audioTrack = audioConsumer.track;
      audioTrack.enabled = !this.deaf; // respeita ensurdecer
      tracks.push(audioTrack);
    }

    const stream = new MediaStream(tracks);
    this.watching = { peerId, consumers, stream };
    for (const c of consumers) c.on('trackended', () => this.stopWatching());
    this.onWatchStart(stream, peerId);
  }

  stopWatching() {
    if (!this.watching) return;
    for (const consumer of this.watching.consumers) {
      try {
        consumer.close();
      } catch {
        /* já fechado */
      }
    }
    this.watching = null;
    this.onWatchStop();
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
