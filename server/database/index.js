import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db;

/** Abre a conexão, aplica o schema e semeia dados padrão. */
export function initDatabase() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.paths.database), { recursive: true });
  db = new Database(config.paths.database);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  migrate();
  seedDefaults();
  return db;
}

/** Migrações idempotentes para bancos criados antes de uma coluna existir.
 *  ALTER TABLE ADD COLUMN não tem "IF NOT EXISTS", então checamos o schema. */
function migrate() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if (!cols.includes('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  // Índice único do e-mail (caso o banco seja anterior à sua criação).
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE email IS NOT NULL'
  );
}

export function getDb() {
  if (!db) throw new Error('Database não inicializado. Chame initDatabase() primeiro.');
  return db;
}

/** Cria canais e configurações iniciais apenas na primeira execução. */
function seedDefaults() {
  const now = Date.now();

  const textCount = db.prepare('SELECT COUNT(*) AS c FROM channels').get().c;
  if (textCount === 0) {
    const insert = db.prepare(
      'INSERT INTO channels (id, name, icon, position, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    [
      { name: 'avisos', icon: '📢' },
      { name: 'geral', icon: '💬' },
      { name: 'desenvolvimento', icon: '💬' },
    ].forEach((c, i) => insert.run(randomUUID(), c.name, c.icon, i, now));
  }

  const voiceCount = db.prepare('SELECT COUNT(*) AS c FROM voice_channels').get().c;
  if (voiceCount === 0) {
    const insert = db.prepare(
      'INSERT INTO voice_channels (id, name, icon, position, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    [
      { name: 'Geral', icon: '🔊' },
      { name: 'Jogos', icon: '🔊' },
      { name: 'Reunião', icon: '🔊' },
    ].forEach((c, i) => insert.run(randomUUID(), c.name, c.icon, i, now));
  }

  const upsertSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  );
  upsertSetting.run('server_name', 'Discord Lan');
}

export default { initDatabase, getDb };
