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

/**
 * v0.3 tenancy tables (spec3.md §B). `projects` and `project_keys` are new tables so
 * `CREATE TABLE IF NOT EXISTS` is enough on its own; `sessions.project_id` is an added
 * column on an existing table, so it needs the same guarded-migration treatment as
 * `segments.outcome` below (see `ensureProjectIdColumn`).
 */
const PROJECT_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('read','write','admin')),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_project_keys_project ON project_keys(project_id);
`;

export const DEFAULT_PROJECT_ID = 'default';

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

/**
 * Guarded migration for `sessions.project_id` (v0.3): existing DB files predate the
 * column, so `ADD COLUMN ... DEFAULT 'default'` both adds it and backfills every
 * existing row to the default project in one step. Same pragma-probe pattern as
 * `ensureOutcomeColumn` — safe to call on every boot, including already-migrated files.
 */
function ensureProjectIdColumn(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'project_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}'`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)');
}

/**
 * Boot creates the `default` project if absent, so 'none' mode always has somewhere to
 * resolve to. `INSERT OR IGNORE` (rather than a separate SELECT-then-INSERT) makes this
 * atomic on its own even outside `runMigrations`' transaction — belt and suspenders.
 */
function ensureDefaultProject(db: Db): void {
  db.prepare('INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
    DEFAULT_PROJECT_ID,
    'Default',
    new Date().toISOString()
  );
}

/**
 * Runs every schema/migration step as one `BEGIN IMMEDIATE` transaction, so concurrent
 * boots against the same DB file (two Docker Compose instances racing on restart, `npm
 * run keys` running during first boot, ...) serialize instead of interleaving. Without
 * this, each guarded migration's "check pragma table_info, then ALTER" is a classic
 * check-then-act race: two connections can both see the column missing and both attempt
 * the `ALTER TABLE`, and the second gets a fatal "duplicate column name" error. Acquiring
 * the write lock up front (`BEGIN IMMEDIATE`, not better-sqlite3's default `BEGIN
 * DEFERRED`) means a second connection's own `.immediate()` call blocks — respecting
 * `busy_timeout` — until the first fully commits, so its *check* only ever runs after the
 * first connection's migration is already durable, never mid-flight.
 */
function runMigrations(db: Db): void {
  const migrate = db.transaction(() => {
    db.exec(SCHEMA);
    ensureOutcomeColumn(db);
    db.exec(PROJECT_SCHEMA);
    ensureProjectIdColumn(db);
    ensureDefaultProject(db);
  });
  migrate.immediate();
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

/** Blocks the current thread for `ms` — a synchronous sleep, safe to use before any I/O is in flight. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The very first `journal_mode = WAL` against a file still in its original (rollback)
 * journal mode does more than set a pragma — it performs the on-disk conversion to WAL,
 * which needs exclusive access. Empirically (see the concurrent-boot test in db.test.ts)
 * this specific pragma can throw `SQLITE_BUSY` under contention even with `busy_timeout`
 * already set, unlike ordinary statement execution — busy_timeout's retry loop doesn't
 * reliably cover this one operation. Retrying it ourselves at the JS level closes that
 * gap regardless of the underlying SQLite/better-sqlite3 version's exact behavior here.
 */
function setWalModeWithRetry(db: Db): void {
  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      const isBusy = err instanceof Error && 'code' in err && (err as { code?: string }).code === 'SQLITE_BUSY';
      if (!isBusy || attempt === maxAttempts) throw err;
      sleepSync(50);
    }
  }
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
  // Set FIRST, before any other pragma or statement: this reduces (but per
  // setWalModeWithRetry's own retry loop, does not have to fully eliminate) the window
  // where a concurrent boot can hit SQLITE_BUSY before its own busy_timeout is in effect.
  // 10s is generous relative to how long the migration itself takes (milliseconds) — it
  // only matters under contention (many boots racing at once), where waiting is correct.
  db.pragma('busy_timeout = 10000');
  setWalModeWithRetry(db);
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const ftsOk = tryCreateFts(db);
  setFtsSupport(db, ftsOk);
  if (ftsOk) backfillFtsIfNeeded(db);

  return db;
}
