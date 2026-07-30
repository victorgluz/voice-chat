import { request } from '../socket.js';
import { openChessGame, startOnlineChess } from './chess-game.js';
import { showError } from './dialog.js';

/**
 * Modal "Jogos": lista de jogos e, ao escolher xadrez, um seletor de modo
 * (contra o bot ou multiplayer). No multiplayer entra numa fila aberta e
 * espera outro jogador; quando o servidor pareia (evento chess:matchFound,
 * tratado em main.js), a partida online abre.
 */
let overlay, closeBtn, titleEl;
let gridView, modeView, waitingView;
let inQueue = false;

export function initGames() {
  overlay = document.getElementById('games-overlay');
  closeBtn = document.getElementById('games-close');
  titleEl = document.getElementById('games-title');
  gridView = document.getElementById('games-grid');
  modeView = document.getElementById('games-mode');
  waitingView = document.getElementById('games-waiting');

  document.getElementById('game-tile-chess').addEventListener('click', () => showMode('Xadrez'));
  document.getElementById('mode-back').addEventListener('click', showGrid);
  document.getElementById('mode-bot').addEventListener('click', () => {
    closeGamesModal();
    openChessGame();
  });
  document.getElementById('mode-online').addEventListener('click', joinQueue);
  document.getElementById('waiting-cancel').addEventListener('click', leaveQueue);

  closeBtn.addEventListener('click', () => {
    leaveQueue();
    closeGamesModal();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      leaveQueue();
      closeGamesModal();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
      leaveQueue();
      closeGamesModal();
    }
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
  waitingView.classList.add('hidden');
}

function showMode(gameName) {
  titleEl.textContent = gameName;
  gridView.classList.add('hidden');
  modeView.classList.remove('hidden');
  waitingView.classList.add('hidden');
}

function showWaiting() {
  gridView.classList.add('hidden');
  modeView.classList.add('hidden');
  waitingView.classList.remove('hidden');
}

// ---- fila multiplayer ----

async function joinQueue() {
  showWaiting();
  inQueue = true;
  try {
    await request('chess:queueJoin');
    // Se pareou na hora, chess:matchFound já chegou (ver main.js) e fechou o modal.
  } catch (err) {
    inQueue = false;
    showError(err.message);
    showMode('Xadrez');
  }
}

function leaveQueue() {
  if (!inQueue) return;
  inQueue = false;
  request('chess:queueLeave').catch(() => {});
}

/** Chamado pelo main.js quando o servidor forma a partida. */
export function onMatchFound({ gameId, color, opponentName }) {
  inQueue = false;
  closeGamesModal();
  startOnlineChess({ gameId, color, opponentName });
}
