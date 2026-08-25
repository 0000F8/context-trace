import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent TEXT,
  metadata TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  label TEXT,
  kind TEXT NOT NULL,
  model TEXT,
  timestamp TEXT NOT NULL,
  metadata TEXT,
  UNIQUE(session_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id);

CREATE TABLE IF NOT EXISTS sections (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  service TEXT NOT NULL,
  service_kind TEXT NOT NULL,
  role TEXT,
  position INTEGER NOT NULL,
  content TEXT,
  content_hash TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  metadata TEXT,
  PRIMARY KEY (segment_id, key)
);

CREATE INDEX IF NOT EXISTS idx_sections_segment ON sections(segment_id);
`;

/**
 * Opens (and initializes) the SQLite database at `path`.
 * Pass ':memory:' for ephemeral/test databases.
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
