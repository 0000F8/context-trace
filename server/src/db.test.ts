import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { fnv1a64 } from '@context-trace/types';
import { DEFAULT_PROJECT_ID, hasFtsSupport, openDb } from './db.js';
import { upsertSegment, upsertSession } from './store.js';

function resolveTsxBin(): string {
  const local = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  if (existsSync(local)) return local;
  return join(process.cwd(), '..', 'node_modules', '.bin', 'tsx');
}

/** Runs `tsxBin scriptPath dbPath` and resolves with its exit code + stderr, never rejecting. */
function runNodeBoot(tsxBin: string, scriptPath: string, dbPath: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(tsxBin, [scriptPath, dbPath]);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('openDb', () => {
  it('detects FTS5 support and creates sections_fts on a normal build', () => {
    const db = openDb(':memory:');
    expect(hasFtsSupport(db)).toBe(true);
    // sections_fts must be queryable (the guard actually created the table, not just
    // set the flag).
    expect(() => db.prepare('SELECT COUNT(*) FROM sections_fts').get()).not.toThrow();
    db.close();
  });

  it('migrates a pre-v0.2 db file by adding segments.outcome, preserving existing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-migration-'));
    const path = join(dir, 'old.db');
    try {
      // Build the exact pre-v0.2 schema (no `outcome` column on segments) directly,
      // bypassing openDb, then insert a row that must survive the migration.
      const raw = new Database(path);
      raw.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT, metadata TEXT,
          started_at TEXT NOT NULL, ended_at TEXT
        );
        CREATE TABLE segments (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, idx INTEGER NOT NULL,
          label TEXT, kind TEXT NOT NULL, model TEXT, timestamp TEXT NOT NULL, metadata TEXT,
          UNIQUE(session_id, idx)
        );
        CREATE TABLE sections (
          segment_id TEXT NOT NULL, key TEXT NOT NULL, service TEXT NOT NULL,
          service_kind TEXT NOT NULL, role TEXT, position INTEGER NOT NULL,
          content TEXT, content_hash TEXT NOT NULL, tokens INTEGER NOT NULL, metadata TEXT,
          PRIMARY KEY (segment_id, key)
        );
      `);
      raw
        .prepare('INSERT INTO sessions (id, name, started_at) VALUES (?, ?, ?)')
        .run('s1', 'pre-existing session', '2026-01-01T00:00:00.000Z');
      raw
        .prepare('INSERT INTO segments (id, session_id, idx, kind, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('seg-0', 's1', 0, 'llm_call', '2026-01-01T00:00:00.000Z');
      raw.close();

      const db = openDb(path);
      const cols = db.prepare('PRAGMA table_info(segments)').all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'outcome')).toBe(true);

      const row = db.prepare('SELECT * FROM segments WHERE id = ?').get('seg-0') as { session_id: string; outcome: unknown };
      expect(row.session_id).toBe('s1'); // pre-existing data survived the migration
      expect(row.outcome).toBeNull();

      // Re-opening an already-migrated file must not throw ("duplicate column").
      db.close();
      expect(() => openDb(path).close()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a pre-v0.3 db file by adding sessions.project_id + projects/project_keys, backfilling existing sessions to default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-migration-v3-'));
    const path = join(dir, 'old.db');
    try {
      // Build the exact pre-v0.3 schema (v0.2 shape: no project_id, no projects/project_keys
      // tables at all) directly, bypassing openDb, then insert a row that must survive.
      const raw = new Database(path);
      raw.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT, metadata TEXT,
          started_at TEXT NOT NULL, ended_at TEXT
        );
        CREATE TABLE segments (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, idx INTEGER NOT NULL,
          label TEXT, kind TEXT NOT NULL, model TEXT, timestamp TEXT NOT NULL, metadata TEXT,
          outcome TEXT,
          UNIQUE(session_id, idx)
        );
        CREATE TABLE sections (
          segment_id TEXT NOT NULL, key TEXT NOT NULL, service TEXT NOT NULL,
          service_kind TEXT NOT NULL, role TEXT, position INTEGER NOT NULL,
          content TEXT, content_hash TEXT NOT NULL, tokens INTEGER NOT NULL, metadata TEXT,
          PRIMARY KEY (segment_id, key)
        );
      `);
      raw
        .prepare('INSERT INTO sessions (id, name, started_at) VALUES (?, ?, ?)')
        .run('s1', 'pre-existing session', '2026-01-01T00:00:00.000Z');
      raw.close();

      const db = openDb(path);

      const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'project_id')).toBe(true);

      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as { name: string; project_id: string };
      expect(row.name).toBe('pre-existing session'); // pre-existing data survived the migration
      expect(row.project_id).toBe('default'); // backfilled

      const defaultProject = db.prepare('SELECT * FROM projects WHERE id = ?').get('default') as
        | { id: string; name: string }
        | undefined;
      expect(defaultProject).toBeDefined();
      expect(defaultProject?.name).toBe('Default');

      // Re-opening an already-migrated file must not throw ("duplicate column").
      db.close();
      expect(() => openDb(path).close()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('heals a partial sections_fts gap on reopen, not just a fully-empty table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-fts-heal-'));
    const path = join(dir, 'heal.db');
    try {
      let db = openDb(path);
      upsertSession(db, { id: 's1', name: 'sess', startedAt: '2026-01-01T00:00:00.000Z' }, DEFAULT_PROJECT_ID);
      upsertSegment(
        db,
        {
          id: 'seg-0',
          sessionId: 's1',
          index: 0,
          kind: 'llm_call',
          timestamp: '2026-01-01T00:00:00.000Z',
          sections: [
            { key: 'a', service: 'svc', serviceKind: 'memory', position: 0, content: 'alpha', contentHash: fnv1a64('alpha'), tokens: 5 },
            { key: 'b', service: 'svc', serviceKind: 'memory', position: 1, content: 'beta', contentHash: fnv1a64('beta'), tokens: 4 },
          ],
        },
        DEFAULT_PROJECT_ID
      );

      const sectionsCount = (db.prepare('SELECT COUNT(*) AS c FROM sections').get() as { c: number }).c;
      expect((db.prepare('SELECT COUNT(*) AS c FROM sections_fts').get() as { c: number }).c).toBe(sectionsCount);

      // Simulate a partial gap (e.g. rows written during a prior boot without FTS5
      // support) by deleting one fts row directly, leaving the `sections` row intact.
      db.prepare(`DELETE FROM sections_fts WHERE key = 'b'`).run();
      expect((db.prepare('SELECT COUNT(*) AS c FROM sections_fts').get() as { c: number }).c).toBe(sectionsCount - 1);
      db.close();

      db = openDb(path); // reopen: ftsCount < sectionsCount must trigger a full heal
      expect((db.prepare('SELECT COUNT(*) AS c FROM sections_fts').get() as { c: number }).c).toBe(sectionsCount);
      // The section that was never removed must not have been duplicated by the rebuild.
      expect((db.prepare(`SELECT COUNT(*) AS c FROM sections_fts WHERE key = 'a'`).get() as { c: number }).c).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives 4 concurrent boots racing the same pre-v0.3 file, instead of crashing on "duplicate column name"', async () => {
    // Real multi-process concurrency: better-sqlite3 is synchronous, so racing openDb()
    // calls within a single Node process can never actually interleave — the bug (and the
    // fix) only shows up across separate connections/processes, exactly like two Docker
    // Compose instances restarting at once or `npm run keys` running during first boot.
    const dir = mkdtempSync(join(tmpdir(), 'ct-migration-race-'));
    const dbPath = join(dir, 'race.db');
    const scriptPath = join(dir, 'boot.mts');
    try {
      // Build the exact pre-v0.3 schema (v0.2 shape) directly, bypassing openDb.
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT, metadata TEXT,
          started_at TEXT NOT NULL, ended_at TEXT
        );
        CREATE TABLE segments (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, idx INTEGER NOT NULL,
          label TEXT, kind TEXT NOT NULL, model TEXT, timestamp TEXT NOT NULL, metadata TEXT,
          outcome TEXT,
          UNIQUE(session_id, idx)
        );
        CREATE TABLE sections (
          segment_id TEXT NOT NULL, key TEXT NOT NULL, service TEXT NOT NULL,
          service_kind TEXT NOT NULL, role TEXT, position INTEGER NOT NULL,
          content TEXT, content_hash TEXT NOT NULL, tokens INTEGER NOT NULL, metadata TEXT,
          PRIMARY KEY (segment_id, key)
        );
      `);
      raw.close();

      const dbModulePath = JSON.stringify(join(process.cwd(), 'src', 'db.js'));
      writeFileSync(
        scriptPath,
        `import { openDb } from ${dbModulePath};\nopenDb(process.argv[2]).close();\n`
      );

      const tsxBin = resolveTsxBin();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => runNodeBoot(tsxBin, scriptPath, dbPath))
      );

      for (const r of results) {
        expect(r.stderr).not.toMatch(/duplicate column name/);
        expect(r.code).toBe(0);
      }

      // The DB must end up fully and correctly migrated regardless of who won the race.
      const db = openDb(dbPath);
      const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'project_id')).toBe(true);
      const defaultProject = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(DEFAULT_PROJECT_ID);
      expect(defaultProject).toBeDefined();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
