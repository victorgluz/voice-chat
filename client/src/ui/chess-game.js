import { Chess } from 'chess.js';
import { el, clear, initials } from '../util/dom.js';
import { request } from '../socket.js';
import { getBestMove, resetEngine } from '../chess/engine.js';
import { showError, showConfirm } from './dialog.js';
import { getState } from '../state.js';
import { openGamesModal } from './games.js';

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

let overlay, closeBtn, newBtn, resignBtn, statusEl, titleEl, boardEl, squaresLayer, piecesLayer, arrowsLayer, previewGroup;
let boardThemeList;
let clockTopEl, clockBottomEl;
let playerTopEl, playerBottomEl;
let watchersEl, watchersListEl;
let initialized = false;

let chess = null;
let mode = 'bot'; // 'bot' | 'online' | 'spectate'
let botElo = 1943; // rating do Stockfish escolhido no seletor (1320–3190)
let online = null; // { gameId, opponentName, opponentAvatar, timeControl } no modo online
let spectate = null; // ver spectateChessGame/spectateBotGame — tem um campo kind: 'online'|'bot'
let botGameId = null; // id da sessão de bot anunciada no chat (null = nada reportado)

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
let captured = { w: [], b: [] }; // captured.w = peças pretas que o branco já capturou (e vice-versa)
let playerColor = 'w';
let orientation = 'w';
let selectedSquare = null;
let busy = false; // anima/aguarda bot ou servidor — bloqueia cliques
let gameOver = false;

// Relógios (só modo online — servidor é a fonte da verdade, o cliente só
// interpola visualmente entre uma sincronização e outra).
let clocks = { whiteMs: 0, blackMs: 0, syncedAt: 0 };
let clockInterval = null;

// Pré-lances (premove): joga uma casa enquanto ainda não é sua vez; quando
// chegar sua vez, tenta executar de verdade — se não for mais legal, descarta
// em silêncio, igual ao chess.com. Puramente visual/local até esse instante.
let premoveFrom = null; // quadrado "armado" por clique, aguardando o destino
let premove = null; // { from, to } já confirmado, pintado nas duas casas

// Anotações locais (não sincronizam com o oponente — só o seu próprio olhar).
const markedSquares = new Set();
const arrows = []; // [{from, to}]

// Estado de arrasto (mouse esquerdo move peça, direito desenha seta/marca).
let pieceDrag = null; // { square, startX, startY, moved, ghost, size, isPremove }
let arrowDrag = null; // { fromSquare, startX, startY, moved }
let suppressNextClick = false;
let instantNextMove = false; // true: o próximo lance (meu) veio de drag-and-drop — pula a animação de slide

export function initChessGame() {
  overlay = document.getElementById('chess-overlay');
  closeBtn = document.getElementById('chess-close');
  newBtn = document.getElementById('chess-new');
  resignBtn = document.getElementById('chess-resign');
  statusEl = document.getElementById('chess-status');
  titleEl = document.getElementById('chess-title');
  boardEl = document.getElementById('chess-board');
  clockTopEl = document.getElementById('chess-clock-top');
  clockBottomEl = document.getElementById('chess-clock-bottom');
  playerTopEl = document.getElementById('chess-player-top');
  playerBottomEl = document.getElementById('chess-player-bottom');
  watchersEl = document.getElementById('chess-watchers');
  watchersListEl = document.getElementById('chess-watchers-list');

  squaresLayer = el('div', { class: 'chess-squares' });
  piecesLayer = el('div', { class: 'chess-pieces' });
  arrowsLayer = svgEl('svg', { class: 'chess-arrows', viewBox: '0 0 100 100', preserveAspectRatio: 'none' });
  previewGroup = svgEl('g', { class: 'chess-arrow-preview' });
  arrowsLayer.append(previewGroup);
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
  resignBtn.addEventListener('click', async () => {
    if (mode !== 'online' || gameOver) return;
    const ok = await showConfirm({
      title: 'Desistir da partida?',
      message: 'Isso conta como derrota e não pode ser desfeito.',
      confirmLabel: 'Desistir',
      danger: true,
    });
    if (ok) request('chess:resign', { gameId: online.gameId }).catch(() => {});
  });

  boardThemeList = document.getElementById('board-theme-list');
  renderThemeSwatches();
  applyBoardTheme(localStorage.getItem('chess-board-theme') || BOARD_THEMES[2].id);

  initialized = true;
}

