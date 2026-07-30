import { Chess } from 'chess.js';
import { el, clear } from '../util/dom.js';
import { request } from '../socket.js';
import { getBestMove, resetEngine } from '../chess/engine.js';
import { showError } from './dialog.js';

/**
 * Modal de xadrez com dois modos:
 *  - 'bot': partida local contra o Stockfish (client-side).
 *  - 'online': partida multiplayer; o servidor é a autoridade. Ao clicar, o
 *    lance vai por request('chess:move') e SÓ é aplicado quando volta pelo
 *    broadcast 'chess:move' (via applyRemoteMove) — mesmo caminho para o meu
 *    lance e o do oponente, então os dois lados ficam sempre em sincronia.
 *
 * Tabuleiro em duas camadas absolutas: `.chess-squares` (grade 8x8 clicável) e
 * `.chess-pieces` (peças posicionadas por %, com transition — dá a animação de
 * deslizar ao mover/capturar/rocar).
 */

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
// Usa os glifos sólidos (pretos) para as duas cores; os "brancos" do Unicode
// são só contorno vazado e não enchem ao pintar via CSS.
const GLYPH = {
  w: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' },
  b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' },
};

const BOARD_THEMES = [
  { id: 'green', name: 'Verde', light: '#ebecd0', dark: '#779556' },
  { id: 'blue', name: 'Azul', light: '#dee3e6', dark: '#4b7399' },
  { id: 'wood', name: 'Madeira', light: '#f0d9b5', dark: '#b58863' },
  { id: 'gray', name: 'Cinza', light: '#e9e9e9', dark: '#6b7280' },
];

const PIECE_THEMES = [
  { id: 'classic', name: 'Clássico', wFill: '#fdfdfd', wStroke: '#1a1a1a', bFill: '#1a1a1a', bStroke: '#1a1a1a' },
  { id: 'ivory', name: 'Marfim', wFill: '#f6ecd9', wStroke: '#5b3a21', bFill: '#5b3a21', bStroke: '#2e1c10' },
  { id: 'ocean', name: 'Oceano', wFill: '#eaf6ff', wStroke: '#0b4f6c', bFill: '#0b4f6c', bStroke: '#062c3d' },
  { id: 'ember', name: 'Brasa', wFill: '#ffe8d6', wStroke: '#7a1f1f', bFill: '#7a1f1f', bStroke: '#3d0f0f' },
];

let overlay, closeBtn, newBtn, resignBtn, statusEl, boardEl, squaresLayer, piecesLayer;
let boardThemeList, pieceThemeList;
let initialized = false;

let chess = null;
let mode = 'bot'; // 'bot' | 'online'
let online = null; // { gameId, opponentName } no modo online
let playerColor = 'w';
let orientation = 'w';
let selectedSquare = null;
let busy = false; // anima/aguarda bot ou servidor — bloqueia cliques
let gameOver = false;

export function initChessGame() {
  overlay = document.getElementById('chess-overlay');
  closeBtn = document.getElementById('chess-close');
  newBtn = document.getElementById('chess-new');
  resignBtn = document.getElementById('chess-resign');
  statusEl = document.getElementById('chess-status');
  boardEl = document.getElementById('chess-board');

  squaresLayer = el('div', { class: 'chess-squares' });
  piecesLayer = el('div', { class: 'chess-pieces' });
  boardEl.append(squaresLayer, piecesLayer);

  closeBtn.addEventListener('click', closeGame);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeGame();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeGame();
  });
  newBtn.addEventListener('click', () => startNewGame());
  resignBtn.addEventListener('click', () => {
    if (mode === 'online' && !gameOver) request('chess:resign', { gameId: online.gameId }).catch(() => {});
  });

  boardThemeList = document.getElementById('board-theme-list');
  pieceThemeList = document.getElementById('piece-theme-list');
  renderThemeSwatches();
  applyBoardTheme(localStorage.getItem('chess-board-theme') || BOARD_THEMES[0].id);
  applyPieceTheme(localStorage.getItem('chess-piece-theme') || PIECE_THEMES[0].id);

  initialized = true;
}

function closeGame() {
  // Sair no meio de uma partida online conta como desistência.
  if (mode === 'online' && !gameOver) request('chess:resign', { gameId: online.gameId }).catch(() => {});
  overlay.classList.add('hidden');
}

