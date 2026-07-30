import { mediasoupServer } from '../../mediasoup/index.js';
import { getChannel } from '../../database/repositories/channels.js';
import * as state from '../state.js';

const roomName = (channelId) => `voice:${channelId}`;

/**
 * Sinalização WebRTC via mediasoup. O fluxo é o padrão SFU:
 *   join -> (cliente carrega Device) -> createTransport(send/recv)
 *   -> connectTransport -> produce -> consume dos demais -> resume.
 * A mídia (RTP/Opus) trafega direto no WebRTC; aqui só negociamos.
 */
export function registerVoiceHandlers(io, socket) {
  const ack = (cb, fn) => async (data) => {
    try {
      const result = await fn(data);
      if (typeof cb === 'function') cb({ data: result });
    } catch (err) {
      console.error('[voice]', err.message);
      if (typeof cb === 'function') cb({ error: err.message });
    }
  };

  // Guarda em qual canal de voz este socket está (para cleanup no disconnect).
  const currentChannel = () => state.getPresence(socket.id)?.voiceChannelId || null;

  socket.on('voice:join', (data, cb) =>
    ack(cb, async ({ channelId }) => {
      const channel = getChannel('voice', channelId);
      if (!channel) throw new Error('Canal de voz inexistente.');

      // Se já estava em outro canal, sai antes.
      const prev = currentChannel();
      if (prev && prev !== channelId) await leave(prev);

      const presence = state.getPresence(socket.id);
      if (!presence) throw new Error('Não autenticado.');

      const room = await mediasoupServer.getOrCreateRoom(channelId);
      room.addPeer(socket.id, presence.user);
      state.setVoiceChannel(socket.id, channelId);
      socket.join(roomName(channelId));

      // Som de entrada para todos no canal (incluindo quem acabou de entrar).
      io.to(roomName(channelId)).emit('voice:sound', { sound: 'join' });

      broadcastPresence();
      return { rtpCapabilities: room.rtpCapabilities };
    })(data)
  );

  socket.on('voice:createTransport', (data, cb) =>
    ack(cb, async ({ direction }) => {
      const room = requireRoom();
      const peer = requirePeer(room);
      const { transport, params } = await room.createWebRtcTransport();
      transport.appData.direction = direction;
      peer.transports.set(transport.id, transport);
      transport.on('dtlsstatechange', (s) => {
        if (s === 'closed') transport.close();
      });
      return params;
    })(data)
  );

  socket.on('voice:connectTransport', (data, cb) =>
    ack(cb, async ({ transportId, dtlsParameters }) => {
      const peer = requirePeer(requireRoom());
      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error('Transport não encontrado.');
      await transport.connect({ dtlsParameters });
      return { connected: true };
    })(data)
  );

  socket.on('voice:produce', (data, cb) =>
    ack(cb, async ({ transportId, kind, rtpParameters, appData }) => {
      const room = requireRoom();
      const peer = requirePeer(room);
      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error('Transport não encontrado.');

      // mediaType distingue microfone de compartilhamento de tela (vídeo/áudio).
      const mediaType = appData?.mediaType || 'mic';
      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: { mediaType },
      });
      peer.producers.set(producer.id, producer);

      producer.on('transportclose', () => {
        peer.producers.delete(producer.id);
      });

      // Avisa os demais participantes que há um novo stream para consumir.
      socket.to(roomName(room.id)).emit('voice:newProducer', {
        producerId: producer.id,
        peerId: socket.id,
        mediaType,
      });

      return { id: producer.id };
    })(data)
  );

  // Fecha um producer específico (ex.: parar de compartilhar a tela). Producers
  // de mic normalmente só fecham no disconnect; este é o caminho explícito.
  socket.on('voice:closeProducer', (data, cb) =>
    ack(cb, async ({ producerId }) => {
      const room = requireRoom();
      const peer = requirePeer(room);
      const producer = peer.producers.get(producerId);
      if (!producer) throw new Error('Producer não encontrado.');

      const mediaType = producer.appData?.mediaType || 'mic';
      producer.close();
      peer.producers.delete(producerId);

      socket.to(roomName(room.id)).emit('voice:producerClosed', {
        producerId,
        peerId: socket.id,
        mediaType,
      });

      return { closed: true };
    })(data)
  );

  socket.on('voice:consume', (data, cb) =>
    ack(cb, async ({ transportId, producerId, rtpCapabilities }) => {
      const room = requireRoom();
      const peer = requirePeer(room);

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('Não é possível consumir este producer.');
      }

      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error('Transport de recepção não encontrado.');

      // Começa pausado; retomamos após o cliente confirmar (evita perder áudio inicial).
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });
      peer.consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
        socket.emit('voice:consumerClosed', { consumerId: consumer.id });
      });

      return {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      };
    })(data)
  );

  socket.on('voice:resumeConsumer', (data, cb) =>
    ack(cb, async ({ consumerId }) => {
      const peer = requirePeer(requireRoom());
      const consumer = peer.consumers.get(consumerId);
      if (!consumer) throw new Error('Consumer não encontrado.');
      await consumer.resume();
      return { resumed: true };
    })(data)
  );

  socket.on('voice:getProducers', (data, cb) =>
    ack(cb, async () => {
      const room = requireRoom();
      return room.otherProducers(socket.id);
    })(data)
  );

  // Estado de voz reportado pelo cliente (mute/deaf/voice-activity/sharing).
  socket.on('voice:state', ({ muted, deaf, speaking, sharing } = {}) => {
    const presence = state.getPresence(socket.id);
    if (!presence || !presence.voiceChannelId) return;
    const partial = {};
    if (typeof muted === 'boolean') partial.muted = muted;
    if (typeof deaf === 'boolean') partial.deaf = deaf;
    if (typeof speaking === 'boolean') partial.speaking = speaking;
    if (typeof sharing === 'boolean') partial.sharing = sharing;
    state.setVoiceState(socket.id, partial);
    broadcastPresence();
  });

  socket.on('voice:leave', (data, cb) => ack(cb, async () => leave(currentChannel()))(data));

  // Chamado pelo socket/index.js no disconnect, ANTES de remover a presença.
  const cleanup = () => {
    const ch = currentChannel();
    if (ch) leave(ch).catch(() => {});
  };

  // ---- helpers ----

  function requireRoom() {
    const ch = currentChannel();
    const room = ch && mediasoupServer.getRoom(ch);
    if (!room) throw new Error('Você não está em um canal de voz.');
    return room;
  }

  function requirePeer(room) {
    const peer = room.getPeer(socket.id);
    if (!peer) throw new Error('Peer não encontrado na sala.');
    return peer;
  }

  async function leave(channelId) {
    if (!channelId) return { left: false };
    // Som de saída para todos no canal (incluindo quem está saindo, que ainda
    // está no room neste instante). No disconnect, só os que ficam o ouvem.
    io.to(roomName(channelId)).emit('voice:sound', { sound: 'leave' });
    socket.to(roomName(channelId)).emit('voice:peerLeft', { peerId: socket.id });
    socket.leave(roomName(channelId));
    mediasoupServer.leaveRoom(channelId, socket.id);
    state.setVoiceChannel(socket.id, null);
    broadcastPresence();
    return { left: true };
  }

  function broadcastPresence() {
    io.emit('presence:update', state.listPresence());
  }

  return { cleanup };
}
