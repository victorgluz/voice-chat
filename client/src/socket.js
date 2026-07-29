/* global io */

// O cliente do Socket.IO é servido automaticamente pelo servidor em
// /socket.io/socket.io.js e exposto como `io` global (ver index.html).
export const socket = io({ transports: ['websocket', 'polling'] });

/**
 * Emite um evento e devolve uma Promise resolvida pelo ack do servidor.
 * Convenção: o servidor responde { data } em sucesso ou { error } em falha.
 */
export function request(event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(15000).emit(event, payload, (timeoutErr, res) => {
      if (timeoutErr) return reject(new Error('Tempo esgotado. Verifique a conexão.'));
      if (res && res.error) return reject(new Error(res.error));
      resolve(res ? res.data : undefined);
    });
  });
}
