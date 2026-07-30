/**
 * Wrapper fino sobre o Worker do Stockfish (build "lite single-threaded" —
 * não precisa de headers COOP/COEP para SharedArrayBuffer). Um só worker é
 * criado e reaproveitado entre partidas.
 *
 * Força ajustável por rating (UCI_Elo, 1320–3190 — faixa documentada do
 * Stockfish para limitar a força por Elo real, diferente do Skill Level
 * 0–20 que é uma escala mais grosseira sem correspondência direta a rating).
 */

const SEARCH_DEPTH = 12;

let worker = null;
let readyPromise = null;
let pendingResolve = null;

function ensureWorker() {
  if (readyPromise) return readyPromise;

  worker = new Worker('/vendor/stockfish/stockfish.js');
  readyPromise = new Promise((resolve) => {
    const onBoot = (e) => {
      if (e.data === 'uciok') {
        worker.postMessage('isready');
      } else if (e.data === 'readyok') {
        worker.removeEventListener('message', onBoot);
        worker.addEventListener('message', onEngineMessage);
        resolve();
      }
    };
    worker.addEventListener('message', onBoot);
    worker.postMessage('uci');
  });
  return readyPromise;
}

function onEngineMessage(e) {
  const line = e.data;
  if (typeof line !== 'string') return;
  const match = line.match(/^bestmove (\S+)/);
  if (match && pendingResolve) {
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(match[1] === '(none)' ? null : match[1]);
  }
}

/** Reseta a tabela de transposição do engine para uma nova partida e ajusta
 * a força pelo rating escolhido (1320–3190). */
export async function resetEngine(elo) {
  await ensureWorker();
  worker.postMessage('ucinewgame');
  if (elo) {
    worker.postMessage('setoption name UCI_LimitStrength value true');
    worker.postMessage(`setoption name UCI_Elo value ${Math.round(elo)}`);
  }
}

/** Pede o melhor lance para o FEN atual. Resolve com algo como "e2e4" ou "e7e8q". */
export async function getBestMove(fen) {
  await ensureWorker();
  return new Promise((resolve) => {
    pendingResolve = resolve;
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${SEARCH_DEPTH}`);
  });
}
