import { randomUUID } from 'node:crypto';
import { getDb } from '../index.js';

/**
 * Soundboard: biblioteca global de áudios. Qualquer usuário cria; a permissão
 * de apagar (autor ou admin) é validada na camada de socket, não aqui.
 */
export function createSound({ name, icon = null, url, mime = null, size = null, uploaderId = null }) {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sounds (id, name, icon, url, mime, size, uploader_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, icon, url, mime, size, uploaderId, now);
  return getSound(id);
}

export function getSound(id) {
  const row = getDb()
    .prepare(
      `SELECT s.*, u.name AS uploader_name
         FROM sounds s
         LEFT JOIN users u ON u.id = s.uploader_id
        WHERE s.id = ?`
    )
    .get(id);
  return row ? toSound(row) : null;
}

export function listSounds() {
  return getDb()
    .prepare(
      `SELECT s.*, u.name AS uploader_name
         FROM sounds s
         LEFT JOIN users u ON u.id = s.uploader_id
        ORDER BY s.name COLLATE NOCASE, s.created_at`
    )
    .all()
    .map(toSound);
}

export function deleteSound(id) {
  return getDb().prepare('DELETE FROM sounds WHERE id = ?').run(id).changes > 0;
}

function toSound(row) {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    url: row.url,
    mime: row.mime,
    size: row.size,
    uploaderId: row.uploader_id,
    uploaderName: row.uploader_name,
    createdAt: row.created_at,
  };
}
