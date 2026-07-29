/** Store reativo minimalista: um objeto de estado + assinantes notificados
 *  a cada mudança. Evita trazer um framework para algo tão pequeno. */

const state = {
  me: null, // { id, name, avatar, isAdmin }
  channels: { text: [], voice: [] },
  presence: [], // [{ socketId, user, voiceChannelId, voice }]
  settings: {},
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