// ---- abertura: bot ----

export function openChessGame() {
  if (!initialized) initChessGame();
  mode = 'bot';
  online = null;
  newBtn.classList.remove('hidden');
  resignBtn.classList.add('hidden');
  overlay.classList.remove('hidden');
  startNewGame();
}

async function startNewGame() {
  if (mode !== 'bot') return; // "Novo jogo" só existe no modo bot
  chess = new Chess();
  playerColor = Math.random() < 0.5 ? 'w' : 'b';
  orientation = playerColor;
  selectedSquare = null;
  busy = false;
  gameOver = false;
  resetEngine();
  renderFullBoard();
  updateStatus();
  if (playerColor === 'b') {
    busy = true;
    setTimeout(botTurn, 400);
  }
}

// ---- abertura: online ----

export function startOnlineChess({ gameId, color, opponentName }) {
  if (!initialized) initChessGame();
  mode = 'online';
  online = { gameId, opponentName };
  chess = new Chess();
  playerColor = color;
  orientation = color;
  selectedSquare = null;
  busy = false;
  gameOver = false;
  newBtn.classList.add('hidden');
  resignBtn.classList.remove('hidden');
  renderFullBoard();
  updateStatus();
  overlay.classList.remove('hidden');
}

/** Lance autoritativo vindo do servidor (meu ou do oponente). */
export function applyRemoteMove({ from, to, promotion, fen }) {
  if (mode !== 'online' || !chess) return;
  let result = null;
  try {
    result = chess.move({ from, to, promotion: promotion || undefined });
  } catch {
    result = null;
  }
  if (result) {
    animateMove(result);
  } else if (fen) {
    // Dessincronizou: reconstrói do FEN autoritativo.
    chess.load(fen);
    renderFullBoard();
    markCheck();
  }
  busy = false;
  selectedSquare = null;
  clearHighlights();
  updateStatus();
}

/** Fim de partida online, anunciado pelo servidor. */
export function handleChessGameOver({ reason, winner }) {
  if (mode !== 'online') return;
  gameOver = true;
  busy = true;
  resignBtn.classList.add('hidden');
  const won = winner === playerColor;
  const opp = online?.opponentName || 'Oponente';
  let msg;
  if (reason === 'checkmate') msg = won ? 'Xeque-mate — você venceu! 🎉' : 'Xeque-mate — você perdeu.';
  else if (reason === 'resign') msg = won ? `${opp} desistiu — você venceu!` : 'Você desistiu.';
  else if (reason === 'opponentLeft') msg = `${opp} saiu da partida — você venceu!`;
  else if (reason === 'stalemate') msg = 'Afogamento — empate.';
  else msg = 'Empate.';
  statusEl.textContent = msg;
}

// ---- coordenadas ----

function squareToXY(square) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]) - 1;
  return orientation === 'w' ? { col: file, row: 7 - rank } : { col: 7 - file, row: rank };
}

function xyToSquare(col, row) {
  const file = orientation === 'w' ? col : 7 - col;
  const rank = orientation === 'w' ? 7 - row : row;
  return FILES[file] + (rank + 1);
}

// ---- render ----

function renderFullBoard() {
  clear(squaresLayer);
  clear(piecesLayer);

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = xyToSquare(col, row);
      const fileIdx = FILES.indexOf(square[0]);
      const rankIdx = Number(square[1]) - 1;
      const light = (fileIdx + rankIdx) % 2 === 1;
      squaresLayer.append(
        el('button', {
          type: 'button',
          class: `chess-square ${light ? 'light' : 'dark'}`,
          dataset: { square },
          onClick: () => onSquareClick(square),
        })
      );
    }
  }

  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) piecesLayer.append(createPieceEl(cell.square, cell.color, cell.type));
    }
  }
}

function createPieceEl(square, color, type) {
  const { col, row } = squareToXY(square);
  const node = el('div', { class: `chess-piece piece-${color}`, dataset: { square } }, GLYPH[color][type]);
  node.style.left = `${col * 12.5}%`;
  node.style.top = `${row * 12.5}%`;
  return node;
}

function squareBtn(square) {
  return squaresLayer.querySelector(`[data-square="${square}"]`);
}

