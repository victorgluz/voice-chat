import { getState } from '../state.js';
import { request } from '../socket.js';
import { openChessGame, startOnlineChess } from './chess-game.js';
import { showError } from './dialog.js';

/**
 * Modal "Jogos": lista de jogos e, ao escolher xadrez, um seletor de modo
 * (contra o bot ou multiplayer). No multiplayer cria um CONVITE — uma
 * instância própria, anunciada no chat do canal atual — e fecha o modal na
 * hora: quem espera é o CARD no chat (spinner + cancelar), não uma tela deste
 * modal (ver chess-invite-card em chat.js). Vários convites (e várias
 * partidas) podem existir ao mesmo tempo, inclusive no mesmo canal.
 */
let overlay, closeBtn, titleEl;
let gridView, modeView;

export function initGames() {
  overlay = document.getElementById('games-overlay');
  closeBtn = document.getElementById('games-close');
  titleEl = document.getElementById('games-title');
  gridView = document.getElementById('games-grid');
  modeView = document.getElementById('games-mode');

  document.getElementById('game-tile-chess').addEventListener('click', () => showMode('Xadrez'));
  document.getElementById('mode-back').addEventListener('click', showGrid);
  document.getElementById('mode-bot').addEventListener('click', () => {
    closeGamesModal();
    openChessGame();
  });
  document.getElementById('mode-online').addEventListener('click', createInvite);

  closeBtn.addEventListener('click', closeGamesModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeGamesModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeGamesModal();
  });
}

export function openGamesModal() {
  showGrid();
  overlay.classList.remove('hidden');
}

export function closeGamesModal() {
  overlay.classList.add('hidden');
}

// ---- views ----

function showGrid() {
  titleEl.textContent = 'Jogos';
  gridView.classList.remove('hidden');
  modeView.classList.add('hidden');
}

function showMode(gameName) {
  titleEl.textContent = gameName;
  gridView.classList.add('hidden');
  modeView.classList.remove('hidden');
}

// ---- convite multiplayer ----

async function createInvite() {
  const channelId = getState().activeTextChannel;
  if (!channelId) return;
  try {
    await request('chess:invite:create', { channelId });
    closeGamesModal();
  } catch (err) {
    showError(err.message);
  }
}

/** Chamado pelo main.js quando o servidor forma a partida (eu criei o convite
 * e alguém entrou, ou eu mesmo cliquei para entrar no convite de outra pessoa). */
export function onMatchFound({ gameId, color, opponentName }) {
  closeGamesModal();
  startOnlineChess({ gameId, color, opponentName });
}
