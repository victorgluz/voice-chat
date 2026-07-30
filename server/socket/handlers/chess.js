import { Chess } from 'chess.js';
import * as state from '../state.js';

/**
 * Xadrez multiplayer via convite no chat: quem clica em "Multiplayer" cria um
 * convite (uma instância independente, com seu próprio id) que é anunciado
 * para todo mundo; quem estiver vendo aquele canal vê um card clicável e
 * entra na hora — sem fila cega. Vários convites (e várias partidas) podem
 * coexistir ao mesmo tempo, inclusive no mesmo canal: cada um é uma instância
 * própria, independente das outras.
 *
 * As cores são sorteadas no servidor. Todo lance é validado aqui com chess.js
 * — o cliente nunca é confiável — e retransmitido para os dois jogadores.
 */

const roomName = (gameId) => `chess:${gameId}`;
const INVITE_TTL_MS = 10 * 60 * 1000; // convite não aceito expira em 10min

// Estado compartilhado entre conexões (uma instância por processo, como presence).
const invites = new Map(); // inviteId -> { id, channelId, hostSocketId, hostName, timer }
const games = new Map(); // gameId -> { id, chess, white, black, whiteName, blackName, over }
const socketGame = new Map(); // socketId -> gameId

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
    ack(cb, async ({ channelId } = {}) => {
      const presence = requirePresence();
      if (!channelId) throw new Error('Canal inválido.');
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
      io.emit('chess:invite:closed', { id, reason: 'started' });

      const meWhite = Math.random() < 0.5;
      const whiteId = meWhite ? socket.id : invite.hostSocketId;
      const blackId = meWhite ? invite.hostSocketId : socket.id;
      const whiteName = state.getPresence(whiteId)?.user.name || 'Brancas';
      const blackName = state.getPresence(blackId)?.user.name || 'Pretas';

      const gameId = nextGameId++;
      const game = { id: gameId, chess: new Chess(), white: whiteId, black: blackId, whiteName, blackName, over: false };
      games.set(gameId, game);
      socketGame.set(whiteId, gameId);
      socketGame.set(blackId, gameId);

      io.sockets.sockets.get(whiteId)?.join(roomName(gameId));
      io.sockets.sockets.get(blackId)?.join(roomName(gameId));

      io.to(whiteId).emit('chess:matchFound', { gameId, color: 'w', opponentName: blackName });
      io.to(blackId).emit('chess:matchFound', { gameId, color: 'b', opponentName: whiteName });

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

      let move;
      try {
        move = game.chess.move({ from, to, promotion: promotion || undefined });
      } catch {
        move = null;
      }
      if (!move) throw new Error('Lance ilegal.');

      io.to(roomName(gameId)).emit('chess:move', {
        gameId,
        from: move.from,
        to: move.to,
        promotion: move.promotion || null,
        fen: game.chess.fen(),
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

  const cleanup = () => {
    for (const inv of [...invites.values()]) {
      if (inv.hostSocketId === socket.id) closeInvite(io, inv.id, 'cancelled');
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

function publicInvite(invite) {
  return { id: invite.id, channelId: invite.channelId, hostName: invite.hostName, hostSocketId: invite.hostSocketId };
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
  io.to(roomName(game.id)).emit('chess:gameOver', { gameId: game.id, reason, winner });
  games.delete(game.id);
  socketGame.delete(game.white);
  socketGame.delete(game.black);
}
