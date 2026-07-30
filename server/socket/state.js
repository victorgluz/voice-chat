/**
 * Estado de presença em memória. Reflete quem está conectado AGORA
 * (o banco guarda o histórico; isto é volátil e some ao reiniciar).
 */
const bySocket = new Map(); // socketId -> presence

function defaultVoice() {
  return { muted: false, deaf: false, speaking: false, sharing: false, cam: false };
}

export function addPresence(socketId, user) {
  const presence = {
    socketId,
    user, // { id, name, avatar, isAdmin }
    voiceChannelId: null,
    voice: defaultVoice(),
  };
  bySocket.set(socketId, presence);
  return presence;
}

export function removePresence(socketId) {
  const presence = bySocket.get(socketId);
  bySocket.delete(socketId);
  return presence;
}

export function getPresence(socketId) {
  return bySocket.get(socketId);
}

export function setVoiceChannel(socketId, voiceChannelId) {
  const p = bySocket.get(socketId);
  if (!p) return null;
  p.voiceChannelId = voiceChannelId;
  if (!voiceChannelId) p.voice = defaultVoice();
  return p;
}

export function setVoiceState(socketId, partial) {
  const p = bySocket.get(socketId);
  if (!p) return null;
  p.voice = { ...p.voice, ...partial };
  return p;
}

/** Lista serializável para os clientes (painel da direita). */
export function listPresence() {
  return [...bySocket.values()].map((p) => ({
    socketId: p.socketId,
    user: p.user,
    voiceChannelId: p.voiceChannelId,
    voice: p.voice,
  }));
}

export function socketsInVoiceChannel(voiceChannelId) {
  return [...bySocket.values()].filter((p) => p.voiceChannelId === voiceChannelId);
}
