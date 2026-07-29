import * as users from '../../database/repositories/users.js';
import { listChannels } from '../../database/repositories/channels.js';
import { getAllSettings } from '../../database/repositories/settings.js';
import * as state from '../state.js';
import { cleanName, cleanAvatar } from '../../util/sanitize.js';

/**
 * Login sem cadastro: o usuário informa nome (e avatar opcional) e recebe
 * um ID temporário. O primeiro a entrar enquanto ninguém está online vira
 * admin — comportamento natural para o "host" numa LAN.
 */
export function registerPresenceHandlers(io, socket) {
  socket.on('auth:login', ({ name, avatar } = {}, cb) => {
    try {
      const cleanedName = cleanName(name);
      if (!cleanedName) throw new Error('Nome inválido.');

      const isFirstOnline = state.listPresence().length === 0;
      const user = users.createUser({
        name: cleanedName,
        avatar: cleanAvatar(avatar),
        isAdmin: isFirstOnline,
      });

      socket.data.userId = user.id;
      state.addPresence(socket.id, {
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        isAdmin: user.isAdmin,
      });

      const payload = {
        user: { id: user.id, name: user.name, avatar: user.avatar, isAdmin: user.isAdmin },
        channels: listChannels(),
        settings: getAllSettings(),
        presence: state.listPresence(),
      };

      if (typeof cb === 'function') cb({ data: payload });
      io.emit('presence:update', state.listPresence());
    } catch (err) {
      if (typeof cb === 'function') cb({ error: err.message });
    }
  });
}
