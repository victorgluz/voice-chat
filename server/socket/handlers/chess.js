import { Chess } from 'chess.js';
import * as state from '../state.js';

/**
 * Xadrez multiplayer via convite no chat: quem clica em "Multiplayer" escolhe
 * um tempo (bullet/blitz/rapid) e cria um CONVITE — uma instância própria,
 * anunciada no chat — que qualquer um vendo aquele canal pode aceitar na hora,
 * sem fila cega. Vários convites (e várias partidas) podem coexistir, mesmo
 * no mesmo canal: cada um é independente.
 *
 * As cores são sorteadas no servidor. Todo lance é validado aqui com chess.js
 * — o cliente nunca é confiável — e retransmitido para os dois jogadores. O
 * relógio de cada partida também é controlado aqui (fonte da verdade): cada
 * lance debita do relógio de quem acabou de jogar o tempo decorrido desde o
 * último lance, e um timer agenda a queda de bandeira (perda por tempo) para
 * quem está pensando.
 */

const roomName = (gameId) => `chess:${gameId}`;
const INVITE_TTL_MS = 10 * 60 * 1000; // convite não aceito expira em 10min
const TIME_CONTROLS = [60, 180, 300, 600]; // bullet 1min, blitz 3/5min, rapid 10min

// Estado compartilhado entre conexões (uma instância por processo, como presence).
const invites = new Map(); // inviteId -> { id, channelId, hostSocketId, hostName, timeControl, timer }
const games = new Map(); // gameId -> ver createGame()
const socketGame = new Map(); // socketId -> gameId

// Partidas contra o bot: rodam 100% no cliente de quem joga (Stockfish local),
// o servidor não valida nada — só retransmite o que o anfitrião reporta pra
// quem estiver assistindo. Confiança equivalente a compartilhar tela: sem
// integridade competitiva em jogo, é só deixar outros verem o que já está
// acontecendo no navegador de quem jogou.
const botGames = new Map(); // id -> { id, channelId, hostSocketId, hostName, hostAvatar, elo, hostColor, fen, over }
const botRoomName = (id) => `botgame:${id}`;
let nextBotGameId = 1;

let nextInviteId = 1;
let nextGameId = 1;

