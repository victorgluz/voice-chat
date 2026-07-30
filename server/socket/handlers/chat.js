import * as messages from '../../database/repositories/messages.js';
import { getChannel } from '../../database/repositories/channels.js';
import { listUsers } from '../../database/repositories/users.js';
import * as state from '../state.js';
import { cleanText } from '../../util/sanitize.js';
import { extractMentions } from '../../util/mentions.js';

/** Valida os metadados de anexo enviados pelo cliente (o arquivo em si já
 *  foi validado no upload HTTP; aqui garantimos o formato). */
function cleanAttachment(att) {
  if (!att || typeof att !== 'object') return null;
  const { url, name, mime, size } = att;
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  return {
    url,
    name: cleanText(name || 'arquivo', 200),
    mime: typeof mime === 'string' ? mime.slice(0, 100) : 'application/octet-stream',
    size: Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0,
  };
}

export function registerChatHandlers(io, socket) {
  const ack = (cb, fn) => async (data) => {
    try {
      const result = await fn(data);
      if (typeof cb === 'function') cb({ data: result });
    } catch (err) {
      if (typeof cb === 'function') cb({ error: err.message });
    }
  };

  const me = () => state.getPresence(socket.id)?.user;

  socket.on('chat:history', (data, cb) =>
    ack(cb, async ({ channelId, before = null, limit = 50 }) => {
      if (!getChannel('text', channelId)) throw new Error('Canal inexistente.');
      return messages.listMessages(channelId, Math.min(limit, 100), before);
    })(data)
  );

  socket.on('chat:send', (data, cb) =>
    ack(cb, async ({ channelId, content, replyTo = null, attachment = null }) => {
      const user = me();
      if (!user) throw new Error('Não autenticado.');
      if (!getChannel('text', channelId)) throw new Error('Canal inexistente.');

      const text = cleanText(content);
      const att = cleanAttachment(attachment);
      if (!text && !att) throw new Error('Mensagem vazia.');

      // Se responde a algo, o alvo precisa existir no mesmo canal.
      let validReply = null;
      if (replyTo) {
        const target = messages.getMessage(replyTo);
        if (target && target.channelId === channelId) validReply = replyTo;
      }

      // Resolve @menções (exceto o próprio autor) contra os usuários cadastrados.
      const mentions = extractMentions(text, listUsers()).filter((id) => id !== user.id);

      const message = messages.createMessage({
        channelId,
        userId: user.id,
        content: text,
        replyTo: validReply,
        attachment: att,
        mentions,
      });

      io.emit('chat:message', message);
      return message;
    })(data)
  );

  // Cliente informa que viu as mensagens mencionadas (marca como lidas).
  socket.on('mentions:read', (data, cb) =>
    ack(cb, async ({ messageIds } = {}) => {
      const user = me();
      if (!user) throw new Error('Não autenticado.');
      messages.markMentionsRead(user.id, messageIds);
      return { ok: true };
    })(data)
  );

  socket.on('chat:edit', (data, cb) =>
    ack(cb, async ({ id, content }) => {
      const user = me();
      if (!user) throw new Error('Não autenticado.');
      const text = cleanText(content);
      if (!text) throw new Error('Mensagem vazia.');

      const updated = messages.editMessage(id, user.id, text);
      if (!updated) throw new Error('Não foi possível editar (sem permissão?).');
      io.emit('chat:updated', updated);
      return updated;
    })(data)
  );

  socket.on('chat:delete', (data, cb) =>
    ack(cb, async ({ id }) => {
      const user = me();
      if (!user) throw new Error('Não autenticado.');

      // Autor apaga a própria; admin apaga qualquer uma.
      const ok = messages.deleteMessage(id, { userId: user.id, force: user.isAdmin });
      if (!ok) throw new Error('Não foi possível apagar (sem permissão?).');
      io.emit('chat:deleted', { id });
      return { id };
    })(data)
  );
}
