import { Chess } from 'chess.js';
import { el, clear } from '../util/dom.js';
import { request } from '../socket.js';
import { getBestMove, resetEngine } from '../chess/engine.js';
import { showError } from './dialog.js';

/**
 * Modal de xadrez com dois modos:
 *  - 'bot': partida local contra o Stockfish (client-side).
 *  - 'online': partida multiplayer; o servidor é a autoridade. Ao clicar/soltar
 *    um lance, ele vai por request('chess:move') e SÓ é aplicado quando volta
 *    pelo broadcast 'chess:move' (via applyRemoteMove) — mesmo caminho para o
 *    meu lance e o do oponente, então os dois lados ficam sempre em sincronia.
 *
 * Tabuleiro em três camadas absolutas do mesmo tamanho:
 *  - `.chess-squares`: grade 8x8 clicável, estática entre lances.
 *  - `.chess-pieces`: peças posicionadas por %, com transition (animação de
 *    deslizar ao mover/capturar/rocar).
 *  - `.chess-arrows`: SVG por cima de tudo, com as setas desenhadas com botão
 *    direito (arrastar) — puramente uma anotação local, não sincroniza com o
 *    oponente, igual ao chess.com.
 *
 * Interação por clique (mousedown+mouseup sem mover) e por arrastar (drag) usam
 * o MESMO caminho de lance (playMove) — dragging só decide se um "click"
 * nativo deve ou não seguir adiante (suppressNextClick), pra não selecionar/
 * desselecionar em duplicidade.
 */

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

const BOARD_THEMES = [
  { id: 'green', name: 'Verde', light: '#ebecd0', dark: '#779556' },
  { id: 'blue', name: 'Azul', light: '#dee3e6', dark: '#4b7399' },
  { id: 'wood', name: 'Madeira', light: '#f0d9b5', dark: '#b58863' },
  { id: 'gray', name: 'Cinza', light: '#e9e9e9', dark: '#6b7280' },
];

const ARROW_COLOR = '#f2a93c'; // laranja padrão do chess.com para setas de botão direito
const DRAG_THRESHOLD = 10; // px — abaixo disso, conta como clique, não arrasto (folga p/ tremor natural da mão)

let overlay, closeBtn, newBtn, resignBtn, statusEl, boardEl, squaresLayer, piecesLayer, arrowsLayer, previewGroup;
let boardThemeList;
let initialized = false;

let chess = null;
let mode = 'bot'; // 'bot' | 'online'
let online = null; // { gameId, opponentName } no modo online
let playerColor = 'w';
let orientation = 'w';
let selectedSquare = null;
let busy = false; // anima/aguarda bot ou servidor — bloqueia cliques
let gameOver = false;

// Anotações locais (não sincronizam com o oponente — só o seu próprio olhar).
const markedSquares = new Set();
const arrows = []; // [{from, to}]

// Estado de arrasto (mouse esquerdo move peça, direito desenha seta/marca).
let pieceDrag = null; // { square, startX, startY, moved, ghost, size }
let arrowDrag = null; // { fromSquare, startX, startY, moved }
let suppressNextClick = false;
let instantNextMove = false; // true: o próximo lance (meu) veio de drag-and-drop — pula a animação de slide

