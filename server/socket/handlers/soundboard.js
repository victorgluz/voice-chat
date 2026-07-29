import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../config/index.js';
import { createSound, listSounds, getSound, deleteSound } from '../../database/repositories/sounds.js';
import * as state from '../state.js';
import { cleanSoundName, cleanAvatar } from '../../util/sanitize.js';

const roomName = (channelId) => `voice:${channelId}`;

/** URL de upload válida: relativa a /uploads e sem path traversal. */
function isUploadUrl(url) {
  return typeof url === 'string' && url.startsWith('/uploads/') && !url.includes('..') && url.length < 256;
}

/** Apaga (best-effort) um arquivo de /uploads a partir da sua URL pública. */
function removeUploadFile(url) {
  if (!isUploadUrl(url)) return;
  const file = path.join(config.paths.uploads, path.basename(url));
  fs.unlink(file, () => {});
}

/**
 * Soundboard: biblioteca global de sons. Qualquer usuário autenticado envia e
 * toca; apagar só o autor do som ou um admin. Tocar um som faz broadcast para
 * o canal de voz atual (todos ouvem localmente); fora de call, toca só para
 * quem clicou (preview).
 */
export function registerSoundboardHandlers(io, socket) {
  const ack = (cb, fn) => async (data) => {
    try {
      const result = await fn(data);
      if (typeof cb === 'function') cb({ data: result });
    } catch (err) {
      if (typeof cb === 'function') cb({ error: err.message });
    }
  };

  const requirePresence = () => {
    const presence = state.getPresence(socket.id);
    if (!presence) throw new Error('Não autenticado.');
    return presence;
  };

  socket.on('soundboard:list', (data, cb) => ack(cb, async () => listSounds())(data));

  socket.on('soundboard:add', (data, cb) =>
    ack(cb, async ({ name, icon = null, url, mime = null, size = null } = {}) => {
      const presence = requirePresence();

      const cleanName = cleanSoundName(name);
      if (!cleanName) throw new Error('Dê um nome ao som.');
      if (!isUploadUrl(url)) throw new Error('Áudio inválido.');

      // Ícone é opcional: aceita URL de /uploads ou emoji (via cleanAvatar).
      const cleanIcon = icon ? cleanAvatar(icon) : null;

      const sound = createSound({
        name: cleanName,
        icon: cleanIcon,
        url,
        mime: typeof mime === 'string' ? mime.slice(0, 100) : null,
        size: Number.isFinite(size) ? size : null,
        uploaderId: presence.user.id,
      });

      io.emit('soundboard:update', listSounds());
      return sound;
    })(data)
  );

  socket.on('soundboard:delete', (data, cb) =>
    ack(cb, async ({ id } = {}) => {
      const presence = requirePresence();
      const sound = getSound(id);
      if (!sound) throw new Error('Som inexistente.');

      const isOwner = sound.uploaderId && sound.uploaderId === presence.user.id;
      if (!isOwner && !presence.user.isAdmin) {
        throw new Error('Só quem enviou o som (ou um admin) pode apagá-lo.');
      }

      deleteSound(id);
      removeUploadFile(sound.url);
      // Só remove o ícone do disco se for um arquivo (não emoji) e exclusivo.
      if (sound.icon && sound.icon.startsWith('/uploads/')) removeUploadFile(sound.icon);

      io.emit('soundboard:update', listSounds());
      return { id };
    })(data)
  );

  socket.on('soundboard:play', (data, cb) =>
    ack(cb, async ({ id } = {}) => {
      const presence = requirePresence();
      const sound = getSound(id);
      if (!sound) throw new Error('Som inexistente.');

      const channelId = presence.voiceChannelId;
      if (channelId) {
        io.to(roomName(channelId)).emit('soundboard:play', {
          sound,
          playedBy: presence.user.name,
          playerId: socket.id, // socketId de quem tocou (p/ volume de efeitos por pessoa)
        });
        return { scope: 'voice' };
      }
      // Fora de um canal de voz: preview só para quem clicou.
      socket.emit('soundboard:play', { sound, preview: true, playerId: socket.id });
      return { scope: 'preview' };
    })(data)
  );

  socket.on('soundboard:stop', (data, cb) =>
    ack(cb, async () => {
      const presence = requirePresence();
      const channelId = presence.voiceChannelId;
      if (channelId) io.to(roomName(channelId)).emit('soundboard:stop');
      else socket.emit('soundboard:stop');
      return { stopped: true };
    })(data)
  );
}