export function registerChessHandlers(io, socket) {
  const ack = (cb, fn) => async (data) => {
    try {
      const result = await fn(data);
      if (typeof cb === 'function') cb({ data: result });
    } catch (err) {
      if (typeof cb === 'function') cb({ error: err.message });
    }
  };

  const requirePresence = () => {
    const presence = state.getPresence(socket.id);
    if (!presence) throw new Error('Não autenticado.');
    return presence;
  };

  socket.on('chess:invite:create', (data, cb) =>
    ack(cb, async ({ channelId, timeControl } = {}) => {
      const presence = requirePresence();
      if (!channelId) throw new Error('Canal inválido.');
      if (!TIME_CONTROLS.includes(timeControl)) throw new Error('Tempo de partida inválido.');
      if (socketGame.has(socket.id)) throw new Error('Você já está em uma partida.');
      if ([...invites.values()].some((inv) => inv.hostSocketId === socket.id)) {
        throw new Error('Você já tem um convite aberto.');
      }

      const id = nextInviteId++;
      const invite = {
        id,
        channelId,
        hostSocketId: socket.id,
        hostName: presence.user.name,
        timeControl,
        timer: setTimeout(() => closeInvite(io, id, 'expired'), INVITE_TTL_MS),
      };
      invites.set(id, invite);
      io.emit('chess:invite', publicInvite(invite));
      return { id };
    })(data)
  );

  socket.on('chess:invite:cancel', (data, cb) =>
    ack(cb, async ({ id } = {}) => {
      const invite = invites.get(id);
      if (invite && invite.hostSocketId === socket.id) closeInvite(io, id, 'cancelled');
      return { ok: true };
    })(data)
  );

  socket.on('chess:invite:accept', (data, cb) =>
    ack(cb, async ({ id } = {}) => {
      const presence = requirePresence();
      const invite = invites.get(id);
      if (!invite) throw new Error('Convite expirado ou já encerrado.');
      if (invite.hostSocketId === socket.id) throw new Error('Você não pode entrar no seu próprio convite.');
      if (socketGame.has(socket.id)) throw new Error('Você já está em uma partida.');

      const host = state.getPresence(invite.hostSocketId);
      if (!host || socketGame.has(invite.hostSocketId)) {
        closeInvite(io, id, 'expired');
        throw new Error('O anfitrião não está mais disponível.');
      }

      clearTimeout(invite.timer);
      invites.delete(id);

      const meWhite = Math.random() < 0.5;
      const whiteId = meWhite ? socket.id : invite.hostSocketId;
      const blackId = meWhite ? invite.hostSocketId : socket.id;
      const whiteName = state.getPresence(whiteId)?.user.name || 'Brancas';
      const blackName = state.getPresence(blackId)?.user.name || 'Pretas';
      const whiteAvatar = state.getPresence(whiteId)?.user.avatar || null;
      const blackAvatar = state.getPresence(blackId)?.user.avatar || null;

      const gameId = nextGameId++;
      const game = createGame({
        id: gameId,
        white: whiteId,
        black: blackId,
        whiteName,
        blackName,
        whiteAvatar,
        blackAvatar,
        channelId: invite.channelId,
        timeControl: invite.timeControl,
      });
      games.set(gameId, game);
      socketGame.set(whiteId, gameId);
      socketGame.set(blackId, gameId);

      io.sockets.sockets.get(whiteId)?.join(roomName(gameId));
      io.sockets.sockets.get(blackId)?.join(roomName(gameId));

      scheduleTimeout(io, game);

      io.emit('chess:invite:closed', { id, reason: 'started', gameId });

      const base = { gameId, timeControl: invite.timeControl, whiteMs: game.whiteMs, blackMs: game.blackMs };
      io.to(whiteId).emit('chess:matchFound', {
        ...base,
        color: 'w',
        opponentName: blackName,
        opponentAvatar: blackAvatar,
      });
      io.to(blackId).emit('chess:matchFound', {
        ...base,
        color: 'b',
        opponentName: whiteName,
        opponentAvatar: whiteAvatar,
      });

      return { status: 'matched' };
    })(data)
  );

  socket.on('chess:move', (data, cb) =>
    ack(cb, async ({ gameId, from, to, promotion } = {}) => {
      requirePresence();
      const game = games.get(gameId);
      if (!game || game.over) throw new Error('Partida inexistente.');

      const myColor = colorOf(game, socket.id);
      if (!myColor) throw new Error('Você não está nesta partida.');
      if (game.chess.turn() !== myColor) throw new Error('Não é sua vez.');

      // Debita do relógio de quem está jogando agora o tempo decorrido desde
      // o último lance. Se já tiver estourado, a queda de bandeira deveria ter
      // rodado sozinha (scheduleTimeout) — isto é só uma rede de segurança.
      const elapsed = Date.now() - game.turnStartedAt;
      const remaining = (myColor === 'w' ? game.whiteMs : game.blackMs) - elapsed;
      if (remaining <= 0) {
        endGame(io, game, { reason: 'timeout', winner: myColor === 'w' ? 'b' : 'w' });
        throw new Error('Tempo esgotado.');
      }
      if (myColor === 'w') game.whiteMs = remaining;
      else game.blackMs = remaining;

      let move;
      try {
        move = game.chess.move({ from, to, promotion: promotion || undefined });
      } catch {
        move = null;
      }
      if (!move) throw new Error('Lance ilegal.');

      game.turnStartedAt = Date.now();
      scheduleTimeout(io, game);

      io.to(roomName(gameId)).emit('chess:move', {
        gameId,
        from: move.from,
        to: move.to,
        promotion: move.promotion || null,
        fen: game.chess.fen(),
        whiteMs: game.whiteMs,
        blackMs: game.blackMs,
      });

      maybeEndGame(io, game);
      return { ok: true };
    })(data)
  );

  socket.on('chess:resign', (data, cb) =>
    ack(cb, async ({ gameId } = {}) => {
      requirePresence();
      const game = games.get(gameId);
      if (!game || game.over) return { ok: true };
      const myColor = colorOf(game, socket.id);
      if (!myColor) throw new Error('Você não está nesta partida.');

      endGame(io, game, { reason: 'resign', winner: myColor === 'w' ? 'b' : 'w' });
      return { ok: true };
    })(data)
  );

  // Assistir uma partida em andamento: entra na sala do jogo (mesma sala dos
  // dois jogadores) só de leitura — recebe os mesmos broadcasts de
  // chess:move/chess:gameOver que eles, sem poder jogar (o cliente que
  // controla isso, aqui é só a autenticação e o snapshot inicial).
  socket.on('chess:spectate', (data, cb) =>
    ack(cb, async ({ gameId } = {}) => {
      const presence = requirePresence();
      const game = games.get(gameId);
      if (!game || game.over) throw new Error('Essa partida não está mais em andamento.');

      socket.join(roomName(gameId));
      game.spectators.set(socket.id, { name: presence.user.name, avatar: presence.user.avatar });
      broadcastSpectators(io, roomName(gameId), 'chess:spectators', gameId, game);

      return {
        gameId,
        fen: game.chess.fen(),
        whiteName: game.whiteName,
        blackName: game.blackName,
        whiteAvatar: game.whiteAvatar,
        blackAvatar: game.blackAvatar,
        timeControl: game.timeControl,
        whiteMs: game.whiteMs,
        blackMs: game.blackMs,
        spectators: listSpectators(game),
      };
    })(data)
  );

  socket.on('chess:spectate:leave', (data, cb) =>
    ack(cb, async ({ gameId } = {}) => {
      socket.leave(roomName(gameId));
      const game = games.get(gameId);
      if (game?.spectators.delete(socket.id)) {
        broadcastSpectators(io, roomName(gameId), 'chess:spectators', gameId, game);
      }
      return { ok: true };
    })(data)
  );

  // Anuncia no chat que alguém começou uma partida contra o bot — vira um
  // card com botão "Assistir" pra quem estiver vendo aquele canal.
  socket.on('chess:botgame:start', (data, cb) =>
    ack(cb, async ({ channelId, elo, color } = {}) => {
      const presence = requirePresence();
      if (!channelId) throw new Error('Canal inválido.');

      const id = nextBotGameId++;
      const session = {
        id,
        channelId,
        hostSocketId: socket.id,
        hostName: presence.user.name,
        hostAvatar: presence.user.avatar,
        elo,
        hostColor: color === 'b' ? 'b' : 'w',
        fen: new Chess().fen(),
        over: false,
        spectators: new Map(),
      };
      botGames.set(id, session);
      socket.join(botRoomName(id));
      io.emit('chess:botgame:announce', publicBotGame(session));
      return { id };
    })(data)
  );

  // Cada lance (do humano ou do Stockfish local dele) é só retransmitido pra
  // sala de quem está assistindo — sem validação, quem manda é o anfitrião.
  socket.on('chess:botgame:move', (data, cb) =>
    ack(cb, async ({ id, from, to, promotion, fen } = {}) => {
      const session = botGames.get(id);
      if (!session || session.over) return { ok: true };
      if (session.hostSocketId !== socket.id) throw new Error('Só quem começou a partida pode reportar lances.');
      if (fen) session.fen = fen;
      io.to(botRoomName(id)).emit('chess:botgame:move', { id, from, to, promotion: promotion || null, fen: session.fen });
      return { ok: true };
    })(data)
  );

  socket.on('chess:botgame:end', (data, cb) =>
    ack(cb, async ({ id, reason, winner } = {}) => {
      const session = botGames.get(id);
      if (!session || session.over) return { ok: true };
      if (session.hostSocketId !== socket.id) return { ok: true };
      session.over = true;
      io.emit('chess:botgame:closed', { id });
      announceBotGameResult(io, session, reason, winner);
      botGames.delete(id);
      return { ok: true };
    })(data)
  );

  socket.on('chess:botgame:spectate', (data, cb) =>
    ack(cb, async ({ id } = {}) => {
      const presence = requirePresence();
      const session = botGames.get(id);
      if (!session || session.over) throw new Error('Essa partida não está mais em andamento.');
      socket.join(botRoomName(id));
      session.spectators.set(socket.id, { name: presence.user.name, avatar: presence.user.avatar });
      broadcastSpectators(io, botRoomName(id), 'chess:botgame:spectators', id, session);
      return {
        id: session.id,
        fen: session.fen,
        hostName: session.hostName,
        hostAvatar: session.hostAvatar,
        hostColor: session.hostColor,
        elo: session.elo,
        spectators: listSpectators(session),
      };
    })(data)
  );

  socket.on('chess:botgame:spectate:leave', (data, cb) =>
    ack(cb, async ({ id } = {}) => {
      socket.leave(botRoomName(id));
      const session = botGames.get(id);
      if (session?.spectators.delete(socket.id)) {
        broadcastSpectators(io, botRoomName(id), 'chess:botgame:spectators', id, session);
      }
      return { ok: true };
    })(data)
  );

  const cleanup = () => {
    for (const inv of [...invites.values()]) {
      if (inv.hostSocketId === socket.id) closeInvite(io, inv.id, 'cancelled');
    }
    for (const session of [...botGames.values()]) {
      if (session.hostSocketId === socket.id && !session.over) {
        session.over = true;
        io.emit('chess:botgame:closed', { id: session.id });
        botGames.delete(session.id);
      }
    }
    // Se o socket estava só assistindo (não jogando) alguma partida, tira ele
    // da lista de espectadores e avisa quem ficou.
    for (const [id, game] of games) {
      if (!game.over && game.spectators.delete(socket.id)) {
        broadcastSpectators(io, roomName(id), 'chess:spectators', id, game);
      }
    }
    for (const [id, session] of botGames) {
      if (!session.over && session.spectators.delete(socket.id)) {
        broadcastSpectators(io, botRoomName(id), 'chess:botgame:spectators', id, session);
      }
    }

    const gameId = socketGame.get(socket.id);
    if (gameId == null) return;
    const game = games.get(gameId);
    if (game && !game.over) {
      const myColor = colorOf(game, socket.id);
      endGame(io, game, { reason: 'opponentLeft', winner: myColor === 'w' ? 'b' : 'w' });
    }
  };

  return { cleanup };
}

