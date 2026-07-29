import { createChannel, deleteChannel, listChannels, getChannel } from '../../database/repositories/channels.js';
import { mediasoupServer } from '../../mediasoup/index.js';
import * as state from '../state.js';
import { cleanChannelName } from '../../util/sanitize.js';

const roomName = (channelId) => `voice:${channelId}`;

/**
 * Ações restritas a administradores. A checagem de permissão é sempre no
 * servidor (o cliente pode esconder botões, mas nunca é a fonte da verdade).
 */
export function registerAdminHandlers(io, socket) {
  const ack = (cb, fn) => async (data) => {
    try {
      requireAdmin();
      const result = await fn(data);
      if (typeof cb === 'function') cb({ data: result });
    } catch (err) {
      if (typeof cb === 'function') cb({ error: err.message });
    }
  };

  function requireAdmin() {
    const presence = state.getPresence(socket.id);
    if (!presence?.user?.isAdmin) throw new Error('Ação restrita a administradores.');
  }

  socket.on('admin:createChannel', (data, cb) =>
    ack(cb, async ({ type, name, icon }) => {
      if (type !== 'text' && type !== 'voice') throw new Error('Tipo inválido.');
      const clean = cleanChannelName(name);
      if (!clean) throw new Error('Nome de canal inválido.');
      const channel = createChannel({ type, name: clean, icon });
      io.emit('channels:update', listChannels());
      return channel;
    })(data)
  );

  socket.on('admin:deleteChannel', (data, cb) =>
    ack(cb, async ({ type, id }) => {
      if (type !== 'text' && type !== 'voice') throw new Error('Tipo inválido.');
      if (!getChannel(type, id)) throw new Error('Canal inexistente.');

      if (type === 'voice') {
        // Expulsa todos do canal antes de removê-lo.
        io.to(roomName(id)).emit('voice:forceLeave');
        for (const p of state.socketsInVoiceChannel(id)) {
          mediasoupServer.leaveRoom(id, p.socketId);
          state.setVoiceChannel(p.socketId, null);
        }
      }

      deleteChannel(type, id);
      io.emit('channels:update', listChannels());
      io.emit('presence:update', state.listPresence());
      return { id, type };
    })(data)
  );

  socket.on('admin:moveUser', (data, cb) =>
    ack(cb, async ({ socketId, channelId }) => {
      if (!getChannel('voice', channelId)) throw new Error('Canal de voz inexistente.');
      io.to(socketId).emit('voice:forceJoin', { channelId });
      return { socketId, channelId };
    })(data)
  );

  socket.on('admin:kickUser', (data, cb) =>
    ack(cb, async ({ socketId }) => {
      const target = io.sockets.sockets.get(socketId);
      if (!target) throw new Error('Usuário não conectado.');
      target.emit('kicked', { reason: 'Você foi removido por um administrador.' });
      target.disconnect(true);
      return { socketId };
    })(data)
  );

  socket.on('admin:silenceUser', (data, cb) =>
    ack(cb, async ({ socketId, muted = true }) => {
      const presence = state.getPresence(socketId);
      if (!presence) throw new Error('Usuário não conectado.');
      state.setVoiceState(socketId, { muted: !!muted });
      io.to(socketId).emit('voice:forceMute', { muted: !!muted });
      io.emit('presence:update', state.listPresence());
      return { socketId, muted: !!muted };
    })(data)
  );
}