export function initChessGame() {
  overlay = document.getElementById('chess-overlay');
  closeBtn = document.getElementById('chess-close');
  newBtn = document.getElementById('chess-new');
  resignBtn = document.getElementById('chess-resign');
  statusEl = document.getElementById('chess-status');
  boardEl = document.getElementById('chess-board');

  squaresLayer = el('div', { class: 'chess-squares' });
  piecesLayer = el('div', { class: 'chess-pieces' });
  arrowsLayer = svgEl('svg', { class: 'chess-arrows', viewBox: '0 0 100 100', preserveAspectRatio: 'none' });
  const defs = svgEl('defs', {});
  const marker = svgEl('marker', {
    id: 'chess-arrowhead',
    viewBox: '0 0 10 10',
    markerWidth: '3.2',
    markerHeight: '3.2',
    refX: '8.5',
    refY: '5',
    orient: 'auto-start-reverse',
    markerUnits: 'userSpaceOnUse',
  });
  marker.append(svgEl('path', { d: 'M0,1 L9,5 L0,9 Z', fill: ARROW_COLOR }));
  defs.append(marker);
  previewGroup = svgEl('g', { class: 'chess-arrow-preview' });
  arrowsLayer.append(defs, previewGroup);
  boardEl.append(squaresLayer, piecesLayer, arrowsLayer);

  // Botão direito nunca abre o menu nativo — vira ferramenta de anotação.
  boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

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
  renderThemeSwatches();
  applyBoardTheme(localStorage.getItem('chess-board-theme') || BOARD_THEMES[0].id);

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
  const instant = instantNextMove;
  instantNextMove = false;
  let result = null;
  try {
    result = chess.move({ from, to, promotion: promotion || undefined });
  } catch {
    result = null;
  }
  if (result) {
    animateMove(result, { instant });
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

/** Quadrado sob um ponto da tela (clientX/Y), ou null se fora do tabuleiro. */
function squareFromPoint(clientX, clientY) {
  const rect = boardEl.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
  const col = Math.min(7, Math.floor((x / rect.width) * 8));
  const row = Math.min(7, Math.floor((y / rect.height) * 8));
  return xyToSquare(col, row);
}

// ---- render ----

function renderFullBoard() {
  clear(squaresLayer);
  clear(piecesLayer);
  clearAnnotations();

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
          onPointerdown: (e) => onSquarePointerDown(e, square),
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

/** Caminho do SVG do set "Alpha" (Eric Bentzen, via lichess) para uma peça. */
function pieceImg(color, type) {
  return `/pieces/alpha/${color}${type.toUpperCase()}.svg`;
}

function createPieceEl(square, color, type) {
  const { col, row } = squareToXY(square);
  const node = el('div', { class: `chess-piece piece-${color}`, dataset: { square } });
  node.style.left = `${col * 12.5}%`;
  node.style.top = `${row * 12.5}%`;
  node.style.backgroundImage = `url(${pieceImg(color, type)})`;
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

// ---- interação: clique ----

function onSquareClick(square) {
  if (suppressNextClick) {
    // Esse clique é o "eco" nativo de um arrasto que a gente já tratou.
    suppressNextClick = false;
    return;
  }
  clearAnnotations();
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

// ---- interação: arrastar peça (botão esquerdo) e anotar (botão direito) ----

// Usa Pointer Capture: uma vez capturado, TODOS os eventos seguintes desse
// ponteiro (move/up/cancel) chegam no MESMO elemento, não importa por onde o
// cursor passe — inclusive se sair da janela. Sem isso, um pointerup perdido
// (gesto cancelado pelo navegador, cursor saindo da viewport, etc.) deixava o
// drag "preso": quadrado selecionado para sempre e o fantasma nunca some,
// porque a limpeza só rodava dentro do handler de pointerup.
function onSquarePointerDown(e, square) {
  if (e.button === 2) {
    e.preventDefault();
    arrowDrag = { fromSquare: square, startX: e.clientX, startY: e.clientY, moved: false };
    capturePointer(e, onArrowDragMove, onArrowDragUp);
    return;
  }
  if (e.button !== 0) return;
  if (busy || gameOver || chess.isGameOver() || chess.turn() !== playerColor) return;
  const piece = chess.get(square);
  if (!piece || piece.color !== playerColor) return;

  pieceDrag = { square, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, size: 0 };
  capturePointer(e, onPieceDragMove, onPieceDragUp);
}

/** Captura o ponteiro no elemento do pointerdown e registra move/up/cancel nele
 * (em vez de no document) — up e cancel disparam a MESMA função de limpeza. */
function capturePointer(e, onMove, onEnd) {
  const target = e.currentTarget;
  try {
    target.setPointerCapture(e.pointerId);
  } catch {
    // Ignora — em navegadores sem suporte o gesto ainda funciona, só sem a garantia extra.
  }
  const end = (ev) => {
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    try {
      target.releasePointerCapture(e.pointerId);
    } catch {
      // Idem.
    }
    onEnd(ev);
  };
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}

function onPieceDragMove(e) {
  if (!pieceDrag) return;
  // Só vira "arrasto de verdade" quando o cursor sai do próprio quadrado de
  // origem — um clique normal nunca sai dali, mesmo com tremor da mão/mouse,
  // então isso distingue os dois casos de forma muito mais confiável que um
  // limiar de pixels (que varia demais entre mouse/trackpad).
  if (!pieceDrag.moved) {
    const hover = squareFromPoint(e.clientX, e.clientY);
    if (hover && hover !== pieceDrag.square) {
      pieceDrag.moved = true;
      clearAnnotations();
      selectSquare(pieceDrag.square);
      startGhost(pieceDrag);
    }
  }
  if (pieceDrag.moved) moveGhost(pieceDrag, e);
}

function onPieceDragUp(e) {
  const state = pieceDrag;
  pieceDrag = null;
  if (!state) return;
  if (!state.moved) return; // não moveu o suficiente: era só um clique — o 'click' nativo assume

  // Se soltar em outro quadrado, o navegador nem chega a disparar 'click'
  // (mousedown/mouseup em elementos diferentes) — sem esse timeout a flag
  // ficaria travada em true e engoliria o PRÓXIMO clique de verdade.
  suppressNextClick = true;
  setTimeout(() => {
    suppressNextClick = false;
  }, 0);

  pieceAt(state.square)?.classList.remove('piece-lifted');
  state.ghost?.remove();

  // e.type === 'pointercancel': gesto abortado pelo navegador — só solta a peça de volta.
  if (e.type === 'pointercancel') {
    clearSelection();
    return;
  }

  const dropSquare = squareFromPoint(e.clientX, e.clientY);
  const legal = chess.moves({ square: state.square, verbose: true });
  const matches = dropSquare ? legal.filter((m) => m.to === dropSquare) : [];
  if (matches.length) playMove(matches, { instant: true });
  else clearSelection();
}

function startGhost(state) {
  const piece = chess.get(state.square);
  if (!piece) return;
  const rect = boardEl.getBoundingClientRect();
  state.size = rect.width / 8;
  const ghost = el('div', { class: `chess-piece chess-piece-ghost piece-${piece.color}` });
  ghost.style.backgroundImage = `url(${pieceImg(piece.color, piece.type)})`;
  ghost.style.width = `${state.size}px`;
  ghost.style.height = `${state.size}px`;
  boardEl.append(ghost);
  state.ghost = ghost;
  pieceAt(state.square)?.classList.add('piece-lifted');
}

function moveGhost(state, e) {
  const rect = boardEl.getBoundingClientRect();
  state.ghost.style.left = `${e.clientX - rect.left - state.size / 2}px`;
  state.ghost.style.top = `${e.clientY - rect.top - state.size / 2}px`;
}

async function playMove(matches, { instant = false } = {}) {
  clearSelection();
  let promotion;
  if (matches.length > 1) {
    promotion = await askPromotion(playerColor);
    if (!promotion) return; // cancelado
  }
  const chosen = matches.find((m) => m.promotion === promotion) || matches[0];

  if (mode === 'online') {
    // Não aplica local: manda ao servidor e espera o broadcast (applyRemoteMove).
    instantNextMove = instant;
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
      instantNextMove = false;
      busy = false;
      showError(err.message);
      updateStatus();
    }
    return;
  }

  // Modo bot: aplica local e chama o bot.
  const result = chess.move({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
  animateMove(result, { instant });
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

function animateMove(move, { instant = false } = {}) {
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
    // Drag-and-drop: o fantasma já mostrou a peça indo até o destino, então o
    // reposicionamento aqui é só "encaixar" — sem deslizar de novo.
    if (instant) fromEl.style.transition = 'none';
    fromEl.dataset.square = move.to;
    const { col, row } = squareToXY(move.to);
    fromEl.style.left = `${col * 12.5}%`;
    fromEl.style.top = `${row * 12.5}%`;
    if (move.promotion) {
      fromEl.style.backgroundImage = `url(${pieceImg(move.color, move.promotion)})`;
    }
    if (instant) {
      void fromEl.offsetWidth; // força o reflow antes de restaurar a transition
      fromEl.style.transition = '';
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
      choices.map((p) => {
        const btn = el('button', { type: 'button', class: 'promo-choice', onClick: () => onChoose(p) });
        btn.style.backgroundImage = `url(${pieceImg(color, p)})`;
        return btn;
      })
    );
    boardEl.append(box);
  });
}

// ---- anotações locais: marcar quadrado e desenhar seta (botão direito) ----

function svgEl(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function centerOf(square) {
  const { col, row } = squareToXY(square);
  return { x: (col + 0.5) * 12.5, y: (row + 0.5) * 12.5 };
}

function isKnightMove(from, to) {
  const a = squareToXY(from);
  const b = squareToXY(to);
  const dc = Math.abs(a.col - b.col);
  const dr = Math.abs(a.row - b.row);
  return (dc === 1 && dr === 2) || (dc === 2 && dr === 1);
}

function pullBack(from, to, amount) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ratio = Math.max(0, (len - amount) / len);
  return { x: from.x + dx * ratio, y: from.y + dy * ratio };
}

/** Desenha uma seta (reta, ou "em L" para lances de cavalo — igual ao chess.com). */
function buildArrowEl(from, to) {
  const start = centerOf(from);
  const end = centerOf(to);

  if (isKnightMove(from, to)) {
    const a = squareToXY(from);
    const b = squareToXY(to);
    // Anda primeiro no eixo mais longo (2 casas), dobra 90° e completa no curto.
    const elbowColRow = Math.abs(a.row - b.row) === 2 ? { col: a.col, row: b.row } : { col: b.col, row: a.row };
    const elbow = { x: (elbowColRow.col + 0.5) * 12.5, y: (elbowColRow.row + 0.5) * 12.5 };
    const tip = pullBack(elbow, end, 3);
    return svgEl('polyline', {
      points: `${start.x},${start.y} ${elbow.x},${elbow.y} ${tip.x},${tip.y}`,
      fill: 'none',
      stroke: ARROW_COLOR,
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'marker-end': 'url(#chess-arrowhead)',
      opacity: '0.8',
    });
  }

  const tip = pullBack(start, end, 3);
  return svgEl('line', {
    x1: start.x,
    y1: start.y,
    x2: tip.x,
    y2: tip.y,
    stroke: ARROW_COLOR,
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'marker-end': 'url(#chess-arrowhead)',
    opacity: '0.8',
  });
}

function renderArrows() {
  arrowsLayer.querySelectorAll(':scope > line, :scope > polyline').forEach((n) => n.remove());
  for (const a of arrows) arrowsLayer.append(buildArrowEl(a.from, a.to));
}

function toggleMark(square) {
  if (markedSquares.has(square)) markedSquares.delete(square);
  else markedSquares.add(square);
  squareBtn(square)?.classList.toggle('marked');
}

function toggleArrow(from, to) {
  const idx = arrows.findIndex((a) => a.from === from && a.to === to);
  if (idx >= 0) arrows.splice(idx, 1);
  else arrows.push({ from, to });
  renderArrows();
}

function clearAnnotations() {
  markedSquares.clear();
  arrows.length = 0;
  squaresLayer.querySelectorAll('.marked').forEach((b) => b.classList.remove('marked'));
  clear(previewGroup);
  renderArrows();
}

function onArrowDragMove(e) {
  if (!arrowDrag) return;
  const dx = e.clientX - arrowDrag.startX;
  const dy = e.clientY - arrowDrag.startY;
  if (!arrowDrag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) arrowDrag.moved = true;
  clear(previewGroup);
  if (!arrowDrag.moved) return;
  const hover = squareFromPoint(e.clientX, e.clientY);
  if (hover && hover !== arrowDrag.fromSquare) {
    const preview = buildArrowEl(arrowDrag.fromSquare, hover);
    preview.setAttribute('opacity', '0.5');
    previewGroup.append(preview);
  }
}

function onArrowDragUp(e) {
  clear(previewGroup);
  const state = arrowDrag;
  arrowDrag = null;
  if (!state) return;

  if (e.type === 'pointercancel') return; // gesto abortado — não marca nem desenha nada

  const toSquare = squareFromPoint(e.clientX, e.clientY);
  if (!state.moved || !toSquare || toSquare === state.fromSquare) {
    toggleMark(state.fromSquare);
    return;
  }
  toggleArrow(state.fromSquare, toSquare);
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

// ---- tema do tabuleiro ----

function renderThemeSwatches() {
  clear(boardThemeList);
  for (const t of BOARD_THEMES) {
    const swatch = el('button', { type: 'button', class: 'theme-swatch', dataset: { theme: t.id }, title: t.name, onClick: () => applyBoardTheme(t.id) }, [
      el('span', { class: 'theme-swatch-half', style: `background:${t.light}` }),
      el('span', { class: 'theme-swatch-half', style: `background:${t.dark}` }),
    ]);
    boardThemeList.append(swatch);
  }
}

function applyBoardTheme(id) {
  const t = BOARD_THEMES.find((x) => x.id === id) || BOARD_THEMES[0];
  boardEl.style.setProperty('--sq-light', t.light);
  boardEl.style.setProperty('--sq-dark', t.dark);
  localStorage.setItem('chess-board-theme', t.id);
  boardThemeList.querySelectorAll('.theme-swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === t.id));
}