function publicBotGame(session) {
  return {
    id: session.id,
    channelId: session.channelId,
    hostSocketId: session.hostSocketId,
    hostName: session.hostName,
    elo: session.elo,
  };
}

/** Anuncia no chat o resultado de uma partida contra o bot. */
function announceBotGameResult(io, session, reason, winner) {
  const humanWon = winner === session.hostColor;
  let text;
  if (reason === 'checkmate') text = humanWon ? `${session.hostName} venceu o bot por xeque-mate.` : `${session.hostName} perdeu para o bot por xeque-mate.`;
  else if (reason === 'stalemate') text = `${session.hostName} empatou com o bot por afogamento.`;
  else if (reason === 'draw') text = `${session.hostName} empatou com o bot.`;
  else text = `${session.hostName} encerrou a partida contra o bot.`;
  io.emit('chess:announce', { channelId: session.channelId, text });
}

function createGame({ id, white, black, whiteName, blackName, whiteAvatar, blackAvatar, channelId, timeControl }) {
  return {
    id,
    chess: new Chess(),
    white,
    black,
    whiteName,
    blackName,
    whiteAvatar,
    blackAvatar,
    channelId,
    timeControl,
    whiteMs: timeControl * 1000,
    blackMs: timeControl * 1000,
    turnStartedAt: Date.now(),
    timeoutTimer: null,
    over: false,
    spectators: new Map(),
  };
}

