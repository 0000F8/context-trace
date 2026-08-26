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
  outcome TEXT,
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

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
  content, key, service, session_id UNINDEXED, segment_id UNINDEXED, segment_index UNINDEXED
);
`;

/**
 * Guarded migration: `segments.outcome` ships in the schema above for fresh databases,
 * but existing (pre-v0.2) DB files were created without it. `ALTER TABLE ... ADD COLUMN`
 * is only safe to run once, so check `pragma table_info` first rather than risk a
 * "duplicate column" error on every boot against an already-migrated file.
 */
function ensureOutcomeColumn(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(segments)').all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'outcome')) {
    db.exec('ALTER TABLE segments ADD COLUMN outcome TEXT');
  }
}

// Whether a given Db instance has a working sections_fts table — detected once at open
// time (some SQLite builds ship without the FTS5 module) and stashed directly on the
// instance so callers never need to re-probe or thread an extra parameter around.
const FTS_FLAG: unique symbol = Symbol('ftsAvailable');
type DbWithFlags = Db & { [FTS_FLAG]?: boolean };

export function hasFtsSupport(db: Db): boolean {
  return Boolean((db as DbWithFlags)[FTS_FLAG]);
}

/** Test-only escape hatch to simulate a build without FTS5 without needing one. */
export function setFtsSupport(db: Db, value: boolean): void {
  (db as DbWithFlags)[FTS_FLAG] = value;
}

function tryCreateFts(db: Db): boolean {
  try {
    db.exec(FTS_SCHEMA);
    return true;
  } catch {
    return false;
  }
}

/**
 * Backfill for DBs where sections_fts is behind sections — either it was empty (never
 * populated, e.g. sections written before FTS5 support existed) or only partially
 * populated (e.g. some sections were written during a prior boot that lacked FTS5
 * support, so upsertSegment's own fts maintenance silently skipped them). Comparing
 * row counts (rather than just checking for emptiness) catches both cases; healing is
 * a full rebuild rather than trying to diff in the missing rows, since this only runs
 * once at boot and correctness matters far more than its cost here.
 */
function backfillFtsIfNeeded(db: Db): void {
  const ftsCount = (db.prepare('SELECT COUNT(*) AS c FROM sections_fts').get() as { c: number }).c;
  const sectionsCount = (
    db.prepare('SELECT COUNT(*) AS c FROM sections WHERE content IS NOT NULL').get() as { c: number }
  ).c;
  // Rebuild on ANY count divergence (either direction). Known limitation:
  // content drift with identical counts (an FTS5-less boot that updated a
  // section in place) is not detected; a full rebuild only happens when the
  // counts disagree.
  if (ftsCount === sectionsCount) return;
  db.exec('DELETE FROM sections_fts');
  db.exec(`
    INSERT INTO sections_fts (content, key, service, session_id, segment_id, segment_index)
    SELECT sec.content, sec.key, sec.service, seg.session_id, sec.segment_id, seg.idx
    FROM sections sec JOIN segments seg ON seg.id = sec.segment_id
    WHERE sec.content IS NOT NULL
  `);
}

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
  ensureOutcomeColumn(db);

  const ftsOk = tryCreateFts(db);
  setFtsSupport(db, ftsOk);
  if (ftsOk) backfillFtsIfNeeded(db);

  return db;
}