function pieceAt(square) {
  return piecesLayer.querySelector(`[data-square="${square}"]`);
}

// ---- seleção e destaques ----

function clearHighlights() {
  squaresLayer.querySelectorAll('.selected, .move-hint, .move-hint-capture').forEach((b) => {
    b.classList.remove('selected', 'move-hint', 'move-hint-capture');
  });
}

function selectSquare(square) {
  clearHighlights();
  selectedSquare = square;
  squareBtn(square)?.classList.add('selected');
  for (const m of chess.moves({ square, verbose: true })) {
    squareBtn(m.to)?.classList.add(m.captured ? 'move-hint-capture' : 'move-hint');
  }
}

function clearSelection() {
  clearHighlights();
  selectedSquare = null;
}

function markCheck() {
  squaresLayer.querySelectorAll('.in-check').forEach((b) => b.classList.remove('in-check'));
  if (chess.inCheck()) {
    const kingSquare = chess.board().flat().find((c) => c && c.type === 'k' && c.color === chess.turn())?.square;
    if (kingSquare) squareBtn(kingSquare)?.classList.add('in-check');
  }
}

// ---- interação ----

function onSquareClick(square) {
  if (busy || gameOver || chess.isGameOver() || chess.turn() !== playerColor) return;

  const piece = chess.get(square);

  if (selectedSquare) {
    if (square === selectedSquare) {
      clearSelection();
      return;
    }
    const legal = chess.moves({ square: selectedSquare, verbose: true });
    const matches = legal.filter((m) => m.to === square);
    if (matches.length) {
      playMove(matches);
      return;
    }
  }

  if (piece && piece.color === playerColor) selectSquare(square);
  else clearSelection();
}

