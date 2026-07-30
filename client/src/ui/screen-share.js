import { getState } from '../state.js';
import { voiceClient } from '../voice/voice-client.js';
import { el, clear, initials } from '../util/dom.js';
import { showError } from './dialog.js';

/**
 * UI do compartilhamento de tela:
 *   - botão de compartilhar (na barra do usuário);
 *   - lista flutuante de quem está compartilhando no canal de voz atual;
 *   - overlay em tela cheia para assistir a uma tela por vez.
 * Toda a mídia é tratada pelo voiceClient; aqui só cuidamos do DOM.
 */
export function initScreenShare() {
  const btn = document.getElementById('btn-screen');
  const overlay = document.getElementById('screen-overlay');
  const video = document.getElementById('screen-video');
  const title = document.getElementById('screen-overlay-title');
  const closeBtn = document.getElementById('screen-overlay-close');

  btn.addEventListener('click', async () => {
    try {
      if (voiceClient.sharing) voiceClient.stopScreenShare();
      else await voiceClient.startScreenShare();
    } catch (err) {
      // getDisplayMedia lança se o usuário cancelar o seletor; ignore esse caso.
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        showError('Não foi possível compartilhar a tela: ' + err.message);
      }
    }
  });

  closeBtn.addEventListener('click', () => voiceClient.stopWatching());

  voiceClient.onShareStateChange = (sharing) => {
    btn.classList.toggle('active', sharing);
    btn.title = sharing ? 'Parar de compartilhar' : 'Compartilhar tela';
    renderScreenList();
  };

  voiceClient.onScreensChange = renderScreenList;

  voiceClient.onWatchStart = (stream, peerId) => {
    video.srcObject = stream;
    title.textContent = `Tela de ${peerName(peerId)}`;
    overlay.classList.remove('hidden');
    video.play().catch(() => {});
  };

  voiceClient.onWatchStop = () => {
    overlay.classList.add('hidden');
    video.srcObject = null;
  };
}

/** Nome de um participante a partir do socketId (peerId). */
function peerName(peerId) {
  const p = getState().presence.find((x) => x.socketId === peerId);
  return p?.user?.name || 'alguém';
}

/** Renderiza a lista flutuante de telas disponíveis para assistir. */
export function renderScreenList() {
  const container = document.getElementById('screen-list');
  if (!container) return;
  clear(container);

  const screens = [...voiceClient.availableScreens.values()];
  if (!voiceClient.connected || screens.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  container.append(el('div', { class: 'screen-list-head' }, 'Telas compartilhadas'));

  for (const { peerId } of screens) {
    const name = peerName(peerId);
    const watching = voiceClient.watching?.peerId === peerId;
    const row = el(
      'button',
      {
        class: `screen-item${watching ? ' active' : ''}`,
        onClick: () => (watching ? voiceClient.stopWatching() : watchScreen(peerId)),
      },
      [avatar(peerId, name), el('span', { class: 'screen-item-name' }, name)]
    );
    container.append(row);
  }
}

function watchScreen(peerId) {
  voiceClient.watchScreen(peerId).catch((err) => showError('Não foi possível assistir: ' + err.message));
}

function avatar(peerId, name) {
  const p = getState().presence.find((x) => x.socketId === peerId);
  const node = el('div', { class: 'avatar avatar-sm' });
  const av = p?.user?.avatar;
  if (av?.startsWith('/uploads/')) node.style.backgroundImage = `url(${av})`;
  else node.textContent = av || initials(name);
  return node;
}