async function closeGame() {
  // Sair no meio de uma partida online conta como desistência.
  if (mode === 'online' && !gameOver) {
    const ok = await showConfirm({
      title: 'Sair da partida?',
      message: 'Fechar agora conta como desistência.',
      confirmLabel: 'Sair e desistir',
      danger: true,
    });
    if (!ok) return;
    request('chess:resign', { gameId: online.gameId }).catch(() => {});
  } else if (mode === 'spectate' && spectate?.kind === 'online') {
    request('chess:spectate:leave', { gameId: spectate.gameId }).catch(() => {});
  } else if (mode === 'spectate' && spectate?.kind === 'bot') {
    request('chess:botgame:spectate:leave', { id: spectate.gameId }).catch(() => {});
  } else if (mode === 'bot') {
    endBotGameSession('abandoned', null);
  }
  overlay.classList.add('hidden');
}

// ---- abertura: bot ----

export function openChessGame(elo) {
  if (!initialized) initChessGame();
  mode = 'bot';
  online = null;
  spectate = null;
  if (elo) botElo = elo;
  titleEl.textContent = 'Xadrez';
  renderWatchers([]);
  stopClock();
  newBtn.classList.remove('hidden');
  resignBtn.classList.add('hidden');
  overlay.classList.remove('hidden');
  startNewGame();
}

async function startNewGame() {
  if (mode !== 'bot') return; // "Novo jogo" só existe no modo bot
  endBotGameSession('abandoned', null); // fecha uma sessão anterior não finalizada, se houver
  chess = new Chess();
  playerColor = Math.random() < 0.5 ? 'w' : 'b';
  orientation = playerColor;
  selectedSquare = null;
  clearPremove();
  clearPremoveSelection();
  captured = { w: [], b: [] };
  busy = false;
  gameOver = false;
  resetEngine(botElo);
  renderFullBoard();
  updateStatus();

  // Orientação sempre acompanha playerColor (você fica embaixo), então o topo
  // é sempre o adversário — aqui, sempre o bot — não importa a cor sorteada.
  // Sem bot mode não tem relógio de verdade (nada pra cronometrar), então o
  // badge de tempo em cima/embaixo do tabuleiro fica escondido — só o painel
  // de jogadores (foto+nome+capturas) à direita aparece.
  const me = getState().me;
  clockTopEl.classList.add('hidden');
  clockBottomEl.classList.add('hidden');
  playerTopEl.classList.remove('hidden');
  playerBottomEl.classList.remove('hidden');
  setPlayerInfo(playerTopEl, '🤖', `Stockfish (${botElo})`);
  setPlayerInfo(playerBottomEl, me?.avatar, me?.name || 'Você');
  updateCapturedDisplay();
  updateActiveHighlight();

  const channelId = getState().activeTextChannel;
  if (channelId) {
    request('chess:botgame:start', { channelId, elo: botElo, color: playerColor })
      .then(({ id }) => {
        botGameId = id;
      })
      .catch(() => {});
  }

  if (playerColor === 'b') {
    busy = true;
    setTimeout(botTurn, 400);
  }
}

/** Reporta o fim (ou abandono) da sessão de bot anunciada no chat. Idempotente
 * — chamar de novo com botGameId já nulo não faz nada. */
function endBotGameSession(reason, winner) {
  if (!botGameId) return;
  const id = botGameId;
  botGameId = null;
  request('chess:botgame:end', { id, reason, winner }).catch(() => {});
}

// ---- abertura: online ----