async function playMove(matches) {
  clearSelection();
  let promotion;
  if (matches.length > 1) {
    promotion = await askPromotion(playerColor);
    if (!promotion) return; // cancelado
  }
  const chosen = matches.find((m) => m.promotion === promotion) || matches[0];

  if (mode === 'online') {
    // Não aplica local: manda ao servidor e espera o broadcast (applyRemoteMove).
    busy = true;
    updateStatus();
    try {
      await request('chess:move', {
        gameId: online.gameId,
        from: chosen.from,
        to: chosen.to,
        promotion: chosen.promotion || null,
      });
    } catch (err) {
      busy = false;
      showError(err.message);
      updateStatus();
    }
    return;
  }

  // Modo bot: aplica local e chama o bot.
  const result = chess.move({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
  animateMove(result);
  updateStatus();
  if (!chess.isGameOver()) {
    busy = true;
    setTimeout(botTurn, 250);
  }
}

async function botTurn() {
  busy = true;
  statusEl.textContent = 'Bot pensando…';
  try {
    const uci = await getBestMove(chess.fen());
    if (!uci) return;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const result = chess.move({ from, to, promotion });
    animateMove(result);
  } finally {
    busy = false;
    updateStatus();
  }
}

// ---- animação ----

function animateMove(move) {
  const fromEl = pieceAt(move.from);

  // Remove a peça capturada ANTES de mover a atacante para o destino — senão as
  // duas ficam com o mesmo data-square e o seletor pode pegar a errada.
  if (move.isCapture()) {
    let capturedSquare = move.to;
    if (move.isEnPassant()) {
      const dir = move.color === 'w' ? -1 : 1;
      capturedSquare = move.to[0] + (Number(move.to[1]) + dir);
    }
    const capEl = pieceAt(capturedSquare);
    if (capEl) {
      capEl.classList.add('piece-captured');
      setTimeout(() => capEl.remove(), 150);
    }
  }

  if (fromEl) {
    fromEl.dataset.square = move.to;
    const { col, row } = squareToXY(move.to);
    fromEl.style.left = `${col * 12.5}%`;
    fromEl.style.top = `${row * 12.5}%`;
    if (move.promotion) {
      fromEl.textContent = GLYPH[move.color][move.promotion];
    }
  }

  if (move.isKingsideCastle() || move.isQueensideCastle()) {
    const rank = move.color === 'w' ? '1' : '8';
    const kingside = move.isKingsideCastle();
    const rookFrom = (kingside ? 'h' : 'a') + rank;
    const rookTo = (kingside ? 'f' : 'd') + rank;
    const rookEl = pieceAt(rookFrom);
    if (rookEl) {
      rookEl.dataset.square = rookTo;
      const { col, row } = squareToXY(rookTo);
      rookEl.style.left = `${col * 12.5}%`;
      rookEl.style.top = `${row * 12.5}%`;
    }
  }

  markCheck();
}

// ---- promoção ----

function askPromotion(color) {
  return new Promise((resolve) => {
    const choices = ['q', 'r', 'b', 'n'];
    let box;
    const onChoose = (p) => {
      box.remove();
      resolve(p);
    };
    box = el(
      'div',
      { class: 'promo-picker' },
      choices.map((p) => el('button', { type: 'button', class: 'promo-choice', onClick: () => onChoose(p) }, GLYPH[color][p]))
    );
    boardEl.append(box);
  });
}

// ---- status ----

function updateStatus() {
  if (gameOver) return;
  const yourTurn = chess.turn() === playerColor;

  if (mode === 'online') {
    const youAre = playerColor === 'w' ? 'brancas' : 'pretas';
    const opp = online?.opponentName || 'Oponente';
    if (busy && yourTurn) {
      statusEl.textContent = 'Enviando lance…';
      return;
    }
    statusEl.textContent = `${yourTurn ? 'Sua vez' : `Vez de ${opp}`} — vs ${opp} (você: ${youAre})${chess.inCheck() ? ' — Xeque!' : ''}`;
    return;
  }

  const youAre = playerColor === 'w' ? 'brancas' : 'pretas';
  if (chess.isCheckmate()) {
    const playerWon = chess.turn() !== playerColor;
    statusEl.textContent = playerWon ? `Xeque-mate — você venceu! (você jogou de ${youAre})` : 'Xeque-mate — você perdeu.';
    return;
  }
  if (chess.isStalemate() || chess.isDraw()) {
    statusEl.textContent = 'Empate.';
    return;
  }
  statusEl.textContent = `${yourTurn ? 'Sua vez' : 'Vez do bot'} (você joga de ${youAre})${chess.inCheck() ? ' — Xeque!' : ''}`;
}

// ---- temas ----

function renderThemeSwatches() {
  clear(boardThemeList);
  for (const t of BOARD_THEMES) {
    const swatch = el('button', { type: 'button', class: 'theme-swatch', dataset: { theme: t.id }, title: t.name, onClick: () => applyBoardTheme(t.id) }, [
      el('span', { class: 'theme-swatch-half', style: `background:${t.light}` }),
      el('span', { class: 'theme-swatch-half', style: `background:${t.dark}` }),
    ]);
    boardThemeList.append(swatch);
  }

  clear(pieceThemeList);
  for (const t of PIECE_THEMES) {
    const wGlyph = el('span', { class: 'swatch-w', style: `color:${t.wFill};-webkit-text-stroke:1px ${t.wStroke}` }, GLYPH.w.k);
    const bGlyph = el('span', { class: 'swatch-b', style: `color:${t.bFill};-webkit-text-stroke:1px ${t.bStroke}` }, GLYPH.b.k);
    const swatch = el('button', { type: 'button', class: 'piece-theme-swatch', dataset: { theme: t.id }, title: t.name, onClick: () => applyPieceTheme(t.id) }, [wGlyph, bGlyph]);
    pieceThemeList.append(swatch);
  }
}

function applyBoardTheme(id) {
  const t = BOARD_THEMES.find((x) => x.id === id) || BOARD_THEMES[0];
  boardEl.style.setProperty('--sq-light', t.light);
  boardEl.style.setProperty('--sq-dark', t.dark);
  localStorage.setItem('chess-board-theme', t.id);
  boardThemeList.querySelectorAll('.theme-swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === t.id));
}

function applyPieceTheme(id) {
  const t = PIECE_THEMES.find((x) => x.id === id) || PIECE_THEMES[0];
  boardEl.style.setProperty('--piece-w-fill', t.wFill);
  boardEl.style.setProperty('--piece-w-stroke', t.wStroke);
  boardEl.style.setProperty('--piece-b-fill', t.bFill);
  boardEl.style.setProperty('--piece-b-stroke', t.bStroke);
  localStorage.setItem('chess-piece-theme', t.id);
  pieceThemeList.querySelectorAll('.piece-theme-swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === t.id));
}
