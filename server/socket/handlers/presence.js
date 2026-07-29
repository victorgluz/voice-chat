import * as users from '../../database/repositories/users.js';
import { listChannels } from '../../database/repositories/channels.js';
import { getAllSettings } from '../../database/repositories/settings.js';
import { listSounds } from '../../database/repositories/sounds.js';
import * as state from '../state.js';
import { cleanName, cleanAvatar } from '../../util/sanitize.js';
import { verifyToken } from '../../util/auth.js';

/**
 * Sessão via token: o cadastro/login acontece por HTTP (routes/auth.js) e
 * devolve um token. O cliente guarda o token no localStorage e o envia aqui
 * para (re)estabelecer a presença em tempo real — inclusive após um F5.
 */
export function registerPresenceHandlers(io, socket) {
  socket.on('auth:session', ({ token } = {}, cb) => {
    try {
      const payload = verifyToken(token);
      const user = payload && users.getUser(payload.uid);
      if (!user) throw new Error('Sessão inválida. Faça login novamente.');

      users.touchUser(user.id);
      socket.data.userId = user.id;
      state.addPresence(socket.id, {
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        isAdmin: user.isAdmin,
      });

      const payloadOut = {
        user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, isAdmin: user.isAdmin },
        channels: listChannels(),
        settings: getAllSettings(),
        sounds: listSounds(),
        presence: state.listPresence(),
      };

      if (typeof cb === 'function') cb({ data: payloadOut });
      io.emit('presence:update', state.listPresence());
    } catch (err) {
      if (typeof cb === 'function') cb({ error: err.message });
    }
  });

  // Edição do próprio nome (nas configurações). Persiste e propaga a todos.
  socket.on('user:updateName', ({ name } = {}, cb) => {
    try {
      const presence = state.getPresence(socket.id);
      if (!presence) throw new Error('Não autenticado.');

      const cleaned = cleanName(name);
      if (!cleaned) throw new Error('Nome inválido.');

      const user = users.updateUserName(presence.user.id, cleaned);
      presence.user.name = user.name;

      if (typeof cb === 'function') cb({ data: { name: user.name } });
      io.emit('presence:update', state.listPresence());
    } catch (err) {
      if (typeof cb === 'function') cb({ error: err.message });
    }
  });

  // Edição da própria foto de perfil (nas configurações). A imagem já foi
  // enviada por HTTP (/api/upload); aqui só persistimos a URL e propagamos a
  // todos, para que o novo avatar apareça no painel de todos em tempo real.
  socket.on('user:updateAvatar', ({ avatar } = {}, cb) => {
    try {
      const presence = state.getPresence(socket.id);
      if (!presence) throw new Error('Não autenticado.');

      const cleaned = cleanAvatar(avatar);
      if (!cleaned) throw new Error('Imagem inválida.');

      const user = users.updateUserAvatar(presence.user.id, cleaned);
      presence.user.avatar = user.avatar;

      if (typeof cb === 'function') cb({ data: { avatar: user.avatar } });
      io.emit('presence:update', state.listPresence());
    } catch (err) {
      if (typeof cb === 'function') cb({ error: err.message });
    }
  });
}