function listSpectators(entity) {
  return [...entity.spectators.values()];
}

function broadcastSpectators(io, room, event, id, entity) {
  io.to(room).emit(event, { id, spectators: listSpectators(entity) });
}

/** (Re)agenda a queda de bandeira de quem está para jogar agora. */
function scheduleTimeout(io, game) {
  clearTimeout(game.timeoutTimer);
  const mover = game.chess.turn();
  const remaining = mover === 'w' ? game.whiteMs : game.blackMs;
  game.timeoutTimer = setTimeout(() => {
    if (game.over) return;
    endGame(io, game, { reason: 'timeout', winner: mover === 'w' ? 'b' : 'w' });
  }, Math.max(0, remaining));
}

function publicInvite(invite) {
  return {
    id: invite.id,
    channelId: invite.channelId,
    hostName: invite.hostName,
    hostSocketId: invite.hostSocketId,
    timeControl: invite.timeControl,
  };
}

function closeInvite(io, id, reason) {
  const invite = invites.get(id);
  if (!invite) return;
  clearTimeout(invite.timer);
  invites.delete(id);
  io.emit('chess:invite:closed', { id, reason });
}

function colorOf(game, socketId) {
  if (game.white === socketId) return 'w';
  if (game.black === socketId) return 'b';
  return null;
}

function maybeEndGame(io, game) {
  const c = game.chess;
  if (!c.isGameOver()) return;
  if (c.isCheckmate()) {
    // Quem deu o mate é a cor oposta à de quem está para jogar agora.
    endGame(io, game, { reason: 'checkmate', winner: c.turn() === 'w' ? 'b' : 'w' });
  } else {
    endGame(io, game, { reason: c.isStalemate() ? 'stalemate' : 'draw', winner: null });
  }
}

function endGame(io, game, { reason, winner }) {
  if (game.over) return;
  game.over = true;
  clearTimeout(game.timeoutTimer);
  io.to(roomName(game.id)).emit('chess:gameOver', { gameId: game.id, reason, winner });
  announceResult(io, game, reason, winner);
  games.delete(game.id);
  socketGame.delete(game.white);
  socketGame.delete(game.black);
}

/** Anuncia o resultado no chat do canal onde a partida foi combinada. */
function announceResult(io, game, reason, winner) {
  const winnerName = winner === 'w' ? game.whiteName : winner === 'b' ? game.blackName : null;
  const loserName = winner === 'w' ? game.blackName : winner === 'b' ? game.whiteName : null;
  let text;
  if (reason === 'checkmate') text = `${winnerName} venceu ${loserName} por xeque-mate.`;
  else if (reason === 'resign') text = `${winnerName} venceu — ${loserName} desistiu.`;
  else if (reason === 'opponentLeft') text = `${winnerName} venceu — ${loserName} abandonou a partida.`;
  else if (reason === 'timeout') text = `${winnerName} venceu por tempo — ${loserName} ficou sem tempo.`;
  else if (reason === 'stalemate') text = `Empate por afogamento entre ${game.whiteName} e ${game.blackName}.`;
  else text = `Empate entre ${game.whiteName} e ${game.blackName}.`;
  io.emit('chess:announce', { channelId: game.channelId, text });
}
