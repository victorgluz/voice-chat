import { Chess } from 'chess.js';
import * as state from '../state.js';

/**
 * Xadrez multiplayer. Fila aberta ("open queue"): quem clica em jogar online
 * entra numa fila de um lugar; o próximo que entra é pareado na hora. As cores
 * são sorteadas no servidor (fonte da verdade). Todo lance é validado aqui com
 * chess.js — o cliente nunca é confiável — e retransmitido para os dois
 * jogadores, que animam a partir do broadcast (mesmo código dos dois lados).
 *
 * Estado é de módulo (compartilhado entre todos os sockets), volátil: some ao
 * reiniciar o servidor, como a presença.
 */

const roomName = (gameId) => `chess:${gameId}`;

// Estado compartilhado entre conexões.
let waiting = null; // socketId aguardando par (ou null)
const games = new Map(); // gameId -> { id, chess, white, black, whiteName, blackName, over }
const socketGame = new Map(); // socketId -> gameId

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

  socket.on('chess:queueJoin', (data, cb) =>
    ack(cb, async () => {
      const presence = requirePresence();

      if (socketGame.has(socket.id)) throw new Error('Você já está em uma partida.');
      if (waiting === socket.id) return { status: 'queued' };

      // Ninguém esperando (ou o que esperava caiu): entra na fila.
      if (!waiting || !state.getPresence(waiting)) {
        waiting = socket.id;
        return { status: 'queued' };
      }

      // Há alguém esperando: forma a partida.
      const opponentId = waiting;
      waiting = null;
      const opponent = state.getPresence(opponentId);

      const meWhite = Math.random() < 0.5;
      const whiteId = meWhite ? socket.id : opponentId;
      const blackId = meWhite ? opponentId : socket.id;
      const whiteName = state.getPresence(whiteId)?.user.name || 'Brancas';
      const blackName = state.getPresence(blackId)?.user.name || 'Pretas';

      const id = nextGameId++;
      const game = { id, chess: new Chess(), white: whiteId, black: blackId, whiteName, blackName, over: false };
      games.set(id, game);
      socketGame.set(whiteId, id);
      socketGame.set(blackId, id);

      io.sockets.sockets.get(whiteId)?.join(roomName(id));
      io.sockets.sockets.get(blackId)?.join(roomName(id));

      io.to(whiteId).emit('chess:matchFound', { gameId: id, color: 'w', opponentName: blackName });
      io.to(blackId).emit('chess:matchFound', { gameId: id, color: 'b', opponentName: whiteName });

      return { status: 'matched' };
    })(data)
  );

  socket.on('chess:queueLeave', (data, cb) =>
    ack(cb, async () => {
      if (waiting === socket.id) waiting = null;
      return { left: true };
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
    if (waiting === socket.id) waiting = null;
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
