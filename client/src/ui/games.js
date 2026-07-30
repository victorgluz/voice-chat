import { getState } from '../state.js';
import { request } from '../socket.js';
import { openChessGame, startOnlineChess } from './chess-game.js';
import { showError } from './dialog.js';

/**
 * Modal "Jogos": lista de jogos e, ao escolher xadrez, um seletor de modo
 * (contra o bot ou multiplayer):
 *  - Bot: antes de começar, escolhe o rating do Stockfish (10 níveis, de
 *    1320 a 3190 — faixa que o UCI_Elo do engine aceita).
 *  - Multiplayer: escolhe o tempo de partida (bullet/blitz/rapid) e cria um
 *    CONVITE — uma instância própria, anunciada no chat do canal atual — que
 *    fecha o modal na hora: quem espera é o CARD no chat (spinner + cancelar),
 *    não uma tela deste modal (ver chess-invite-card em chat.js). Vários
 *    convites (e várias partidas) podem existir ao mesmo tempo, inclusive no
 *    mesmo canal.
 */
let overlay, closeBtn, titleEl;
let gridView, modeView, timeView, botLevelView;

export function initGames() {
  overlay = document.getElementById('games-overlay');
  closeBtn = document.getElementById('games-close');
  titleEl = document.getElementById('games-title');
  gridView = document.getElementById('games-grid');
  modeView = document.getElementById('games-mode');
  timeView = document.getElementById('games-timecontrol');
  botLevelView = document.getElementById('games-botlevel');

  document.getElementById('game-tile-chess').addEventListener('click', () => showMode('Xadrez'));
  document.getElementById('mode-back').addEventListener('click', showGrid);
  document.getElementById('mode-bot').addEventListener('click', showBotLevel);
  document.getElementById('mode-online').addEventListener('click', showTimeControl);
  document.getElementById('time-back').addEventListener('click', () => showMode('Xadrez'));
  document.getElementById('botlevel-back').addEventListener('click', () => showMode('Xadrez'));

  for (const btn of timeView.querySelectorAll('.time-option')) {
    btn.addEventListener('click', () => createInvite(Number(btn.dataset.seconds)));
  }

  for (const btn of botLevelView.querySelectorAll('.bot-level-option')) {
    btn.addEventListener('click', () => {
      closeGamesModal();
      openChessGame(Number(btn.dataset.elo));
    });
  }

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
  titleEl.textContent = 'Apps';
  gridView.classList.remove('hidden');
  modeView.classList.add('hidden');
  timeView.classList.add('hidden');
  botLevelView.classList.add('hidden');
}

function showMode(gameName) {
  titleEl.textContent = gameName;
  gridView.classList.add('hidden');
  modeView.classList.remove('hidden');
  timeView.classList.add('hidden');
  botLevelView.classList.add('hidden');
}

function showTimeControl() {
  titleEl.textContent = 'Escolha o tempo';
  gridView.classList.add('hidden');
  modeView.classList.add('hidden');
  timeView.classList.remove('hidden');
  botLevelView.classList.add('hidden');
}

function showBotLevel() {
  titleEl.textContent = 'Escolha o rating do bot';
  gridView.classList.add('hidden');
  modeView.classList.add('hidden');
  timeView.classList.add('hidden');
  botLevelView.classList.remove('hidden');
}

// ---- convite multiplayer ----

async function createInvite(timeControl) {
  const channelId = getState().activeTextChannel;
  if (!channelId) return;
  try {
    await request('chess:invite:create', { channelId, timeControl });
    closeGamesModal();
  } catch (err) {
    showError(err.message);
  }
}

/** Chamado pelo main.js quando o servidor forma a partida (eu criei o convite
 * e alguém entrou, ou eu mesmo cliquei para entrar no convite de outra pessoa). */
export function onMatchFound({ gameId, color, opponentName, opponentAvatar, timeControl, whiteMs, blackMs }) {
  closeGamesModal();
  startOnlineChess({ gameId, color, opponentName, opponentAvatar, timeControl, whiteMs, blackMs });
}