export function startOnlineChess({ gameId, color, opponentName, opponentAvatar, timeControl, whiteMs, blackMs }) {
  if (!initialized) initChessGame();
  mode = 'online';
  spectate = null;
  titleEl.textContent = 'Xadrez';
  renderWatchers([]);
  online = { gameId, opponentName, opponentAvatar, timeControl };
  chess = new Chess();
  playerColor = color;
  orientation = color;
  selectedSquare = null;
  clearPremove();
  clearPremoveSelection();
  captured = { w: [], b: [] };
  busy = false;
  gameOver = false;
  newBtn.classList.add('hidden');
  resignBtn.classList.remove('hidden');
  renderFullBoard();
  updateStatus();

  const me = getState().me;
  clockTopEl.classList.remove('hidden');
  clockBottomEl.classList.remove('hidden');
  playerTopEl.classList.remove('hidden');
  playerBottomEl.classList.remove('hidden');
  setPlayerInfo(playerTopEl, opponentAvatar, opponentName);
  setPlayerInfo(playerBottomEl, me?.avatar, me?.name || 'Você');
  updateCapturedDisplay();
  updateActiveHighlight();
  clocks = { whiteMs, blackMs, syncedAt: Date.now() };
  startClock();

  overlay.classList.remove('hidden');
}

// ---- abertura: assistir (spectate) ----

/** Assiste a uma partida multiplayer em andamento, só de leitura — sem
 * interação, sem "você"/oponente, mostra os dois jogadores de verdade com
 * foto e nome, como no chess.com. */
export async function spectateChessGame(gameId) {
  if (!initialized) initChessGame();
  try {
    const snap = await request('chess:spectate', { gameId });
    mode = 'spectate';
    titleEl.textContent = 'Assistindo Xadrez';
    online = null;
    spectate = {
      kind: 'online',
      gameId: snap.gameId,
      whiteName: snap.whiteName,
      blackName: snap.blackName,
      whiteAvatar: snap.whiteAvatar,
      blackAvatar: snap.blackAvatar,
    };
    chess = new Chess(snap.fen);
    playerColor = null;
    orientation = 'w';
    selectedSquare = null;
    clearPremove();
    clearPremoveSelection();
    captured = { w: [], b: [] };
    busy = false;
    gameOver = false;
    newBtn.classList.add('hidden');
    resignBtn.classList.add('hidden');
    renderFullBoard();
    markCheck();
    updateStatus();

    clockTopEl.classList.remove('hidden');
    clockBottomEl.classList.remove('hidden');
    playerTopEl.classList.remove('hidden');
    playerBottomEl.classList.remove('hidden');
    setPlayerInfo(playerTopEl, snap.blackAvatar, snap.blackName);
    setPlayerInfo(playerBottomEl, snap.whiteAvatar, snap.whiteName);
    updateCapturedDisplay();
    updateActiveHighlight();
    renderWatchers(snap.spectators);
    clocks = { whiteMs: snap.whiteMs, blackMs: snap.blackMs, syncedAt: Date.now() };
    startClock();

    overlay.classList.remove('hidden');
  } catch (err) {
    showError(err.message);
  }
}

/** Assiste a uma partida contra o bot em andamento — mesma ideia, mas o
 * "adversário" é sempre o Stockfish local de quem começou (sem clock real,
 * já que bot não tem tempo). */
