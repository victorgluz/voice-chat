import { Server } from 'socket.io';
import * as state from './state.js';
import { registerPresenceHandlers } from './handlers/presence.js';
import { registerChatHandlers } from './handlers/chat.js';
import { registerVoiceHandlers } from './handlers/voice.js';
import { registerAdminHandlers } from './handlers/admin.js';
import { registerSoundboardHandlers } from './handlers/soundboard.js';

export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    // Em LAN não há origem cruzada real; liberamos para simplificar.
    cors: { origin: true },
    maxHttpBufferSize: 1e6,
  });

  io.on('connection', (socket) => {
    // Ordem importa: 'voice' é registrado primeiro para que seu cleanup no
    // disconnect rode enquanto a presença ainda existe.
    const voice = registerVoiceHandlers(io, socket);
    registerChatHandlers(io, socket);
    registerAdminHandlers(io, socket);
    registerSoundboardHandlers(io, socket);
    registerPresenceHandlers(io, socket);

    socket.on('disconnect', () => {
      voice.cleanup();
      state.removePresence(socket.id);
      io.emit('presence:update', state.listPresence());
    });
  });

  return io;
}
