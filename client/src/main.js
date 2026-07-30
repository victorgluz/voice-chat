import { socket } from './socket.js';
import { getState, setState, subscribe } from './state.js';
import { initLogin } from './ui/login.js';
import { renderChannels } from './ui/channels.js';
import { renderUsers } from './ui/users.js';
import { initChat, setActiveChannel, appendMessage, updateMessage, removeMessage, appendChessInvite, closeChessInvite } from './ui/chat.js';
import { initSettings } from './ui/settings.js';
import { initSoundboard, renderSounds } from './ui/soundboard.js';
import { initScreenShare, renderScreenList } from './ui/screen-share.js';
import { initVideoGrid, renderVideoGrid } from './ui/video-grid.js';
import { initGames, onMatchFound } from './ui/games.js';
import { initChessGame, applyRemoteMove, handleChessGameOver } from './ui/chess-game.js';
import { showError, showInfo } from './ui/dialog.js';
import { voiceClient } from './voice/voice-client.js';
import { initials } from './util/dom.js';
import { setIcon } from './util/icons.js';

const channelHandlers = {
  onSelectText: (id) => setActiveChannel(id),
  onJoinVoice: (id) => joinVoice(id),
};

initLogin(boot);
registerSocketEvents();

// Re-renderiza as colunas sempre que o estado muda (presença, canais, etc.).
subscribe(() => {
  if (getState().me) {
    renderChannels(channelHandlers);
    renderUsers();
    renderSounds();
    renderScreenList();
    renderVideoGrid();
  }
});

function boot(loginData) {
  setState({
    me: loginData.user,
    channels: loginData.channels,
    settings: loginData.settings,
    sounds: loginData.sounds || [],
    presence: loginData.presence,
    users: loginData.users || [],
    mentions: loginData.mentions || [],
  });

  document.getElementById('app').classList.remove('hidden');
  document.getElementById('server-name').textContent = loginData.settings.server_name || 'LOCALL';

  setupSelfPanel();
  initSettings();
  initSoundboard();
  initScreenShare();
  initVideoGrid();
  initChat();
  initGames();
  initChessGame();

  const firstText = loginData.channels.text[0];
  if (firstText) setActiveChannel(firstText.id);

  renderChannels(channelHandlers);
  renderUsers();
  renderSounds();
}

function registerSocketEvents() {
  socket.on('presence:update', (presence) => setState({ presence }));
  socket.on('users:update', (users) => setState({ users }));
  socket.on('channels:update', (channels) => setState({ channels }));
  socket.on('soundboard:update', (sounds) => setState({ sounds }));

  socket.on('soundboard:play', ({ sound, preview, playerId }) =>
    voiceClient.playSound(sound.url, { preview, playerId })
  );
  socket.on('soundboard:stop', () => voiceClient.stopSound());

  socket.on('chat:message', (msg) => {
    const me = getState().me;
    // Fui mencionado (e não sou o autor): toca notificação e marca como não lida
    // (badge). O IntersectionObserver marca lida quando a mensagem for vista.
    if (msg.mentions?.includes(me?.id) && msg.userId !== me?.id) {
      voiceClient.playNotification('mention');
      const mentions = getState().mentions;
      if (!mentions.some((m) => m.messageId === msg.id)) {
        setState({
          mentions: [...mentions, { messageId: msg.id, channelId: msg.channelId, createdAt: msg.createdAt }],
        });
      }
    }
    appendMessage(msg);
  });
  socket.on('chat:updated', updateMessage);
  socket.on('chat:deleted', ({ id }) => removeMessage(id));

  socket.on('chess:invite', appendChessInvite);
  socket.on('chess:invite:closed', ({ id, reason }) => closeChessInvite(id, reason));
  socket.on('chess:matchFound', onMatchFound);
  socket.on('chess:move', applyRemoteMove);
  socket.on('chess:gameOver', handleChessGameOver);

  socket.on('voice:sound', ({ sound }) => voiceClient.playNotification(sound));

  socket.on('voice:forceJoin', ({ channelId }) => joinVoice(channelId));
  socket.on('voice:forceLeave', () => voiceClient.leave());
  socket.on('voice:forceMute', ({ muted }) => voiceClient.setMuted(muted));

  socket.on('kicked', ({ reason }) => {
    showInfo(reason, 'Você foi desconectado', { onClose: () => location.reload() });
  });

  socket.on('connect_error', (err) => console.warn('Socket erro:', err.message));
}

async function joinVoice(channelId) {
  if (voiceClient.channelId === channelId) return;
  try {
    await voiceClient.join(channelId);
  } catch (err) {
    showError('Não foi possível entrar no canal de voz: ' + err.message);
  }
}

function setupSelfPanel() {
  const me = getState().me;
  const avatar = document.getElementById('self-avatar');
  if (me.avatar?.startsWith('/uploads/')) avatar.style.backgroundImage = `url(${me.avatar})`;
  else avatar.textContent = me.avatar || initials(me.name);
  document.getElementById('self-name').textContent = me.name;

  const btnMute = document.getElementById('btn-mute');
  const btnDeaf = document.getElementById('btn-deaf');
  const btnLeave = document.getElementById('btn-leave');

  btnMute.addEventListener('click', () => voiceClient.setMuted(!voiceClient.muted));
  btnDeaf.addEventListener('click', () => voiceClient.setDeaf(!voiceClient.deaf));
  btnLeave.addEventListener('click', () => voiceClient.leave());

  voiceClient.onSpeaking = (speaking) => {
    document.getElementById('self-panel').classList.toggle('speaking', speaking);
  };

  // Aviso de autoplay bloqueado: mostra um botão que, ao ser clicado, libera
  // o áudio remoto (o próprio clique já conta como gesto do usuário).
  const unblock = document.getElementById('audio-unblock');
  voiceClient.onAudioBlocked = () => unblock.classList.remove('hidden');
  voiceClient.onAudioResumed = () => unblock.classList.add('hidden');
  unblock.addEventListener('click', () => voiceClient.resumeAudio());

  voiceClient.onStateChange = (s) => {
    setState({ activeVoiceChannel: s.channelId });
    btnMute.classList.toggle('active', s.muted);
    btnDeaf.classList.toggle('active', s.deaf);
    setIcon(btnMute, s.muted ? 'micOff' : 'mic');
    setIcon(btnDeaf, s.deaf ? 'headphonesOff' : 'headphones');

    const status = document.getElementById('voice-status');
    if (s.connected) {
      const name = getState().channels.voice.find((c) => c.id === s.channelId)?.name || '';
      status.classList.remove('hidden');
      status.querySelector('.voice-status-name').textContent = name;
      startCallTimer();
    } else {
      status.classList.add('hidden');
      stopCallTimer();
    }
  };
}

// Cronômetro da chamada (mm:ss ou h:mm:ss), exibido no painel "Voz conectada".
let callTimerId = null;
let callStartedAt = 0;

function startCallTimer() {
  if (callTimerId) return; // já rodando (mudou de mute/deaf, não de call)
  callStartedAt = Date.now();
  const render = () => {
    const el = document.getElementById('call-timer');
    if (el) el.textContent = formatDuration(Date.now() - callStartedAt);
  };
  render();
  callTimerId = setInterval(render, 1000);
}

function stopCallTimer() {
  if (callTimerId) clearInterval(callTimerId);
  callTimerId = null;
  const el = document.getElementById('call-timer');
  if (el) el.textContent = '';
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
