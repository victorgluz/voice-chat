import { randomUUID } from 'node:crypto';
import { getDb } from '../index.js';

export function createMessage({ channelId, userId, content, replyTo = null, attachment = null }) {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO messages (id, channel_id, user_id, content, reply_to, attachment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, channelId, userId, content, replyTo, attachment ? JSON.stringify(attachment) : null, now);
  return getMessage(id);
}

export function getMessage(id) {
  const row = getDb()
    .prepare(
      `SELECT m.*, u.name AS author_name, u.avatar AS author_avatar
       FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.id = ?`
    )
    .get(id);
  return row ? toMessage(row) : null;
}

/** Últimas N mensagens de um canal, em ordem cronológica. */
export function listMessages(channelId, limit = 50, before = null) {
  const db = getDb();
  const rows = before
    ? db
        .prepare(
          `SELECT m.*, u.name AS author_name, u.avatar AS author_avatar
           FROM messages m JOIN users u ON u.id = m.user_id
           WHERE m.channel_id = ? AND m.created_at < ?
           ORDER BY m.created_at DESC LIMIT ?`
        )
        .all(channelId, before, limit)
    : db
        .prepare(
          `SELECT m.*, u.name AS author_name, u.avatar AS author_avatar
           FROM messages m JOIN users u ON u.id = m.user_id
           WHERE m.channel_id = ?
           ORDER BY m.created_at DESC LIMIT ?`
        )
        .all(channelId, limit);
  return rows.reverse().map(toMessage);
}

export function editMessage(id, userId, content) {
  const db = getDb();
  const res = db
    .prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND user_id = ? AND deleted = 0')
    .run(content, Date.now(), id, userId);
  return res.changes > 0 ? getMessage(id) : null;
}

/** Soft-delete: mantém o registro para não quebrar respostas encadeadas. */
export function deleteMessage(id, { userId = null, force = false } = {}) {
  const db = getDb();
  const res = force
    ? db.prepare("UPDATE messages SET deleted = 1, content = '' WHERE id = ?").run(id)
    : db
        .prepare("UPDATE messages SET deleted = 1, content = '' WHERE id = ? AND user_id = ?")
        .run(id, userId);
  return res.changes > 0;
}

function toMessage(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    author: { id: row.user_id, name: row.author_name, avatar: row.author_avatar },
    content: row.content,
    replyTo: row.reply_to,
    attachment: row.attachment ? JSON.parse(row.attachment) : null,
    editedAt: row.edited_at,
    deleted: row.deleted === 1,
    createdAt: row.created_at,
  };
}
