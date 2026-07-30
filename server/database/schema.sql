-- Esquema do banco. Executado no boot; idempotente (IF NOT EXISTS).

PRAGMA journal_mode = WAL;      -- melhor concorrência leitura/escrita
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT,
  password_hash TEXT,
  avatar        TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);
-- Nota: o índice único de e-mail é criado em migrate() (database/index.js),
-- pois em bancos antigos a coluna `email` só existe após o ALTER TABLE.

-- Canais de texto.
CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT '💬',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Canais de voz.
CREATE TABLE IF NOT EXISTS voice_channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT '🔊',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  content     TEXT NOT NULL,
  reply_to    TEXT REFERENCES messages(id) ON DELETE SET NULL,
  attachment  TEXT,           -- JSON: {url, name, mime, size} ou NULL
  edited_at   INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel
  ON messages (channel_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Soundboard: biblioteca global de áudios (compartilhada por todo o servidor).
CREATE TABLE IF NOT EXISTS sounds (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon        TEXT,                                    -- /uploads/... (imagem) ou NULL
  url         TEXT NOT NULL,                           -- /uploads/<uuid>.<ext> do áudio
  mime        TEXT,
  size        INTEGER,
  uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sounds_created ON sounds (created_at);

-- Menções (@user) por mensagem, para badges e "não lida" persistente por usuário.
CREATE TABLE IF NOT EXISTS mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions (user_id, read);
