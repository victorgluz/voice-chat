import { randomUUID } from 'node:crypto';
import { getDb } from '../index.js';

export function createUser({ name, avatar = null, isAdmin = false }) {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    'INSERT INTO users (id, name, avatar, is_admin, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, name, avatar, isAdmin ? 1 : 0, now, now);
  return getUser(id);
}

export function getUser(id) {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? toUser(row) : null;
}

export function touchUser(id) {
  getDb().prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), id);
}

/** Marca se este usuário deve ser admin (primeiro a entrar vira admin). */
export function setAdmin(id, isAdmin) {
  getDb().prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
}

export function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function toUser(row) {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };
}