export async function spectateBotGame(id) {
  if (!initialized) initChessGame();
  try {
    const snap = await request('chess:botgame:spectate', { id });
    mode = 'spectate';
    titleEl.textContent = 'Assistindo Xadrez';
    online = null;
    spectate = {
      kind: 'bot',
      gameId: snap.id,
      hostName: snap.hostName,
      hostAvatar: snap.hostAvatar,
      hostColor: snap.hostColor,
      elo: snap.elo,
    };
    chess = new Chess(snap.fen);
    playerColor = null;
    orientation = 'w';
    selectedSquare = null;
    clearPremove();
    clearPremoveSelection();
    captured = { w: [], b: [] };
    busy = false;
    gameOver = false;
    newBtn.classList.add('hidden');
    resignBtn.classList.add('hidden');
    renderFullBoard();
    markCheck();
    updateStatus();

    const hostIsWhite = snap.hostColor === 'w';
    clockTopEl.classList.add('hidden');
    clockBottomEl.classList.add('hidden');
    playerTopEl.classList.remove('hidden');
    playerBottomEl.classList.remove('hidden');
    setPlayerInfo(playerTopEl, hostIsWhite ? '🤖' : snap.hostAvatar, hostIsWhite ? `Stockfish (${snap.elo})` : snap.hostName);
    setPlayerInfo(playerBottomEl, hostIsWhite ? snap.hostAvatar : '🤖', hostIsWhite ? snap.hostName : `Stockfish (${snap.elo})`);
    updateCapturedDisplay();
    updateActiveHighlight();
    renderWatchers(snap.spectators);

    overlay.classList.remove('hidden');
  } catch (err) {
    showError(err.message);
  }
}

/** Lance retransmitido de uma partida-contra-bot que estou assistindo. */
export function applyBotGameMove({ id, from, to, promotion, fen }) {
  if (mode !== 'spectate' || spectate?.kind !== 'bot' || spectate.gameId !== id || !chess) return;
  let result = null;
  try {
    result = chess.move({ from, to, promotion: promotion || undefined });
  } catch {
    result = null;
  }
  if (result) animateMove(result);
  else if (fen) {
    chess.load(fen);
    renderFullBoard();
    markCheck();
  }
  updateStatus();
}

/** A partida-contra-bot que eu assistia foi encerrada. */
export function handleBotGameClosed({ id }) {
  if (mode !== 'spectate' || spectate?.kind !== 'bot' || spectate.gameId !== id) return;
  gameOver = true;
  statusEl.textContent = 'Partida encerrada.';
}

/** Preenche foto + nome de um dos relógios (jogando ou assistindo). */
/** Preenche foto + nome de um dos jogadores no painel à direita do tabuleiro
 * (não mais junto do relógio — só o tempo fica ali em cima/embaixo). */
function setPlayerInfo(playerEl, avatar, name) {
  const avatarEl = playerEl.querySelector('.chess-player-avatar');
  if (avatar?.startsWith('/uploads/')) {
    avatarEl.style.backgroundImage = `url(${avatar})`;
    avatarEl.textContent = '';
  } else {
    avatarEl.style.backgroundImage = '';
    avatarEl.textContent = avatar || initials(name || '?');
  }
  playerEl.querySelector('.chess-player-name').textContent = name || '';
}

/** Lista de quem está assistindo (foto + nome), embaixo do painel de temas —
 * atualizada ao vivo pelo servidor conforme gente entra/sai. */
function renderWatchers(spectators) {
  clear(watchersListEl);
  if (!spectators || !spectators.length) {
    watchersEl.classList.add('hidden');
    return;
  }
  watchersEl.classList.remove('hidden');
  for (const s of spectators) {
    const avatarEl = el('div', { class: 'avatar avatar-sm chess-watcher-avatar' });
    if (s.avatar?.startsWith('/uploads/')) avatarEl.style.backgroundImage = `url(${s.avatar})`;
    else avatarEl.textContent = s.avatar || initials(s.name || '?');
    watchersListEl.append(el('div', { class: 'chess-watcher' }, [avatarEl, el('span', {}, s.name)]));
  }
}

/** Atualização ao vivo dos espectadores de uma partida multiplayer. */
export function updateChessSpectators({ id, spectators }) {
  if (mode === 'online' && online?.gameId === id) renderWatchers(spectators);
  else if (mode === 'spectate' && spectate?.kind === 'online' && spectate.gameId === id) renderWatchers(spectators);
}

