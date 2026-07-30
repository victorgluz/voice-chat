/**
 * Wrapper fino sobre o Worker do Stockfish (build "lite single-threaded" —
 * não precisa de headers COOP/COEP para SharedArrayBuffer). Um só worker é
 * criado e reaproveitado entre partidas; a força é reduzida (Skill Level)
 * para um bot casual, já que o adversário aqui é um amigo no chat, não um
 * torneio.
 */

const SKILL_LEVEL = 6;
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
        worker.postMessage(`setoption name Skill Level value ${SKILL_LEVEL}`);
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

/** Reseta a tabela de transposição do engine para uma nova partida. */
export async function resetEngine() {
  await ensureWorker();
  worker.postMessage('ucinewgame');
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
