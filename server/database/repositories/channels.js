import { randomUUID } from 'node:crypto';
import { getDb } from '../index.js';

const TABLES = { text: 'channels', voice: 'voice_channels' };

function tableFor(type) {
  const table = TABLES[type];
  if (!table) throw new Error(`Tipo de canal inválido: ${type}`);
  return table;
}

export function listChannels() {
  const db = getDb();
  const text = db.prepare('SELECT * FROM channels ORDER BY position, created_at').all();
  const voice = db.prepare('SELECT * FROM voice_channels ORDER BY position, created_at').all();
  return {
    text: text.map((r) => toChannel(r, 'text')),
    voice: voice.map((r) => toChannel(r, 'voice')),
  };
}

export function getChannel(type, id) {
  const row = getDb().prepare(`SELECT * FROM ${tableFor(type)} WHERE id = ?`).get(id);
  return row ? toChannel(row, type) : null;
}

export function createChannel({ type, name, icon }) {
  const db = getDb();
  const table = tableFor(type);
  const id = randomUUID();
  const now = Date.now();
  const position = db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM ${table}`).get().p;
  const defaultIcon = type === 'voice' ? '🔊' : '💬';
  db.prepare(
    `INSERT INTO ${table} (id, name, icon, position, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, icon || defaultIcon, position, now);
  return getChannel(type, id);
}

export function deleteChannel(type, id) {
  return getDb().prepare(`DELETE FROM ${tableFor(type)} WHERE id = ?`).run(id).changes > 0;
}

function toChannel(row, type) {
  return { id: row.id, name: row.name, icon: row.icon, position: row.position, type };
}