/** Atualização ao vivo dos espectadores de uma partida contra o bot. */
export function updateBotGameSpectators({ id, spectators }) {
  if (mode === 'bot' && botGameId === id) renderWatchers(spectators);
  else if (mode === 'spectate' && spectate?.kind === 'bot' && spectate.gameId === id) renderWatchers(spectators);
}

/** Material capturado + vantagem (como no chess.com): `captured.w` são peças
 * pretas já tiradas do tabuleiro pelo branco (e vice-versa). Só reflete o que
 * aconteceu DEPOIS de eu ter começado a jogar/assistir — quem entra pra
 * assistir no meio do jogo não vê capturas anteriores (o servidor manda só o
 * FEN atual, não o histórico de lances). */
function updateCapturedDisplay() {
  if (mode === 'spectate') {
    renderCaptured(playerTopEl, 'b');
    renderCaptured(playerBottomEl, 'w');
    return;
  }
  const oppColor = playerColor === 'w' ? 'b' : 'w';
  renderCaptured(playerTopEl, oppColor);
  renderCaptured(playerBottomEl, playerColor);
}

function materialDiff() {
  const sum = (list) => list.reduce((total, t) => total + (PIECE_VALUE[t] || 0), 0);
  return sum(captured.w) - sum(captured.b);
}

/** Mostra, no painel do jogador de `color`, os ícones das peças que ELE
 * capturou (na cor do adversário, já que são peças inimigas removidas do
 * tabuleiro) + um "+N" se esse lado estiver na frente em material. */
function renderCaptured(playerEl, color) {
  const list = playerEl.querySelector('.chess-player-captured');
  if (!list) return;
  clear(list);
  const order = { q: 0, r: 1, b: 2, n: 3, p: 4 };
  const pieces = [...captured[color]].sort((a, b) => order[a] - order[b]);
  const enemyColor = color === 'w' ? 'b' : 'w';
  for (const type of pieces) {
    const icon = el('span', { class: 'captured-piece' });
    icon.style.backgroundImage = `url(${pieceImg(enemyColor, type)})`;
    list.append(icon);
  }
  const diff = materialDiff();
  const mine = color === 'w' ? diff : -diff;
  if (mine > 0) list.append(el('span', { class: 'captured-advantage' }, `+${mine}`));
}

