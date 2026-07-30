/** Store reativo minimalista: um objeto de estado + assinantes notificados
 *  a cada mudança. Evita trazer um framework para algo tão pequeno. */

const state = {
  me: null, // { id, name, avatar, isAdmin }
  channels: { text: [], voice: [] },
  presence: [], // [{ socketId, user, voiceChannelId, voice }]
  users: [], // todos os cadastrados: [{ id, name, avatar, isAdmin, lastSeen }]
  mentions: [], // menções não lidas para mim: [{ messageId, channelId, createdAt }]
  settings: {},
  sounds: [], // soundboard: [{ id, name, icon, url, mime, size, uploaderId, ... }]
  activeTextChannel: null,
  activeVoiceChannel: null,
  replyingTo: null, // mensagem sendo respondida
};

const subscribers = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of subscribers) fn(state);
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function presenceInVoice(channelId) {
  return state.presence.filter((p) => p.voiceChannelId === channelId);
}

/** Um usuário está online se tem presença ativa (socket conectado). */
export function isOnline(userId) {
  return state.presence.some((p) => p.user.id === userId);
}

/** Quantidade de menções não lidas num canal de texto. */
export function unreadMentions(channelId) {
  return state.mentions.filter((m) => m.channelId === channelId).length;
}