/** Lance autoritativo vindo do servidor (meu ou do oponente). */
export function applyRemoteMove({ from, to, promotion, fen, whiteMs, blackMs }) {
  if ((mode !== 'online' && mode !== 'spectate') || !chess) return;
  const instant = instantNextMove;
  instantNextMove = false;
  let result = null;
  try {
    result = chess.move({ from, to, promotion: promotion || undefined });
  } catch {
    result = null;
  }
  if (typeof whiteMs === 'number' && typeof blackMs === 'number') {
    clocks = { whiteMs, blackMs, syncedAt: Date.now() };
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
  if (mode === 'online') maybeExecutePremove();
}

/** Fim de partida online, anunciado pelo servidor (também usado por quem está
 * assistindo — sem o enquadramento pessoal "você venceu/perdeu" e sem o
 * modal de resultado, que é só pra quem jogou). */
export function handleChessGameOver({ reason, winner }) {
  if (mode !== 'online' && mode !== 'spectate') return;
  gameOver = true;
  busy = true;
  stopClock();
  clearPremove();
  clearPremoveSelection();
  resignBtn.classList.add('hidden');

  if (mode === 'spectate') {
    const winnerName = winner === 'w' ? spectate?.whiteName : winner === 'b' ? spectate?.blackName : null;
    statusEl.textContent = winnerName ? `Fim de jogo — ${winnerName} venceu.` : 'Fim de jogo — empate.';
    return;
  }

  const won = winner === playerColor;
  const draw = winner == null;
  const opp = online?.opponentName || 'Oponente';
  let msg;
  if (reason === 'checkmate') msg = won ? 'Xeque-mate — você venceu! 🎉' : 'Xeque-mate — você perdeu.';
  else if (reason === 'resign') msg = won ? `${opp} desistiu — você venceu!` : 'Você desistiu.';
  else if (reason === 'opponentLeft') msg = `${opp} saiu da partida — você venceu!`;
  else if (reason === 'timeout') msg = won ? `${opp} ficou sem tempo — você venceu!` : 'Você ficou sem tempo.';
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
      const coords = [];
      if (row === 7) coords.push(el('span', { class: 'coord-file' }, square[0]));
      if (col === 0) coords.push(el('span', { class: 'coord-rank' }, square[1]));
      squaresLayer.append(
        el(
          'button',
          {
            type: 'button',
            class: `chess-square ${light ? 'light' : 'dark'}`,
            dataset: { square },
            onClick: () => onSquareClick(square),
            onPointerdown: (e) => onSquarePointerDown(e, square),
          },
          coords
        )
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
  if (mode === 'spectate') return; // só leitura — sem seleção, sem anotações
  clearAnnotations();
  if (busy || gameOver || chess.isGameOver()) return;

  if (chess.turn() !== playerColor) {
    handlePremoveClick(square);
    return;
  }

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

// ---- pré-lances (premove) ----

function handlePremoveClick(square) {
  // Clicar numa das duas casas de um premove já confirmado cancela ele.
  if (premove && (square === premove.from || square === premove.to)) {
    clearPremove();
    return;
  }
  if (premoveFrom) {
    if (square === premoveFrom) {
      clearPremoveSelection();
      return;
    }
    setPremove(premoveFrom, square);
    clearPremoveSelection();
    return;
  }
  const piece = chess.get(square);
  if (piece && piece.color === playerColor) {
    premoveFrom = square;
    squareBtn(square)?.classList.add('selected');
  }
}

function setPremove(from, to) {
  clearPremove();
  premove = { from, to };
  squareBtn(from)?.classList.add('premove');
  squareBtn(to)?.classList.add('premove');
}

function clearPremove() {
  if (!premove) return;
  squareBtn(premove.from)?.classList.remove('premove');
  squareBtn(premove.to)?.classList.remove('premove');
  premove = null;
}

function clearPremoveSelection() {
  if (premoveFrom) squareBtn(premoveFrom)?.classList.remove('selected');
  premoveFrom = null;
}

/** Chamado sempre que a vez pode ter passado a ser sua (lance do oponente ou
 * do bot processado) — tenta executar o pré-lance guardado; se não for mais
 * legal na posição atual, descarta em silêncio (igual ao chess.com). */
function maybeExecutePremove() {
  if (!premove || gameOver || chess.isGameOver() || chess.turn() !== playerColor) return;
  const { from, to } = premove;
  clearPremove();
  const legal = chess.moves({ square: from, verbose: true });
  const matches = legal.filter((m) => m.to === to);
  if (!matches.length) return;
  const chosen = matches.find((m) => m.promotion === 'q') || matches[0];
  playMove([chosen]);
}

// ---- interação: arrastar peça (botão esquerdo) e anotar (botão direito) ----

// Usa Pointer Capture: uma vez capturado, TODOS os eventos seguintes desse
// ponteiro (move/up/cancel) chegam no MESMO elemento, não importa por onde o
// cursor passe — inclusive se sair da janela. Sem isso, um pointerup perdido
// (gesto cancelado pelo navegador, cursor saindo da viewport, etc.) deixava o
// drag "preso": quadrado selecionado para sempre e o fantasma nunca some,
// porque a limpeza só rodava dentro do handler de pointerup.
function onSquarePointerDown(e, square) {
  if (mode === 'spectate') return; // só leitura — sem arrastar peça, sem anotar
  if (e.button === 2) {
    e.preventDefault();
    arrowDrag = { fromSquare: square, startX: e.clientX, startY: e.clientY, moved: false };
    capturePointer(e, onArrowDragMove, onArrowDragUp);
    return;
  }
  if (e.button !== 0) return;
  if (busy || gameOver || chess.isGameOver()) return;
  const piece = chess.get(square);
  if (!piece || piece.color !== playerColor) return;

  const isPremove = chess.turn() !== playerColor;
  pieceDrag = { square, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, size: 0, isPremove };
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
      if (pieceDrag.isPremove) clearPremoveSelection();
      else selectSquare(pieceDrag.square);
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
    if (!state.isPremove) clearSelection();
    return;
  }

  const dropSquare = squareFromPoint(e.clientX, e.clientY);

  if (state.isPremove) {
    if (dropSquare && dropSquare !== state.square) setPremove(state.square, dropSquare);
    return;
  }

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
    maybeExecutePremove();
  }
}

// ---- relógios ----

function startClock() {
  stopClock();
  clockInterval = setInterval(tickClocks, 200);
  tickClocks();
}

function stopClock() {
  clearInterval(clockInterval);
  clockInterval = null;
}

function tickClocks() {
  updateActiveHighlight();
  // Sem relógio de verdade fora de online/spectate-de-partida-online (bot e
  // spectate-de-bot são sem tempo) — só o destaque de turno se aplica a eles.
  if (mode === 'spectate' && spectate?.kind === 'bot') return;
  if ((mode !== 'online' && mode !== 'spectate') || !chess) return;
  const turn = chess.turn();
  const elapsed = gameOver ? 0 : Date.now() - clocks.syncedAt;
  const liveWhite = turn === 'w' && !gameOver ? Math.max(0, clocks.whiteMs - elapsed) : clocks.whiteMs;
  const liveBlack = turn === 'b' && !gameOver ? Math.max(0, clocks.blackMs - elapsed) : clocks.blackMs;

  if (mode === 'spectate') {
    // Orientação sempre 'w' pra quem assiste: topo=preto, embaixo=branco.
    renderClock(clockTopEl, liveBlack);
    renderClock(clockBottomEl, liveWhite);
    return;
  }
  const opponentColor = playerColor === 'w' ? 'b' : 'w';
  renderClock(clockTopEl, opponentColor === 'w' ? liveWhite : liveBlack);
  renderClock(clockBottomEl, playerColor === 'w' ? liveWhite : liveBlack);
}

function renderClock(clockEl, ms) {
  clockEl.querySelector('.chess-clock-time').textContent = formatClock(ms);
  clockEl.classList.toggle('low', ms < 20000);
}

/** Cor que o lado de cima (ou de baixo) representa, dado o modo/orientação
 * atual — em cima é sempre o adversário (bot, oponente online, ou preto pra
 * quem assiste), embaixo é sempre você (ou branco, pra quem assiste). */
function sideColor(isTop) {
  if (mode === 'spectate') return isTop ? 'b' : 'w';
  const opponentColor = playerColor === 'w' ? 'b' : 'w';
  return isTop ? opponentColor : playerColor;
}

/** Destaca (fundo colorido) quem está pra jogar agora — no relógio (se
 * tiver, i.e. online/spectate) E no painel de jogadores à direita (sempre).
 * Vale pro bot (sem relógio de verdade, só o destaque de turno), pro online e
 * pra quem está assistindo qualquer um dos dois. */
function updateActiveHighlight() {
  if (!chess) return;
  const turn = chess.turn();
  const topActive = !gameOver && sideColor(true) === turn;
  const bottomActive = !gameOver && sideColor(false) === turn;
  clockTopEl?.classList.toggle('active', topActive);
  clockBottomEl?.classList.toggle('active', bottomActive);
  playerTopEl?.classList.toggle('active', topActive);
  playerBottomEl?.classList.toggle('active', bottomActive);
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
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

  if (move.captured) {
    captured[move.color].push(move.captured);
    updateCapturedDisplay();
  }

  if (mode === 'bot' && botGameId) {
    request('chess:botgame:move', {
      id: botGameId,
      from: move.from,
      to: move.to,
      promotion: move.promotion || null,
      fen: chess.fen(),
    }).catch(() => {});
  }

  markCheck();
  updateActiveHighlight();
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

const ARROW_STROKE_WIDTH = 2;
const ARROW_HEAD_LEN = 4.5; // comprimento da ponta triangular
const ARROW_HEAD_HALF_WIDTH = 3; // metade da largura da base do triângulo
const ARROW_TIP_GAP = 1.2; // distância entre a ponta e o centro do quadrado (não cobre a peça)

/** Ponta da seta desenhada à mão como um triângulo — nada de <marker>/viewBox
 * (o marker-end do SVG se mostrou frágil demais entre os ajustes de tamanho:
 * ou vinha um blob por causa do stroke-linecap round, ou sumia de vez). Total
 * controle manual: calcula o vetor da linha e desenha o triângulo apontando
 * nessa direção. */
function arrowHeadPolygon(fromPt, toPt) {
  const dx = toPt.x - fromPt.x;
  const dy = toPt.y - fromPt.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  const tip = pullBack(fromPt, toPt, ARROW_TIP_GAP);
  const baseX = tip.x - ux * ARROW_HEAD_LEN;
  const baseY = tip.y - uy * ARROW_HEAD_LEN;

  const p2 = { x: baseX + px * ARROW_HEAD_HALF_WIDTH, y: baseY + py * ARROW_HEAD_HALF_WIDTH };
  const p3 = { x: baseX - px * ARROW_HEAD_HALF_WIDTH, y: baseY - py * ARROW_HEAD_HALF_WIDTH };

  return {
    base: { x: baseX, y: baseY },
    polygon: svgEl('polygon', { points: `${tip.x},${tip.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`, fill: ARROW_COLOR }),
  };
}

/** Desenha uma seta (reta, ou "em L" para lances de cavalo — igual ao chess.com). */
function buildArrowEl(from, to) {
  const start = centerOf(from);
  const end = centerOf(to);
  const group = svgEl('g', { class: 'chess-arrow', opacity: '0.8' });

  if (isKnightMove(from, to)) {
    const a = squareToXY(from);
    const b = squareToXY(to);
    // Anda primeiro no eixo mais longo (2 casas), dobra 90° e completa no curto.
    const elbowColRow = Math.abs(a.row - b.row) === 2 ? { col: a.col, row: b.row } : { col: b.col, row: a.row };
    const elbow = { x: (elbowColRow.col + 0.5) * 12.5, y: (elbowColRow.row + 0.5) * 12.5 };
    const head = arrowHeadPolygon(elbow, end);
    group.append(
      svgEl('polyline', {
        points: `${start.x},${start.y} ${elbow.x},${elbow.y} ${head.base.x},${head.base.y}`,
        fill: 'none',
        stroke: ARROW_COLOR,
        'stroke-width': String(ARROW_STROKE_WIDTH),
        'stroke-linecap': 'butt',
        'stroke-linejoin': 'round',
      })
    );
    group.append(head.polygon);
    return group;
  }

  const head = arrowHeadPolygon(start, end);
  group.append(
    svgEl('line', {
      x1: start.x,
      y1: start.y,
      x2: head.base.x,
      y2: head.base.y,
      stroke: ARROW_COLOR,
      'stroke-width': String(ARROW_STROKE_WIDTH),
      'stroke-linecap': 'butt',
    })
  );
  group.append(head.polygon);
  return group;
}

function renderArrows() {
  arrowsLayer.querySelectorAll(':scope > g.chess-arrow').forEach((n) => n.remove());
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
    const msg = playerWon ? `Xeque-mate — você venceu! (você jogou de ${youAre})` : 'Xeque-mate — você perdeu.';
    statusEl.textContent = msg;
    gameOver = true;
    endBotGameSession('checkmate', playerWon ? playerColor : playerColor === 'w' ? 'b' : 'w');
    return;
  }
  if (chess.isStalemate() || chess.isDraw()) {
    statusEl.textContent = 'Empate.';
    gameOver = true;
    endBotGameSession(chess.isStalemate() ? 'stalemate' : 'draw', null);
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
